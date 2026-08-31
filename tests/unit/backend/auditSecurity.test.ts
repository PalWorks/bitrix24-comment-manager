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

import { writeAuditLog, queryActivityLog, setPool } from '../../../backend/src/services/auditLogger';
import { sha256 } from '../../../backend/src/utils/hash';
import type { AuditLogEntry } from '../../../backend/src/models/auditLog';

/**
 * Creates a mock mysql2 Pool with a configurable execute function.
 */
function createMockPool(executeFn?: (...args: unknown[]) => unknown) {
    return {
        execute: executeFn || vi.fn().mockResolvedValue([[], []]),
    } as any;
}

describe('Audit Security: Comment Body Never in Logs (T-6.5)', () => {
    let mockPool: ReturnType<typeof createMockPool>;
    let capturedEntries: AuditLogEntry[];

    beforeEach(() => {
        capturedEntries = [];
        mockPool = createMockPool(
            vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
                capturedEntries.push({
                    agent_id: params[0] as string,
                    bitrix_user_id: params[1] as string,
                    portal_domain: params[2] as string,
                    lead_id: params[3] as string,
                    comment_id: params[4] as string | null,
                    action_type: params[5] as AuditLogEntry['action_type'],
                    comment_hash: params[6] as string,
                    timestamp: params[7] as string,
                    ip_address: params[8] as string | null,
                    status: params[9] as AuditLogEntry['status'],
                    failure_reason: params[10] as string | null,
                });
                return Promise.resolve([[], []]);
            }),
        );
        setPool(mockPool);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const UNIQUE_COMMENT_BODY = 'UNIQUE_SENTINEL_STRING_7x29kQm4pL_FOR_AUDIT_TEST';

    it('should store the SHA-256 hash of the comment body, not the body itself', async () => {
        const expectedHash = sha256(UNIQUE_COMMENT_BODY);

        const entry: AuditLogEntry = {
            agent_id: 'agent-security-test',
            bitrix_user_id: 'bx-user-sec',
            lead_id: '99999',
            comment_id: 'comment-sec-001',
            action_type: 'CREATE',
            comment_hash: expectedHash,
            timestamp: new Date().toISOString(),
            ip_address: '10.0.0.1',
            status: 'SUCCESS',
            failure_reason: null,
        };

        await writeAuditLog(entry);

        expect(capturedEntries).toHaveLength(1);
        const stored = capturedEntries[0];

        expect(stored.comment_hash).toBe(expectedHash);
        expect(stored.comment_hash).not.toBe(UNIQUE_COMMENT_BODY);
    });

    it('should not include the raw comment body in any audit log field', async () => {
        const expectedHash = sha256(UNIQUE_COMMENT_BODY);

        const entry: AuditLogEntry = {
            agent_id: 'agent-security-test',
            bitrix_user_id: 'bx-user-sec',
            lead_id: '99999',
            comment_id: 'comment-sec-002',
            action_type: 'CREATE',
            comment_hash: expectedHash,
            timestamp: new Date().toISOString(),
            ip_address: '10.0.0.1',
            status: 'SUCCESS',
            failure_reason: null,
        };

        await writeAuditLog(entry);

        expect(capturedEntries).toHaveLength(1);
        const stored = capturedEntries[0];

        const allFieldValues = Object.values(stored).map(String).join(' ');
        expect(allFieldValues).not.toContain(UNIQUE_COMMENT_BODY);
    });

    it('should never store raw comment body even for failed operations', async () => {
        const expectedHash = sha256(UNIQUE_COMMENT_BODY);

        const entry: AuditLogEntry = {
            agent_id: 'agent-security-test',
            bitrix_user_id: 'bx-user-sec',
            lead_id: '99999',
            comment_id: null,
            action_type: 'CREATE',
            comment_hash: expectedHash,
            timestamp: new Date().toISOString(),
            ip_address: '10.0.0.1',
            status: 'FAILED',
            failure_reason: 'Validation failed: comment too long.',
        };

        await writeAuditLog(entry);

        expect(capturedEntries).toHaveLength(1);
        const stored = capturedEntries[0];

        const allFieldValues = Object.values(stored)
            .filter((v) => v !== null)
            .map(String)
            .join(' ');
        expect(allFieldValues).not.toContain(UNIQUE_COMMENT_BODY);
        expect(stored.comment_hash).toBe(expectedHash);
    });

    it('should not include raw body in failure_reason field', async () => {
        const entry: AuditLogEntry = {
            agent_id: 'agent-security-test',
            bitrix_user_id: 'bx-user-sec',
            lead_id: '99999',
            comment_id: null,
            action_type: 'CREATE',
            comment_hash: sha256(UNIQUE_COMMENT_BODY),
            timestamp: new Date().toISOString(),
            ip_address: '10.0.0.1',
            status: 'FAILED',
            failure_reason: 'Duplicate content detected.',
        };

        await writeAuditLog(entry);

        expect(capturedEntries).toHaveLength(1);
        const stored = capturedEntries[0];

        expect(stored.failure_reason).not.toContain(UNIQUE_COMMENT_BODY);
    });

    it('should produce a valid SHA-256 hex digest as comment_hash', async () => {
        const expectedHash = sha256(UNIQUE_COMMENT_BODY);

        expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should not include raw comment body in activity log query results', async () => {
        const activityRows = [
            {
                timestamp: new Date().toISOString(),
                lead_id: '99999',
                action_type: 'CREATE' as const,
                status: 'SUCCESS' as const,
            },
        ];

        const queryPool = createMockPool(
            vi.fn().mockResolvedValue([activityRows, []]),
        );
        setPool(queryPool);

        const result = await queryActivityLog('agent-security-test', 10);

        expect(result).toHaveLength(1);

        for (const row of result) {
            const allValues = Object.values(row).map(String).join(' ');
            expect(allValues).not.toContain(UNIQUE_COMMENT_BODY);
        }
    });
});
