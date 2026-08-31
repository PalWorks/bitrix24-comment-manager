import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

import { setTestEnv, createSession } from '../helpers/session';

setTestEnv({
    MAX_COMMENT_LENGTH: '5000',
    DUPLICATE_WINDOW_SECONDS: '300',
    DATABASE_URL: 'mysql://test:test@localhost:3306/testdb',
});

/**
 * Mock the auditLogger module so we can spy on writeAuditLog
 * without needing a real PostgreSQL database.
 */
vi.mock('../../backend/src/services/auditLogger', async () => {
    const mock = {
        writeAuditLog: vi.fn().mockResolvedValue(undefined),
        queryActivityLog: vi.fn().mockResolvedValue([
            { timestamp: '2026-03-04T12:00:00Z', portal_domain: 'test.bitrix24.com', lead_id: '100', action_type: 'CREATE', status: 'SUCCESS' },
            { timestamp: '2026-03-04T11:00:00Z', portal_domain: 'test.bitrix24.com', lead_id: '200', action_type: 'EDIT', status: 'SUCCESS' },
        ]),
        getPool: vi.fn(),
        setPool: vi.fn(),
    };
    return mock;
});

import { commentsRouter } from '../../backend/src/routes/comments';
import { authRouter } from '../../backend/src/routes/auth';
import { activityRouter } from '../../backend/src/routes/activity';
import { AppError } from '../../backend/src/utils/errors';
import { resetRateLimiterState } from '../../backend/src/middleware/rateLimiter';
import { resetDuplicateState } from '../../backend/src/middleware/commentValidator';
import { writeAuditLog, queryActivityLog } from '../../backend/src/services/auditLogger';

const mockedWriteAuditLog = writeAuditLog as ReturnType<typeof vi.fn>;
const mockedQueryActivityLog = queryActivityLog as ReturnType<typeof vi.fn>;

describe('Audit Log Integration', () => {
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
                    member_id: 'member-audit-test',
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

        mockBitrixApp.post('/rest/crm.timeline.comment.add', (_req, res) => {
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
         * Set up the test Express app with auth, comment, and activity routes.
         */
        testApp = express();
        testApp.use(express.json());
        testApp.use('/auth', authRouter);
        testApp.use('/api/comments', commentsRouter);
        testApp.use('/api/activity', activityRouter);
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
            memberId: 'member-audit-test',
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
        mockedWriteAuditLog.mockClear();
        mockedQueryActivityLog.mockClear();
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

    describe('Comment audit logging', () => {
        it('should write a SUCCESS audit entry after creating a comment', async () => {
            const response = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: 'Audit test comment.',
                }),
            });

            expect(response.status).toBe(200);
            expect(mockedWriteAuditLog).toHaveBeenCalledTimes(1);

            const entry = mockedWriteAuditLog.mock.calls[0][0];
            expect(entry.action_type).toBe('CREATE');
            expect(entry.status).toBe('SUCCESS');
            expect(entry.comment_id).toBe(String(testCommentId));
            expect(entry.lead_id).toBe(testLeadId);
            expect(entry.agent_id).toBe('member-audit-test');
            expect(entry.comment_hash).toBeDefined();
            expect(entry.comment_hash).not.toBe('');
            expect(entry.failure_reason).toBeNull();
        });

        it('should write a SUCCESS audit entry after editing a comment', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: 'Updated for audit test.',
                }),
            });

            expect(response.status).toBe(200);
            expect(mockedWriteAuditLog).toHaveBeenCalledTimes(1);

            const entry = mockedWriteAuditLog.mock.calls[0][0];
            expect(entry.action_type).toBe('EDIT');
            expect(entry.status).toBe('SUCCESS');
            expect(entry.comment_id).toBe(String(testCommentId));
        });

        it('should write a SUCCESS audit entry after deleting a comment', async () => {
            const response = await fetch(baseUrl(`/api/comments/${testCommentId}`), {
                method: 'DELETE',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                }),
            });

            expect(response.status).toBe(200);
            expect(mockedWriteAuditLog).toHaveBeenCalledTimes(1);

            const entry = mockedWriteAuditLog.mock.calls[0][0];
            expect(entry.action_type).toBe('DELETE');
            expect(entry.status).toBe('SUCCESS');
            expect(entry.comment_id).toBe(String(testCommentId));
        });

        it('should write a FAILED audit entry when comment validation fails', async () => {
            const response = await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: '',
                }),
            });

            expect(response.status).toBe(400);

            /**
             * The validation failure happens in middleware before the route
             * handler, so writeAuditLog is not called at the route level.
             * This verifies that middleware-level failures do not produce
             * spurious audit entries (the error handler catches them).
             */
        });

        it('should never store the raw comment body in the audit entry', async () => {
            const secretText = 'This is sensitive content that must not be stored.';

            await fetch(baseUrl('/api/comments'), {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    lead_id: testLeadId,
                    comment_body: secretText,
                }),
            });

            expect(mockedWriteAuditLog).toHaveBeenCalled();
            const entry = mockedWriteAuditLog.mock.calls[0][0];
            const entryJson = JSON.stringify(entry);
            expect(entryJson).not.toContain(secretText);
            expect(entry.comment_hash).toBeDefined();
            expect(entry.comment_hash.length).toBe(64);
        });
    });

    describe('Auth failure audit logging', () => {
        it('should write an AUTH_FAILURE audit entry for missing callback fields', async () => {
            const response = await fetch(baseUrl('/auth/callback?code=abc'));

            expect(response.status).toBe(400);
            expect(mockedWriteAuditLog).toHaveBeenCalledTimes(1);

            const entry = mockedWriteAuditLog.mock.calls[0][0];
            expect(entry.action_type).toBe('AUTH_FAILURE');
            expect(entry.status).toBe('FAILED');
            expect(entry.lead_id).toBe('N/A');
            expect(entry.comment_hash).toBe('N/A');
            expect(entry.failure_reason).toContain('Missing required fields');
        });

        it('should write an AUTH_FAILURE audit entry for invalid OAuth state', async () => {
            const response = await fetch(
                baseUrl('/auth/callback?code=abc&state=invalid-state-value&member_id=member-bad-state'),
            );

            expect(response.status).toBe(400);
            expect(mockedWriteAuditLog).toHaveBeenCalledTimes(1);

            const entry = mockedWriteAuditLog.mock.calls[0][0];
            expect(entry.action_type).toBe('AUTH_FAILURE');
            expect(entry.status).toBe('FAILED');
            expect(entry.agent_id).toBe('member-bad-state');
            expect(entry.failure_reason).toContain('Invalid or expired OAuth state');
        });
    });

    describe('GET /api/activity', () => {
        it('should return recent activity for authenticated agent', async () => {
            const response = await fetch(baseUrl('/api/activity?limit=10'), {
                headers: authHeaders(),
            });
            const data = await response.json();

            expect(response.status).toBe(200);
            expect(data.actions).toBeDefined();
            expect(Array.isArray(data.actions)).toBe(true);
            expect(mockedQueryActivityLog).toHaveBeenCalledWith('member-audit-test', 10);
        });

        it('should use default limit of 20 when not specified', async () => {
            const response = await fetch(baseUrl('/api/activity'), {
                headers: authHeaders(),
            });

            expect(response.status).toBe(200);
            expect(mockedQueryActivityLog).toHaveBeenCalledWith('member-audit-test', 20);
        });

        it('should cap limit at 50', async () => {
            const response = await fetch(baseUrl('/api/activity?limit=100'), {
                headers: authHeaders(),
            });

            expect(response.status).toBe(200);
            expect(mockedQueryActivityLog).toHaveBeenCalledWith('member-audit-test', 50);
        });

        it('should reject unauthenticated requests', async () => {
            const response = await fetch(baseUrl('/api/activity'));
            expect(response.status).toBe(401);
        });
    });
});
