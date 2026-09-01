import { CONFIG } from '../shared/constants';
import { getBackendUrl } from '../shared/settings';
import type { ApiErrorResponse } from '../shared/types';
import { getToken, ensureFreshToken } from './tokenManager';

export interface ApiRequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    requireAuth?: boolean;
}

export interface ApiResult<T> {
    success: boolean;
    data?: T;
    error?: {
        code: string;
        message: string;
    };
}

/**
 * Fetch wrapper for backend API communication.
 * Resolves the user configured backend origin, injects the JWT from
 * tokenManager, parses JSON responses, and extracts error payloads.
 * Enforces a 30 second timeout via AbortController to prevent hanging requests.
 */
export async function apiRequest<T>(
    endpoint: string,
    options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
    const {
        method = 'GET',
        body,
        headers = {},
        requireAuth = true,
    } = options;

    const backendUrl = await getBackendUrl();

    if (!backendUrl) {
        return {
            success: false,
            error: {
                code: 'NOT_CONFIGURED',
                message: 'No backend configured. Open the extension options to set one up.',
            },
        };
    }

    const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
    };

    if (requireAuth) {
        // Renews a token the scheduled refresh may never have got to, before
        // spending the request on a 401.
        await ensureFreshToken();
        const token = await getToken();
        if (!token) {
            return {
                success: false,
                error: {
                    code: 'NO_TOKEN',
                    message: 'Not authenticated. Please log in.',
                },
            };
        }
        requestHeaders['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

    try {
        const response = await fetch(`${backendUrl}${endpoint}`, {
            method,
            headers: requestHeaders,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });

        // Not everything that answers on the backend's URL is the backend. A
        // proxy timing out, a captive portal, or a tunnel that has gone down
        // all reply with HTML, and parsing that as JSON throws a SyntaxError
        // whose message ("Unexpected token <") tells the agent nothing about
        // what to do next. The status code does.
        let json: unknown;
        try {
            json = await response.json();
        } catch {
            return {
                success: false,
                error: {
                    code: response.ok ? 'BAD_RESPONSE' : 'API_ERROR',
                    message: response.ok
                        ? 'The backend replied with something other than JSON. Check that the backend URL points at the API and not at a proxy or login page.'
                        : `The backend returned ${response.status} ${response.statusText || ''}`.trim(),
                },
            };
        }

        if (!response.ok) {
            const errorResponse = json as ApiErrorResponse;
            return {
                success: false,
                error: {
                    code: errorResponse.error?.code || 'API_ERROR',
                    message: errorResponse.error?.message || 'An unexpected error occurred.',
                },
            };
        }

        return {
            success: true,
            data: json as T,
        };
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return {
                success: false,
                error: {
                    code: 'TIMEOUT',
                    message: 'Request timed out. Please try again.',
                },
            };
        }
        const message = error instanceof Error ? error.message : 'Network error';
        return {
            success: false,
            error: {
                code: 'NETWORK_ERROR',
                message,
            },
        };
    } finally {
        clearTimeout(timeoutId);
    }
}
