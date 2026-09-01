import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/**
 * Client identification behind a reverse proxy.
 *
 * Every deployment of this backend sits behind something that terminates TLS,
 * so req.ip is the proxy unless Express is told how many hops to skip. Left at
 * the default, the per IP rate limiters collapse into one shared bucket: the
 * first three visitors of the hour consume the whole budget and everyone after
 * them is refused, while an individual abuser is never singled out.
 *
 * These tests pin both halves. With the hop count set, distinct clients are
 * limited separately. Without it, they are not, which is the failure the
 * setting exists to prevent.
 */

process.env.JWT_SECRET = 'trust-proxy-test-secret';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.SUPPORT_FROM_EMAIL = 'Support <support@example.com>';
process.env.SUPPORT_TO_EMAIL = 'inbox@example.com';

import { supportRouter, resetSupportConfig } from '../../backend/src/routes/support';
import { AppError } from '../../backend/src/utils/errors';
import { resetRateLimiterState } from '../../backend/src/middleware/rateLimiter';

let realFetch: typeof globalThis.fetch;

/** One app per test, so the trust setting can differ between them. */
function buildApp(trustProxy: number): express.Express {
    const app = express();
    app.set('trust proxy', trustProxy);
    app.use('/support', supportRouter);
    app.use(
        (
            err: Error,
            _req: express.Request,
            res: express.Response,
            _next: express.NextFunction,
        ) => {
            if (err instanceof AppError) {
                res.status(err.statusCode).json(err.toResponse());
                return;
            }
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        },
    );
    return app;
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
    const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}` };
}

function body(seed: number) {
    return {
        name: 'Jane Cooper',
        email: 'reporter@example.com',
        category: 'bug' as const,
        message: `A distinct enough report to pass validation, number ${seed}.`,
    };
}

/** Posts as a client whose address the proxy recorded in X-Forwarded-For. */
async function postAs(url: string, clientIp: string, seed: number): Promise<number> {
    const response = await realFetch(`${url}/support`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // What a single proxy in front of this server would send.
            'X-Forwarded-For': clientIp,
        },
        body: JSON.stringify(body(seed)),
    });
    return response.status;
}

describe('rate limiting behind a reverse proxy', () => {
    const servers: Server[] = [];

    beforeAll(() => {
        realFetch = globalThis.fetch.bind(globalThis);
        resetSupportConfig();
    });

    afterAll(async () => {
        for (const server of servers) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    beforeEach(() => {
        resetRateLimiterState();
        const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
            if (String(input).startsWith('https://api.resend.com/')) {
                return { ok: true, status: 200, text: async () => '{"id":"stub"}' } as unknown as Response;
            }
            return realFetch(input as RequestInfo, init);
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        resetRateLimiterState();
    });

    it('limits each client separately when the hop count is set', async () => {
        const { server, url } = await listen(buildApp(1));
        servers.push(server);

        // One client spends its whole budget.
        for (let i = 0; i < 3; i += 1) {
            expect(await postAs(url, '203.0.113.10', i)).toBe(202);
        }
        expect(await postAs(url, '203.0.113.10', 99)).toBe(429);

        // A different client is untouched by it.
        expect(await postAs(url, '198.51.100.20', 0)).toBe(202);
    });

    it('collapses every client into one bucket when it is not set', async () => {
        const { server, url } = await listen(buildApp(0));
        servers.push(server);

        for (let i = 0; i < 3; i += 1) {
            expect(await postAs(url, `203.0.113.${i}`, i)).toBe(202);
        }

        // A fourth, entirely separate client is refused for traffic that was
        // never theirs. This is the misbehaviour TRUST_PROXY exists to fix.
        expect(await postAs(url, '198.51.100.20', 4)).toBe(429);
    });

    it('ignores addresses a client prepends beyond the trusted hop count', async () => {
        const { server, url } = await listen(buildApp(1));
        servers.push(server);

        // The proxy appends the real address on the right. Anything the client
        // wrote itself sits to the left of it and must not be read.
        const spoofed = async (forged: string, seed: number) => {
            const response = await realFetch(`${url}/support`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Forwarded-For': `${forged}, 203.0.113.77`,
                },
                body: JSON.stringify(body(seed)),
            });
            return response.status;
        };

        // Three requests, each claiming a different forged origin, all actually
        // from 203.0.113.77. They share one budget because the forged entries
        // are never reached.
        expect(await spoofed('1.1.1.1', 1)).toBe(202);
        expect(await spoofed('2.2.2.2', 2)).toBe(202);
        expect(await spoofed('3.3.3.3', 3)).toBe(202);
        expect(await spoofed('4.4.4.4', 4)).toBe(429);
    });
});
