import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../helpers/chromeMock';

/**
 * How the extension behaves when the network is bad rather than absent.
 *
 * The distinction matters more here than anywhere else in the codebase: an
 * agent on hotel wifi is not an agent whose session has ended, and treating the
 * two the same is how a working session gets thrown away mid-sentence.
 */

const BACKEND = 'https://backend.example.com';

async function getTokenManager() {
    return import('../../../extension/background/tokenManager');
}

function futureExpiry(seconds = 3600): number {
    return Math.floor(Date.now() / 1000) + seconds;
}

describe('token refresh over an unreliable network', () => {
    let chromeState: ChromeMock;

    beforeEach(() => {
        vi.resetModules();
        chromeState = installChromeMock();
        chromeState.storage.local.settings = { backendUrl: BACKEND, portals: [] };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        uninstallChromeMock();
    });

    it('keeps a valid token when the refresh call cannot reach the backend', async () => {
        const tm = await getTokenManager();
        // Far enough out that the token is still good, close enough that a
        // refresh is due.
        await tm.storeToken('still-good-jwt', futureExpiry(240));

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            }),
        );

        await tm.refreshToken();

        // The agent is still signed in. Before the audit this cleared the
        // token, logging them out because a single request timed out.
        expect(await tm.getToken()).toBe('still-good-jwt');
    });

    it('keeps a valid token when the backend answers 502 through a proxy', async () => {
        const tm = await getTokenManager();
        await tm.storeToken('still-good-jwt', futureExpiry(240));

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
        );

        await tm.refreshToken();

        expect(await tm.getToken()).toBe('still-good-jwt');
    });

    it('clears the token when the backend actually rejects it', async () => {
        const tm = await getTokenManager();
        await tm.storeToken('revoked-jwt', futureExpiry(240));

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
        );

        await tm.refreshToken();

        // A 401 is an answer, not a failure to get one. Retrying cannot change it.
        expect(await tm.getToken()).toBeNull();
    });

    it('gives up once the token it was protecting has expired anyway', async () => {
        const tm = await getTokenManager();
        await tm.storeToken('expiring-jwt', futureExpiry(-1));

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            }),
        );

        await tm.refreshToken();

        expect(await tm.getToken()).toBeNull();
    });

    it('renews a token that is past its refresh point before spending a request on it', async () => {
        const tm = await getTokenManager();
        await tm.storeToken('ageing-jwt', futureExpiry(60));

        const fetchSpy = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ jwt: 'renewed-jwt', expiresAt: futureExpiry() }),
        }));
        vi.stubGlobal('fetch', fetchSpy);

        await tm.ensureFreshToken();

        expect(await tm.getToken()).toBe('renewed-jwt');
    });

    it('leaves a token that is nowhere near expiry alone', async () => {
        const tm = await getTokenManager();
        await tm.storeToken('fresh-jwt', futureExpiry(3600));

        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        await tm.ensureFreshToken();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await tm.getToken()).toBe('fresh-jwt');
    });
});

describe('apiClient against a response that is not the backend', () => {
    let chromeState: ChromeMock;

    beforeEach(() => {
        vi.resetModules();
        chromeState = installChromeMock();
        chromeState.storage.local.settings = { backendUrl: BACKEND, portals: [] };
        chromeState.storage.session.auth = { jwt: 'jwt', expiresAt: futureExpiry() };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        uninstallChromeMock();
    });

    it('explains an HTML error page instead of leaking a JSON parse error', async () => {
        // A proxy timing out, a captive portal, or a tunnel that has gone down
        // all answer with HTML. Parsing that as JSON throws "Unexpected token
        // <", which tells the agent nothing they can act on.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 502,
                statusText: 'Bad Gateway',
                json: async () => {
                    throw new SyntaxError('Unexpected token < in JSON at position 0');
                },
            })),
        );

        const { apiRequest } = await import('../../../extension/background/apiClient');
        const result = await apiRequest('/api/comments', { requireAuth: false });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('API_ERROR');
        expect(result.error?.message).toContain('502');
        expect(result.error?.message).not.toContain('Unexpected token');
    });

    it('names the likely cause when a 200 carries something other than JSON', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => {
                    throw new SyntaxError('Unexpected token <');
                },
            })),
        );

        const { apiRequest } = await import('../../../extension/background/apiClient');
        const result = await apiRequest('/api/comments', { requireAuth: false });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('BAD_RESPONSE');
        expect(result.error?.message).toMatch(/proxy|login page/i);
    });
});
