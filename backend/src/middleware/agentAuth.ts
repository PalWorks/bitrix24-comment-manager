import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './jwtAuth.js';
import { getBitrixTokens } from '../services/tokenService.js';
import { ForbiddenError } from '../utils/errors.js';

/**
 * Middleware that validates the authenticated agent is active and has
 * a valid Bitrix24 token mapping.
 *
 * Authorization chain steps covered:
 *   Step 3: Agent is active (token store entry exists)
 *   Step 4: Agent-to-Bitrix24 mapping exists (tokens contain clientEndpoint and accessToken)
 *
 * Must be placed after jwtAuth middleware.
 */
export async function agentAuth(
    req: Request,
    _res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { user } = req as AuthenticatedRequest;

        const tokens = await getBitrixTokens(user.memberId);

        if (!tokens) {
            throw new ForbiddenError('Agent is not active. No Bitrix24 tokens found.');
        }

        if (!tokens.clientEndpoint || !tokens.accessToken) {
            throw new ForbiddenError('Agent Bitrix24 mapping is incomplete.');
        }

        next();
    } catch (error) {
        next(error);
    }
}
