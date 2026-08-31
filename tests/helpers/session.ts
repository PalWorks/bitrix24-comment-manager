/**
 * Shared helpers for tests that need an authenticated agent.
 *
 * Tests used to obtain a JWT by driving the OAuth callback with a mocked
 * Bitrix24 token endpoint. That coupled every comment, lead, and audit test to
 * the shape of the auth flow, so a change to the flow broke tests that were not
 * about auth at all. These helpers mint a session directly instead. The auth
 * flow itself is exercised in tests/integration/auth.flow.test.ts, which is
 * where that coverage belongs.
 */

export const TEST_PORTAL = 'test.bitrix24.com';
export const TEST_CLIENT_ENDPOINT = `https://${TEST_PORTAL}/rest/`;
export const TEST_MEMBER_ID = 'member-test';

/**
 * Sets the environment every backend module expects. Call this at module
 * scope, before importing anything from backend/src, because config is read at
 * import time in several modules.
 */
export function setTestEnv(overrides: Record<string, string> = {}): void {
    const defaults: Record<string, string> = {
        JWT_SECRET: 'integration-test-secret',
        JWT_EXPIRY_SECONDS: '3600',
        BITRIX24_CLIENT_ID: 'test-client-id',
        BITRIX24_CLIENT_SECRET: 'test-client-secret',
        BITRIX24_PORTAL_DOMAIN: TEST_PORTAL,
        BITRIX24_ALLOWED_PORTALS: `${TEST_PORTAL},*.bitrix24.de`,
        TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
        NODE_ENV: 'test',
    };

    for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
        process.env[key] = value;
    }
}

export interface TestSession {
    jwt: string;
    expiresAt: number;
    memberId: string;
    domain: string;
    clientEndpoint: string;
}

/**
 * Mints a JWT and registers matching Bitrix24 tokens so the agentAuth and
 * leadAuth middleware treat the caller as an active, mapped agent.
 *
 * Imports are dynamic so callers control when backend modules first load,
 * which matters because several read configuration at import time.
 */
export async function createSession(
    options: {
        memberId?: string;
        domain?: string;
        clientEndpoint?: string;
        accessToken?: string;
        refreshToken?: string;
    } = {},
): Promise<TestSession> {
    const { signJwt, storeBitrixTokens } = await import(
        '../../backend/src/services/tokenService'
    );

    const memberId = options.memberId ?? TEST_MEMBER_ID;
    const domain = options.domain ?? TEST_PORTAL;
    const clientEndpoint = options.clientEndpoint ?? TEST_CLIENT_ENDPOINT;

    await storeBitrixTokens(memberId, {
        accessToken: options.accessToken ?? 'bitrix-access-token-123',
        refreshToken: options.refreshToken ?? 'bitrix-refresh-token-456',
        clientEndpoint,
        domain,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const { token, expiresAt } = signJwt({ memberId, domain, clientEndpoint });

    return { jwt: token, expiresAt, memberId, domain, clientEndpoint };
}

/**
 * Mints a JWT without registering Bitrix24 tokens, for tests that assert an
 * agent with no mapping is rejected.
 */
export async function createUnmappedJwt(memberId = 'member-unmapped'): Promise<string> {
    const { signJwt } = await import('../../backend/src/services/tokenService');
    return signJwt({
        memberId,
        domain: TEST_PORTAL,
        clientEndpoint: TEST_CLIENT_ENDPOINT,
    }).token;
}
