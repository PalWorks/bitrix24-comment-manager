import { CONFIG } from '../shared/constants';
import { getBackendUrl } from '../shared/settings';
import type { ApiErrorResponse } from '../shared/types';
import { getToken } from './tokenManager';

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

        const json = await response.json();

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
