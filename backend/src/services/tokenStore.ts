import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import { getPool } from './auditLogger.js';

/**
 * Durable storage for Bitrix24 OAuth tokens.
 *
 * Tokens used to live only in a process Map, so every restart, deploy, or
 * watchdog respawn silently de-authenticated every agent. They are persisted to
 * MySQL here, with the process Map kept as a read-through cache so the request
 * path still resolves tokens without a query in the common case.
 *
 * access_token and refresh_token are encrypted with AES-256-GCM before they
 * reach the database. When no DATABASE_URL is configured, which is the
 * documented development setup, the cache is the only store and tokens are
 * lost on restart exactly as before.
 */

export interface BitrixTokens {
    accessToken: string;
    refreshToken: string;
    clientEndpoint: string;
    domain: string;
    expiresAt: number;
}

interface TokenRow extends RowDataPacket {
    member_id: string;
    portal_domain: string;
    client_endpoint: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
}

const cache = new Map<string, BitrixTokens>();

const UPSERT_SQL = `
    INSERT INTO bitrix_tokens
        (member_id, portal_domain, client_endpoint, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        portal_domain   = VALUES(portal_domain),
        client_endpoint = VALUES(client_endpoint),
        access_token    = VALUES(access_token),
        refresh_token   = VALUES(refresh_token),
        expires_at      = VALUES(expires_at)
`;

const SELECT_SQL = `
    SELECT member_id, portal_domain, client_endpoint, access_token, refresh_token, expires_at
    FROM bitrix_tokens
    WHERE member_id = ?
`;

const DELETE_SQL = `DELETE FROM bitrix_tokens WHERE member_id = ?`;

/**
 * True when a database is configured. Without one the store degrades to the
 * in-process cache, which is acceptable for local development only.
 */
function isPersistent(): boolean {
    return Boolean(loadConfig().databaseUrl);
}

/**
 * Writes tokens to the cache and, when a database is configured, to MySQL.
 *
 * A failed database write is logged and swallowed: the tokens are already in
 * the cache, so the agent's current session keeps working and only durability
 * across a restart is lost. Failing the request instead would turn a storage
 * hiccup into a failed login.
 */
export async function storeBitrixTokens(
    memberId: string,
    tokens: BitrixTokens,
): Promise<void> {
    cache.set(memberId, tokens);

    if (!isPersistent()) {
        return;
    }

    try {
        const key = loadConfig().tokenEncryptionKey;
        await getPool().execute(UPSERT_SQL, [
            memberId,
            tokens.domain,
            tokens.clientEndpoint,
            encryptSecret(tokens.accessToken, key),
            encryptSecret(tokens.refreshToken, key),
            tokens.expiresAt,
        ]);
    } catch (error) {
        logger.error('Failed to persist Bitrix24 tokens', {
            memberId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * Reads tokens for a member, falling back to the database on a cache miss.
 * Returns undefined when the member has no stored tokens.
 */
export async function getBitrixTokens(memberId: string): Promise<BitrixTokens | undefined> {
    const cached = cache.get(memberId);
    if (cached) {
        return cached;
    }

    if (!isPersistent()) {
        return undefined;
    }

    try {
        const [rows] = await getPool().execute<TokenRow[]>(SELECT_SQL, [memberId]);
        const row = rows[0];

        if (!row) {
            return undefined;
        }

        const key = loadConfig().tokenEncryptionKey;
        const tokens: BitrixTokens = {
            accessToken: decryptSecret(row.access_token, key),
            refreshToken: decryptSecret(row.refresh_token, key),
            clientEndpoint: row.client_endpoint,
            domain: row.portal_domain,
            expiresAt: Number(row.expires_at),
        };

        cache.set(memberId, tokens);
        return tokens;
    } catch (error) {
        logger.error('Failed to load Bitrix24 tokens', {
            memberId,
            error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
}

/**
 * Removes a member's tokens from the cache and the database.
 * Returns true when the member had cached tokens.
 */
export async function removeBitrixTokens(memberId: string): Promise<boolean> {
    let existed = cache.delete(memberId);

    if (isPersistent()) {
        try {
            // The row counts as much as the cache entry. After a restart the
            // cache is empty while the tokens are still on disk, so reporting
            // only the cache would call a real logout a no-op.
            const [result] = await getPool().execute(DELETE_SQL, [memberId]);
            const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
            existed = existed || affected > 0;
        } catch (error) {
            logger.error('Failed to delete Bitrix24 tokens', {
                memberId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (existed) {
        logger.info('Bitrix24 tokens removed', { memberId });
    }

    return existed;
}

/**
 * Clears the in-process cache. Used for testing only; leaves the database
 * untouched.
 */
export function resetTokenCache(): void {
    cache.clear();
}
