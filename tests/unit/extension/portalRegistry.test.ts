import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../helpers/chromeMock';

/**
 * Portals outside *.bitrix24.com are reached by requesting a host permission
 * and registering a content script at runtime. These tests cover that the
 * registry keeps permissions, registrations, and stored settings in step.
 */
async function getRegistry() {
    return import('../../../extension/background/portalRegistry');
}

describe('portalRegistry', () => {
    let chromeState: ChromeMock;

    beforeEach(() => {
        vi.resetModules();
        chromeState = installChromeMock();
    });

    afterEach(() => {
        uninstallChromeMock();
    });

    describe('addPortal', () => {
        it('should register a content script and record the portal', async () => {
            const { addPortal } = await getRegistry();
            const { getSettings } = await import('../../../extension/shared/settings');

            expect(await addPortal('acme.bitrix24.de')).toBe(true);

            expect(chromeState.permissions.granted.has('https://acme.bitrix24.de/*')).toBe(true);
            expect(chromeState.registeredContentScripts).toHaveLength(1);
            expect(chromeState.registeredContentScripts[0]).toMatchObject({
                id: 'portal-acme.bitrix24.de',
                matches: ['https://acme.bitrix24.de/*'],
            });
            expect((await getSettings()).portals).toEqual(['acme.bitrix24.de']);
        });

        it('should use the built content script filename from the manifest', async () => {
            const { addPortal } = await getRegistry();

            await addPortal('acme.bitrix24.de');

            // The bundler emits a hashed filename, so the source path would not
            // resolve at runtime.
            expect(chromeState.registeredContentScripts[0].js).toEqual([
                'assets/content-hashed.js',
            ]);
        });

        it('should not register anything for a statically covered portal', async () => {
            const { addPortal } = await getRegistry();
            const { getSettings } = await import('../../../extension/shared/settings');

            expect(await addPortal('acme.bitrix24.com')).toBe(true);

            expect(chromeState.registeredContentScripts).toHaveLength(0);
            expect((await getSettings()).portals).toEqual([]);
        });

        it('should report failure and store nothing when permission is declined', async () => {
            const { addPortal } = await getRegistry();
            const { getSettings } = await import('../../../extension/shared/settings');

            (globalThis as unknown as {
                chrome: { permissions: { request: ReturnType<typeof vi.fn> } };
            }).chrome.permissions.request = vi.fn(async () => false);

            expect(await addPortal('acme.bitrix24.de')).toBe(false);

            expect(chromeState.registeredContentScripts).toHaveLength(0);
            expect((await getSettings()).portals).toEqual([]);
        });

        it('should not duplicate a portal that was already added', async () => {
            const { addPortal } = await getRegistry();
            const { getSettings } = await import('../../../extension/shared/settings');

            await addPortal('acme.bitrix24.de');
            await addPortal('acme.bitrix24.de');

            expect((await getSettings()).portals).toEqual(['acme.bitrix24.de']);
            expect(chromeState.registeredContentScripts).toHaveLength(1);
        });
    });

    describe('removePortal', () => {
        it('should unregister the script, drop the permission, and forget the portal', async () => {
            const { addPortal, removePortal } = await getRegistry();
            const { getSettings } = await import('../../../extension/shared/settings');

            await addPortal('acme.bitrix24.de');
            await removePortal('acme.bitrix24.de');

            expect(chromeState.registeredContentScripts).toHaveLength(0);
            expect(chromeState.permissions.granted.has('https://acme.bitrix24.de/*')).toBe(false);
            expect((await getSettings()).portals).toEqual([]);
        });
    });

    describe('syncRegisteredPortals', () => {
        it('should do nothing when no portals are stored', async () => {
            const { syncRegisteredPortals } = await getRegistry();

            await syncRegisteredPortals();

            expect(chromeState.registeredContentScripts).toHaveLength(0);
        });

        it('should drop a portal whose permission the user revoked', async () => {
            const { addPortal, syncRegisteredPortals } = await getRegistry();
            const { getSettings } = await import('../../../extension/shared/settings');

            await addPortal('acme.bitrix24.de');

            // Simulate the user revoking access from chrome://extensions.
            chromeState.permissions.granted.delete('https://acme.bitrix24.de/*');

            await syncRegisteredPortals();

            expect((await getSettings()).portals).toEqual([]);
            expect(chromeState.registeredContentScripts).toHaveLength(0);
        });

        it('should keep a portal whose permission is still granted', async () => {
            const { addPortal, syncRegisteredPortals } = await getRegistry();
            const { getSettings } = await import('../../../extension/shared/settings');

            await addPortal('acme.bitrix24.de');
            await syncRegisteredPortals();

            expect((await getSettings()).portals).toEqual(['acme.bitrix24.de']);
        });
    });

    describe('hasPortalPermission', () => {
        it('should be true for a statically covered portal without asking', async () => {
            const { hasPortalPermission } = await getRegistry();
            expect(await hasPortalPermission('acme.bitrix24.com')).toBe(true);
        });

        it('should reflect whether a permission was granted', async () => {
            const { hasPortalPermission, addPortal } = await getRegistry();

            expect(await hasPortalPermission('acme.bitrix24.de')).toBe(false);
            await addPortal('acme.bitrix24.de');
            expect(await hasPortalPermission('acme.bitrix24.de')).toBe(true);
        });
    });
});
