import { Request, Response, NextFunction } from 'express';
import { verifyJwt, JwtPayload } from '../services/tokenService.js';
import { UnauthorizedError } from '../utils/errors.js';

/**
 * Extends Express Request to include the authenticated user's JWT claims.
 */
export interface AuthenticatedRequest extends Request {
    user: JwtPayload;
}

/**
 * Express middleware that verifies the JWT from the Authorization header.
 * Attaches decoded claims to `req.user` on success.
 * Throws UnauthorizedError if the token is missing, malformed, or invalid.
 */
export function jwtAuth(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        throw new UnauthorizedError('Authorization header is required.');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new UnauthorizedError('Authorization header must use Bearer scheme.');
    }

    const token = parts[1];
    const payload = verifyJwt(token);

    if (!payload) {
        throw new UnauthorizedError('Invalid or expired token.');
    }

    (req as AuthenticatedRequest).user = payload;
    next();
}
