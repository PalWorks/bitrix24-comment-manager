import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/testdb';

import { writeAuditLog, queryActivityLog, setPool, drainPendingWrites } from '../../../backend/src/services/auditLogger';
import type { AuditLogEntry } from '../../../backend/src/models/auditLog';

/**
 * Creates a mock mysql2 Pool with a configurable execute function.
 */
function createMockPool(executeFn?: (...args: unknown[]) => unknown) {
    return {
        execute: executeFn || vi.fn().mockResolvedValue([[], []]),
    } as any;
}

describe('auditLogger', () => {
    let mockPool: ReturnType<typeof createMockPool>;

    beforeEach(() => {
        mockPool = createMockPool();
        setPool(mockPool);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Maps the positional parameters of an INSERT back onto the column names
     * declared in its own SQL, so these assertions survive a schema change
     * instead of silently shifting by one.
     */
    function paramsByColumn(
        sql: string,
        params: unknown[],
    ): Record<string, unknown> {
        const columns = sql
            .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
            .split(',')
            .map((column) => column.trim());

        expect(columns.length).toBe(params.length);

        return Object.fromEntries(columns.map((column, index) => [column, params[index]]));
    }

    const sampleEntry: AuditLogEntry = {
        agent_id: 'agent-001',
        bitrix_user_id: 'bx-user-001',
        portal_domain: 'test.bitrix24.com',
        lead_id: '12345',
        comment_id: '99001',
        action_type: 'CREATE',
        comment_hash: 'abc123def456',
        timestamp: '2026-03-04T12:00:00.000Z',
        ip_address: '192.168.1.1',
        status: 'SUCCESS',
        failure_reason: null,
    };

    describe('writeAuditLog', () => {
        it('should insert the audit entry with correct parameters', async () => {
            await writeAuditLog(sampleEntry);

            expect(mockPool.execute).toHaveBeenCalledTimes(1);

            const [sql, params] = mockPool.execute.mock.calls[0];
            expect(sql).toContain('INSERT INTO comment_audit_log');
            expect(paramsByColumn(sql, params)).toEqual({
                agent_id: sampleEntry.agent_id,
                bitrix_user_id: sampleEntry.bitrix_user_id,
                portal_domain: sampleEntry.portal_domain,
                lead_id: sampleEntry.lead_id,
                comment_id: sampleEntry.comment_id,
                action_type: sampleEntry.action_type,
                comment_hash: sampleEntry.comment_hash,
                timestamp: sampleEntry.timestamp,
                ip_address: sampleEntry.ip_address,
                status: sampleEntry.status,
                failure_reason: sampleEntry.failure_reason,
            });
        });

        it('should insert a FAILED entry with failure_reason', async () => {
            const failedEntry: AuditLogEntry = {
                ...sampleEntry,
                comment_id: null,
                status: 'FAILED',
                failure_reason: 'Validation failed: comment_body is required.',
            };

            await writeAuditLog(failedEntry);

            expect(mockPool.execute).toHaveBeenCalledTimes(1);
            const [sql, params] = mockPool.execute.mock.calls[0];
            const byColumn = paramsByColumn(sql, params);
            expect(byColumn.comment_id).toBeNull();
            expect(byColumn.status).toBe('FAILED');
            expect(byColumn.failure_reason).toBe('Validation failed: comment_body is required.');
        });

        it('should insert an AUTH_FAILURE entry', async () => {
            const authFailEntry: AuditLogEntry = {
                ...sampleEntry,
                lead_id: 'N/A',
                comment_id: null,
                action_type: 'AUTH_FAILURE',
                comment_hash: 'N/A',
                status: 'FAILED',
                failure_reason: 'Invalid or expired OAuth state.',
            };

            await writeAuditLog(authFailEntry);

            expect(mockPool.execute).toHaveBeenCalledTimes(1);
            const [sql, params] = mockPool.execute.mock.calls[0];
            const byColumn = paramsByColumn(sql, params);
            expect(byColumn.action_type).toBe('AUTH_FAILURE');
            expect(byColumn.lead_id).toBe('N/A');
            expect(byColumn.comment_hash).toBe('N/A');
        });

        it('should never throw even when the database query rejects', async () => {
            const rejectingPool = createMockPool(
                vi.fn().mockRejectedValue(new Error('Connection refused')),
            );
            setPool(rejectingPool);

            await expect(writeAuditLog(sampleEntry)).resolves.toBeUndefined();
        });

        it('should log errors internally when the database write fails', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const rejectingPool = createMockPool(
                vi.fn().mockRejectedValue(new Error('Connection refused')),
            );
            setPool(rejectingPool);

            await writeAuditLog(sampleEntry);

            expect(consoleSpy).toHaveBeenCalled();
            const loggedMessage = consoleSpy.mock.calls[0][0] as string;
            expect(loggedMessage).toContain('Failed to write audit log entry');
            consoleSpy.mockRestore();
        });
    });

    describe('queryActivityLog', () => {
        it('should query with correct agent_id and limit', async () => {
            const mockRows = [
                { timestamp: '2026-03-04T12:00:00Z', portal_domain: 'test.bitrix24.com', lead_id: '100', action_type: 'CREATE', status: 'SUCCESS' },
                { timestamp: '2026-03-04T11:00:00Z', portal_domain: 'test.bitrix24.com', lead_id: '200', action_type: 'EDIT', status: 'SUCCESS' },
            ];
            const queryPool = createMockPool(
                vi.fn().mockResolvedValue([[mockRows[0], mockRows[1]], []]),
            );
            setPool(queryPool);

            const result = await queryActivityLog('agent-001', 20);

            expect(queryPool.execute).toHaveBeenCalledTimes(1);
            const [sql, params] = queryPool.execute.mock.calls[0];
            expect(sql).toContain('SELECT timestamp, portal_domain, lead_id, action_type, status');
            expect(sql).toContain('ORDER BY timestamp DESC');
            expect(params[0]).toBe('agent-001');
            expect(params[1]).toBe(20);
            expect(result).toEqual(mockRows);
        });

        it('should cap the limit at 50', async () => {
            await queryActivityLog('agent-001', 100);

            const [, params] = mockPool.execute.mock.calls[0];
            expect(params[1]).toBe(50);
        });

        it('should enforce a minimum limit of 1', async () => {
            await queryActivityLog('agent-001', 0);

            const [, params] = mockPool.execute.mock.calls[0];
            expect(params[1]).toBe(1);
        });

        it('should handle negative limit values', async () => {
            await queryActivityLog('agent-001', -5);

            const [, params] = mockPool.execute.mock.calls[0];
            expect(params[1]).toBe(1);
        });
    });

    describe('drainPendingWrites (D4)', () => {
        it('should resolve immediately when no writes are pending', async () => {
            await expect(drainPendingWrites()).resolves.toBeUndefined();
        });

        it('should resolve after all tracked writes complete', async () => {
            let resolveQuery!: () => void;
            const slowPool = createMockPool(
                vi.fn().mockImplementation(
                    () => new Promise<[never[], []]>((resolve) => {
                        resolveQuery = () => resolve([[], []]);
                    }),
                ),
            );
            setPool(slowPool);

            const writeFinished = writeAuditLog(sampleEntry);

            /** Drain should block until the slow write resolves. */
            let drained = false;
            const drainPromise = drainPendingWrites().then(() => { drained = true; });

            /** Write is still in progress. */
            expect(drained).toBe(false);

            /** Release the slow query. */
            resolveQuery();
            await writeFinished;
            await drainPromise;

            expect(drained).toBe(true);
        });

        it('should resolve even when a write fails internally', async () => {
            const failPool = createMockPool(
                vi.fn().mockRejectedValue(new Error('DB error')),
            );
            setPool(failPool);

            await writeAuditLog(sampleEntry);
            await expect(drainPendingWrites()).resolves.toBeUndefined();
        });
    });
});
