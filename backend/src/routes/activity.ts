import { Router, Request, Response, NextFunction } from 'express';
import { jwtAuth, AuthenticatedRequest } from '../middleware/jwtAuth.js';
import { queryActivityLog } from '../services/auditLogger.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/activity?limit=20
 *
 * Returns the authenticated agent's recent audit log entries.
 * Protected by JWT authentication.
 *
 * Query parameters:
 *   limit  (optional, default 20, max 50, min 1)
 *
 * Response: { actions: Array<{ timestamp, lead_id, action_type, status }> }
 */
router.get('/', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { user } = req as AuthenticatedRequest;

        const rawLimit = req.query.limit;
        let limit = 20;

        if (rawLimit !== undefined) {
            const parsed = parseInt(String(rawLimit), 10);
            if (!Number.isNaN(parsed) && parsed >= 1) {
                limit = Math.min(parsed, 50);
            }
        }

        const actions = await queryActivityLog(user.memberId, limit);

        logger.debug('Activity log queried', {
            memberId: user.memberId,
            resultCount: actions.length,
        });

        res.json({ actions });
    } catch (error) {
        next(error);
    }
});

export { router as activityRouter };
