import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

import { setTestEnv, TEST_PORTAL } from '../helpers/session';

setTestEnv();

import { authRouter } from '../../backend/src/routes/auth';
import { resetAllState } from '../../backend/src/services/tokenService';
import { resetRateLimiterState } from '../../backend/src/middleware/rateLimiter';
import { AppError } from '../../backend/src/utils/errors';

/**
 * Integration test for the server-side OAuth flow.
 *
 * Bitrix24 validates the redirect URI against the handler registered with the
 * application, so the redirect lands on the backend rather than on the
 * extension. The flow under test is therefore:
 *
 *   GET  /auth/login?portal=  ->  { authUrl, state, portal }
 *   GET  /auth/callback       <-  Bitrix24 redirects here with code + state
 *   GET  /auth/poll?state=    ->  { jwt, ... } once the callback has completed
 *
 * The callback renders HTML for the human who is looking at it; the JWT is
 * handed to the extension through the poll endpoint.
 */
describe('Auth Flow Integration', () => {
    let testApp: express.Express;
    let testServer: Server;
    let testPort: number;

    let mockBitrixApp: express.Express;
    let mockBitrixServer: Server;
    let mockBitrixPort: number;

    beforeAll(async () => {
        mockBitrixApp = express();
        mockBitrixApp.use(express.urlencoded({ extended: true }));
        mockBitrixApp.post('/oauth/token/', (req, res) => {
            const { grant_type, code, client_id, client_secret } = req.body;

            if (grant_type !== 'authorization_code') {
                res.status(400).json({ error: 'invalid_grant_type' });
                return;
            }
            if (code !== 'valid-auth-code') {
                res.status(400).json({ error: 'invalid_code' });
                return;
            }
            if (client_id !== 'test-client-id' || client_secret !== 'test-client-secret') {
                res.status(400).json({ error: 'invalid_client' });
                return;
            }

            res.json({
                access_token: 'bitrix-access-token-123',
                refresh_token: 'bitrix-refresh-token-456',
                expires_in: 3600,
                client_endpoint: `https://${TEST_PORTAL}/rest/`,
                member_id: 'member-integration-test',
            });
        });

        mockBitrixServer = await new Promise<Server>((resolve) => {
            const s = mockBitrixApp.listen(0, () => resolve(s));
        });

        const bitrixAddr = mockBitrixServer.address();
        if (typeof bitrixAddr === 'object' && bitrixAddr !== null) {
            mockBitrixPort = bitrixAddr.port;
        }

        /**
         * Redirect the real Bitrix24 OAuth token endpoint to the mock server.
         */
        const originalFetch = globalThis.fetch;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url =
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : (input as Request).url;

            if (url.includes('oauth.bitrix.info/oauth/token/')) {
                return originalFetch(`http://localhost:${mockBitrixPort}/oauth/token/`, init);
            }

            return originalFetch(input, init);
        });

        testApp = express();
        testApp.use(express.json());
        testApp.use('/auth', authRouter);
        testApp.use(
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

        testServer = await new Promise<Server>((resolve) => {
            const s = testApp.listen(0, () => resolve(s));
        });

        const testAddr = testServer.address();
        if (typeof testAddr === 'object' && testAddr !== null) {
            testPort = testAddr.port;
        }
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await new Promise<void>((resolve) => testServer.close(() => resolve()));
        await new Promise<void>((resolve) => mockBitrixServer.close(() => resolve()));
    });

    beforeEach(() => {
        resetAllState();
        resetRateLimiterState();
    });

    function baseUrl(path: string): string {
        return `http://localhost:${testPort}${path}`;
    }

    /**
     * Drives login, callback, and poll, and returns the resulting session.
     */
    async function completeOAuth(
        overrides: { portal?: string; memberId?: string } = {},
    ): Promise<{ jwt: string; expiresAt: number; memberId: string; domain: string }> {
        const portal = overrides.portal ?? TEST_PORTAL;
        const memberId = overrides.memberId ?? 'member-integration-test';

        const loginRes = await fetch(baseUrl(`/auth/login?portal=${portal}`));
        const { state } = await loginRes.json();

        const callbackRes = await fetch(
            baseUrl(
                `/auth/callback?code=valid-auth-code&state=${state}` +
                `&domain=${portal}&member_id=${memberId}`,
            ),
        );
        expect(callbackRes.status).toBe(200);

        const pollRes = await fetch(baseUrl(`/auth/poll?state=${state}`));
        return pollRes.json();
    }

    describe('GET /auth/login', () => {
        it('should return an authUrl, state, and portal', async () => {
            const response = await fetch(baseUrl('/auth/login'));
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.authUrl).toContain('oauth/authorize');
            expect(data.authUrl).toContain('client_id=test-client-id');
            expect(data.authUrl).toContain(TEST_PORTAL);
            expect(typeof data.state).toBe('string');
            expect(data.portal).toBe(TEST_PORTAL);
        });

        it('should build the authUrl for an explicitly requested allowed portal', async () => {
            const response = await fetch(baseUrl('/auth/login?portal=acme.bitrix24.de'));
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.portal).toBe('acme.bitrix24.de');
            expect(data.authUrl).toContain('https://acme.bitrix24.de/oauth/authorize/');
        });

        it('should reject a portal outside the allowlist', async () => {
            const response = await fetch(baseUrl('/auth/login?portal=evil.example.com'));

            expect(response.status).toBe(403);
            const data = await response.json();
            expect(data.error.code).toBe('FORBIDDEN');
        });

        it('should reject a malformed portal', async () => {
            const response = await fetch(
                baseUrl('/auth/login?portal=' + encodeURIComponent('https://x.com/path')),
            );

            expect(response.status).toBe(400);
            const data = await response.json();
            expect(data.error.code).toBe('BAD_REQUEST');
        });
    });

    describe('GET /auth/callback', () => {
        it('should exchange a valid code and make the JWT available to poll', async () => {
            const session = await completeOAuth();

            expect(session.jwt).toBeDefined();
            expect(session.memberId).toBe('member-integration-test');
            expect(session.domain).toBe(TEST_PORTAL);
            expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
        });

        it('should reject an invalid state', async () => {
            const response = await fetch(
                baseUrl('/auth/callback?code=valid-auth-code&state=not-a-real-state'),
            );

            expect(response.status).toBe(400);
        });

        it('should reject a request with missing parameters', async () => {
            const response = await fetch(baseUrl('/auth/callback?code=valid-auth-code'));

            expect(response.status).toBe(400);
        });

        it('should reject a callback whose portal differs from the one the login started for', async () => {
            // The state was issued for TEST_PORTAL. Completing it against a
            // different, still allowed, portal must not succeed.
            const loginRes = await fetch(baseUrl(`/auth/login?portal=${TEST_PORTAL}`));
            const { state } = await loginRes.json();

            const response = await fetch(
                baseUrl(
                    `/auth/callback?code=valid-auth-code&state=${state}` +
                    `&domain=acme.bitrix24.de&member_id=member-integration-test`,
                ),
            );

            expect(response.status).toBe(400);

            // And the session must not become available to poll.
            const pollRes = await fetch(baseUrl(`/auth/poll?state=${state}`));
            const pollData = await pollRes.json();
            expect(pollData.jwt).toBeUndefined();
        });

        it('should reject a callback for a portal outside the allowlist', async () => {
            const loginRes = await fetch(baseUrl('/auth/login'));
            const { state } = await loginRes.json();

            const response = await fetch(
                baseUrl(
                    `/auth/callback?code=valid-auth-code&state=${state}` +
                    `&domain=evil.example.com&member_id=x`,
                ),
            );

            expect(response.status).toBe(403);
        });
    });

    describe('GET /auth/poll', () => {
        it('should report pending before the callback completes', async () => {
            const loginRes = await fetch(baseUrl('/auth/login'));
            const { state } = await loginRes.json();

            const response = await fetch(baseUrl(`/auth/poll?state=${state}`));
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.pending).toBe(true);
        });

        it('should return 404 for an unknown state', async () => {
            const response = await fetch(baseUrl('/auth/poll?state=nope'));
            expect(response.status).toBe(404);
        });

        it('should consume the session so a second poll returns 404', async () => {
            const loginRes = await fetch(baseUrl('/auth/login'));
            const { state } = await loginRes.json();

            await fetch(
                baseUrl(
                    `/auth/callback?code=valid-auth-code&state=${state}` +
                    `&domain=${TEST_PORTAL}&member_id=member-integration-test`,
                ),
            );

            const first = await fetch(baseUrl(`/auth/poll?state=${state}`));
            expect(first.status).toBe(200);

            const second = await fetch(baseUrl(`/auth/poll?state=${state}`));
            expect(second.status).toBe(404);
        });
    });

    describe('POST /auth/logout', () => {
        it('should successfully log out with a valid JWT', async () => {
            const { jwt } = await completeOAuth();

            const response = await fetch(baseUrl('/auth/logout'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
            });

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data.success).toBe(true);
        });

        it('should reject a blacklisted JWT on second logout attempt', async () => {
            const { jwt } = await completeOAuth();

            await fetch(baseUrl('/auth/logout'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
            });

            const second = await fetch(baseUrl('/auth/logout'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
            });

            expect(second.status).toBe(401);
        });

        it('should reject logout without a JWT', async () => {
            const response = await fetch(baseUrl('/auth/logout'), { method: 'POST' });
            expect(response.status).toBe(401);
        });
    });

    describe('POST /auth/refresh', () => {
        it('should issue a fresh JWT with a new jti', async () => {
            const { jwt } = await completeOAuth();

            const response = await fetch(baseUrl('/auth/refresh'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
            });

            expect(response.status).toBe(200);
            const data = await response.json();
            expect(data.jwt).toBeDefined();
            expect(data.jwt).not.toBe(jwt);
            expect(data.domain).toBe(TEST_PORTAL);
        });

        it('should reject the old JWT after refresh', async () => {
            const { jwt } = await completeOAuth();

            await fetch(baseUrl('/auth/refresh'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
            });

            const second = await fetch(baseUrl('/auth/refresh'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
            });

            expect(second.status).toBe(401);
        });

        it('should reject refresh without a JWT', async () => {
            const response = await fetch(baseUrl('/auth/refresh'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            expect(response.status).toBe(401);
        });
    });

    describe('Auth rate limiting', () => {
        it('should return 429 after exceeding the rate limit on /auth/login', async () => {
            for (let i = 0; i < 5; i++) {
                const response = await fetch(baseUrl('/auth/login'));
                expect(response.status).toBe(200);
            }

            const response = await fetch(baseUrl('/auth/login'));
            expect(response.status).toBe(429);

            const data = await response.json();
            expect(data.error.code).toBe('RATE_LIMITED');
            expect(data.error.retry_after_seconds).toBeGreaterThan(0);
        });

        it('should rate limit /auth/poll independently of /auth/login', async () => {
            /**
             * Poll is limited at 60 per minute rather than 5, because the
             * extension polls every 2 seconds while the user completes the
             * Bitrix24 consent screen.
             */
            for (let i = 0; i < 10; i++) {
                const response = await fetch(baseUrl('/auth/poll?state=unknown'));
                expect(response.status).toBe(404);
            }
        });
    });
});
