import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../helpers/chromeMock';

/**
 * The extension ships with no backend baked in, so these helpers are the gate
 * between whatever a user types and what the extension will talk to.
 */
async function getSettingsModule() {
    return import('../../../extension/shared/settings');
}

describe('settings', () => {
    let chromeState: ChromeMock;

    beforeEach(() => {
        vi.resetModules();
        chromeState = installChromeMock();
    });

    afterEach(() => {
        uninstallChromeMock();
    });

    describe('normalizeBackendUrl', () => {
        it('should strip trailing slashes and surrounding whitespace', async () => {
            const { normalizeBackendUrl } = await getSettingsModule();
            expect(normalizeBackendUrl('  https://api.example.com///  ')).toBe(
                'https://api.example.com',
            );
        });

        it('should return an empty string for empty input', async () => {
            const { normalizeBackendUrl } = await getSettingsModule();
            expect(normalizeBackendUrl('')).toBe('');
        });
    });

    describe('validateBackendUrl', () => {
        it('should accept an https origin', async () => {
            const { validateBackendUrl } = await getSettingsModule();
            expect(validateBackendUrl('https://api.example.com')).toBeNull();
        });

        it('should accept http on localhost for development', async () => {
            const { validateBackendUrl } = await getSettingsModule();
            expect(validateBackendUrl('http://localhost:3000')).toBeNull();
            expect(validateBackendUrl('http://127.0.0.1:3000')).toBeNull();
        });

        it('should reject http on a public host', async () => {
            const { validateBackendUrl } = await getSettingsModule();
            expect(validateBackendUrl('http://api.example.com')).toMatch(/https/);
        });

        it('should reject an empty value', async () => {
            const { validateBackendUrl } = await getSettingsModule();
            expect(validateBackendUrl('')).toBeTruthy();
        });

        it('should reject a value that is not a URL', async () => {
            const { validateBackendUrl } = await getSettingsModule();
            expect(validateBackendUrl('not a url')).toBeTruthy();
        });

        it('should reject a non http scheme', async () => {
            const { validateBackendUrl } = await getSettingsModule();
            expect(validateBackendUrl('ftp://api.example.com')).toBeTruthy();
            expect(validateBackendUrl('javascript:alert(1)')).toBeTruthy();
        });

        it('should reject a URL carrying a path', async () => {
            const { validateBackendUrl } = await getSettingsModule();
            expect(validateBackendUrl('https://api.example.com/v1')).toMatch(/origin/);
        });
    });

    describe('parsePortalHost', () => {
        it('should accept a bare hostname', async () => {
            const { parsePortalHost } = await getSettingsModule();
            expect(parsePortalHost('acme.bitrix24.com')).toBe('acme.bitrix24.com');
        });

        it('should extract the hostname from a full URL', async () => {
            const { parsePortalHost } = await getSettingsModule();
            expect(parsePortalHost('https://acme.bitrix24.de/crm/lead/details/1/')).toBe(
                'acme.bitrix24.de',
            );
        });

        it('should lower case the hostname', async () => {
            const { parsePortalHost } = await getSettingsModule();
            expect(parsePortalHost('ACME.Bitrix24.COM')).toBe('acme.bitrix24.com');
        });

        it('should reject a bare label with no dot', async () => {
            const { parsePortalHost } = await getSettingsModule();
            expect(parsePortalHost('localhost')).toBeNull();
        });

        it('should reject an IP address', async () => {
            const { parsePortalHost } = await getSettingsModule();
            expect(parsePortalHost('192.168.1.10')).toBeNull();
        });

        it('should reject empty input', async () => {
            const { parsePortalHost } = await getSettingsModule();
            expect(parsePortalHost('')).toBeNull();
            expect(parsePortalHost('   ')).toBeNull();
        });
    });

    describe('isStaticallyCoveredPortal', () => {
        it('should cover bitrix24.com and its subdomains', async () => {
            const { isStaticallyCoveredPortal } = await getSettingsModule();
            expect(isStaticallyCoveredPortal('acme.bitrix24.com')).toBe(true);
            expect(isStaticallyCoveredPortal('bitrix24.com')).toBe(true);
        });

        it('should not cover other Bitrix24 domains or custom domains', async () => {
            const { isStaticallyCoveredPortal } = await getSettingsModule();
            expect(isStaticallyCoveredPortal('acme.bitrix24.de')).toBe(false);
            expect(isStaticallyCoveredPortal('crm.acme.com')).toBe(false);
        });

        it('should not be fooled by a lookalike suffix', async () => {
            const { isStaticallyCoveredPortal } = await getSettingsModule();
            expect(isStaticallyCoveredPortal('evilbitrix24.com')).toBe(false);
        });
    });

    describe('getSettings / updateSettings', () => {
        it('should fall back to the build time default when nothing is stored', async () => {
            const { getSettings, BUILD_TIME_BACKEND_URL, normalizeBackendUrl } =
                await getSettingsModule();

            // A distributor may bake a default in with VITE_BACKEND_URL. Assert
            // against whatever this build carries rather than assuming empty,
            // so the test does not depend on the ambient .env.
            expect(await getSettings()).toEqual({
                backendUrl: normalizeBackendUrl(BUILD_TIME_BACKEND_URL),
                portals: [],
            });
        });

        it('should round trip a saved backend URL', async () => {
            const { updateSettings, getSettings } = await getSettingsModule();

            await updateSettings({ backendUrl: 'https://api.example.com/' });

            expect(await getSettings()).toEqual({
                backendUrl: 'https://api.example.com',
                portals: [],
            });
        });

        it('should preserve untouched fields on a partial update', async () => {
            const { updateSettings, getSettings } = await getSettingsModule();

            await updateSettings({ backendUrl: 'https://api.example.com' });
            await updateSettings({ portals: ['acme.bitrix24.de'] });

            expect(await getSettings()).toEqual({
                backendUrl: 'https://api.example.com',
                portals: ['acme.bitrix24.de'],
            });
        });

        it('should write settings to chrome.storage.local', async () => {
            const { updateSettings } = await getSettingsModule();

            await updateSettings({ backendUrl: 'https://api.example.com' });

            expect(chromeState.storage.local.settings).toEqual({
                backendUrl: 'https://api.example.com',
                portals: [],
            });
        });
    });

    describe('isConfigured', () => {
        it('should be false when no backend is configured or baked in', async () => {
            const { isConfigured, updateSettings } = await getSettingsModule();

            await updateSettings({ backendUrl: '' });

            expect(await isConfigured()).toBe(false);
        });

        it('should be true once a backend is set', async () => {
            const { updateSettings, isConfigured } = await getSettingsModule();
            await updateSettings({ backendUrl: 'https://api.example.com' });
            expect(await isConfigured()).toBe(true);
        });
    });
});
