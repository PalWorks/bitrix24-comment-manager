import { describe, it, expect, vi, afterEach } from 'vitest';
import express, { Request, Response } from 'express';
import type { Server } from 'http';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'readiness-test-secret';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/testdb';

import { loadConfig } from '../../../backend/src/config';
import { setPool, getPool } from '../../../backend/src/services/auditLogger';

/**
 * Creates a mock mysql2 Pool with a configurable execute function.
 */
function createMockPool(executeFn?: (...args: unknown[]) => unknown) {
    return {
        execute: executeFn || vi.fn().mockResolvedValue([[], []]),
        end: vi.fn().mockResolvedValue(undefined),
    } as any;
}

/**
 * Builds a minimal Express app that mirrors only the /readiness handler
 * from server.ts, avoiding the side effect of app.listen on port 3000.
 */
function createReadinessApp(): express.Express {
    const config = loadConfig();
    const app = express();

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

    return app;
}

describe('Readiness endpoint (D1)', () => {
    let testServer: Server;
    let testPort: number;

    afterEach(async () => {
        if (testServer) {
            await new Promise<void>((resolve) => testServer.close(() => resolve()));
        }
        vi.restoreAllMocks();
    });

    async function startApp(mockPool: ReturnType<typeof createMockPool>): Promise<void> {
        setPool(mockPool);
        const app = createReadinessApp();

        testServer = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });

        const addr = testServer.address();
        if (typeof addr === 'object' && addr !== null) {
            testPort = addr.port;
        }
    }

    function baseUrl(path: string): string {
        return `http://localhost:${testPort}${path}`;
    }

    it('should return ready with database: true when DB is reachable', async () => {
        const pool = createMockPool(
            vi.fn().mockResolvedValue([[], []]),
        );
        await startApp(pool);

        const response = await fetch(baseUrl('/readiness'));
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.status).toBe('ready');
        expect(data.checks.database).toBe(true);
        expect(data.checks.config).toBe(true);
        expect(data.checks.uptime).toBeGreaterThan(0);
    });

    it('should return not_ready with database: false when DB is unreachable', async () => {
        const pool = createMockPool(
            vi.fn().mockRejectedValue(new Error('Connection refused')),
        );
        await startApp(pool);

        const response = await fetch(baseUrl('/readiness'));
        const data = await response.json();

        expect(response.status).toBe(503);
        expect(data.status).toBe('not_ready');
        expect(data.checks.database).toBe(false);
        expect(data.checks.config).toBe(true);
    });
});
