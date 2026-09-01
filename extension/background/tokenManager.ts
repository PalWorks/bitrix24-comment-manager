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
let cacheLoading: Promise<void> | null = null;

let refreshTimerId: ReturnType<typeof setTimeout> | null = null;

/**
 * Consecutive refresh attempts that failed to reach a verdict. Resets on the
 * first success, and drives the retry backoff so a backend that is down does
 * not get hammered by every installed extension at a fixed interval.
 */
let refreshFailures = 0;

const REFRESH_RETRY_BASE_MS = 30_000;
const REFRESH_RETRY_MAX_MS = 5 * 60_000;

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

    // Several handlers can wake the worker at once and all reach for the token.
    // Without coalescing each issues its own storage read, and a persist landing
    // between one read and its assignment would be overwritten by the loser.
    if (!cacheLoading) {
        cacheLoading = (async () => {
            try {
                const stored = (await chrome.storage.session.get(TOKEN_KEY)) as {
                    auth?: StoredToken;
                };
                cached = stored.auth ?? null;
            } catch {
                cached = null;
            }
            cacheLoaded = true;
            cacheLoading = null;
        })();
    }

    return cacheLoading;
}

async function persist(value: StoredToken | null): Promise<void> {
    cached = value;
    cacheLoaded = true;
    cacheLoading = null;
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
 * Refreshes the token now if it is close enough to expiry to be worth it.
 *
 * The scheduled refresh runs on a setTimeout, and Manifest V3 discards timers
 * whenever it decides the worker has been idle long enough. resumeSession
 * reinstates the schedule when the worker next starts, but nothing starts a
 * worker just because a token is ageing: leave the browser open overnight and
 * the timer that should have fired at 3am never existed to fire.
 *
 * Checking here closes that gap without a new permission, because the moment an
 * agent actually uses the extension is a moment the worker is awake and a
 * request is about to be made anyway.
 */
export async function ensureFreshToken(): Promise<void> {
    await loadCache();

    if (!cached) {
        return;
    }

    const refreshAtMs = (cached.expiresAt - CONFIG.JWT_REFRESH_BUFFER_SECONDS) * 1000;

    if (Date.now() >= refreshAtMs) {
        await refreshToken();
    }
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
 * Handles a refresh that did not complete for a reason that says nothing about
 * whether the session is still good: a timeout, a dropped connection, a backend
 * that answered 502 through a proxy.
 *
 * The token in hand is still valid until its own expiry, so throwing it away
 * here would log the agent out over a momentary loss of signal, mid-sentence,
 * with a comment half typed. Instead the existing token is kept and the refresh
 * is retried, backing off, for as long as there is validity left to save. Only
 * when the token has actually expired is the session given up.
 */
async function handleTransientRefreshFailure(reason: string): Promise<void> {
    const stillValid = cached !== null && cached.expiresAt * 1000 > Date.now();

    if (!stillValid) {
        await clearToken();
        return;
    }

    refreshFailures += 1;

    const backoffMs = Math.min(
        REFRESH_RETRY_BASE_MS * Math.pow(2, refreshFailures - 1),
        REFRESH_RETRY_MAX_MS,
    );
    const msUntilExpiry = cached!.expiresAt * 1000 - Date.now();

    // Never schedule past the point where the token dies anyway; at that moment
    // the retry becomes the last chance rather than one of many.
    const delayMs = Math.max(0, Math.min(backoffMs, msUntilExpiry));

    console.warn(
        `[tokenManager] Token refresh failed (${reason}). Keeping the current token and retrying in ${Math.round(delayMs / 1000)}s.`,
    );

    clearRefreshTimer();
    refreshTimerId = setTimeout(() => {
        void refreshToken();
    }, delayMs);
}

/**
 * Performs the actual token refresh network call.
 *
 * A refusal by the backend clears the token, because the session really is
 * over. A failure to reach the backend does not: see
 * handleTransientRefreshFailure.
 *
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

        if (response.status === 401 || response.status === 403) {
            // The backend has rejected this token outright: expired, revoked, or
            // signed by a key that no longer applies. No amount of retrying
            // changes that answer.
            await clearToken();
            return;
        }

        if (!response.ok) {
            await handleTransientRefreshFailure(`HTTP ${response.status}`);
            return;
        }

        const data = (await response.json()) as AuthLoginResponse;
        refreshFailures = 0;
        await persist({ jwt: data.jwt, expiresAt: data.expiresAt });
        scheduleRefresh(data.expiresAt);
    } catch (error) {
        const reason =
            error instanceof DOMException && error.name === 'AbortError'
                ? 'timed out'
                : error instanceof Error
                    ? error.message
                    : 'network error';
        await handleTransientRefreshFailure(reason);
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
    cacheLoading = null;
    refreshInProgress = null;
    refreshFailures = 0;
    clearRefreshTimer();
}
