import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';
process.env.MAX_COMMENT_LENGTH = '5000';
process.env.DUPLICATE_WINDOW_SECONDS = '300';

import {
    validateCommentSize,
    detectDuplicate,
    resetDuplicateState,
} from '../../../backend/src/middleware/commentValidator';
import { BadRequestError, DuplicateError } from '../../../backend/src/utils/errors';

/**
 * Helper that produces a minimal mock Express request, response, and next function.
 */
function createMockReqRes(body: Record<string, unknown>, memberId = 'agent-001', params: Record<string, string> = {}) {
    const req = {
        body,
        params,
        user: { memberId },
    } as any;
    const res = {} as any;
    let nextCalled = false;
    const next = (err?: unknown) => {
        if (err) throw err;
        nextCalled = true;
    };
    return { req, res, next, wasAllowed: () => nextCalled };
}

describe('commentValidator', () => {
    beforeEach(() => {
        resetDuplicateState();
    });

    describe('validateCommentSize', () => {
        it('should allow a valid comment body', () => {
            const { req, res, next, wasAllowed } = createMockReqRes({
                comment_body: 'Hello, this is a test comment.',
            });
            validateCommentSize(req, res, next);
            expect(wasAllowed()).toBe(true);
        });

        it('should reject a missing comment_body', () => {
            const { req, res, next } = createMockReqRes({});
            expect(() => validateCommentSize(req, res, next)).toThrow(BadRequestError);
        });

        it('should reject a non-string comment_body', () => {
            const { req, res, next } = createMockReqRes({ comment_body: 12345 });
            expect(() => validateCommentSize(req, res, next)).toThrow(BadRequestError);
        });

        it('should reject an empty (whitespace only) comment_body', () => {
            const { req, res, next } = createMockReqRes({ comment_body: '   ' });
            expect(() => validateCommentSize(req, res, next)).toThrow(BadRequestError);
        });

        it('should reject a comment exceeding the max length', () => {
            const longBody = 'a'.repeat(5001);
            const { req, res, next } = createMockReqRes({ comment_body: longBody });
            expect(() => validateCommentSize(req, res, next)).toThrow(BadRequestError);
        });

        it('should allow a comment at exactly the max length', () => {
            const exactBody = 'a'.repeat(5000);
            const { req, res, next, wasAllowed } = createMockReqRes({ comment_body: exactBody });
            validateCommentSize(req, res, next);
            expect(wasAllowed()).toBe(true);
        });

        it('should handle multi-byte characters (emoji) within limits', () => {
            const emojiBody = '\u{1F600}'.repeat(100);
            const { req, res, next, wasAllowed } = createMockReqRes({ comment_body: emojiBody });
            validateCommentSize(req, res, next);
            expect(wasAllowed()).toBe(true);
        });
    });

    describe('detectDuplicate', () => {
        it('should allow the first submission of a comment', () => {
            const { req, res, next, wasAllowed } = createMockReqRes(
                { comment_body: 'Unique comment text', lead_id: '100' },
                'agent-dup-001',
            );
            detectDuplicate(req, res, next);
            expect(wasAllowed()).toBe(true);
        });

        it('should reject an identical comment submitted twice within the window', () => {
            const body = { comment_body: 'Duplicate test', lead_id: '200' };
            const memberId = 'agent-dup-002';

            const m1 = createMockReqRes(body, memberId);
            detectDuplicate(m1.req, m1.res, m1.next);
            expect(m1.wasAllowed()).toBe(true);

            const m2 = createMockReqRes(body, memberId);
            expect(() => detectDuplicate(m2.req, m2.res, m2.next)).toThrow(DuplicateError);
        });

        it('should allow the same comment from different agents', () => {
            const body = { comment_body: 'Same text by different agents', lead_id: '300' };

            const m1 = createMockReqRes(body, 'agent-A');
            detectDuplicate(m1.req, m1.res, m1.next);
            expect(m1.wasAllowed()).toBe(true);

            const m2 = createMockReqRes(body, 'agent-B');
            detectDuplicate(m2.req, m2.res, m2.next);
            expect(m2.wasAllowed()).toBe(true);
        });

        it('should allow the same comment for different leads', () => {
            const memberId = 'agent-dup-003';

            const m1 = createMockReqRes({ comment_body: 'Same text', lead_id: '400' }, memberId);
            detectDuplicate(m1.req, m1.res, m1.next);
            expect(m1.wasAllowed()).toBe(true);

            const m2 = createMockReqRes({ comment_body: 'Same text', lead_id: '401' }, memberId);
            detectDuplicate(m2.req, m2.res, m2.next);
            expect(m2.wasAllowed()).toBe(true);
        });

        it('should allow different comments from the same agent and lead', () => {
            const memberId = 'agent-dup-004';
            const leadId = '500';

            const m1 = createMockReqRes({ comment_body: 'First comment', lead_id: leadId }, memberId);
            detectDuplicate(m1.req, m1.res, m1.next);
            expect(m1.wasAllowed()).toBe(true);

            const m2 = createMockReqRes({ comment_body: 'Second comment', lead_id: leadId }, memberId);
            detectDuplicate(m2.req, m2.res, m2.next);
            expect(m2.wasAllowed()).toBe(true);
        });

        it('should pass through if comment_body is missing (let other middleware handle)', () => {
            const { req, res, next, wasAllowed } = createMockReqRes({}, 'agent-dup-005');
            detectDuplicate(req, res, next);
            expect(wasAllowed()).toBe(true);
        });
    });
});
