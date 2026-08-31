import mysql from 'mysql2/promise';
import { loadConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import type { AuditLogEntry, ActivityLogRow } from '../models/auditLog.js';

let pool: mysql.Pool | null = null;

/**
 * Tracks in-flight audit write promises so the shutdown sequence
 * can drain them before closing the database pool.
 */
const pendingWrites = new Set<Promise<void>>();

/**
 * Returns the shared MySQL connection pool, creating it lazily
 * on first call using the DATABASE_URL from config.
 */
export function getPool(): mysql.Pool {
    if (!pool) {
        const config = loadConfig();
        pool = mysql.createPool(config.databaseUrl);
    }
    return pool;
}

/**
 * Replaces the internal pool reference. Used exclusively in tests
 * to inject a mock pool without touching the real database.
 */
export function setPool(mockPool: mysql.Pool): void {
    pool = mockPool;
}

const INSERT_SQL = `
    INSERT INTO comment_audit_log
        (agent_id, bitrix_user_id, portal_domain, lead_id, comment_id, action_type,
         comment_hash, timestamp, ip_address, status, failure_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Writes a single audit log entry to the database.
 *
 * This function follows the fire and forget pattern:
 *   - It is invoked without `await` from route handlers so it never
 *     blocks the HTTP response path.
 *   - It never throws. Any database errors are caught and logged internally.
 *   - The raw comment body is NEVER stored; only its SHA-256 hash.
 *   - The write promise is tracked in `pendingWrites` so shutdown can drain it.
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
    const writePromise = (async () => {
        try {
            const db = getPool();
            await db.execute(INSERT_SQL, [
                entry.agent_id,
                entry.bitrix_user_id,
                entry.portal_domain,
                entry.lead_id,
                entry.comment_id,
                entry.action_type,
                entry.comment_hash,
                entry.timestamp,
                entry.ip_address,
                entry.status,
                entry.failure_reason,
            ]);
        } catch (error) {
            logger.error('Failed to write audit log entry', {
                agent_id: entry.agent_id,
                action_type: entry.action_type,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    })();

    pendingWrites.add(writePromise);
    writePromise.finally(() => pendingWrites.delete(writePromise));

    await writePromise;
}

/**
 * Waits for all in-flight audit writes to settle.
 * Must be called during shutdown before closing the database pool.
 */
export async function drainPendingWrites(): Promise<void> {
    if (pendingWrites.size > 0) {
        await Promise.all([...pendingWrites]);
    }
}

const ACTIVITY_SQL = `
    SELECT timestamp, portal_domain, lead_id, action_type, status
    FROM comment_audit_log
    WHERE agent_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
`;

/**
 * Gracefully shuts down the MySQL connection pool.
 * Should be called during server shutdown to release all connections.
 */
export async function shutdownPool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
        logger.info('MySQL connection pool shut down.');
    }
}

/**
 * Queries the audit log for an agent's recent activity.
 *
 * Returns an array of activity rows ordered by timestamp descending,
 * capped at the requested limit (max 50).
 */
export async function queryActivityLog(
    agentId: string,
    limit: number,
): Promise<ActivityLogRow[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 50);
    const db = getPool();
    const [rows] = await db.execute<mysql.RowDataPacket[]>(ACTIVITY_SQL, [agentId, cappedLimit]);
    return rows as ActivityLogRow[];
}
