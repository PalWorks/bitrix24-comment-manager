import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setTestEnv } from '../../helpers/session';

setTestEnv();

import {
    storeBitrixTokens,
    getBitrixTokens,
    removeBitrixTokens,
    resetTokenCache,
} from '../../../backend/src/services/tokenStore';
import { setPool } from '../../../backend/src/services/auditLogger';
import { decryptSecret } from '../../../backend/src/utils/crypto';

const KEY = 'a'.repeat(64);

/**
 * Builds a mock pool that records executed statements and can serve rows back.
 */
function createMockPool(rows: unknown[] = []) {
    const execute = vi.fn(async (sql: string) =>
        sql.trim().startsWith('SELECT') ? [rows, []] : [{ affectedRows: 1 }, []],
    );
    return { execute, end: vi.fn(async () => undefined) } as never;
}

const SAMPLE = {
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    clientEndpoint: 'https://test.bitrix24.com/rest/',
    domain: 'test.bitrix24.com',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('tokenStore', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        resetTokenCache();
        vi.clearAllMocks();
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        resetTokenCache();
    });

    describe('without a database (development)', () => {
        beforeEach(() => {
            delete process.env.DATABASE_URL;
        });

        it('should serve tokens from the in-process cache', async () => {
            await storeBitrixTokens('member-1', SAMPLE);
            expect(await getBitrixTokens('member-1')).toEqual(SAMPLE);
        });

        it('should return undefined for an unknown member', async () => {
            expect(await getBitrixTokens('nobody')).toBeUndefined();
        });

        it('should remove tokens from the cache', async () => {
            await storeBitrixTokens('member-1', SAMPLE);
            expect(await removeBitrixTokens('member-1')).toBe(true);
            expect(await getBitrixTokens('member-1')).toBeUndefined();
        });
    });

    describe('with a database', () => {
        beforeEach(() => {
            process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/testdb';
        });

        it('should persist tokens encrypted, never in plaintext', async () => {
            const pool = createMockPool();
            setPool(pool);

            await storeBitrixTokens('member-1', SAMPLE);

            const [sql, params] = (pool as unknown as {
                execute: { mock: { calls: [string, unknown[]][] } };
            }).execute.mock.calls[0];

            expect(sql).toContain('INSERT INTO bitrix_tokens');

            const serialised = JSON.stringify(params);
            expect(serialised).not.toContain('access-token-value');
            expect(serialised).not.toContain('refresh-token-value');

            // Columns: member_id, portal_domain, client_endpoint, access, refresh, expires
            expect(decryptSecret(params[3] as string, KEY)).toBe('access-token-value');
            expect(decryptSecret(params[4] as string, KEY)).toBe('refresh-token-value');
        });

        it('should load and decrypt tokens on a cache miss', async () => {
            const { encryptSecret } = await import('../../../backend/src/utils/crypto');
            const pool = createMockPool([
                {
                    member_id: 'member-1',
                    portal_domain: 'test.bitrix24.com',
                    client_endpoint: 'https://test.bitrix24.com/rest/',
                    access_token: encryptSecret('access-token-value', KEY),
                    refresh_token: encryptSecret('refresh-token-value', KEY),
                    expires_at: SAMPLE.expiresAt,
                },
            ]);
            setPool(pool);

            expect(await getBitrixTokens('member-1')).toEqual(SAMPLE);
        });

        it('should not query again once a member is cached', async () => {
            const pool = createMockPool();
            setPool(pool);

            await storeBitrixTokens('member-1', SAMPLE);
            const callsAfterStore = (pool as unknown as { execute: { mock: { calls: unknown[] } } })
                .execute.mock.calls.length;

            await getBitrixTokens('member-1');
            await getBitrixTokens('member-1');

            expect(
                (pool as unknown as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls
                    .length,
            ).toBe(callsAfterStore);
        });

        it('should keep the session alive when the database write fails', async () => {
            const pool = {
                execute: vi.fn(async () => {
                    throw new Error('Connection refused');
                }),
                end: vi.fn(),
            } as never;
            setPool(pool);

            await expect(storeBitrixTokens('member-1', SAMPLE)).resolves.toBeUndefined();

            // Durability is lost, but the agent's current session is not.
            expect(await getBitrixTokens('member-1')).toEqual(SAMPLE);
        });

        it('should return undefined when a read fails rather than throwing', async () => {
            const pool = {
                execute: vi.fn(async () => {
                    throw new Error('Connection refused');
                }),
                end: vi.fn(),
            } as never;
            setPool(pool);

            expect(await getBitrixTokens('member-unknown')).toBeUndefined();
        });

        it('should delete the row on removal', async () => {
            const pool = createMockPool();
            setPool(pool);

            await storeBitrixTokens('member-1', SAMPLE);
            await removeBitrixTokens('member-1');

            const calls = (pool as unknown as { execute: { mock: { calls: [string][] } } }).execute
                .mock.calls;
            expect(calls.some(([sql]) => sql.includes('DELETE FROM bitrix_tokens'))).toBe(true);
        });
    });
});
