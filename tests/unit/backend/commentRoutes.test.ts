import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/**
 * Mock environment variables before importing app modules.
 */
process.env.JWT_SECRET = 'test-secret-for-comment-routes';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
process.env.MAX_COMMENT_LENGTH = '5000';
process.env.DUPLICATE_WINDOW_SECONDS = '300';

import { commentsRouter } from '../../../backend/src/routes/comments';
import { authRouter } from '../../../backend/src/routes/auth';
import { AppError } from '../../../backend/src/utils/errors';
import { createSession } from '../../helpers/session';
import { resetRateLimiterState } from '../../../backend/src/middleware/rateLimiter';
import { resetDuplicateState } from '../../../backend/src/middleware/commentValidator';

/**
 * Tests for B1: Verifies that PUT and DELETE comment routes
 * reject requests that omit lead_id from the request body.
 */
describe('Comment Routes: lead_id Validation (B1)', () => {
    let testApp: express.Express;
    let testServer: Server;
    let testPort: number;

    let mockBitrixApp: express.Express;
    let mockBitrixServer: Server;
    let mockBitrixPort: number;

    let validJwt: string;

    const testLeadId = '12345';
    const testCommentId = '99001';

    beforeAll(async () => {
        /**
         * Spin up a mock Bitrix24 REST API.
         */
        mockBitrixApp = express();
        mockBitrixApp.use(express.json());
        mockBitrixApp.use(express.urlencoded({ extended: true }));

        mockBitrixApp.post('/oauth/token/', (req, res) => {
            const { grant_type, code, client_id, client_secret } = req.body;
            if (grant_type === 'authorization_code') {
                if (code !== 'valid-auth-code' || client_id !== 'test-client-id' || client_secret !== 'test-client-secret') {
                    res.status(400).json({ error: 'invalid_request' });
                    return;
                }
                res.json({
                    access_token: 'mock-access-token',
                    refresh_token: 'mock-refresh-token',
                    expires_in: 3600,
                    client_endpoint: `http://localhost:BITRIX_PORT/rest/`,
                    member_id: 'member-b1-test',
                });
                return;
            }
            if (grant_type === 'refresh_token') {
                res.json({
                    access_token: 'mock-refreshed-access-token',
                    refresh_token: 'mock-new-refresh-token',
                    expires_in: 3600,
                });
                return;
            }
            res.status(400).json({ error: 'invalid_grant_type' });
        });

        mockBitrixApp.post('/rest/crm.lead.get', (_req, res) => {
            res.json({ result: { ID: testLeadId, TITLE: 'Test Lead' } });
        });

        mockBitrixApp.post('/rest/crm.timeline.comment.update', (_req, res) => {
            res.json({ result: true });
        });

        mockBitrixApp.post('/rest/crm.timeline.comment.delete', (_req, res) => {
            res.json({ result: true });
        });

        mockBitrixServer = await new Promise<Server>((resolve) => {
            const s = mockBitrixApp.listen(0, () => resolve(s));
        });

        const bitrixAddr = mockBitrixServer.address();
        if (typeof bitrixAddr === 'object' && bitrixAddr !== null) {
            mockBitrixPort = bitrixAddr.port;
        }

        /**
         * Patch global fetch to redirect Bitrix24 API calls.
         */
        const originalFetch = globalThis.fetch;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
            if (url.includes('oauth.bitrix.info/oauth/token/')) {
                return originalFetch(`http://localhost:${mockBitrixPort}/oauth/token/`, init);
            }
            if (url.includes('/rest/')) {
                const path = url.replace(/https?:\/\/[^/]+/, '');
                return originalFetch(`http://localhost:${mockBitrixPort}${path}`, init);
            }
            return originalFetch(input, init);
        });

        /**
         * Set up the test Express app.
         */
        testApp = express();
        testApp.use(express.json());
        testApp.use('/auth', authRouter);
        testApp.use('/api/comments', commentsRouter);
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

        const session = await createSession({
            memberId: 'member-b1-test',
            clientEndpoint: `http://localhost:${mockBitrixPort}/rest/`,
            accessToken: 'mock-access-token',
            refreshToken: 'mock-refresh-token',
        });
        validJwt = session.jwt;
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await new Promise<void>((resolve) => testServer.close(() => resolve()));
        await new Promise<void>((resolve) => mockBitrixServer.close(() => resolve()));
    });

    beforeEach(() => {
        resetRateLimiterState();
        resetDuplicateState();
    });

    function baseUrl(path: string): string {
        return `http://localhost:${testPort}${path}`;
    }

    function authHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${validJwt}`,
        };
    }

    describe('PUT /api/comments/:id without lead_id', () => {
        it('should return 400 BAD_REQUEST when lead_id is missing from body', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify({
                    comment_body: 'Updated comment without lead_id.',
                }),
            });
            const data = await response.json();

            expect(response.status).toBe(400);
            expect(data.error.code).toBe('BAD_REQUEST');
            expect(data.error.message).toContain('lead_id is required');
        });

        it('should succeed when lead_id is provided in body', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: 'Updated comment with lead_id.',
                }),
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.action).toBe('EDIT');
        });
    });

    describe('DELETE /api/comments/:id without lead_id', () => {
        it('should return 400 BAD_REQUEST when lead_id is missing from body', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'DELETE',
                headers: authHeaders(),
            });
            const data = await response.json();

            expect(response.status).toBe(400);
            expect(data.error.code).toBe('BAD_REQUEST');
            expect(data.error.message).toContain('lead_id is required');
        });

        it('should succeed when lead_id is provided in body', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'DELETE',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                }),
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.action).toBe('DELETE');
        });
    });
});
