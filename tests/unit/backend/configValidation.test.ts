import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Config validation tests for Phase C items:
 *   C1: CORS wildcard warning in production
 *   C4: DATABASE_URL required in production
 *
 * Each test sets NODE_ENV and related vars, then dynamically imports
 * loadConfig to trigger fresh module evaluation.
 */

/** Store original env values to restore after each test. */
const originalEnv = { ...process.env };

function setRequiredEnv(): void {
    process.env.JWT_SECRET = 'test-secret';
    process.env.BITRIX24_CLIENT_ID = 'test-client-id';
    process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
    process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
}

describe('Config Validation', () => {
    beforeEach(() => {
        vi.resetModules();
        setRequiredEnv();
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
    });

    describe('C4: DATABASE_URL production validation', () => {
        it('should throw when DATABASE_URL is empty in production', async () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = '';
            process.env.CORS_ORIGINS = 'https://example.com';

            const { loadConfig } = await import('../../../backend/src/config');
            expect(() => loadConfig()).toThrow('DATABASE_URL is required in production.');
        });

        it('should throw when DATABASE_URL is undefined in production', async () => {
            process.env.NODE_ENV = 'production';
            delete process.env.DATABASE_URL;
            process.env.CORS_ORIGINS = 'https://example.com';

            const { loadConfig } = await import('../../../backend/src/config');
            expect(() => loadConfig()).toThrow('DATABASE_URL is required in production.');
        });

        it('should not throw when DATABASE_URL is set in production', async () => {
            process.env.NODE_ENV = 'production';
            process.env.DATABASE_URL = 'postgresql://localhost/testdb';
            process.env.CORS_ORIGINS = 'https://example.com';

            const { loadConfig } = await import('../../../backend/src/config');
            expect(() => loadConfig()).not.toThrow();
        });

        it('should not throw in development even without DATABASE_URL', async () => {
            process.env.NODE_ENV = 'development';
            process.env.DATABASE_URL = '';

            const { loadConfig } = await import('../../../backend/src/config');
            expect(() => loadConfig()).not.toThrow();
        });
    });

    describe('C1: CORS wildcard warning', () => {
        it('should log a warning when CORS_ORIGINS is wildcard in production', async () => {
            process.env.NODE_ENV = 'production';
            process.env.CORS_ORIGINS = '*';
            process.env.DATABASE_URL = 'postgresql://localhost/testdb';

            const loggerModule = await import('../../../backend/src/utils/logger');
            const warnSpy = vi.spyOn(loggerModule.logger, 'warn');

            const { loadConfig } = await import('../../../backend/src/config');
            loadConfig();

            expect(warnSpy).toHaveBeenCalledWith(
                'CORS_ORIGINS is set to wildcard (*) in production. Set explicit origins.',
            );
        });

        it('should not log a warning when CORS_ORIGINS has explicit origins in production', async () => {
            process.env.NODE_ENV = 'production';
            process.env.CORS_ORIGINS = 'chrome-extension://abc123';
            process.env.DATABASE_URL = 'postgresql://localhost/testdb';

            const loggerModule = await import('../../../backend/src/utils/logger');
            const warnSpy = vi.spyOn(loggerModule.logger, 'warn');

            const { loadConfig } = await import('../../../backend/src/config');
            loadConfig();

            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('should not log a warning in development even with wildcard CORS', async () => {
            process.env.NODE_ENV = 'development';
            process.env.CORS_ORIGINS = '*';

            const loggerModule = await import('../../../backend/src/utils/logger');
            const warnSpy = vi.spyOn(loggerModule.logger, 'warn');

            const { loadConfig } = await import('../../../backend/src/config');
            loadConfig();

            expect(warnSpy).not.toHaveBeenCalled();
        });
    });
});
