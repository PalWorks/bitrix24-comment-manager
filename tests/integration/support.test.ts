import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/**
 * Integration test for the public support endpoint.
 *
 * The endpoint is unauthenticated and causes an outbound email, so most of what
 * is asserted here is refusal: what it will not accept, and what it will not
 * let a caller control. The Resend call itself is stubbed at the fetch layer,
 * which is also how the test proves the request Resend would receive never
 * carries a caller supplied recipient.
 */

process.env.JWT_SECRET = 'support-test-secret';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.SUPPORT_FROM_EMAIL = 'Support <support@example.com>';
process.env.SUPPORT_TO_EMAIL = 'inbox@example.com';
process.env.SUPPORT_MAX_ATTACHMENT_BYTES = String(1024 * 1024);

import { supportRouter, resetSupportConfig } from '../../backend/src/routes/support';
import { AppError } from '../../backend/src/utils/errors';
import { resetRateLimiterState } from '../../backend/src/middleware/rateLimiter';

const PNG_BASE64 = Buffer.from('fake png bytes').toString('base64');

function buildApp(): express.Express {
    const app = express();
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

interface TestResponse {
    status: number;
    body: Record<string, unknown>;
}

/**
 * The suite makes real HTTP requests to a real server while stubbing only the
 * outbound Resend call, so the route's own body parsing and limits are the ones
 * under test rather than a mock's.
 */
let realFetch: typeof globalThis.fetch;
let baseUrl: string;

async function post(body: unknown): Promise<TestResponse> {
    const response = await realFetch(`${baseUrl}/support`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getConfig(): Promise<TestResponse> {
    const response = await realFetch(`${baseUrl}/support/config`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function validBody(overrides: Record<string, unknown> = {}) {
    return {
        email: 'reporter@example.com',
        category: 'bug',
        message: 'The popup does not open on a lead page.',
        context: { extensionVersion: '2.0.0' },
        ...overrides,
    };
}

describe('Support endpoint', () => {
    let server: Server;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        // The env above is assigned after the imports, which ESM hoists, so the
        // router's cached config must be dropped before the first request.
        resetSupportConfig();
        realFetch = globalThis.fetch.bind(globalThis);
        server = await new Promise<Server>((resolve) => {
            const s = buildApp().listen(0, () => resolve(s));
        });
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
        resetRateLimiterState();

        // Only the Resend call is stubbed. Anything else, including the test's
        // own requests to the server under test, goes out for real.
        fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
            const url = String(
                typeof input === 'string' || input instanceof URL ? input : (input as Request).url,
            );
            if (url.startsWith('https://api.resend.com/')) {
                return {
                    ok: true,
                    status: 200,
                    text: async () => '{"id":"stub"}',
                } as unknown as Response;
            }
            return realFetch(input as RequestInfo, init);
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        resetRateLimiterState();
    });

    /** Calls to Resend only, filtering out the suite's own inbound requests. */
    function resendCalls(): unknown[][] {
        return fetchMock.mock.calls.filter(([input]) =>
            String(input).startsWith('https://api.resend.com/'),
        );
    }

    /** The JSON body Resend would have received on the most recent send. */
    function lastResendPayload(): Record<string, unknown> {
        const call = resendCalls().at(-1);
        return JSON.parse((call?.[1] as { body: string }).body) as Record<string, unknown>;
    }

    describe('acceptance', () => {
        it('accepts a well formed message and calls Resend once', async () => {
            const response = await post(validBody());

            expect(response.status).toBe(202);
            expect(response.body).toEqual({ success: true });
            expect(resendCalls()).toHaveLength(1);
            expect(resendCalls()[0][0]).toBe('https://api.resend.com/emails');
        });

        it('accepts an attachment within the size limit', async () => {
            const response = await post(
                    validBody({
                        attachment: {
                            filename: 'screenshot.png',
                            contentType: 'image/png',
                            content: PNG_BASE64,
                        },
                    }),
                );

            expect(response.status).toBe(202);

            const payload = lastResendPayload();
            expect(payload.attachments).toEqual([
                { filename: 'screenshot.png', content: PNG_BASE64, content_type: 'image/png' },
            ]);
        });

        it('accepts the hosting waitlist category', async () => {
            const response = await post(validBody({ category: 'hosting-waitlist' }));

            expect(response.status).toBe(202);
        });
    });

    describe('recipient control', () => {
        it('sends from and to the configured addresses, never the request body', async () => {
            await post(
                    validBody({
                        to: 'victim@elsewhere.test',
                        from: 'spoofed@elsewhere.test',
                        reply_to: 'victim@elsewhere.test',
                    }),
                );

            const payload = lastResendPayload();
            expect(payload.from).toBe('Support <support@example.com>');
            expect(payload.to).toEqual(['inbox@example.com']);
            expect(payload.reply_to).toBe('reporter@example.com');
        });

        it('escapes the message so a report cannot inject markup into the email', async () => {
            await post(validBody({ message: 'Broken <img src=x onerror=alert(1)> here' }));

            const payload = lastResendPayload();
            expect(payload.html).not.toContain('<img');
            expect(payload.html).toContain('&lt;img');
        });
    });

    describe('validation', () => {
        it('rejects a missing email', async () => {
            const response = await post(validBody({ email: undefined }));

            expect(response.status).toBe(400);
            expect(resendCalls()).toHaveLength(0);
        });

        it('rejects a malformed email', async () => {
            const response = await post(validBody({ email: 'not-an-address' }));

            expect(response.status).toBe(400);
        });

        it('rejects an unknown category', async () => {
            const response = await post(validBody({ category: 'anything-goes' }));

            expect(response.status).toBe(400);
        });

        it('rejects a message that is too short', async () => {
            const response = await post(validBody({ message: 'help' }));

            expect(response.status).toBe(400);
        });

        it('rejects a message over the length limit', async () => {
            const response = await post(validBody({ message: 'x'.repeat(5001) }));

            expect(response.status).toBe(400);
        });
    });

    describe('attachments', () => {
        it('rejects a disallowed content type', async () => {
            const response = await post(
                    validBody({
                        attachment: {
                            filename: 'payload.exe',
                            contentType: 'application/x-msdownload',
                            content: PNG_BASE64,
                        },
                    }),
                );

            expect(response.status).toBe(400);
            expect(resendCalls()).toHaveLength(0);
        });

        it('rejects content that is not base64', async () => {
            const response = await post(
                    validBody({
                        attachment: {
                            filename: 'note.txt',
                            contentType: 'text/plain',
                            content: 'not base64 !!!',
                        },
                    }),
                );

            expect(response.status).toBe(400);
        });

        it('measures the decoded size, not the encoded string', async () => {
            // Just over 1 MB decoded, which is the limit set for this suite.
            const oversized = Buffer.alloc(1024 * 1024 + 64, 1).toString('base64');

            const response = await post(
                    validBody({
                        attachment: {
                            filename: 'big.png',
                            contentType: 'image/png',
                            content: oversized,
                        },
                    }),
                );

            expect(response.status).toBe(400);
            expect((response.body.error as { message: string }).message).toMatch(/too large/i);
            expect(resendCalls()).toHaveLength(0);
        });

        it('strips path separators from the filename', async () => {
            await post(
                    validBody({
                        attachment: {
                            filename: '../../etc/passwd',
                            contentType: 'text/plain',
                            content: PNG_BASE64,
                        },
                    }),
                );

            const payload = lastResendPayload();
            const [attachment] = payload.attachments as Array<{ filename: string }>;
            expect(attachment.filename).not.toContain('/');
            expect(attachment.filename).not.toMatch(/^\.\./);
        });
    });

    describe('abuse controls', () => {
        it('swallows a submission that fills the honeypot', async () => {
            const response = await post(validBody({ company: 'Acme Spam Co' }));

            expect(response.status).toBe(202);
            expect(response.body).toEqual({ success: true });
            expect(resendCalls()).toHaveLength(0);
        });

        it('rate limits after three submissions from one address', async () => {
            for (let i = 0; i < 3; i += 1) {
                const ok = await post(validBody());
                expect(ok.status).toBe(202);
            }

            const blocked = await post(validBody());

            expect(blocked.status).toBe(429);
            expect(resendCalls()).toHaveLength(3);
        });

        it('clips the context to a bounded number of entries', async () => {
            const context: Record<string, string> = {};
            for (let i = 0; i < 50; i += 1) {
                context[`key${i}`] = 'v';
            }

            await post(validBody({ context }));

            const payload = lastResendPayload();
            const rows = (payload.text as string).split('\n').filter((line) => /^key\d+: /.test(line));
            expect(rows.length).toBeLessThanOrEqual(12);
        });
    });

    describe('transport failures', () => {
        it('reports a bad gateway when Resend rejects the message', async () => {
            fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
                if (String(input).startsWith('https://api.resend.com/')) {
                    return {
                        ok: false,
                        status: 422,
                        text: async () => '{"message":"domain not verified"}',
                    } as unknown as Response;
                }
                return realFetch(input as RequestInfo, init);
            });

            const response = await post(validBody());

            expect(response.status).toBe(502);
            expect(JSON.stringify(response.body)).not.toContain('inbox@example.com');
        });

        it('reports a bad gateway when Resend is unreachable', async () => {
            fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
                if (String(input).startsWith('https://api.resend.com/')) {
                    throw new Error('ECONNREFUSED');
                }
                return realFetch(input as RequestInfo, init);
            });

            const response = await post(validBody());

            expect(response.status).toBe(502);
        });
    });

    describe('discovery', () => {
        it('reports itself available and publishes its limits', async () => {
            const response = await getConfig();

            expect(response.status).toBe(200);
            expect(response.body.available).toBe(true);
            expect(response.body.maxAttachmentBytes).toBe(1024 * 1024);
            expect(response.body.categories).toContain('bug');
            expect(response.body.allowedAttachmentTypes).toContain('image/png');
        });
    });
});
