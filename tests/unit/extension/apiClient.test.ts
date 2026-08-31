import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock the chrome.runtime API and fetch globally before importing the module.
 */
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/**
 * Re-import the module under test for each test to get a clean module state.
 */
async function getApiClient() {
    const module = await import('../../../extension/background/apiClient');
    return module;
}

/**
 * Provides a mock getToken implementation for authenticated requests.
 */
vi.mock('../../../extension/background/tokenManager', () => ({
    getToken: vi.fn(() => 'test-jwt-token'),
}));

describe('apiClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('successful requests', () => {
        it('should return success with parsed data on 200 response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ result: 'test-data' }),
            });

            const { apiRequest } = await getApiClient();
            const result = await apiRequest('/api/test');

            expect(result.success).toBe(true);
            expect(result.data).toEqual({ result: 'test-data' });
        });

        it('should pass signal to fetch for timeout enforcement', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({}),
            });

            const { apiRequest } = await getApiClient();
            await apiRequest('/api/test');

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const fetchCall = mockFetch.mock.calls[0];
            expect(fetchCall[1].signal).toBeDefined();
            expect(fetchCall[1].signal).toBeInstanceOf(AbortSignal);
        });
    });

    describe('error handling', () => {
        it('should return API_ERROR on non-ok response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                json: async () => ({
                    error: { code: 'FORBIDDEN', message: 'Access denied.' },
                }),
            });

            const { apiRequest } = await getApiClient();
            const result = await apiRequest('/api/test');

            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('FORBIDDEN');
        });

        it('should return NETWORK_ERROR on fetch failure', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

            const { apiRequest } = await getApiClient();
            const result = await apiRequest('/api/test');

            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('NETWORK_ERROR');
            expect(result.error?.message).toBe('Connection refused');
        });

        it('should return TIMEOUT error on AbortError', async () => {
            const abortError = new DOMException('The operation was aborted.', 'AbortError');
            mockFetch.mockRejectedValueOnce(abortError);

            const { apiRequest } = await getApiClient();
            const result = await apiRequest('/api/test');

            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('TIMEOUT');
            expect(result.error?.message).toBe('Request timed out. Please try again.');
        });

        it('should return NO_TOKEN when not authenticated', async () => {
            /**
             * Override the mock to return null for this test.
             */
            const tokenManager = await import('../../../extension/background/tokenManager');
            vi.mocked(tokenManager.getToken).mockReturnValueOnce(null);

            const { apiRequest } = await getApiClient();
            const result = await apiRequest('/api/test', { requireAuth: true });

            expect(result.success).toBe(false);
            expect(result.error?.code).toBe('NO_TOKEN');
        });
    });
});
