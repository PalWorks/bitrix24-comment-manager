import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';

import {
    signJwt,
    verifyJwt,
    blacklistJwt,
    generateOAuthState,
    validateOAuthState,
    resetAllState,
} from '../../../backend/src/services/tokenService';

describe('tokenService', () => {
    beforeEach(() => {
        resetAllState();
    });

    describe('signJwt', () => {
        it('should return a token string and a future expiresAt timestamp', () => {
            const result = signJwt({
                memberId: 'member-001',
                domain: 'test.bitrix24.com',
                clientEndpoint: 'https://test.bitrix24.com/rest/',
            });

            expect(result.token).toBeDefined();
            expect(typeof result.token).toBe('string');
            expect(result.token.split('.')).toHaveLength(3);
            expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
        });

        it('should produce different jti values for successive calls', () => {
            const claims = {
                memberId: 'member-001',
                domain: 'test.bitrix24.com',
                clientEndpoint: 'https://test.bitrix24.com/rest/',
            };

            const result1 = signJwt(claims);
            const result2 = signJwt(claims);

            const payload1 = verifyJwt(result1.token);
            const payload2 = verifyJwt(result2.token);

            expect(payload1?.jti).not.toBe(payload2?.jti);
        });
    });

    describe('verifyJwt', () => {
        it('should return the decoded payload for a valid token', () => {
            const { token } = signJwt({
                memberId: 'member-002',
                domain: 'portal.bitrix24.com',
                clientEndpoint: 'https://portal.bitrix24.com/rest/',
            });

            const payload = verifyJwt(token);

            expect(payload).not.toBeNull();
            expect(payload!.memberId).toBe('member-002');
            expect(payload!.domain).toBe('portal.bitrix24.com');
            expect(payload!.clientEndpoint).toBe('https://portal.bitrix24.com/rest/');
            expect(payload!.jti).toBeDefined();
            expect(payload!.iat).toBeDefined();
            expect(payload!.exp).toBeDefined();
        });

        it('should return null for a tampered token', () => {
            const { token } = signJwt({
                memberId: 'member-003',
                domain: 'test.bitrix24.com',
                clientEndpoint: 'https://test.bitrix24.com/rest/',
            });

            const tampered = token.slice(0, -5) + 'XXXXX';
            const payload = verifyJwt(tampered);

            expect(payload).toBeNull();
        });

        it('should return null for a completely invalid token', () => {
            const payload = verifyJwt('not.a.valid.jwt');
            expect(payload).toBeNull();
        });

        it('should return null for an empty string', () => {
            const payload = verifyJwt('');
            expect(payload).toBeNull();
        });
    });

    describe('blacklistJwt', () => {
        it('should reject a blacklisted token', () => {
            const { token } = signJwt({
                memberId: 'member-004',
                domain: 'test.bitrix24.com',
                clientEndpoint: 'https://test.bitrix24.com/rest/',
            });

            const payload = verifyJwt(token);
            expect(payload).not.toBeNull();

            blacklistJwt(payload!.jti);

            const afterBlacklist = verifyJwt(token);
            expect(afterBlacklist).toBeNull();
        });

        it('should only affect the blacklisted token, not others', () => {
            const claims = {
                memberId: 'member-005',
                domain: 'test.bitrix24.com',
                clientEndpoint: 'https://test.bitrix24.com/rest/',
            };

            const result1 = signJwt(claims);
            const result2 = signJwt(claims);

            const payload1 = verifyJwt(result1.token)!;
            blacklistJwt(payload1.jti);

            expect(verifyJwt(result1.token)).toBeNull();
            expect(verifyJwt(result2.token)).not.toBeNull();
        });
    });

    describe('OAuth State Management', () => {
        it('should generate a state string and validate it successfully', () => {
            const state = generateOAuthState();

            expect(typeof state).toBe('string');
            expect(state.length).toBeGreaterThan(0);

            const isValid = validateOAuthState(state);
            expect(isValid).toBe(true);
        });

        it('should reject a state that was never generated', () => {
            const isValid = validateOAuthState('fabricated-state-value');
            expect(isValid).toBe(false);
        });

        it('should reject a state on second use (single-use enforcement)', () => {
            const state = generateOAuthState();

            expect(validateOAuthState(state)).toBe(true);
            expect(validateOAuthState(state)).toBe(false);
        });

        it('should handle multiple concurrent states independently', () => {
            const state1 = generateOAuthState();
            const state2 = generateOAuthState();

            expect(validateOAuthState(state1)).toBe(true);
            expect(validateOAuthState(state2)).toBe(true);
        });
    });
});
