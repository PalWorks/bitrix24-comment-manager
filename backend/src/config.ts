import { randomBytes } from 'crypto';
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
    /**
     * Resend API key. Empty disables the support endpoint, which is the
     * correct default for a self hosted instance that has no mailbox of its
     * own to deliver to.
     */
    resendApiKey: string;
    /** Verified sender. Fixed by configuration, never taken from a request. */
    supportFromEmail: string;
    /** Where support messages land. Fixed by configuration. */
    supportToEmail: string;
    /** Largest decoded attachment accepted on the support endpoint. */
    supportMaxAttachmentBytes: number;
    /**
     * Runs this process as a support mailbox and nothing else.
     *
     * The support form has to reach a server the publisher runs, which is not
     * the server any individual user runs. That instance has no Bitrix24
     * application, no portal and no audit log, so demanding those would force
     * an operator to invent credentials that are never used, and leave a
     * half wired auth flow answering requests. In this mode the Bitrix24 and
     * database requirements are lifted and the comment routes are not mounted.
     */
    supportOnly: boolean;
    /**
     * How many reverse proxies sit in front of this process.
     *
     * Without it Express reports the proxy's address as req.ip, so every
     * client shares one bucket and the per IP rate limiters stop limiting
     * anyone individually while limiting everyone collectively. It is a hop
     * count rather than a boolean because a client can prepend entries to
     * X-Forwarded-For but cannot affect the rightmost ones: trusting exactly
     * the number of proxies that really exist is what makes the header safe
     * to read. Too high and a client can forge its own address.
     */
    trustProxy: number;
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
function parsePortalList(
    allowedPortals: string,
    portalDomain: string,
    required = true,
): string[] {
    const source = allowedPortals.trim() || portalDomain.trim();

    const entries = source
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);

    if (entries.length === 0 && required) {
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
    const supportOnly = /^(1|true|yes)$/i.test(optionalEnv('SUPPORT_ONLY', '').trim());

    // In support only mode nothing signs or verifies a JWT, so requiring a
    // secret would be configuration for its own sake. A random one keeps the
    // type honest and fails loudly if anything ever does try to sign with it
    // across a restart.
    const requireOrSupportOnly = (key: string): string =>
        supportOnly ? optionalEnv(key, '') : requireEnv(key);

    const config: AppConfig = {
        port: parseInt(optionalEnv('PORT', '3000'), 10),
        nodeEnv: optionalEnv('NODE_ENV', 'development'),
        backendUrl: optionalEnv('BACKEND_URL', 'http://localhost:3000'),
        jwtSecret: supportOnly
            ? optionalEnv('JWT_SECRET', randomBytes(32).toString('hex'))
            : requireEnv('JWT_SECRET'),
        jwtExpirySeconds: parseInt(optionalEnv('JWT_EXPIRY_SECONDS', '3600'), 10),
        bitrix24ClientId: requireOrSupportOnly('BITRIX24_CLIENT_ID'),
        bitrix24ClientSecret: requireOrSupportOnly('BITRIX24_CLIENT_SECRET'),
        bitrix24PortalDomain: optionalEnv('BITRIX24_PORTAL_DOMAIN', '').trim().toLowerCase(),
        bitrix24AllowedPortals: parsePortalList(
            optionalEnv('BITRIX24_ALLOWED_PORTALS', ''),
            optionalEnv('BITRIX24_PORTAL_DOMAIN', ''),
            !supportOnly,
        ),
        corsOrigins: optionalEnv('CORS_ORIGINS', '*').split(',').map((s) => s.trim()),
        databaseUrl: optionalEnv('DATABASE_URL', ''),
        tokenEncryptionKey: optionalEnv('TOKEN_ENCRYPTION_KEY', ''),
        maxCommentLength: parseInt(optionalEnv('MAX_COMMENT_LENGTH', '5000'), 10),
        duplicateWindowSeconds: parseInt(optionalEnv('DUPLICATE_WINDOW_SECONDS', '300'), 10),
        resendApiKey: optionalEnv('RESEND_API_KEY', '').trim(),
        supportFromEmail: optionalEnv('SUPPORT_FROM_EMAIL', '').trim(),
        supportToEmail: optionalEnv('SUPPORT_TO_EMAIL', '').trim(),
        supportMaxAttachmentBytes: parseInt(
            optionalEnv('SUPPORT_MAX_ATTACHMENT_BYTES', String(5 * 1024 * 1024)),
            10,
        ),
        supportOnly,
        trustProxy: Math.max(0, parseInt(optionalEnv('TRUST_PROXY', '0'), 10) || 0),
    };

    if (config.nodeEnv === 'production' && config.corsOrigins.includes('*')) {
        logger.warn('CORS_ORIGINS is set to wildcard (*) in production. Set explicit origins.');
    }

    if (config.nodeEnv === 'production' && !config.supportOnly && !config.databaseUrl) {
        throw new Error('DATABASE_URL is required in production.');
    }

    if (config.nodeEnv === 'production' && !config.supportOnly && !config.tokenEncryptionKey) {
        throw new Error(
            'TOKEN_ENCRYPTION_KEY is required in production. Generate one with: openssl rand -hex 32',
        );
    }

    if (config.tokenEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(config.tokenEncryptionKey)) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
    }

    const supportFields = [
        config.resendApiKey,
        config.supportFromEmail,
        config.supportToEmail,
    ];
    if (supportFields.some(Boolean) && !supportFields.every(Boolean)) {
        throw new Error(
            'Support mail is half configured. Set all of RESEND_API_KEY, SUPPORT_FROM_EMAIL and SUPPORT_TO_EMAIL, or none of them.',
        );
    }

    // The mode exists to answer the support form, so a support only instance
    // with no mailbox would start up and do nothing at all.
    if (config.supportOnly && !supportFields.every(Boolean)) {
        throw new Error(
            'SUPPORT_ONLY is set but no mailbox is configured. Set RESEND_API_KEY, SUPPORT_FROM_EMAIL and SUPPORT_TO_EMAIL.',
        );
    }

    if (config.supportOnly) {
        logger.info('Running in support only mode. Comment and auth routes are not served.');
    }

    if (config.nodeEnv === 'production' && config.trustProxy === 0) {
        logger.warn(
            'TRUST_PROXY is 0. If a reverse proxy fronts this server, every client shares one rate limit bucket. Set it to the number of proxies in front.',
        );
    }

    if (config.bitrix24AllowedPortals.includes('*')) {
        logger.warn(
            'BITRIX24_ALLOWED_PORTALS is set to wildcard (*). This backend will start an OAuth flow for any portal.',
        );
    }

    return config;
}
