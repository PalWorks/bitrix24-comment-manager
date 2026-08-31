import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'test-secret-for-shutdown';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
process.env.DATABASE_URL = 'mysql://test:test@localhost:3306/testdb';

import { shutdownPool, setPool } from '../../../backend/src/services/auditLogger';
import { stopCleanupTimers, resetAllState } from '../../../backend/src/services/tokenService';

/**
 * Creates a mock mysql2 Pool with a configurable end() method.
 */
function createMockPool(endFn?: () => Promise<void>) {
    return {
        execute: vi.fn().mockResolvedValue([[], []]),
        end: endFn || vi.fn().mockResolvedValue(undefined),
    } as any;
}

describe('Graceful Shutdown (B2)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('shutdownPool', () => {
        it('should call pool.end() and reset the pool reference', async () => {
            const mockPool = createMockPool();
            setPool(mockPool);

            await shutdownPool();

            expect(mockPool.end).toHaveBeenCalledTimes(1);
        });

        it('should be safe to call when no pool exists', async () => {
            /**
             * After shutdownPool resets pool to null, calling it again
             * should be a no-op without throwing.
             */
            const mockPool = createMockPool();
            setPool(mockPool);

            await shutdownPool();
            await expect(shutdownPool()).resolves.toBeUndefined();

            expect(mockPool.end).toHaveBeenCalledTimes(1);
        });

        it('should handle pool.end() rejection gracefully', async () => {
            const failingPool = createMockPool(
                vi.fn().mockRejectedValue(new Error('Connection terminated')),
            );
            setPool(failingPool);

            await expect(shutdownPool()).rejects.toThrow('Connection terminated');
            expect(failingPool.end).toHaveBeenCalledTimes(1);
        });
    });

    describe('stopCleanupTimers', () => {
        beforeEach(() => {
            resetAllState();
        });

        it('should not throw when called with no active timer', () => {
            expect(() => stopCleanupTimers()).not.toThrow();
        });

        it('should be safe to call multiple times', () => {
            stopCleanupTimers();
            stopCleanupTimers();
            expect(true).toBe(true);
        });
    });
});
