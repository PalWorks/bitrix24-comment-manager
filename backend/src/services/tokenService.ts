import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { loadConfig, AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { resetTokenCache } from './tokenStore.js';

export interface JwtPayload {
    memberId: string;
    domain: string;
    clientEndpoint: string;
    jti: string;
    iat: number;
    exp: number;
}

interface OAuthState {
    value: string;
    createdAt: number;
}

const STATE_EXPIRY_MS = 300_000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60_000; // 60 seconds

const jtiBlacklist = new Map<string, number>();
const oauthStateStore = new Map<string, OAuthState>();

let cachedConfig: AppConfig | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function getConfig(): AppConfig {
    if (!cachedConfig) {
        cachedConfig = loadConfig();
    }
    return cachedConfig;
}

/**
 * Removes expired entries from the JTI blacklist.
 * Entries are considered expired when the corresponding JWT's exp timestamp
 * is in the past.
 */
function pruneExpiredBlacklistEntries(): void {
    const now = Math.floor(Date.now() / 1000);
    let prunedCount = 0;
    for (const [jti, exp] of jtiBlacklist) {
        if (exp < now) {
            jtiBlacklist.delete(jti);
            prunedCount++;
        }
    }
    if (prunedCount > 0) {
        logger.debug('Pruned expired JTI blacklist entries', { count: prunedCount });
    }
}

/**
 * Removes expired entries from the OAuth state store.
 * States older than STATE_EXPIRY_MS are cleaned up.
 */
function pruneExpiredStates(): void {
    const cutoff = Date.now() - STATE_EXPIRY_MS;
    let prunedCount = 0;
    for (const [state, data] of oauthStateStore) {
        if (data.createdAt < cutoff) {
            oauthStateStore.delete(state);
            prunedCount++;
        }
    }
    if (prunedCount > 0) {
        logger.debug('Pruned expired OAuth states', { count: prunedCount });
    }
}

/**
 * Starts the periodic cleanup timer for expired blacklist entries
 * and OAuth states. Safe to call multiple times; subsequent calls are no-ops.
 */
function startCleanupTimers(): void {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        pruneExpiredBlacklistEntries();
        pruneExpiredStates();
    }, CLEANUP_INTERVAL_MS);
    if (cleanupTimer.unref) {
        cleanupTimer.unref();
    }
}

/**
 * Stops the periodic cleanup timer. Used for graceful shutdown and testing.
 */
export function stopCleanupTimers(): void {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

startCleanupTimers();

/**
 * Generates a cryptographically random state string and stores it for CSRF validation.
 * Returns the state value for inclusion in the OAuth2 authorization URL.
 */
export function generateOAuthState(): string {
    const state = crypto.randomBytes(32).toString('hex');
    oauthStateStore.set(state, {
        value: state,
        createdAt: Date.now(),
    });
    return state;
}

/**
 * Validates a returned OAuth2 state against stored values.
 * Removes the state on successful validation (single-use).
 * Returns true if the state is valid and not expired.
 */
export function validateOAuthState(state: string): boolean {
    const stored = oauthStateStore.get(state);
    if (!stored) {
        return false;
    }
    oauthStateStore.delete(state);

    const elapsed = Date.now() - stored.createdAt;
    if (elapsed > STATE_EXPIRY_MS) {
        logger.warn('OAuth state expired', { state: state.substring(0, 8) });
        return false;
    }
    return true;
}

/**
 * Signs a JWT with the provided claims.
 * Generates a unique jti for blacklist tracking.
 */
export function signJwt(claims: {
    memberId: string;
    domain: string;
    clientEndpoint: string;
}): { token: string; expiresAt: number } {
    const config = getConfig();
    const jti = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + config.jwtExpirySeconds;

    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
        memberId: claims.memberId,
        domain: claims.domain,
        clientEndpoint: claims.clientEndpoint,
        jti,
    };

    const token = jwt.sign(payload, config.jwtSecret, {
        expiresIn: config.jwtExpirySeconds,
    });

    return { token, expiresAt };
}

/**
 * Verifies a JWT and checks that its jti is not blacklisted.
 * Returns the decoded payload on success, or null on failure.
 */
export function verifyJwt(token: string): JwtPayload | null {
    const config = getConfig();

    try {
        const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;

        if (jtiBlacklist.has(decoded.jti)) {
            logger.warn('Rejected blacklisted JWT', { jti: decoded.jti });
            return null;
        }

        return decoded;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown verification error';
        logger.debug('JWT verification failed', { error: message });
        return null;
    }
}

/**
 * Adds a JWT's jti to the blacklist with its expiry timestamp,
 * preventing further use. The entry will be automatically pruned
 * after the JWT's natural expiration.
 */
export function blacklistJwt(jti: string, exp?: number): void {
    const effectiveExp = exp ?? Math.floor(Date.now() / 1000) + getConfig().jwtExpirySeconds;
    jtiBlacklist.set(jti, effectiveExp);
    logger.info('JWT blacklisted', { jti });
}

/**
 * Bitrix24 OAuth token storage lives in tokenStore, which persists to MySQL.
 * Re-exported here so callers have a single import for session concerns.
 */
export {
    storeBitrixTokens,
    getBitrixTokens,
    removeBitrixTokens,
    type BitrixTokens,
} from './tokenStore.js';

/**
 * Clears all in-memory state. Used for testing only.
 */
export function resetAllState(): void {
    jtiBlacklist.clear();
    oauthStateStore.clear();
    cachedConfig = null;
    stopCleanupTimers();
    resetTokenCache();
}
