/**
 * Runtime registration of Bitrix24 portals beyond the statically declared
 * *.bitrix24.com match.
 *
 * Bitrix24 serves portals on several regional top level domains, on customer
 * owned domains, and on self hosted installations. There is no published list
 * to enumerate, so rather than guessing one into the manifest, the user adds
 * their portal once and the extension requests the host permission and
 * registers a content script for it at runtime.
 */

import { getSettings, updateSettings, isStaticallyCoveredPortal } from '../shared/settings';

/** Prefix for dynamically registered content script ids. */
const SCRIPT_ID_PREFIX = 'portal-';

/**
 * Resolves the content script files to register, read from the manifest of the
 * running extension.
 *
 * The build step rewrites the content script to a hashed filename, so the
 * source path is not what ships. Reading the built manifest keeps dynamic
 * registration in step with whatever the bundler emitted.
 */
function contentScriptFiles(): string[] {
    const declared = chrome.runtime.getManifest().content_scripts ?? [];
    const files = declared.flatMap((entry) => entry.js ?? []);

    if (files.length === 0) {
        throw new Error('No content script declared in the manifest.');
    }

    return files;
}

function originPattern(host: string): string {
    return `https://${host}/*`;
}

function scriptId(host: string): string {
    return `${SCRIPT_ID_PREFIX}${host}`;
}

/**
 * True when the extension currently holds host permission for the portal.
 */
export async function hasPortalPermission(host: string): Promise<boolean> {
    if (isStaticallyCoveredPortal(host)) {
        return true;
    }
    return chrome.permissions.contains({ origins: [originPattern(host)] });
}

/**
 * Registers a content script for the portal if one is not already registered.
 * Safe to call repeatedly.
 */
async function ensureContentScript(host: string): Promise<void> {
    if (isStaticallyCoveredPortal(host)) {
        return;
    }

    const id = scriptId(host);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });

    if (existing.length > 0) {
        return;
    }

    await chrome.scripting.registerContentScripts([
        {
            id,
            matches: [originPattern(host)],
            js: contentScriptFiles(),
            runAt: 'document_idle',
        },
    ]);
}

/**
 * Removes the dynamically registered content script for a portal, if present.
 */
async function removeContentScript(host: string): Promise<void> {
    const id = scriptId(host);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: [id] });
    }
}

/**
 * Adds a portal: requests host permission, registers the content script, and
 * records it in settings.
 *
 * Must be called from a user gesture, because chrome.permissions.request
 * requires one. Returns false when the user declines the permission prompt.
 */
export async function addPortal(host: string): Promise<boolean> {
    if (isStaticallyCoveredPortal(host)) {
        return true;
    }

    const granted = await chrome.permissions.request({ origins: [originPattern(host)] });

    if (!granted) {
        return false;
    }

    await ensureContentScript(host);

    const { portals } = await getSettings();
    if (!portals.includes(host)) {
        await updateSettings({ portals: [...portals, host] });
    }

    return true;
}

/**
 * Removes a portal: unregisters its content script, drops the host permission,
 * and removes it from settings.
 */
export async function removePortal(host: string): Promise<void> {
    await removeContentScript(host);

    try {
        await chrome.permissions.remove({ origins: [originPattern(host)] });
    } catch {
        // Permission may already be gone. Removing it from settings is what matters.
    }

    const { portals } = await getSettings();
    await updateSettings({ portals: portals.filter((p) => p !== host) });
}

/**
 * Re-registers content scripts for every stored portal.
 *
 * Dynamic content script registrations survive service worker restarts but not
 * every browser update or profile migration, and a user can revoke a host
 * permission from chrome://extensions at any time. Running this on startup
 * reconciles stored settings with the browser's actual state, and prunes
 * portals whose permission has been revoked.
 */
export async function syncRegisteredPortals(): Promise<void> {
    const { portals } = await getSettings();

    if (portals.length === 0) {
        return;
    }

    const stillPermitted: string[] = [];

    for (const host of portals) {
        try {
            const permitted = await chrome.permissions.contains({
                origins: [originPattern(host)],
            });

            if (permitted) {
                await ensureContentScript(host);
                stillPermitted.push(host);
            } else {
                await removeContentScript(host);
            }
        } catch {
            // Skip a portal that cannot be reconciled rather than aborting the
            // whole sync and leaving the remaining portals unregistered.
        }
    }

    if (stillPermitted.length !== portals.length) {
        await updateSettings({ portals: stillPermitted });
    }
}
