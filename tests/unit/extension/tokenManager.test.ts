import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../helpers/chromeMock';

/**
 * tokenManager runs in the service worker and holds the JWT in
 * chrome.storage.session so it survives the worker being terminated. These
 * tests exercise it against an in-memory stand in for that storage area.
 */
async function getTokenManager() {
    return import('../../../extension/background/tokenManager');
}

describe('tokenManager', () => {
    let chromeState: ChromeMock;

    beforeEach(() => {
        vi.resetModules();
        chromeState = installChromeMock();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        uninstallChromeMock();
    });

    function futureExpiry(): number {
        return Math.floor(Date.now() / 1000) + 3600;
    }

    describe('storeToken / getToken', () => {
        it('should store and retrieve a JWT', async () => {
            const tm = await getTokenManager();

            expect(await tm.getToken()).toBeNull();

            await tm.storeToken('test-jwt-token', futureExpiry());

            expect(await tm.getToken()).toBe('test-jwt-token');
        });

        it('should persist the JWT to chrome.storage.session', async () => {
            const tm = await getTokenManager();
            const expiresAt = futureExpiry();

            await tm.storeToken('test-jwt-token', expiresAt);

            expect(chromeState.storage.session.auth).toEqual({
                jwt: 'test-jwt-token',
                expiresAt,
            });
        });

        it('should never write the JWT to chrome.storage.local', async () => {
            const tm = await getTokenManager();

            await tm.storeToken('test-jwt-token', futureExpiry());

            expect(chromeState.storage.local).toEqual({});
        });
    });

    describe('rehydration after a service worker restart', () => {
        it('should read a token written by a previous worker instance', async () => {
            const expiresAt = futureExpiry();
            const tm = await getTokenManager();
            await tm.storeToken('surviving-token', expiresAt);

            // A fresh module registry stands in for a restarted service worker:
            // module state is gone, but session storage is not.
            vi.resetModules();
            const restarted = await getTokenManager();

            expect(await restarted.getToken()).toBe('surviving-token');
            expect(await restarted.isAuthenticated()).toBe(true);
            expect(await restarted.getExpiresAt()).toBe(expiresAt);
        });

        it('should reinstate the refresh schedule on resumeSession', async () => {
            const tm = await getTokenManager();
            await tm.storeToken('surviving-token', futureExpiry());

            vi.resetModules();
            const restarted = await getTokenManager();

            await expect(restarted.resumeSession()).resolves.toBeUndefined();
            expect(await restarted.getToken()).toBe('surviving-token');
        });
    });

    describe('clearToken', () => {
        it('should nullify the stored JWT', async () => {
            const tm = await getTokenManager();

            await tm.storeToken('test-jwt-token', futureExpiry());
            expect(await tm.getToken()).toBe('test-jwt-token');

            await tm.clearToken();
            expect(await tm.getToken()).toBeNull();
        });

        it('should remove the entry from session storage', async () => {
            const tm = await getTokenManager();

            await tm.storeToken('test-jwt-token', futureExpiry());
            await tm.clearToken();

            expect(chromeState.storage.session.auth).toBeUndefined();
        });
    });

    describe('isAuthenticated', () => {
        it('should return false when no token is stored', async () => {
            const tm = await getTokenManager();
            expect(await tm.isAuthenticated()).toBe(false);
        });

        it('should return true when a token is stored', async () => {
            const tm = await getTokenManager();
            await tm.storeToken('test-jwt-token', futureExpiry());
            expect(await tm.isAuthenticated()).toBe(true);
        });

        it('should return false after clearing the token', async () => {
            const tm = await getTokenManager();
            await tm.storeToken('test-jwt-token', futureExpiry());
            await tm.clearToken();
            expect(await tm.isAuthenticated()).toBe(false);
        });

        it('should return false and discard an already expired token', async () => {
            const tm = await getTokenManager();
            const past = Math.floor(Date.now() / 1000) - 10;

            // Seed storage directly: storeToken would schedule an immediate
            // refresh, and the point here is the expiry check on read.
            chromeState.storage.session.auth = { jwt: 'stale-token', expiresAt: past };

            expect(await tm.isAuthenticated()).toBe(false);
            expect(chromeState.storage.session.auth).toBeUndefined();
        });
    });

    describe('getExpiresAt', () => {
        it('should return null when no token is stored', async () => {
            const tm = await getTokenManager();
            expect(await tm.getExpiresAt()).toBeNull();
        });

        it('should return the stored expiry timestamp', async () => {
            const tm = await getTokenManager();
            const expiresAt = futureExpiry();

            await tm.storeToken('test-jwt-token', expiresAt);
            expect(await tm.getExpiresAt()).toBe(expiresAt);
        });
    });

    describe('parseJwtClaims', () => {
        it('should parse a valid JWT payload', async () => {
            const tm = await getTokenManager();

            const payload = {
                memberId: 'test-member',
                domain: 'test.bitrix24.com',
                exp: 9999999999,
            };
            const fakeJwt = `header.${btoa(JSON.stringify(payload))}.signature`;

            const claims = tm.parseJwtClaims(fakeJwt);
            expect(claims).not.toBeNull();
            expect(claims!.memberId).toBe('test-member');
            expect(claims!.domain).toBe('test.bitrix24.com');
        });

        it('should return null for an invalid JWT format', async () => {
            const tm = await getTokenManager();
            expect(tm.parseJwtClaims('not-a-jwt')).toBeNull();
        });

        it('should return null for invalid base64 payload', async () => {
            const tm = await getTokenManager();
            expect(tm.parseJwtClaims('header.!!!invalid!!!.signature')).toBeNull();
        });
    });
});
