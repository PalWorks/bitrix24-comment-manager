import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Support only mode.
 *
 * The extension's support form has to reach a server the publisher runs, which
 * is not the server any individual user runs. That instance has no Bitrix24
 * application, no portal and no audit log. These tests pin the two halves of
 * that: which requirements are lifted, and which are not, so the mode can never
 * quietly become a way to start a misconfigured full backend.
 */

const BITRIX_KEYS = [
    'BITRIX24_CLIENT_ID',
    'BITRIX24_CLIENT_SECRET',
    'BITRIX24_PORTAL_DOMAIN',
    'BITRIX24_ALLOWED_PORTALS',
];

const ALL_KEYS = [
    ...BITRIX_KEYS,
    'SUPPORT_ONLY',
    'JWT_SECRET',
    'NODE_ENV',
    'DATABASE_URL',
    'TOKEN_ENCRYPTION_KEY',
    'RESEND_API_KEY',
    'SUPPORT_FROM_EMAIL',
    'SUPPORT_TO_EMAIL',
];

let saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>): void {
    for (const key of ALL_KEYS) {
        delete process.env[key];
    }
    Object.assign(process.env, values);
}

const MAILBOX = {
    RESEND_API_KEY: 're_test_key',
    SUPPORT_FROM_EMAIL: 'Support <support@mail.example.com>',
    SUPPORT_TO_EMAIL: 'inbox@example.com',
};

describe('support only mode', () => {
    beforeEach(() => {
        saved = Object.fromEntries(ALL_KEYS.map((key) => [key, process.env[key]]));
    });

    afterEach(() => {
        for (const key of ALL_KEYS) {
            delete process.env[key];
        }
        for (const [key, value] of Object.entries(saved)) {
            if (value !== undefined) {
                process.env[key] = value;
            }
        }
    });

    describe('requirements it lifts', () => {
        it('starts with no Bitrix24 application and no portal', async () => {
            setEnv({ SUPPORT_ONLY: '1', ...MAILBOX });

            const { loadConfig } = await import('../../../backend/src/config');
            const config = loadConfig();

            expect(config.supportOnly).toBe(true);
            expect(config.bitrix24ClientId).toBe('');
            expect(config.bitrix24AllowedPortals).toEqual([]);
        });

        it('does not demand a database or an encryption key in production', async () => {
            setEnv({ SUPPORT_ONLY: 'true', NODE_ENV: 'production', ...MAILBOX });

            const { loadConfig } = await import('../../../backend/src/config');

            expect(() => loadConfig()).not.toThrow();
        });

        it('generates a JWT secret rather than demanding one nothing will use', async () => {
            setEnv({ SUPPORT_ONLY: 'yes', ...MAILBOX });

            const { loadConfig } = await import('../../../backend/src/config');
            const config = loadConfig();

            expect(config.jwtSecret).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    describe('requirements it keeps', () => {
        it('refuses to start without a mailbox, which is its whole purpose', async () => {
            setEnv({ SUPPORT_ONLY: '1' });

            const { loadConfig } = await import('../../../backend/src/config');

            expect(() => loadConfig()).toThrow(/no mailbox is configured/i);
        });

        it('refuses a half configured mailbox', async () => {
            setEnv({
                SUPPORT_ONLY: '1',
                RESEND_API_KEY: 're_test_key',
                SUPPORT_TO_EMAIL: 'inbox@example.com',
            });

            const { loadConfig } = await import('../../../backend/src/config');

            expect(() => loadConfig()).toThrow(/half configured|no mailbox/i);
        });
    });

    describe('when the flag is absent', () => {
        it('still demands a Bitrix24 application', async () => {
            setEnv({ JWT_SECRET: 'x'.repeat(32), ...MAILBOX });

            const { loadConfig } = await import('../../../backend/src/config');

            expect(() => loadConfig()).toThrow(/BITRIX24_CLIENT_ID/);
        });

        it('still demands a portal', async () => {
            setEnv({
                JWT_SECRET: 'x'.repeat(32),
                BITRIX24_CLIENT_ID: 'id',
                BITRIX24_CLIENT_SECRET: 'secret',
                ...MAILBOX,
            });

            const { loadConfig } = await import('../../../backend/src/config');

            expect(() => loadConfig()).toThrow(/No Bitrix24 portal configured/);
        });

        it('is not enabled by an unrelated value', async () => {
            setEnv({
                SUPPORT_ONLY: 'no',
                JWT_SECRET: 'x'.repeat(32),
                BITRIX24_CLIENT_ID: 'id',
                BITRIX24_CLIENT_SECRET: 'secret',
                BITRIX24_ALLOWED_PORTALS: 'acme.bitrix24.com',
                ...MAILBOX,
            });

            const { loadConfig } = await import('../../../backend/src/config');

            expect(loadConfig().supportOnly).toBe(false);
        });
    });
});
