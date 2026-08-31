import { Router, Request, Response, NextFunction } from 'express';
import { jwtAuth } from '../middleware/jwtAuth.js';
import { agentAuth } from '../middleware/agentAuth.js';
import { leadAuth, LeadAuthenticatedRequest } from '../middleware/leadAuth.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { validateCommentSize, detectDuplicate } from '../middleware/commentValidator.js';
import { addComment, updateComment, deleteComment } from '../services/bitrix24Client.js';
import { writeAuditLog } from '../services/auditLogger.js';
import { BadRequestError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { sha256 } from '../utils/hash.js';
import type { AuditLogEntry } from '../models/auditLog.js';

const router = Router();

const rateLimiter = createRateLimiter();

/**
 * Builds a partial audit log entry from the common request context.
 * Callers fill in action_type, comment_id, status, and failure_reason.
 */
function buildBaseEntry(req: LeadAuthenticatedRequest, leadId: string, commentBody: string | undefined): Omit<AuditLogEntry, 'action_type' | 'comment_id' | 'status' | 'failure_reason'> {
    return {
        agent_id: req.user.memberId,
        bitrix_user_id: req.user.memberId,
        portal_domain: req.user.domain,
        lead_id: leadId,
        comment_hash: commentBody ? sha256(commentBody.trim()) : 'N/A',
        timestamp: new Date().toISOString(),
        ip_address: req.ip || null,
    };
}

/**
 * POST /api/comments
 *
 * Creates a new timeline comment on a lead.
 *
 * 9-step authorization chain:
 *   1. jwtAuth:            JWT present and valid signature
 *   2. (JWT expiry check is included in jwtAuth verify)
 *   3. agentAuth:          Agent active in token store
 *   4. agentAuth:          Agent-to-Bitrix24 mapping exists
 *   5. leadAuth:           Lead exists (Bitrix24 crm.lead.get)
 *   6. leadAuth:           Agent authorized for this lead
 *   7. rateLimiter:        Per-agent sliding window check
 *   8. validateCommentSize: Comment body size check
 *   9. detectDuplicate:    SHA-256 duplicate detection
 *
 * Request body: { lead_id: string, comment_body: string }
 * Response: { success: true, comment_id, lead_id, action: "CREATE", timestamp }
 */
router.post(
    '/',
    jwtAuth,
    agentAuth,
    leadAuth,
    rateLimiter,
    validateCommentSize,
    detectDuplicate,
    async (req: Request, res: Response, next: NextFunction) => {
        const authReq = req as LeadAuthenticatedRequest;
        const { lead_id, comment_body } = req.body;

        try {
            if (!lead_id) {
                throw new BadRequestError('lead_id is required.');
            }

            const result = await addComment(
                authReq.leadTokens.clientEndpoint,
                authReq.leadTokens.accessToken,
                authReq.user.memberId,
                lead_id,
                comment_body.trim(),
            );

            logger.info('Comment created', {
                commentId: result.commentId,
                leadId: lead_id,
                memberId: authReq.user.memberId,
            });

            const timestamp = new Date().toISOString();

            writeAuditLog({
                ...buildBaseEntry(authReq, lead_id, comment_body),
                action_type: 'CREATE',
                comment_id: result.commentId,
                status: 'SUCCESS',
                failure_reason: null,
            });

            res.json({
                success: true,
                comment_id: result.commentId,
                lead_id,
                action: 'CREATE' as const,
                timestamp,
            });
        } catch (error) {
            writeAuditLog({
                ...buildBaseEntry(authReq, lead_id || 'N/A', comment_body),
                action_type: 'CREATE',
                comment_id: null,
                status: 'FAILED',
                failure_reason: error instanceof Error ? error.message : String(error),
            });
            next(error);
        }
    },
);

/**
 * PUT /api/comments/:id
 *
 * Edits an existing timeline comment.
 * Uses the same middleware chain as POST, minus duplicate detection.
 *
 * Request body: { comment_body: string }
 * Response: { success: true, comment_id, action: "EDIT", timestamp }
 */
router.put(
    '/:id',
    jwtAuth,
    agentAuth,
    leadAuth,
    rateLimiter,
    validateCommentSize,
    async (req: Request, res: Response, next: NextFunction) => {
        const authReq = req as LeadAuthenticatedRequest;
        const commentId = req.params.id;
        const { comment_body } = req.body;
        const leadId = req.body?.lead_id;

        try {
            if (!leadId) {
                throw new BadRequestError('lead_id is required for comment updates.');
            }

            if (!commentId) {
                throw new BadRequestError('Comment ID is required.');
            }

            await updateComment(
                authReq.leadTokens.clientEndpoint,
                authReq.leadTokens.accessToken,
                authReq.user.memberId,
                commentId,
                comment_body.trim(),
            );

            logger.info('Comment updated', {
                commentId,
                memberId: authReq.user.memberId,
            });

            const timestamp = new Date().toISOString();

            writeAuditLog({
                ...buildBaseEntry(authReq, leadId, comment_body),
                action_type: 'EDIT',
                comment_id: commentId,
                status: 'SUCCESS',
                failure_reason: null,
            });

            res.json({
                success: true,
                comment_id: commentId,
                action: 'EDIT' as const,
                timestamp,
            });
        } catch (error) {
            writeAuditLog({
                ...buildBaseEntry(authReq, leadId || 'N/A', comment_body),
                action_type: 'EDIT',
                comment_id: commentId || null,
                status: 'FAILED',
                failure_reason: error instanceof Error ? error.message : String(error),
            });
            next(error);
        }
    },
);

/**
 * DELETE /api/comments/:id
 *
 * Deletes a timeline comment.
 * Uses the same middleware chain as POST, minus size and duplicate checks.
 *
 * Response: { success: true, comment_id, action: "DELETE", timestamp }
 */
router.delete(
    '/:id',
    jwtAuth,
    agentAuth,
    leadAuth,
    rateLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
        const authReq = req as LeadAuthenticatedRequest;
        const commentId = req.params.id;
        const leadId = req.body?.lead_id;

        try {
            if (!leadId) {
                throw new BadRequestError('lead_id is required for comment deletions.');
            }

            if (!commentId) {
                throw new BadRequestError('Comment ID is required.');
            }

            await deleteComment(
                authReq.leadTokens.clientEndpoint,
                authReq.leadTokens.accessToken,
                authReq.user.memberId,
                commentId,
            );

            logger.info('Comment deleted', {
                commentId,
                memberId: authReq.user.memberId,
            });

            const timestamp = new Date().toISOString();

            writeAuditLog({
                ...buildBaseEntry(authReq, leadId, undefined),
                action_type: 'DELETE',
                comment_id: commentId,
                status: 'SUCCESS',
                failure_reason: null,
            });

            res.json({
                success: true,
                comment_id: commentId,
                action: 'DELETE' as const,
                timestamp,
            });
        } catch (error) {
            writeAuditLog({
                ...buildBaseEntry(authReq, leadId || 'N/A', undefined),
                action_type: 'DELETE',
                comment_id: commentId || null,
                status: 'FAILED',
                failure_reason: error instanceof Error ? error.message : String(error),
            });
            next(error);
        }
    },
);

export { router as commentsRouter };
