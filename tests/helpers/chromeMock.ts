import { vi } from 'vitest';

/**
 * Minimal in-memory stand in for the chrome.* APIs the extension uses.
 *
 * Each area (session, local) is backed by a plain object, so a test can assert
 * on what was written as well as what was read back.
 */
export interface ChromeMock {
    storage: {
        session: Record<string, unknown>;
        local: Record<string, unknown>;
    };
    permissions: {
        granted: Set<string>;
    };
    registeredContentScripts: Array<{ id: string; matches: string[]; js: string[] }>;
}

/**
 * Installs a chrome mock on globalThis and returns a handle to its state.
 * Call inside beforeEach, and pair with resetModules when the module under
 * test caches values at import time.
 */
export function installChromeMock(): ChromeMock {
    const state: ChromeMock = {
        storage: { session: {}, local: {} },
        permissions: { granted: new Set<string>() },
        registeredContentScripts: [],
    };

    function makeArea(area: Record<string, unknown>) {
        return {
            get: vi.fn(async (key: string | string[] | null) => {
                if (key === null || key === undefined) {
                    return { ...area };
                }
                const keys = Array.isArray(key) ? key : [key];
                const result: Record<string, unknown> = {};
                for (const k of keys) {
                    if (k in area) {
                        result[k] = area[k];
                    }
                }
                return result;
            }),
            set: vi.fn(async (items: Record<string, unknown>) => {
                Object.assign(area, items);
            }),
            remove: vi.fn(async (key: string | string[]) => {
                for (const k of Array.isArray(key) ? key : [key]) {
                    delete area[k];
                }
            }),
            clear: vi.fn(async () => {
                for (const k of Object.keys(area)) {
                    delete area[k];
                }
            }),
        };
    }

    const chromeMock = {
        storage: {
            session: makeArea(state.storage.session),
            local: makeArea(state.storage.local),
        },
        runtime: {
            sendMessage: vi.fn(),
            getManifest: vi.fn(() => ({
                content_scripts: [{ js: ['assets/content-hashed.js'], matches: ['https://*.bitrix24.com/*'] }],
            })),
            onMessage: { addListener: vi.fn() },
            onStartup: { addListener: vi.fn() },
            onInstalled: { addListener: vi.fn() },
        },
        permissions: {
            request: vi.fn(async ({ origins }: { origins: string[] }) => {
                origins.forEach((o) => state.permissions.granted.add(o));
                return true;
            }),
            contains: vi.fn(async ({ origins }: { origins: string[] }) =>
                origins.every((o) => state.permissions.granted.has(o)),
            ),
            remove: vi.fn(async ({ origins }: { origins: string[] }) => {
                origins.forEach((o) => state.permissions.granted.delete(o));
                return true;
            }),
        },
        scripting: {
            registerContentScripts: vi.fn(
                async (scripts: Array<{ id: string; matches: string[]; js: string[] }>) => {
                    state.registeredContentScripts.push(...scripts);
                },
            ),
            getRegisteredContentScripts: vi.fn(async (filter?: { ids?: string[] }) =>
                filter?.ids
                    ? state.registeredContentScripts.filter((s) => filter.ids!.includes(s.id))
                    : state.registeredContentScripts,
            ),
            unregisterContentScripts: vi.fn(async (filter: { ids: string[] }) => {
                state.registeredContentScripts = state.registeredContentScripts.filter(
                    (s) => !filter.ids.includes(s.id),
                );
                (globalThis as { chrome?: typeof chromeMock }).chrome!.scripting.getRegisteredContentScripts =
                    vi.fn(async (f?: { ids?: string[] }) =>
                        f?.ids
                            ? state.registeredContentScripts.filter((s) => f.ids!.includes(s.id))
                            : state.registeredContentScripts,
                    );
            }),
        },
        tabs: { query: vi.fn(async () => []), onRemoved: { addListener: vi.fn() } },
        windows: { create: vi.fn(async () => ({ id: 1 })), remove: vi.fn(async () => undefined) },
    };

    (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;

    return state;
}

/**
 * Removes the chrome mock from globalThis.
 */
export function uninstallChromeMock(): void {
    delete (globalThis as { chrome?: unknown }).chrome;
}
