import type { AuthState } from '../shared/types';
import { apiRequest } from './apiClient';
import {
    storeToken,
    clearToken,
    getToken,
    isAuthenticated,
    getExpiresAt,
    parseJwtClaims,
} from './tokenManager';
import { getBackendUrl } from '../shared/settings';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initiates the Bitrix24 OAuth2 login flow using a server-side callback.
 *
 * Bitrix24 validates the redirect URI against the handler registered with the
 * application, so the redirect has to land on the backend rather than on a
 * chrome-extension:// URL. The flow is therefore:
 *
 * 1. GET /auth/login?portal=<portal> asks the backend for an authorization URL.
 *    The backend builds it against its own /auth/callback and returns a state.
 * 2. The authorization URL opens in a small popup window so the user stays on
 *    the Bitrix24 page behind it.
 * 3. GET /auth/poll?state=<state> is polled until the backend reports the JWT.
 * 4. The JWT is handed to tokenManager and the popup window is closed.
 *
 * @param portal Optional portal hostname. Sent to the backend so a backend
 *               serving several portals knows which one to authorize against.
 */
export async function initiateLogin(portal?: string): Promise<AuthState> {
    const query = portal ? `?portal=${encodeURIComponent(portal)}` : '';

    const loginResult = await apiRequest<{ authUrl: string; state: string }>(
        `/auth/login${query}`,
        { method: 'GET', requireAuth: false },
    );

    if (!loginResult.success || !loginResult.data) {
        return {
            isAuthenticated: false,
            error: loginResult.error?.message ?? 'Could not start the login flow.',
        };
    }

    const { authUrl, state } = loginResult.data;

    const win = await chrome.windows.create({
        url: authUrl,
        type: 'popup',
        width: 520,
        height: 680,
        focused: true,
    });
    const winId = win.id;

    try {
        const result = await pollForSession(state);

        if (!result) {
            return {
                isAuthenticated: false,
                error: 'Authorization did not complete. Please try again.',
            };
        }

        await storeToken(result.jwt, result.expiresAt);

        return {
            isAuthenticated: true,
            memberId: result.memberId,
            domain: result.domain,
            expiresAt: result.expiresAt,
        };
    } finally {
        if (winId !== undefined) {
            chrome.windows.remove(winId).catch(() => { });
        }
    }
}

/**
 * Polls the backend's /auth/poll endpoint until the OAuth session JWT is ready
 * or the timeout is reached.
 */
async function pollForSession(
    state: string,
): Promise<{ jwt: string; expiresAt: number; memberId: string; domain: string } | null> {
    const backendUrl = await getBackendUrl();

    if (!backendUrl) {
        return null;
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);

        try {
            const response = await fetch(
                `${backendUrl}/auth/poll?state=${encodeURIComponent(state)}`,
                { method: 'GET', signal: AbortSignal.timeout(5_000) },
            );

            if (response.status === 404) {
                return null;
            }

            if (!response.ok) {
                continue;
            }

            const data = await response.json();

            if (data.pending) {
                continue;
            }

            if (data.jwt && data.expiresAt && data.memberId && data.domain) {
                return data as {
                    jwt: string;
                    expiresAt: number;
                    memberId: string;
                    domain: string;
                };
            }
        } catch {
            continue;
        }
    }

    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Logs out by sending POST /auth/logout to the backend
 * and clearing the locally stored token.
 */
export async function initiateLogout(): Promise<void> {
    await apiRequest('/auth/logout', { method: 'POST' });
    await clearToken();
}

/**
 * Returns the current authentication state by reading from tokenManager.
 * Parses JWT claims to extract user display data.
 */
export async function getAuthStatus(): Promise<AuthState> {
    if (!(await isAuthenticated())) {
        return { isAuthenticated: false };
    }

    const token = await getToken();

    if (!token) {
        return { isAuthenticated: false };
    }

    const claims = parseJwtClaims(token);

    return {
        isAuthenticated: true,
        memberId: claims?.memberId as string | undefined,
        domain: claims?.domain as string | undefined,
        expiresAt: (await getExpiresAt()) ?? undefined,
    };
}
