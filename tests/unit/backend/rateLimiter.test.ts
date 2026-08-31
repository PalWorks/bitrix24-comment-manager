import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';

import { createRateLimiter, resetRateLimiterState, stopPruneTimer } from '../../../backend/src/middleware/rateLimiter';
import { RateLimitedError } from '../../../backend/src/utils/errors';

/**
 * Helper that produces a minimal mock Express request, response, and next function.
 * The user object simulates a JWT-authenticated request from jwtAuth middleware.
 */
function createMockReqRes(memberId: string) {
    const req = { user: { memberId } } as any;
    const res = {} as any;
    let nextCalled = false;
    let nextError: unknown = null;
    const next = (err?: unknown) => {
        if (err) {
            nextError = err;
        } else {
            nextCalled = true;
        }
    };
    return { req, res, next, wasAllowed: () => nextCalled, getError: () => nextError };
}

describe('rateLimiter', () => {
    beforeEach(() => {
        resetRateLimiterState();
    });

    afterEach(() => {
        stopPruneTimer();
    });

    describe('under limit', () => {
        it('should allow requests below the maximum limit', () => {
            const limiter = createRateLimiter(5, 60_000);

            for (let i = 0; i < 5; i++) {
                const { req, res, next, wasAllowed, getError } = createMockReqRes('agent-001');
                limiter(req, res, next);
                expect(wasAllowed()).toBe(true);
                expect(getError()).toBeNull();
            }
        });

        it('should track agents independently', () => {
            const limiter = createRateLimiter(2, 60_000);

            const m1 = createMockReqRes('agent-A');
            limiter(m1.req, m1.res, m1.next);
            expect(m1.wasAllowed()).toBe(true);

            const m2 = createMockReqRes('agent-A');
            limiter(m2.req, m2.res, m2.next);
            expect(m2.wasAllowed()).toBe(true);

            const m3 = createMockReqRes('agent-B');
            limiter(m3.req, m3.res, m3.next);
            expect(m3.wasAllowed()).toBe(true);

            const m4 = createMockReqRes('agent-B');
            limiter(m4.req, m4.res, m4.next);
            expect(m4.wasAllowed()).toBe(true);
        });
    });

    describe('at limit', () => {
        it('should reject requests exceeding the maximum limit', () => {
            const limiter = createRateLimiter(3, 60_000);

            for (let i = 0; i < 3; i++) {
                const { req, res, next } = createMockReqRes('agent-002');
                limiter(req, res, next);
            }

            const { req, res, next } = createMockReqRes('agent-002');
            expect(() => limiter(req, res, next)).toThrow(RateLimitedError);
        });

        it('should include retry_after_seconds in the thrown error', () => {
            const limiter = createRateLimiter(1, 60_000);

            const m1 = createMockReqRes('agent-003');
            limiter(m1.req, m1.res, m1.next);

            try {
                const m2 = createMockReqRes('agent-003');
                limiter(m2.req, m2.res, m2.next);
                expect.unreachable('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(RateLimitedError);
                const rateLimitError = error as InstanceType<typeof RateLimitedError>;
                expect(rateLimitError.retryAfterSeconds).toBeGreaterThan(0);
                expect(rateLimitError.retryAfterSeconds).toBeLessThanOrEqual(60);
            }
        });
    });

    describe('window reset', () => {
        it('should reset the counter after the window expires', async () => {
            const windowMs = 100;
            const limiter = createRateLimiter(2, windowMs);

            const m1 = createMockReqRes('agent-004');
            limiter(m1.req, m1.res, m1.next);
            expect(m1.wasAllowed()).toBe(true);

            const m2 = createMockReqRes('agent-004');
            limiter(m2.req, m2.res, m2.next);
            expect(m2.wasAllowed()).toBe(true);

            expect(() => {
                const m3 = createMockReqRes('agent-004');
                limiter(m3.req, m3.res, m3.next);
            }).toThrow(RateLimitedError);

            await new Promise((resolve) => setTimeout(resolve, windowMs + 50));

            const m4 = createMockReqRes('agent-004');
            limiter(m4.req, m4.res, m4.next);
            expect(m4.wasAllowed()).toBe(true);
        });
    });

    describe('stopPruneTimer', () => {
        it('should be safe to call multiple times', () => {
            expect(() => {
                stopPruneTimer();
                stopPruneTimer();
                stopPruneTimer();
            }).not.toThrow();
        });
    });
});

