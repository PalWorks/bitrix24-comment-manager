import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/**
 * Mock environment variables before importing app modules.
 */
process.env.JWT_SECRET = 'integration-test-secret';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
process.env.MAX_COMMENT_LENGTH = '5000';
process.env.DUPLICATE_WINDOW_SECONDS = '300';

import { commentsRouter } from '../../backend/src/routes/comments';
import { authRouter } from '../../backend/src/routes/auth';
import { AppError } from '../../backend/src/utils/errors';
import { createSession } from '../helpers/session';
import { resetRateLimiterState } from '../../backend/src/middleware/rateLimiter';
import { resetDuplicateState } from '../../backend/src/middleware/commentValidator';

/**
 * Integration test: spins up the comment routes on a test Express server
 * alongside a mock Bitrix24 API. Tests full create/edit/delete flows,
 * validation, rate limiting, and duplicate rejection.
 */
describe('Comment CRUD Integration', () => {
    let testApp: express.Express;
    let testServer: Server;
    let testPort: number;

    let mockBitrixApp: express.Express;
    let mockBitrixServer: Server;
    let mockBitrixPort: number;

    let validJwt: string;

    const testLeadId = '12345';
    const testCommentId = '99001';

    let failNextCommentAdd = false;

    beforeAll(async () => {
        /**
         * Mock Bitrix24 REST API and OAuth token endpoint.
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
                    member_id: 'member-comment-test',
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
            res.json({
                result: { ID: testLeadId, TITLE: 'Test Lead' },
            });
        });

        // Lets one test make the far end fail exactly once, which is what a
        // dropped connection looks like from here.
        mockBitrixApp.post('/rest/crm.timeline.comment.add', (_req, res) => {
            if (failNextCommentAdd) {
                failNextCommentAdd = false;
                res.status(500).json({ error: 'INTERNAL', error_description: 'portal unavailable' });
                return;
            }
            res.json({ result: testCommentId });
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
         * Patch global fetch to redirect Bitrix24 API calls to our mock server.
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
         * Set up the test Express app with auth and comment routes plus error handler.
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

        /**
         * Mint an authenticated session pointed at the mock Bitrix server.
         */
        const session = await createSession({
            memberId: 'member-comment-test',
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

    describe('POST /api/comments (Create)', () => {
        it('should create a comment successfully', async () => {
            const response = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: 'Test comment for integration test.',
                }),
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.comment_id).toBe(String(testCommentId));
            expect(data.lead_id).toBe(testLeadId);
            expect(data.action).toBe('CREATE');
            expect(data.timestamp).toBeDefined();
        });

        it('should reject a request without authentication', async () => {
            const response = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: 'No auth comment.',
                }),
            });

            expect(response.status).toBe(401);
        });

        it('should reject an empty comment body', async () => {
            const response = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: '',
                }),
            });

            expect(response.status).toBe(400);
        });

        it('should reject a duplicate comment within the dedup window', async () => {
            const body = {
                lead_id: testLeadId,
                comment_body: 'Duplicate test comment for integration.',
            };

            const first = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body),
            });
            expect(first.status).toBe(200);

            const second = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body),
            });
            expect(second.status).toBe(409);

            const secondData = await second.json();
            expect(secondData.error.code).toBe('DUPLICATE');
        });

        it('lets an agent retry a comment that failed to reach Bitrix24', async () => {
            // The duplicate claim is made before the comment is sent, so that
            // two requests in flight together cannot both pass. But when the
            // send fails, nothing was posted, and the retry is a first attempt
            // rather than a repeat. Holding the claim would leave the agent
            // blocked by our record of an attempt that never landed, which is
            // precisely what a slow or dropped connection produces.
            const body = {
                lead_id: testLeadId,
                comment_body: 'This one fails on the way out, then succeeds.',
            };

            failNextCommentAdd = true;

            const failed = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body),
            });
            expect(failed.status).toBeGreaterThanOrEqual(400);

            const retry = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body),
            });

            expect(retry.status).toBe(200);
            const retryData = await retry.json();
            expect(retryData.success).toBe(true);
        });

        it('still rejects a genuine repeat after a successful post', async () => {
            // The release must be scoped to the failure. A successful comment
            // still holds its claim for the dedup window.
            const body = {
                lead_id: testLeadId,
                comment_body: 'Posted once, and only once.',
            };

            const first = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body),
            });
            expect(first.status).toBe(200);

            const second = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body),
            });
            expect(second.status).toBe(409);
        });

        it('should reject when rate limited', async () => {
            resetRateLimiterState();

            for (let i = 0; i < 10; i++) {
                await fetch(baseUrl('/api/comments'), {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        lead_id: testLeadId,
                        comment_body: `Rate limit comment ${i} ${Date.now()}`,
                    }),
                });
            }

            const response = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: `Rate limit overflow ${Date.now()}`,
                }),
            });

            expect(response.status).toBe(429);
            const data = await response.json();
            expect(data.error.code).toBe('RATE_LIMITED');
            expect(data.error.retry_after_seconds).toBeGreaterThan(0);
        });
    });

    describe('PUT /api/comments/:id (Edit)', () => {
        it('should edit a comment successfully', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: 'Updated comment body for integration test.',
                }),
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.comment_id).toBe(String(testCommentId));
            expect(data.action).toBe('EDIT');
            expect(data.timestamp).toBeDefined();
        });

        it('should reject edit without authentication', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comment_body: 'Unauthorized edit.' }),
            });

            expect(response.status).toBe(401);
        });

        it('should reject edit with empty body', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify({ comment_body: '' }),
            });

            expect(response.status).toBe(400);
        });
    });

    describe('DELETE /api/comments/:id (Delete)', () => {
        it('should delete a comment successfully', async () => {
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
            expect(data.comment_id).toBe(String(testCommentId));
            expect(data.action).toBe('DELETE');
            expect(data.timestamp).toBeDefined();
        });

        it('should reject delete without authentication', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
            });

            expect(response.status).toBe(401);
        });
    });
});
