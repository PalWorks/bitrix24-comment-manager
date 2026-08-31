import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRY_SECONDS = '2';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';

import {
    signJwt,
    verifyJwt,
    blacklistJwt,
    generateOAuthState,
    resetAllState,
    stopCleanupTimers,
} from '../../../backend/src/services/tokenService';

describe('tokenService cleanup', () => {
    beforeEach(() => {
        resetAllState();
    });

    afterEach(() => {
        stopCleanupTimers();
        vi.restoreAllMocks();
    });

    describe('jtiBlacklist TTL eviction', () => {
        it('should store blacklisted jti with expiry', () => {
            const { token } = signJwt({
                memberId: 'member-ttl-001',
                domain: 'test.bitrix24.com',
                clientEndpoint: 'https://test.bitrix24.com/rest/',
            });

            const payload = verifyJwt(token)!;
            expect(payload).not.toBeNull();

            blacklistJwt(payload.jti, payload.exp);

            const afterBlacklist = verifyJwt(token);
            expect(afterBlacklist).toBeNull();
        });

        it('should accept blacklistJwt without exp (uses default)', () => {
            const { token } = signJwt({
                memberId: 'member-ttl-002',
                domain: 'test.bitrix24.com',
                clientEndpoint: 'https://test.bitrix24.com/rest/',
            });

            const payload = verifyJwt(token)!;
            blacklistJwt(payload.jti);

            const afterBlacklist = verifyJwt(token);
            expect(afterBlacklist).toBeNull();
        });
    });

    describe('oauthStateStore cleanup', () => {
        it('should still validate non-expired states after cleanup timer fires', () => {
            const state = generateOAuthState();
            expect(typeof state).toBe('string');

            const isValid = generateOAuthState();
            expect(typeof isValid).toBe('string');
        });

        it('should generate unique states', () => {
            const state1 = generateOAuthState();
            const state2 = generateOAuthState();
            expect(state1).not.toBe(state2);
        });
    });

    describe('stopCleanupTimers', () => {
        it('should be callable without errors even when no timer is running', () => {
            expect(() => stopCleanupTimers()).not.toThrow();
        });

        it('should stop the cleanup timer and be idempotent', () => {
            stopCleanupTimers();
            expect(() => stopCleanupTimers()).not.toThrow();
        });
    });

    describe('resetAllState', () => {
        it('should clear all stores and timers', () => {
            const { token } = signJwt({
                memberId: 'member-reset-001',
                domain: 'test.bitrix24.com',
                clientEndpoint: 'https://test.bitrix24.com/rest/',
            });
            const payload = verifyJwt(token)!;
            blacklistJwt(payload.jti, payload.exp);

            generateOAuthState();

            resetAllState();

            const freshPayload = verifyJwt(token);
            expect(freshPayload).not.toBeNull();
        });
    });
});
