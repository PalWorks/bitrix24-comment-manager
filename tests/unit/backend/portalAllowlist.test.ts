import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * One backend can serve several Bitrix24 portals, and the requested portal is
 * interpolated into an authorization URL, so the allowlist is a security
 * boundary rather than a convenience.
 */
describe('portal allowlist', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.resetModules();
        process.env.JWT_SECRET = 'test-secret';
        process.env.BITRIX24_CLIENT_ID = 'test-client-id';
        process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
        delete process.env.BITRIX24_PORTAL_DOMAIN;
        delete process.env.BITRIX24_ALLOWED_PORTALS;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe('isPortalAllowed', () => {
        it('should match an exact hostname', async () => {
            const { isPortalAllowed } = await import('../../../backend/src/config');
            expect(isPortalAllowed('acme.bitrix24.com', ['acme.bitrix24.com'])).toBe(true);
            expect(isPortalAllowed('other.bitrix24.com', ['acme.bitrix24.com'])).toBe(false);
        });

        it('should be case insensitive', async () => {
            const { isPortalAllowed } = await import('../../../backend/src/config');
            expect(isPortalAllowed('ACME.Bitrix24.com', ['acme.bitrix24.com'])).toBe(true);
        });

        it('should match a subdomain wildcard', async () => {
            const { isPortalAllowed } = await import('../../../backend/src/config');
            expect(isPortalAllowed('acme.bitrix24.com', ['*.bitrix24.com'])).toBe(true);
            expect(isPortalAllowed('a.b.bitrix24.com', ['*.bitrix24.com'])).toBe(true);
        });

        it('should not let a wildcard match the bare suffix', async () => {
            const { isPortalAllowed } = await import('../../../backend/src/config');
            expect(isPortalAllowed('bitrix24.com', ['*.bitrix24.com'])).toBe(false);
        });

        it('should not let a lookalike domain pass a wildcard', async () => {
            const { isPortalAllowed } = await import('../../../backend/src/config');
            expect(isPortalAllowed('evilbitrix24.com', ['*.bitrix24.com'])).toBe(false);
            expect(isPortalAllowed('bitrix24.com.evil.net', ['*.bitrix24.com'])).toBe(false);
        });

        it('should accept anything under a full wildcard', async () => {
            const { isPortalAllowed } = await import('../../../backend/src/config');
            expect(isPortalAllowed('anything.example.com', ['*'])).toBe(true);
        });

        it('should reject an empty host', async () => {
            const { isPortalAllowed } = await import('../../../backend/src/config');
            expect(isPortalAllowed('', ['*'])).toBe(false);
            expect(isPortalAllowed('   ', ['*'])).toBe(false);
        });

        it('should match any entry in a multi entry list', async () => {
            const { isPortalAllowed } = await import('../../../backend/src/config');
            const allowed = ['acme.bitrix24.com', '*.bitrix24.de'];
            expect(isPortalAllowed('acme.bitrix24.com', allowed)).toBe(true);
            expect(isPortalAllowed('other.bitrix24.de', allowed)).toBe(true);
            expect(isPortalAllowed('nope.bitrix24.fr', allowed)).toBe(false);
        });
    });

    describe('configuration', () => {
        it('should derive the allowlist from BITRIX24_ALLOWED_PORTALS', async () => {
            process.env.BITRIX24_ALLOWED_PORTALS = 'a.bitrix24.com, *.bitrix24.de ';
            const { loadConfig } = await import('../../../backend/src/config');
            expect(loadConfig().bitrix24AllowedPortals).toEqual([
                'a.bitrix24.com',
                '*.bitrix24.de',
            ]);
        });

        it('should fall back to BITRIX24_PORTAL_DOMAIN for single portal deployments', async () => {
            process.env.BITRIX24_PORTAL_DOMAIN = 'acme.bitrix24.com';
            const { loadConfig } = await import('../../../backend/src/config');
            const config = loadConfig();
            expect(config.bitrix24AllowedPortals).toEqual(['acme.bitrix24.com']);
            expect(config.bitrix24PortalDomain).toBe('acme.bitrix24.com');
        });

        it('should prefer the explicit list over the single portal shorthand', async () => {
            process.env.BITRIX24_PORTAL_DOMAIN = 'acme.bitrix24.com';
            process.env.BITRIX24_ALLOWED_PORTALS = '*.bitrix24.de';
            const { loadConfig } = await import('../../../backend/src/config');
            expect(loadConfig().bitrix24AllowedPortals).toEqual(['*.bitrix24.de']);
        });

        it('should refuse to start with no portal configured at all', async () => {
            const { loadConfig } = await import('../../../backend/src/config');
            expect(() => loadConfig()).toThrow(/No Bitrix24 portal configured/);
        });
    });
});
