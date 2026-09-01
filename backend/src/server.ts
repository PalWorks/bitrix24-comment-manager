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
        config: Boolean(config.jwtSecret && config.bitrix24ClientId),
        uptime: process.uptime(),
        database: false,
    };

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

app.use('/auth', authRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/activity', activityRouter);

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

function gracefulShutdown(signal: string) {
    logger.info(`Received ${signal}. Shutting down gracefully.`);
    stopCleanupTimers();
    stopPruneTimer();
    server.close(async () => {
        logger.info('HTTP server closed.');
        await drainPendingWrites();
        logger.info('All pending audit writes drained.');
        await shutdownPool();
        logger.info('All resources released. Exiting.');
        process.exit(0);
    });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { app };
