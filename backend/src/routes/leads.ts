import { Router, Request, Response as ExpressResponse, NextFunction } from 'express';
import { jwtAuth, AuthenticatedRequest } from '../middleware/jwtAuth.js';
import { getBitrixTokens } from '../services/tokenService.js';
import { getLead } from '../services/bitrix24Client.js';
import { NotFoundError, BitrixApiError, BadRequestError } from '../utils/errors.js';

const router = Router();

/**
 * GET /api/leads/:leadId
 *
 * Protected by JWT authentication.
 * Retrieves a lead's name from the Bitrix24 CRM using the centralized
 * bitrix24Client service, which handles token refresh and retry internally.
 *
 * Response: { lead_id, lead_name, exists: boolean }
 */
router.get('/:leadId', jwtAuth, async (req: Request, res: ExpressResponse, next: NextFunction) => {
    try {
        const { leadId } = req.params;
        const { user } = req as AuthenticatedRequest;

        if (!leadId || !/^\d+$/.test(leadId)) {
            throw new BadRequestError('Lead ID must be a numeric value.');
        }

        const tokens = await getBitrixTokens(user.memberId);
        if (!tokens) {
            throw new BitrixApiError('No Bitrix24 tokens found. Please re-authenticate.');
        }

        const lead = await getLead(
            tokens.clientEndpoint,
            tokens.accessToken,
            user.memberId,
            leadId,
        );

        res.json({
            lead_id: leadId,
            lead_name: lead.title,
            exists: true,
        });
    } catch (error) {
        if (
            error instanceof BitrixApiError &&
            (error.message.includes('NOT_FOUND') || error.message.includes('Not found'))
        ) {
            next(new NotFoundError(`Lead ${req.params.leadId} not found in Bitrix24.`));
            return;
        }
        next(error);
    }
});

export { router as leadsRouter };
