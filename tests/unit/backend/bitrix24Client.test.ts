import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';

/**
 * Mock tokenService so bitrix24Client does not attempt real token I/O.
 */
vi.mock('../../../backend/src/services/tokenService', () => ({
    getBitrixTokens: vi.fn(),
    storeBitrixTokens: vi.fn(),
}));

import {
    addComment,
    updateComment,
    deleteComment,
    getLead,
    _resetQueuesForTesting,
} from '../../../backend/src/services/bitrix24Client';
import { BitrixApiError } from '../../../backend/src/utils/errors';
import { getBitrixTokens, storeBitrixTokens } from '../../../backend/src/services/tokenService';

const mockedGetBitrixTokens = getBitrixTokens as ReturnType<typeof vi.fn>;
const mockedStoreBitrixTokens = storeBitrixTokens as ReturnType<typeof vi.fn>;

/**
 * Returns a mock Response matching the global fetch Response interface.
 */
function mockFetchResponse(
    body: unknown,
    status = 200,
    ok = true,
): Response {
    return {
        ok,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        headers: new Headers(),
        redirected: false,
        statusText: ok ? 'OK' : 'Error',
        type: 'basic' as ResponseType,
        url: '',
        clone: () => mockFetchResponse(body, status, ok),
        body: null,
        bodyUsed: false,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        blob: () => Promise.resolve(new Blob()),
        formData: () => Promise.resolve(new FormData()),
        bytes: () => Promise.resolve(new Uint8Array()),
    } as Response;
}

describe('bitrix24Client', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    const CLIENT_ENDPOINT = 'https://test.bitrix24.com/rest/';
    const ACCESS_TOKEN = 'mock-access-token';
    const MEMBER_ID = 'member-test-001';

    beforeEach(() => {
        _resetQueuesForTesting();
        fetchSpy = vi.fn();
        vi.spyOn(globalThis, 'fetch').mockImplementation(
            fetchSpy as typeof globalThis.fetch,
        );
        mockedGetBitrixTokens.mockReset();
        mockedStoreBitrixTokens.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('addComment', () => {
        it('should call crm.timeline.comment.add and return the commentId', async () => {
            fetchSpy.mockResolvedValueOnce(
                mockFetchResponse({ result: 55001 }),
            );

            const result = await addComment(
                CLIENT_ENDPOINT,
                ACCESS_TOKEN,
                MEMBER_ID,
                '12345',
                'Test comment body',
            );

            expect(result).toEqual({ commentId: '55001' });
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            const [url, options] = fetchSpy.mock.calls[0];
            expect(url).toBe(`${CLIENT_ENDPOINT}crm.timeline.comment.add`);
            expect(options.method).toBe('POST');

            const body = JSON.parse(options.body);
            expect(body.fields.ENTITY_ID).toBe('12345');
            expect(body.fields.ENTITY_TYPE).toBe('lead');
            expect(body.fields.COMMENT).toBe('Test comment body');
            expect(body.auth).toBe(ACCESS_TOKEN);
        });
    });

    describe('updateComment', () => {
        it('should call crm.timeline.comment.update with correct payload', async () => {
            fetchSpy.mockResolvedValueOnce(
                mockFetchResponse({ result: true }),
            );

            await updateComment(
                CLIENT_ENDPOINT,
                ACCESS_TOKEN,
                MEMBER_ID,
                'comment-123',
                'Updated body',
            );

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, options] = fetchSpy.mock.calls[0];
            expect(url).toBe(`${CLIENT_ENDPOINT}crm.timeline.comment.update`);

            const body = JSON.parse(options.body);
            expect(body.id).toBe('comment-123');
            expect(body.fields.COMMENT).toBe('Updated body');
        });
    });

    describe('deleteComment', () => {
        it('should call crm.timeline.comment.delete with comment id', async () => {
            fetchSpy.mockResolvedValueOnce(
                mockFetchResponse({ result: true }),
            );

            await deleteComment(
                CLIENT_ENDPOINT,
                ACCESS_TOKEN,
                MEMBER_ID,
                'comment-456',
            );

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url, options] = fetchSpy.mock.calls[0];
            expect(url).toBe(`${CLIENT_ENDPOINT}crm.timeline.comment.delete`);

            const body = JSON.parse(options.body);
            expect(body.id).toBe('comment-456');
        });
    });

    describe('getLead', () => {
        it('should return the lead title from the API response', async () => {
            fetchSpy.mockResolvedValueOnce(
                mockFetchResponse({ result: { TITLE: 'Premium Lead' } }),
            );

            const result = await getLead(
                CLIENT_ENDPOINT,
                ACCESS_TOKEN,
                MEMBER_ID,
                '99999',
            );

            expect(result).toEqual({ title: 'Premium Lead' });
            const [url] = fetchSpy.mock.calls[0];
            expect(url).toBe(`${CLIENT_ENDPOINT}crm.lead.get`);
        });

        it('should return "Untitled Lead" when the API response has no TITLE', async () => {
            fetchSpy.mockResolvedValueOnce(
                mockFetchResponse({ result: {} }),
            );

            const result = await getLead(
                CLIENT_ENDPOINT,
                ACCESS_TOKEN,
                MEMBER_ID,
                '88888',
            );

            expect(result).toEqual({ title: 'Untitled Lead' });
        });

        it('should return "Untitled Lead" when result is undefined', async () => {
            fetchSpy.mockResolvedValueOnce(
                mockFetchResponse({ result: undefined }),
            );

            const result = await getLead(
                CLIENT_ENDPOINT,
                ACCESS_TOKEN,
                MEMBER_ID,
                '77777',
            );

            expect(result).toEqual({ title: 'Untitled Lead' });
        });
    });

    describe('error handling', () => {
        it('should throw BitrixApiError when the API returns an error field', async () => {
            fetchSpy.mockResolvedValueOnce(
                mockFetchResponse({
                    error: 'ACCESS_DENIED',
                    error_description: 'Insufficient permissions',
                }),
            );

            try {
                await addComment(CLIENT_ENDPOINT, ACCESS_TOKEN, MEMBER_ID, '100', 'test');
                expect.unreachable('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(BitrixApiError);
                expect((error as Error).message).toMatch(/Insufficient permissions/);
            }
        });

        it('should use error code as message when error_description is absent', async () => {
            fetchSpy.mockResolvedValueOnce(
                mockFetchResponse({
                    error: 'UNKNOWN_METHOD',
                }),
            );

            try {
                await addComment(CLIENT_ENDPOINT, ACCESS_TOKEN, MEMBER_ID, '100', 'test');
                expect.unreachable('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(BitrixApiError);
                expect((error as Error).message).toContain('UNKNOWN_METHOD');
            }
        });

        it('should throw BitrixApiError on non-ok HTTP status (e.g. 500)', async () => {
            fetchSpy.mockResolvedValue(
                mockFetchResponse({ error: 'server error' }, 500, false),
            );

            await expect(
                addComment(CLIENT_ENDPOINT, ACCESS_TOKEN, MEMBER_ID, '100', 'test'),
            ).rejects.toThrow(BitrixApiError);
        });
    });

    describe('401 token refresh', () => {
        it('should refresh the access token on 401 and retry the request', async () => {
            mockedGetBitrixTokens.mockReturnValue({
                accessToken: 'old-access-token',
                refreshToken: 'stored-refresh-token',
                clientEndpoint: CLIENT_ENDPOINT,
                domain: 'test.bitrix24.com',
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
            });

            /**
             * Call 1: original request returns 401.
             * Call 2: token refresh succeeds.
             * Call 3: retried request succeeds.
             */
            fetchSpy
                .mockResolvedValueOnce(mockFetchResponse({}, 401, false))
                .mockResolvedValueOnce(
                    mockFetchResponse({
                        access_token: 'refreshed-token',
                        refresh_token: 'new-refresh-token',
                        expires_in: 3600,
                    }),
                )
                .mockResolvedValueOnce(
                    mockFetchResponse({ result: 99002 }),
                );

            const result = await addComment(
                CLIENT_ENDPOINT,
                ACCESS_TOKEN,
                MEMBER_ID,
                '200',
                'After refresh',
            );

            expect(result).toEqual({ commentId: '99002' });
            expect(fetchSpy).toHaveBeenCalledTimes(3);
            expect(mockedStoreBitrixTokens).toHaveBeenCalledTimes(1);
        });
    });

    describe('503 backoff retry', () => {
        it('should retry with backoff on 503 and succeed on a later attempt', async () => {
            /**
             * Call 1: 503 (rate limited).
             * Call 2: 503 (rate limited).
             * Call 3: 200 success.
             */
            fetchSpy
                .mockResolvedValueOnce(mockFetchResponse({}, 503, false))
                .mockResolvedValueOnce(mockFetchResponse({}, 503, false))
                .mockResolvedValueOnce(mockFetchResponse({ result: 12345 }));

            const result = await addComment(
                CLIENT_ENDPOINT,
                ACCESS_TOKEN,
                MEMBER_ID,
                '300',
                'Retried comment',
            );

            expect(result).toEqual({ commentId: '12345' });
            expect(fetchSpy).toHaveBeenCalledTimes(3);
        }, 30000);

        it('should throw after exhausting all retries on persistent 503', async () => {
            /**
             * All calls return 503. MAX_RETRIES + 1 = 4 attempts total.
             */
            fetchSpy.mockResolvedValue(mockFetchResponse({}, 503, false));

            await expect(
                addComment(CLIENT_ENDPOINT, ACCESS_TOKEN, MEMBER_ID, '400', 'Will fail'),
            ).rejects.toThrow(BitrixApiError);

            await expect(
                addComment(CLIENT_ENDPOINT, ACCESS_TOKEN, MEMBER_ID, '400', 'Will fail'),
            ).rejects.toThrow(/QUERY_LIMIT_EXCEEDED/);
        }, 60000);
    });

    describe('_resetQueuesForTesting', () => {
        it('should not throw when called with no active queues', () => {
            expect(() => _resetQueuesForTesting()).not.toThrow();
        });
    });
});
