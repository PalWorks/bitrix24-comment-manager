import { CONFIG } from '../shared/constants';
import { getBackendUrl } from '../shared/settings';
import type { AuthLoginResponse } from '../shared/types';

/**
 * Session storage key for the persisted JWT.
 *
 * The token lives in chrome.storage.session rather than a module variable
 * because Manifest V3 terminates an idle service worker, which would otherwise
 * discard the token and log the agent out mid-session. Session storage is held
 * in memory, cleared when the browser closes, and is not readable by content
 * scripts, so it keeps the token off disk while surviving worker restarts.
 */
const TOKEN_KEY = 'auth';

interface StoredToken {
    jwt: string;
    expiresAt: number;
}

/** In-process cache so the hot path avoids an async storage read every request. */
let cached: StoredToken | null = null;
let cacheLoaded = false;

let refreshTimerId: ReturnType<typeof setTimeout> | null = null;

/**
 * Guard that tracks an in-flight refresh promise. When set, concurrent
 * callers coalesce onto the same promise instead of issuing duplicate
 * refresh requests.
 */
let refreshInProgress: Promise<void> | null = null;

/**
 * Loads the token from session storage into the in-process cache.
 * Runs once per service worker lifetime.
 */
async function loadCache(): Promise<void> {
    if (cacheLoaded) {
        return;
    }
    try {
        const stored = (await chrome.storage.session.get(TOKEN_KEY)) as {
            auth?: StoredToken;
        };
        cached = stored.auth ?? null;
    } catch {
        cached = null;
    }
    cacheLoaded = true;
}

async function persist(value: StoredToken | null): Promise<void> {
    cached = value;
    cacheLoaded = true;
    try {
        if (value) {
            await chrome.storage.session.set({ [TOKEN_KEY]: value });
        } else {
            await chrome.storage.session.remove(TOKEN_KEY);
        }
    } catch {
        // Storage unavailable. The in-process cache still serves this session.
    }
}

/**
 * Stores a JWT and schedules an automatic refresh 5 minutes before expiry.
 */
export async function storeToken(jwt: string, expiresAt: number): Promise<void> {
    clearRefreshTimer();
    await persist({ jwt, expiresAt });
    scheduleRefresh(expiresAt);
}

/**
 * Returns the currently stored JWT, or null if not authenticated.
 */
export async function getToken(): Promise<string | null> {
    await loadCache();
    return cached?.jwt ?? null;
}

/**
 * Clears the stored JWT and cancels any pending refresh timer.
 */
export async function clearToken(): Promise<void> {
    clearRefreshTimer();
    await persist(null);
}

/**
 * Returns true if a JWT is currently stored and has not already expired.
 */
export async function isAuthenticated(): Promise<boolean> {
    await loadCache();
    if (!cached) {
        return false;
    }
    if (cached.expiresAt * 1000 <= Date.now()) {
        await clearToken();
        return false;
    }
    return true;
}

/**
 * Returns the stored expiry timestamp (Unix seconds), or null.
 */
export async function getExpiresAt(): Promise<number | null> {
    await loadCache();
    return cached?.expiresAt ?? null;
}

/**
 * Parses the JWT payload (base64url) to extract claims without verification.
 * Used only for reading display data on the client side.
 */
export function parseJwtClaims(token: string): Record<string, unknown> | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) {
            return null;
        }
        const payload = parts[1];
        const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

/**
 * Restores the refresh schedule after a service worker restart.
 *
 * The worker can be terminated at any time, taking its setTimeout with it. On
 * the next startup this reinstates the timer from the persisted expiry so the
 * token still refreshes ahead of time.
 */
export async function resumeSession(): Promise<void> {
    await loadCache();
    if (cached) {
        scheduleRefresh(cached.expiresAt);
    }
}

/**
 * Schedules a token refresh 5 minutes before expiry.
 * If the token is already within the refresh window, triggers immediately.
 */
function scheduleRefresh(expiresAt: number): void {
    clearRefreshTimer();

    const refreshAtMs = (expiresAt - CONFIG.JWT_REFRESH_BUFFER_SECONDS) * 1000;
    const delayMs = refreshAtMs - Date.now();

    if (delayMs <= 0) {
        void refreshToken();
        return;
    }

    refreshTimerId = setTimeout(() => {
        void refreshToken();
    }, delayMs);
}

/**
 * Cancels the pending refresh timer.
 */
function clearRefreshTimer(): void {
    if (refreshTimerId !== null) {
        clearTimeout(refreshTimerId);
        refreshTimerId = null;
    }
}

/**
 * Attempts to refresh the JWT by calling the backend.
 * Uses a guard so concurrent callers share a single network request.
 */
export async function refreshToken(): Promise<void> {
    if (refreshInProgress) {
        return refreshInProgress;
    }

    refreshInProgress = performRefresh();
    try {
        await refreshInProgress;
    } finally {
        refreshInProgress = null;
    }
}

/**
 * Performs the actual token refresh network call.
 * On failure, clears the token to trigger a re-authentication state.
 * Enforces a 30 second timeout via AbortController.
 */
async function performRefresh(): Promise<void> {
    await loadCache();

    if (!cached) {
        return;
    }

    const backendUrl = await getBackendUrl();
    if (!backendUrl) {
        await clearToken();
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

    try {
        const response = await fetch(`${backendUrl}/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cached.jwt}`,
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            await clearToken();
            return;
        }

        const data = (await response.json()) as AuthLoginResponse;
        await persist({ jwt: data.jwt, expiresAt: data.expiresAt });
        scheduleRefresh(data.expiresAt);
    } catch {
        await clearToken();
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Resets all module state. Used for testing only.
 */
export function _resetForTesting(): void {
    cached = null;
    cacheLoaded = false;
    refreshInProgress = null;
    clearRefreshTimer();
}
