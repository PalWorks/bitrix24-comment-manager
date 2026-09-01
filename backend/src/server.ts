import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { loadConfig } from './config.js';
import { AppError } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { authRouter } from './routes/auth.js';
import { leadsRouter } from './routes/leads.js';
import { commentsRouter } from './routes/comments.js';
import { activityRouter } from './routes/activity.js';
import { supportRouter } from './routes/support.js';
import { shutdownPool, getPool, drainPendingWrites } from './services/auditLogger.js';
import { stopCleanupTimers } from './services/tokenService.js';
import { stopPruneTimer } from './middleware/rateLimiter.js';

const config = loadConfig();

const app = express();

// Must be set before any middleware reads req.ip. The value is a hop count, so
// Express takes the address that many entries from the right of
// X-Forwarded-For: entries a client prepends itself are never reached.
app.set('trust proxy', config.trustProxy);

app.use(
    helmet({
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
        },
    }),
);

if (config.nodeEnv === 'production') {
    app.use((req: Request, res: Response, next: NextFunction) => {
        const proto = req.headers['x-forwarded-proto'];
        if (proto && proto !== 'https') {
            res.redirect(301, `https://${req.headers.host}${req.url}`);
            return;
        }
        next();
    });
}

app.use(
    cors({
        origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    }),
);
// Mounted ahead of the global parser: the support route accepts a base64
// attachment and installs its own, larger, JSON limit. Everything else stays
// on the 100 kB default.
app.use('/support', supportRouter);

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
});

app.get('/readiness', async (_req: Request, res: Response) => {
    const checks: { config: boolean; uptime: number; database: boolean } = {
        config: config.supportOnly
            ? Boolean(config.resendApiKey && config.supportToEmail)
            : Boolean(config.jwtSecret && config.bitrix24ClientId),
        uptime: process.uptime(),
        database: false,
    };

    // A support only instance keeps no state, so a database it never opens must
    // not hold it out of readiness.
    if (config.supportOnly) {
        const ready = checks.config;
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not_ready',
            mode: 'support-only',
            checks: { config: checks.config, uptime: checks.uptime },
        });
        return;
    }

    try {
        await getPool().execute('SELECT 1');
        checks.database = true;
    } catch {
        checks.database = false;
    }

    const ready = checks.config && checks.database;
    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        checks,
    });
});

if (config.supportOnly) {
    // A support only instance has no Bitrix24 application and no audit log, so
    // these routes could not do anything meaningful. Answering with a reason is
    // clearer than a 404 that reads like a wrong URL.
    app.use(['/auth', '/api'], (_req: Request, res: Response) => {
        res.status(503).json({
            error: {
                code: 'SUPPORT_ONLY',
                message:
                    'This server only answers support requests. Point the extension at your own backend.',
            },
        });
    });
} else {
    app.use('/auth', authRouter);
    app.use('/api/leads', leadsRouter);
    app.use('/api/comments', commentsRouter);
    app.use('/api/activity', activityRouter);
}

app.use((_req: Request, res: Response) => {
    res.status(404).json({
        error: {
            code: 'NOT_FOUND',
            message: 'The requested endpoint does not exist.',
        },
    });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
        logger.warn('Request error', {
            code: err.code,
            statusCode: err.statusCode,
            message: err.message,
        });
        res.status(err.statusCode).json(err.toResponse());
        return;
    }

    logger.error('Unhandled error', {
        name: err.name,
        message: err.message,
        stack: err.stack,
    });
    res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred.',
        },
    });
});

const server = app.listen(config.port, () => {
    logger.info(`Server started on port ${config.port}`, {
        environment: config.nodeEnv,
    });
});

/**
 * How long a shutdown may take before the process stops waiting.
 *
 * server.close() only fires once every open connection has ended, and a
 * keep-alive client that sends nothing keeps its connection open indefinitely.
 * Without a ceiling the container hangs until the orchestrator escalates to
 * SIGKILL, which is the one outcome graceful shutdown exists to avoid: it kills
 * the process mid-write, with audit rows still unflushed.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

let shuttingDown = false;

function gracefulShutdown(signal: string) {
    // Docker sends SIGTERM and, on an unresponsive container, follows with more
    // signals. Re-entering here would start a second drain over a closing pool.
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    logger.info(`Received ${signal}. Shutting down gracefully.`);
    stopCleanupTimers();
    stopPruneTimer();

    const forceExit = setTimeout(() => {
        logger.error('Shutdown did not complete in time. Exiting anyway.', {
            timeoutMs: SHUTDOWN_TIMEOUT_MS,
        });
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close(async () => {
        logger.info('HTTP server closed.');
        try {
            await drainPendingWrites();
            logger.info('All pending audit writes drained.');
            await shutdownPool();
            logger.info('All resources released. Exiting.');
        } catch (error) {
            logger.error('Shutdown encountered an error', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        clearTimeout(forceExit);
        process.exit(0);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * A rejection nobody handled would otherwise terminate the process with only
 * Node's own trace, which names the file but not the request or the deployment.
 * Logging it in the same shape as everything else is what makes it findable at
 * three in the morning; the process still exits, because state after an
 * unhandled rejection is not something to keep serving from.
 */
process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled promise rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
    });
    gracefulShutdown('unhandledRejection');
});

process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught exception', { message: error.message, stack: error.stack });
    gracefulShutdown('uncaughtException');
});

export { app };
