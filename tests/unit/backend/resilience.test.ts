import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Behaviour the codebase audit added, gathered here because each of these is a
 * failure that only appears on a bad network or under concurrency, which is
 * exactly when nobody is watching. Every test below fails against the code as
 * it stood before the audit.
 */

process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';

vi.mock('../../../backend/src/services/tokenService', () => ({
    getBitrixTokens: vi.fn(),
    storeBitrixTokens: vi.fn(),
}));

import {
    addComment,
    getLead,
    _resetQueuesForTesting,
} from '../../../backend/src/services/bitrix24Client';
import { BitrixApiError } from '../../../backend/src/utils/errors';
import {
    getBitrixTokens,
    storeBitrixTokens,
} from '../../../backend/src/services/tokenService';

const mockedGetBitrixTokens = getBitrixTokens as ReturnType<typeof vi.fn>;
const mockedStoreBitrixTokens = storeBitrixTokens as ReturnType<typeof vi.fn>;

const ENDPOINT = 'https://test.bitrix24.com/rest/';

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        headers: new Headers(),
    } as Response;
}

describe('Bitrix24 client resilience', () => {
    beforeEach(() => {
        _resetQueuesForTesting();
        vi.clearAllMocks();
        mockedGetBitrixTokens.mockResolvedValue({
            accessToken: 'stale-token',
            refreshToken: 'refresh-token',
            clientEndpoint: ENDPOINT,
            domain: 'test.bitrix24.com',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
        mockedStoreBitrixTokens.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        _resetQueuesForTesting();
    });

    it('gives every outbound call a deadline, so a portal that stops responding cannot hold a request open', async () => {
        const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ result: '42' }));
        vi.stubGlobal('fetch', fetchSpy);

        await addComment(ENDPOINT, 'token', 'member-1', '7', 'hello');

        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.signal).toBeInstanceOf(AbortSignal);

        vi.unstubAllGlobals();
    });

    it('exchanges the refresh token once when several calls hit 401 together', async () => {
        // Bitrix24 rotates the refresh token on use: the first exchange
        // invalidates the token the others still hold. Without coalescing, one
        // wins and the rest write back a pair Bitrix24 has already superseded.
        let refreshCalls = 0;

        const scriptedFetch = vi.fn(async (url: string, init: RequestInit) => {
            if (String(url).includes('oauth.bitrix.info')) {
                refreshCalls += 1;
                // Slow enough that all three callers are waiting on it at once,
                // which is the only arrangement in which the race can happen.
                await new Promise((resolve) => setTimeout(resolve, 20));
                return jsonResponse({
                    access_token: 'fresh-token',
                    refresh_token: 'rotated-refresh-token',
                    expires_in: 3600,
                });
            }

            const auth = JSON.parse(String(init.body)).auth;
            return auth === 'fresh-token'
                ? jsonResponse({ result: 'ok' })
                : jsonResponse({}, 401);
        });

        vi.stubGlobal('fetch', scriptedFetch);

        await Promise.all([
            addComment(ENDPOINT, 'stale-token', 'member-1', '1', 'a'),
            addComment(ENDPOINT, 'stale-token', 'member-1', '2', 'b'),
            addComment(ENDPOINT, 'stale-token', 'member-1', '3', 'c'),
        ]);

        expect(refreshCalls).toBe(1);

        vi.unstubAllGlobals();
    });

    it('refreshes again for a later 401 once the first exchange has settled', async () => {
        let refreshCalls = 0;

        const scriptedFetch = vi.fn(async (url: string, init: RequestInit) => {
            if (String(url).includes('oauth.bitrix.info')) {
                refreshCalls += 1;
                return jsonResponse({
                    access_token: `fresh-${refreshCalls}`,
                    refresh_token: 'rotated',
                    expires_in: 3600,
                });
            }
            const auth = JSON.parse(String(init.body)).auth;
            return auth.startsWith('fresh-')
                ? jsonResponse({ result: 'ok' })
                : jsonResponse({}, 401);
        });

        vi.stubGlobal('fetch', scriptedFetch);

        await addComment(ENDPOINT, 'stale', 'member-1', '1', 'a');
        await addComment(ENDPOINT, 'stale', 'member-1', '2', 'b');

        // The guard coalesces concurrent callers; it must not cache a result
        // and leave a genuinely expired token unrefreshed later.
        expect(refreshCalls).toBe(2);

        vi.unstubAllGlobals();
    });

    it('retries a dropped connection rather than failing the comment outright', async () => {
        let attempts = 0;
        const scriptedFetch = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new TypeError('fetch failed');
            }
            return jsonResponse({ result: '99' });
        });

        vi.stubGlobal('fetch', scriptedFetch);

        const result = await addComment(ENDPOINT, 'token', 'member-1', '5', 'hi');

        expect(result.commentId).toBe('99');
        expect(attempts).toBe(2);

        vi.unstubAllGlobals();
    }, 15_000);

    it('stops retrying transport failures once the attempts are spent', async () => {
        const scriptedFetch = vi.fn(async () => {
            throw new TypeError('fetch failed');
        });

        vi.stubGlobal('fetch', scriptedFetch);

        await expect(getLead(ENDPOINT, 'token', 'member-1', '5')).rejects.toThrow(
            'fetch failed',
        );

        vi.unstubAllGlobals();
    }, 30_000);

    it('does not sleep out the final backoff before reporting a rate limit', async () => {
        // The last attempt used to wait its full backoff and then throw
        // regardless, adding seconds to an error the caller was always going to
        // receive.
        const scriptedFetch = vi.fn(async () => jsonResponse({}, 503));
        vi.stubGlobal('fetch', scriptedFetch);

        const startedAt = Date.now();
        await expect(getLead(ENDPOINT, 'token', 'member-1', '5')).rejects.toBeInstanceOf(
            BitrixApiError,
        );
        const elapsed = Date.now() - startedAt;

        // Backoffs actually served: 1s + 2s + 4s. The fourth, 8s, is skipped.
        expect(elapsed).toBeLessThan(9_000);

        vi.unstubAllGlobals();
    }, 30_000);
});
