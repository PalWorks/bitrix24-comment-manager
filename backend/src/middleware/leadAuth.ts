import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './jwtAuth.js';
import { getBitrixTokens, BitrixTokens } from '../services/tokenService.js';
import { getLead } from '../services/bitrix24Client.js';
import { NotFoundError, ForbiddenError, BadRequestError, BitrixApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Extends AuthenticatedRequest to carry the resolved Bitrix24 tokens
 * for downstream route handlers (e.g., comment creation).
 */
export interface LeadAuthenticatedRequest extends AuthenticatedRequest {
    leadTokens: BitrixTokens;
}

/**
 * Middleware that validates the lead exists in Bitrix24 and that the
 * current agent is authorized to access it.
 *
 * Authorization chain steps covered:
 *   Step 5: Lead exists (Bitrix24 crm.lead.get)
 *   Step 6: Agent authorized for this lead
 *
 * Reads lead_id exclusively from req.body for all operations (POST, PUT, DELETE).
 * Attaches the agent's Bitrix24 tokens as req.leadTokens for downstream use.
 *
 * Must be placed after jwtAuth and agentAuth middleware.
 */
export async function leadAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
        const { user } = req as AuthenticatedRequest;

        const leadId = req.body?.lead_id;

        if (!leadId) {
            throw new BadRequestError('lead_id is required.');
        }

        const tokens = await getBitrixTokens(user.memberId);

        if (!tokens) {
            throw new ForbiddenError('No Bitrix24 tokens found for agent.');
        }

        try {
            await getLead(tokens.clientEndpoint, tokens.accessToken, user.memberId, leadId);
        } catch (error) {
            if (error instanceof BitrixApiError) {
                const message = error.message.toLowerCase();
                if (message.includes('not found') || message.includes('not_found')) {
                    throw new NotFoundError(`Lead ${leadId} does not exist in Bitrix24.`);
                }
                if (message.includes('access denied') || message.includes('access_denied')) {
                    throw new ForbiddenError(`Agent is not authorized for lead ${leadId}.`);
                }
            }
            throw error;
        }

        (req as LeadAuthenticatedRequest).leadTokens = tokens;
        next();
    } catch (error) {
        logger.debug('leadAuth middleware rejected request', {
            error: error instanceof Error ? error.message : String(error),
        });
        next(error);
    }
}
