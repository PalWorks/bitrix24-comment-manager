import { logger } from './utils/logger.js';

export interface AppConfig {
    port: number;
    nodeEnv: string;
    backendUrl: string;
    jwtSecret: string;
    jwtExpirySeconds: number;
    bitrix24ClientId: string;
    bitrix24ClientSecret: string;
    /**
     * Single portal shorthand. Empty when the deployment serves several
     * portals and configures bitrix24AllowedPortals instead.
     */
    bitrix24PortalDomain: string;
    /**
     * Portals this backend will authenticate against. Entries are lower case
     * hostnames, `*.suffix` wildcards, or the single entry `*` meaning any
     * portal. Never empty: loadConfig rejects a configuration with no portals.
     */
    bitrix24AllowedPortals: string[];
    corsOrigins: string[];
    databaseUrl: string;
    tokenEncryptionKey: string;
    maxCommentLength: number;
    duplicateWindowSeconds: number;
}

function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

function optionalEnv(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
}

/**
 * Builds the portal allowlist.
 *
 * BITRIX24_ALLOWED_PORTALS is the general form. BITRIX24_PORTAL_DOMAIN is the
 * single portal shorthand and is used when the list is not set, which keeps
 * existing single portal deployments working with no configuration change.
 */
function parsePortalList(allowedPortals: string, portalDomain: string): string[] {
    const source = allowedPortals.trim() || portalDomain.trim();

    const entries = source
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);

    if (entries.length === 0) {
        throw new Error(
            'No Bitrix24 portal configured. Set BITRIX24_ALLOWED_PORTALS (comma separated) or BITRIX24_PORTAL_DOMAIN.',
        );
    }

    return entries;
}

/**
 * Checks a portal hostname against the configured allowlist.
 *
 * Supported entry forms:
 *   acme.bitrix24.com   exact hostname
 *   *.bitrix24.com      any subdomain of the suffix, but not the bare suffix
 *   *                   any portal
 *
 * The host is compared case insensitively. Callers must have already validated
 * that `host` is a syntactically valid hostname.
 */
export function isPortalAllowed(host: string, allowed: string[]): boolean {
    const candidate = host.trim().toLowerCase();

    if (!candidate) {
        return false;
    }

    return allowed.some((entry) => {
        if (entry === '*') {
            return true;
        }
        if (entry.startsWith('*.')) {
            return candidate.endsWith(entry.slice(1)) && candidate !== entry.slice(2);
        }
        return candidate === entry;
    });
}

/**
 * Loads and validates all application configuration from environment variables.
 *
 * State and scaling, accurately:
 *   - Request authentication is stateless. A JWT is verified with the shared
 *     secret, so any instance can serve any request.
 *   - Bitrix24 OAuth tokens are persisted in MySQL and cached in process, so
 *     they survive a restart and are shared across instances.
 *   - Four stores remain per process and are NOT shared between instances:
 *     the JWT jti blacklist, the OAuth state store, the pending OAuth session
 *     map, and the rate limiter windows. Their consequences when running more
 *     than one instance:
 *       jti blacklist    a refreshed or logged out token stays usable on other
 *                        instances until it expires naturally
 *       oauth state      the login callback must reach the instance that
 *                        issued the state
 *       rate limiter     limits apply per instance, not globally
 *   - Running a single instance, which is the documented default, avoids all
 *     of the above. Moving these four stores to Redis is what a multi-instance
 *     deployment needs, and is tracked in the README roadmap.
 */
export function loadConfig(): AppConfig {
    const config: AppConfig = {
        port: parseInt(optionalEnv('PORT', '3000'), 10),
        nodeEnv: optionalEnv('NODE_ENV', 'development'),
        backendUrl: optionalEnv('BACKEND_URL', 'http://localhost:3000'),
        jwtSecret: requireEnv('JWT_SECRET'),
        jwtExpirySeconds: parseInt(optionalEnv('JWT_EXPIRY_SECONDS', '3600'), 10),
        bitrix24ClientId: requireEnv('BITRIX24_CLIENT_ID'),
        bitrix24ClientSecret: requireEnv('BITRIX24_CLIENT_SECRET'),
        bitrix24PortalDomain: optionalEnv('BITRIX24_PORTAL_DOMAIN', '').trim().toLowerCase(),
        bitrix24AllowedPortals: parsePortalList(
            optionalEnv('BITRIX24_ALLOWED_PORTALS', ''),
            optionalEnv('BITRIX24_PORTAL_DOMAIN', ''),
        ),
        corsOrigins: optionalEnv('CORS_ORIGINS', '*').split(',').map((s) => s.trim()),
        databaseUrl: optionalEnv('DATABASE_URL', ''),
        tokenEncryptionKey: optionalEnv('TOKEN_ENCRYPTION_KEY', ''),
        maxCommentLength: parseInt(optionalEnv('MAX_COMMENT_LENGTH', '5000'), 10),
        duplicateWindowSeconds: parseInt(optionalEnv('DUPLICATE_WINDOW_SECONDS', '300'), 10),
    };

    if (config.nodeEnv === 'production' && config.corsOrigins.includes('*')) {
        logger.warn('CORS_ORIGINS is set to wildcard (*) in production. Set explicit origins.');
    }

    if (config.nodeEnv === 'production' && !config.databaseUrl) {
        throw new Error('DATABASE_URL is required in production.');
    }

    if (config.nodeEnv === 'production' && !config.tokenEncryptionKey) {
        throw new Error(
            'TOKEN_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32',
        );
    }

    if (config.tokenEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(config.tokenEncryptionKey)) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
    }

    if (config.bitrix24AllowedPortals.includes('*')) {
        logger.warn(
            'BITRIX24_ALLOWED_PORTALS is set to wildcard (*). This backend will start an OAuth flow for any portal.',
        );
    }

    return config;
}
