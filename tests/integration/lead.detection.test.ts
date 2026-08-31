import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/**
 * Mock environment variables before importing app modules.
 */
process.env.JWT_SECRET = 'lead-integration-test-secret';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';

import { leadsRouter } from '../../backend/src/routes/leads';
import { authRouter } from '../../backend/src/routes/auth';
import {
    resetAllState,
    } from '../../backend/src/services/tokenService';
import { AppError } from '../../backend/src/utils/errors';
import { createSession } from '../helpers/session';
import { resetRateLimiterState } from '../../backend/src/middleware/rateLimiter';

/**
 * Integration tests for the GET /api/leads/:leadId endpoint.
 * Spins up a test server with auth and leads routes, plus a mock Bitrix24 API.
 */
describe('Lead Detection Integration', () => {
    let testApp: express.Express;
    let testServer: Server;
    let testPort: number;

    let mockBitrixApp: express.Express;
    let mockBitrixServer: Server;
    let mockBitrixPort: number;

    beforeAll(async () => {
        /**
         * Set up the mock Bitrix24 REST API.
         */
        mockBitrixApp = express();
        mockBitrixApp.use(express.json());

        mockBitrixApp.post('/rest/crm.lead.get', (req, res) => {
            const { id, auth } = req.body;

            if (!auth || auth === 'expired-token') {
                res.status(401).json({ error: 'INVALID_TOKEN' });
                return;
            }

            if (id === '999') {
                res.json({
                    error: 'NOT_FOUND',
                    error_description: 'Not found',
                });
                return;
            }

            if (id === '123') {
                res.json({
                    result: {
                        ID: '123',
                        TITLE: 'Test Lead Alpha',
                        STATUS_ID: 'NEW',
                    },
                });
                return;
            }

            res.json({
                result: {
                    ID: id,
                    TITLE: `Lead ${id}`,
                    STATUS_ID: 'IN_PROCESS',
                },
            });
        });

        /**
         * Mock Bitrix24 OAuth token refresh endpoint.
         */
        mockBitrixApp.post('/oauth/token/', express.urlencoded({ extended: true }), (req, res) => {
            if (req.body.grant_type === 'refresh_token') {
                res.json({
                    access_token: 'refreshed-access-token',
                    refresh_token: 'refreshed-refresh-token',
                    expires_in: 3600,
                });
                return;
            }

            if (req.body.grant_type === 'authorization_code') {
                res.json({
                    access_token: 'bitrix-access-token',
                    refresh_token: 'bitrix-refresh-token',
                    expires_in: 3600,
                    client_endpoint: `http://localhost:${mockBitrixPort}/rest/`,
                    member_id: 'test-member',
                });
                return;
            }

            res.status(400).json({ error: 'invalid_grant_type' });
        });

        mockBitrixServer = await new Promise<Server>((resolve) => {
            const s = mockBitrixApp.listen(0, () => resolve(s));
        });

        const bitrixAddr = mockBitrixServer.address();
        if (typeof bitrixAddr === 'object' && bitrixAddr !== null) {
            mockBitrixPort = bitrixAddr.port;
        }

        /**
         * Patch global fetch to intercept Bitrix24 API calls.
         */
        const originalFetch = globalThis.fetch;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

            if (url.includes('oauth.bitrix.info/oauth/token/')) {
                const mockUrl = `http://localhost:${mockBitrixPort}/oauth/token/`;
                return originalFetch(mockUrl, init);
            }

            if (url.includes('/rest/crm.lead.get') || url.includes('/crm.lead.get')) {
                const mockUrl = `http://localhost:${mockBitrixPort}/rest/crm.lead.get`;
                return originalFetch(mockUrl, init);
            }

            return originalFetch(input, init);
        });

        /**
         * Set up the test Express app with error handling.
         */
        testApp = express();
        testApp.use(express.json());
        testApp.use('/auth', authRouter);
        testApp.use('/api/leads', leadsRouter);
        testApp.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            if (err instanceof AppError) {
                res.status(err.statusCode).json(err.toResponse());
                return;
            }
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        });

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
     * Helper: mints an authenticated session and returns its JWT.
     */
    async function getValidJwt(): Promise<string> {
        const session = await createSession({
            memberId: 'test-member',
            clientEndpoint: `http://localhost:${mockBitrixPort}/rest/`,
        });
        return session.jwt;
    }

    describe('GET /api/leads/:leadId', () => {
        it('should return lead info for a valid lead ID', async () => {
            const jwt = await getValidJwt();

            const response = await fetch(baseUrl('/api/leads/123'), {
                headers: { Authorization: `Bearer ${jwt}` },
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.lead_id).toBe('123');
            expect(data.lead_name).toBe('Test Lead Alpha');
            expect(data.exists).toBe(true);
        });

        it('should return 404 for a non-existent lead', async () => {
            const jwt = await getValidJwt();

            const response = await fetch(baseUrl('/api/leads/999'), {
                headers: { Authorization: `Bearer ${jwt}` },
            });

            expect(response.status).toBe(404);
        });

        it('should return 401 without authorization header', async () => {
            const response = await fetch(baseUrl('/api/leads/123'));

            expect(response.status).toBe(401);
        });

        it('should return 400 for a non-numeric lead ID', async () => {
            const jwt = await getValidJwt();

            const response = await fetch(baseUrl('/api/leads/abc'), {
                headers: { Authorization: `Bearer ${jwt}` },
            });

            expect(response.status).toBe(400);
        });

        it('should return lead info for any valid numeric lead ID', async () => {
            const jwt = await getValidJwt();

            const response = await fetch(baseUrl('/api/leads/456'), {
                headers: { Authorization: `Bearer ${jwt}` },
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.lead_id).toBe('456');
            expect(data.lead_name).toBe('Lead 456');
            expect(data.exists).toBe(true);
        });
    });
});
