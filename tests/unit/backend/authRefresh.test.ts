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
    resetAllState,
} from '../../../backend/src/services/tokenService';

describe('POST /auth/refresh', () => {
    beforeEach(() => {
        resetAllState();
    });

    it('should produce a fresh JWT with a different jti when refreshing', () => {
        const claims = {
            memberId: 'member-refresh-001',
            domain: 'test.bitrix24.com',
            clientEndpoint: 'https://test.bitrix24.com/rest/',
        };

        const original = signJwt(claims);
        const originalPayload = verifyJwt(original.token)!;

        expect(originalPayload).not.toBeNull();

        blacklistJwt(originalPayload.jti, originalPayload.exp);

        const refreshed = signJwt(claims);
        const refreshedPayload = verifyJwt(refreshed.token)!;

        expect(refreshedPayload).not.toBeNull();
        expect(refreshedPayload.jti).not.toBe(originalPayload.jti);
        expect(refreshedPayload.memberId).toBe(claims.memberId);
        expect(refreshedPayload.domain).toBe(claims.domain);
        expect(refreshedPayload.clientEndpoint).toBe(claims.clientEndpoint);
    });

    it('should reject the old token after refresh (old jti is blacklisted)', () => {
        const claims = {
            memberId: 'member-refresh-002',
            domain: 'test.bitrix24.com',
            clientEndpoint: 'https://test.bitrix24.com/rest/',
        };

        const original = signJwt(claims);
        const originalPayload = verifyJwt(original.token)!;

        blacklistJwt(originalPayload.jti, originalPayload.exp);

        const verified = verifyJwt(original.token);
        expect(verified).toBeNull();
    });

    it('should accept the refreshed token after old token is blacklisted', () => {
        const claims = {
            memberId: 'member-refresh-003',
            domain: 'test.bitrix24.com',
            clientEndpoint: 'https://test.bitrix24.com/rest/',
        };

        const original = signJwt(claims);
        const originalPayload = verifyJwt(original.token)!;

        blacklistJwt(originalPayload.jti, originalPayload.exp);

        const refreshed = signJwt(claims);
        const refreshedPayload = verifyJwt(refreshed.token);

        expect(refreshedPayload).not.toBeNull();
        expect(refreshedPayload!.jti).toBeDefined();
    });

    it('should return a future expiresAt on the refreshed token', () => {
        const claims = {
            memberId: 'member-refresh-004',
            domain: 'test.bitrix24.com',
            clientEndpoint: 'https://test.bitrix24.com/rest/',
        };

        const original = signJwt(claims);
        const originalPayload = verifyJwt(original.token)!;

        blacklistJwt(originalPayload.jti, originalPayload.exp);

        const refreshed = signJwt(claims);
        const now = Math.floor(Date.now() / 1000);

        expect(refreshed.expiresAt).toBeGreaterThan(now);
    });

    it('should reject an expired or invalid token (no refresh possible)', () => {
        const result = verifyJwt('expired.invalid.token');
        expect(result).toBeNull();
    });
});
