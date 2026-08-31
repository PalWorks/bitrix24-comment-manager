/**
 * User configurable extension settings.
 *
 * The extension ships with no backend baked in. Each installation points at
 * whichever backend its operator runs, configured on the options page and
 * persisted in chrome.storage.local.
 *
 * A build may optionally supply VITE_BACKEND_URL. That value only seeds the
 * default on first run so a distributor can ship a pre-configured build; the
 * user can still change it afterwards.
 */

const STORAGE_KEY = 'settings';

/**
 * Backend URL supplied at build time, if any. Empty string when the build was
 * produced without VITE_BACKEND_URL.
 */
export const BUILD_TIME_BACKEND_URL: string =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_URL) || '';

export interface Settings {
    /** Origin of the backend API, with no trailing slash. Empty when unconfigured. */
    backendUrl: string;
    /**
     * Bitrix24 portal hostnames the user has added beyond the statically
     * declared *.bitrix24.com match. Each has a granted host permission and a
     * dynamically registered content script.
     */
    portals: string[];
}

const DEFAULTS: Settings = {
    backendUrl: normalizeBackendUrl(BUILD_TIME_BACKEND_URL),
    portals: [],
};

/**
 * Strips trailing slashes and whitespace so callers can concatenate paths
 * without producing a double slash.
 */
export function normalizeBackendUrl(url: string): string {
    return (url || '').trim().replace(/\/+$/, '');
}

/**
 * Validates a backend URL. The backend is reached over the network from the
 * service worker, so http is permitted only for loopback development hosts.
 * Returns null when valid, or a human readable reason when not.
 */
export function validateBackendUrl(url: string): string | null {
    const trimmed = normalizeBackendUrl(url);

    if (!trimmed) {
        return 'Enter the URL of your backend, for example https://api.example.com';
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return 'That is not a valid URL. Include the scheme, for example https://api.example.com';
    }

    const isLoopback =
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]';

    if (parsed.protocol === 'http:' && !isLoopback) {
        return 'Use https. Plain http is only allowed for localhost during development.';
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'The URL must start with https://';
    }

    if (parsed.pathname !== '/' && parsed.pathname !== '') {
        return 'Enter only the origin, with no path. For example https://api.example.com';
    }

    return null;
}

/**
 * Normalises user input for a Bitrix24 portal into a bare hostname.
 * Accepts a hostname or a full URL. Returns null when it cannot be parsed.
 */
export function parsePortalHost(input: string): string | null {
    const trimmed = (input || '').trim().toLowerCase();
    if (!trimmed) {
        return null;
    }

    const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

    let host: string;
    try {
        host = new URL(withScheme).hostname;
    } catch {
        return null;
    }

    // A portal must be a dotted hostname. Reject bare labels and IP addresses,
    // neither of which Bitrix24 serves a portal on.
    if (!host.includes('.') || /^[\d.]+$/.test(host)) {
        return null;
    }

    return host;
}

/**
 * Returns true when the host is already covered by the statically declared
 * content script match, so the user does not need to add it explicitly.
 */
export function isStaticallyCoveredPortal(host: string): boolean {
    return host === 'bitrix24.com' || host.endsWith('.bitrix24.com');
}

/**
 * Reads the current settings, falling back to build time defaults for any
 * field that has never been written.
 */
export async function getSettings(): Promise<Settings> {
    try {
        const stored = (await chrome.storage.local.get(STORAGE_KEY)) as {
            settings?: Partial<Settings>;
        };
        const settings = stored.settings ?? {};
        return {
            backendUrl:
                settings.backendUrl !== undefined
                    ? normalizeBackendUrl(settings.backendUrl)
                    : DEFAULTS.backendUrl,
            portals: Array.isArray(settings.portals) ? settings.portals : DEFAULTS.portals,
        };
    } catch {
        return { ...DEFAULTS };
    }
}

/**
 * Merges a partial update into the stored settings.
 */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await getSettings();
    const next: Settings = {
        backendUrl:
            patch.backendUrl !== undefined
                ? normalizeBackendUrl(patch.backendUrl)
                : current.backendUrl,
        portals: patch.portals !== undefined ? patch.portals : current.portals,
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
}

/**
 * Convenience accessor for the configured backend origin.
 * Returns an empty string when the extension has not been set up yet.
 */
export async function getBackendUrl(): Promise<string> {
    return (await getSettings()).backendUrl;
}

/**
 * True when the extension has enough configuration to talk to a backend.
 */
export async function isConfigured(): Promise<boolean> {
    return Boolean(await getBackendUrl());
}
