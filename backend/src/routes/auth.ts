import { Router, Request, Response, NextFunction } from 'express';
import { loadConfig, isPortalAllowed } from '../config.js';
import { BadRequestError, ForbiddenError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { jwtAuth, AuthenticatedRequest } from '../middleware/jwtAuth.js';
import { createIpRateLimiter } from '../middleware/rateLimiter.js';
import { writeAuditLog } from '../services/auditLogger.js';
import {
    generateOAuthState,
    validateOAuthState,
    signJwt,
    storeBitrixTokens,
    blacklistJwt,
    removeBitrixTokens,
} from '../services/tokenService.js';

const router = Router();
const authRateLimiter = createIpRateLimiter(5, 60_000);
const pollRateLimiter = createIpRateLimiter(60, 60_000);

interface CompletedSession {
    jwt: string;
    expiresAt: number;
    memberId: string;
    domain: string;
}

/**
 * In-memory store for pending OAuth sessions, keyed by the state (CSRF token).
 *
 * `portal` records which portal the login was started for, so the callback can
 * verify that the portal Bitrix24 reports is the one the flow began with. The
 * allowlist alone would let a state issued for one allowed portal complete
 * against another; binding it here keeps a flow to a single portal end to end.
 *
 * `session` is null while the callback has not completed yet.
 * Entries expire after 10 minutes regardless.
 */
interface PendingSession {
    portal: string;
    session: CompletedSession | null;
}

const pendingSessions = new Map<string, PendingSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

function expireSession(state: string): void {
    setTimeout(() => pendingSessions.delete(state), SESSION_TTL_MS);
}

/**
 * Validates a portal hostname supplied by a client.
 *
 * The value is interpolated into an authorization URL, so it is checked
 * structurally before it is trusted: a lower case DNS hostname of dot
 * separated labels, no scheme, no path, no port, no credentials. Anything
 * else is rejected rather than sanitised.
 */
function isValidPortalHostname(host: string): boolean {
    if (!host || host.length > 253) {
        return false;
    }
    return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(host);
}

/**
 * Resolves which portal to authorize against.
 *
 * A client may name its portal, which is what lets one backend serve several.
 * When it does not, the single portal shorthand is used. Either way the result
 * must pass the configured allowlist.
 */
function resolvePortal(requested: unknown, config: ReturnType<typeof loadConfig>): string {
    const candidate =
        typeof requested === 'string' && requested.trim()
            ? requested.trim().toLowerCase()
            : config.bitrix24PortalDomain;

    if (!candidate) {
        throw new BadRequestError(
            'No portal specified and this backend has no default portal configured.',
        );
    }

    if (!isValidPortalHostname(candidate)) {
        throw new BadRequestError('The portal must be a hostname, for example acme.bitrix24.com');
    }

    if (!isPortalAllowed(candidate, config.bitrix24AllowedPortals)) {
        throw new ForbiddenError(`This backend is not configured to serve the portal ${candidate}.`);
    }

    return candidate;
}

/**
 * GET /auth/login?portal=<hostname>
 *
 * Generates a Bitrix24 OAuth2 authorization URL using the backend as redirect URI.
 * The backend will handle the callback at GET /auth/callback.
 *
 * The optional `portal` parameter names the Bitrix24 portal to authorize
 * against, so a single backend can serve several portals. When it is omitted,
 * BITRIX24_PORTAL_DOMAIN is used. Either way the portal must be present in
 * BITRIX24_ALLOWED_PORTALS.
 *
 * Returns { authUrl, state, portal } for the extension to open and poll.
 */
router.get('/login', authRateLimiter, (req: Request, res: Response, next: NextFunction) => {
    try {
        const config = loadConfig();
        const portal = resolvePortal(req.query.portal, config);
        const state = generateOAuthState();

        const redirectUri = `${config.backendUrl}/auth/callback`;

        const params = new URLSearchParams({
            client_id: config.bitrix24ClientId,
            response_type: 'code',
            state,
            redirect_uri: redirectUri,
        });

        const authUrl = `https://${portal}/oauth/authorize/?${params.toString()}`;

        pendingSessions.set(state, { portal, session: null });
        expireSession(state);

        logger.info('OAuth login URL generated', { portal });

        res.json({ authUrl, state, portal });
    } catch (error) {
        next(error);
    }
});

/**
 * Records a failed authorization attempt.
 *
 * Every rejected callback is audited, not only a failed token exchange: a
 * missing parameter, a replayed or expired state, and a portal outside the
 * allowlist are all events an operator needs to see in the audit trail.
 */
function auditAuthFailure(
    req: Request,
    reason: string,
    context: { memberId?: string; domain?: string } = {},
): void {
    writeAuditLog({
        agent_id: context.memberId || 'unknown',
        bitrix_user_id: null,
        portal_domain: (context.domain || '').trim().toLowerCase(),
        lead_id: 'N/A',
        comment_id: null,
        action_type: 'AUTH_FAILURE',
        comment_hash: 'N/A',
        timestamp: new Date().toISOString(),
        ip_address: req.ip || null,
        status: 'FAILED',
        failure_reason: reason,
    });
}

/**
 * GET /auth/callback
 * Receives the authorization code redirect from Bitrix24.
 * Exchanges code for tokens, stores JWT keyed by state for the extension to poll.
 * Returns a simple HTML page the user can close.
 */
router.get('/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const code = req.query.code as string | undefined;
        const state = req.query.state as string | undefined;
        const domain = req.query.domain as string | undefined;
        const memberId = req.query.member_id as string | undefined;

        if (!code || !state) {
            auditAuthFailure(req, 'Missing required fields: code or state.', {
                memberId,
                domain,
            });
            res.status(400).send('<h2>Authorization failed. Missing code or state. Please close this tab and try again.</h2>');
            return;
        }

        if (!validateOAuthState(state)) {
            auditAuthFailure(req, 'Invalid or expired OAuth state.', { memberId, domain });
            res.status(400).send('<h2>Authorization failed. Invalid or expired session. Please close this tab and try again.</h2>');
            return;
        }

        const pending = pendingSessions.get(state);

        if (!pending) {
            auditAuthFailure(req, 'No pending session for the supplied state.', {
                memberId,
                domain,
            });
            res.status(400).send('<h2>Authorization failed. Invalid or expired session. Please close this tab and try again.</h2>');
            return;
        }

        const config = loadConfig();

        const tokenResponse = await fetch('https://oauth.bitrix.info/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: config.bitrix24ClientId,
                client_secret: config.bitrix24ClientSecret,
                redirect_uri: `${config.backendUrl}/auth/callback`,
                code,
            }).toString(),
        });

        if (!tokenResponse.ok) {
            const errorBody = await tokenResponse.text();
            logger.error('Bitrix24 token exchange failed', {
                status: tokenResponse.status,
                body: errorBody,
            });
            auditAuthFailure(req, 'Failed to exchange authorization code with Bitrix24.', {
                memberId,
                domain,
            });
            res.status(502).send('<h2>Authentication failed. Could not exchange code with Bitrix24. Please close this tab and try again.</h2>');
            return;
        }

        const tokenData = await tokenResponse.json();

        const resolvedDomain = (domain || tokenData.domain || config.bitrix24PortalDomain || '')
            .trim()
            .toLowerCase();

        if (!resolvedDomain || !isPortalAllowed(resolvedDomain, config.bitrix24AllowedPortals)) {
            logger.warn('OAuth callback for a portal outside the allowlist', {
                domain: resolvedDomain || '(none)',
            });
            auditAuthFailure(req, 'Portal is not in the configured allowlist.', {
                memberId,
                domain: resolvedDomain,
            });
            res.status(403).send(
                '<h2>Authorization failed. This backend does not serve that Bitrix24 portal. Please close this tab.</h2>',
            );
            return;
        }

        if (resolvedDomain !== pending.portal) {
            logger.warn('OAuth callback portal does not match the portal the flow started for', {
                expected: pending.portal,
                received: resolvedDomain,
            });
            auditAuthFailure(req, 'Callback portal does not match the portal the login started for.', {
                memberId,
                domain: resolvedDomain,
            });
            res.status(400).send(
                '<h2>Authorization failed. This login was started for a different Bitrix24 portal. Please close this tab and try again.</h2>',
            );
            return;
        }

        const resolvedMemberId = memberId || tokenData.user_id?.toString() || 'unknown';
        const clientEndpoint = tokenData.client_endpoint || `https://${resolvedDomain}/rest/`;
        const accessTokenExpiresAt = Math.floor(Date.now() / 1000) + (tokenData.expires_in || 3600);

        await storeBitrixTokens(resolvedMemberId, {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            clientEndpoint,
            domain: resolvedDomain,
            expiresAt: accessTokenExpiresAt,
        });

        const { token: jwt, expiresAt } = signJwt({
            memberId: resolvedMemberId,
            domain: resolvedDomain,
            clientEndpoint,
        });

        pendingSessions.set(state, {
            portal: pending.portal,
            session: { jwt, expiresAt, memberId: resolvedMemberId, domain: resolvedDomain },
        });

        logger.info('OAuth callback completed successfully', { memberId: resolvedMemberId, domain: resolvedDomain });

        res.send(`<!DOCTYPE html>
<html>
<head><title>Authentication Successful</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4;}
.box{text-align:center;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);}
h2{color:#16a34a;margin-bottom:8px;}p{color:#555;}</style></head>
<body><div class="box"><h2>Authentication Successful</h2><p>You can close this tab and return to the extension.</p></div></body>
</html>`);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /auth/poll?state=<state>
 * Extension polls this endpoint (max 60 req/min) to retrieve the JWT after
 * the server-side OAuth callback completes.
 * Returns { pending: true } while waiting, or { jwt, expiresAt, memberId, domain } when ready.
 */
router.get('/poll', pollRateLimiter, (req: Request, res: Response) => {
    const state = req.query.state as string | undefined;

    if (!state || !pendingSessions.has(state)) {
        res.status(404).json({ error: 'Session not found or expired.' });
        return;
    }

    const entry = pendingSessions.get(state);

    if (!entry || entry.session === null) {
        res.json({ pending: true });
        return;
    }

    pendingSessions.delete(state);
    res.json(entry.session);
});

/**
 * POST /auth/logout
 * Requires a valid JWT. Blacklists the JWT jti and removes stored Bitrix24 tokens.
 */
router.post('/logout', jwtAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { user } = req as AuthenticatedRequest;

        blacklistJwt(user.jti, user.exp);
        await removeBitrixTokens(user.memberId);

        logger.info('User logged out', { memberId: user.memberId });

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /auth/refresh
 * Requires a valid JWT. Blacklists the current jti and issues a fresh JWT.
 */
router.post('/refresh', jwtAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
        const { user } = req as AuthenticatedRequest;

        blacklistJwt(user.jti, user.exp);

        const { token: jwt, expiresAt } = signJwt({
            memberId: user.memberId,
            domain: user.domain,
            clientEndpoint: user.clientEndpoint,
        });

        logger.info('JWT refreshed', { memberId: user.memberId });

        res.json({
            jwt,
            expiresAt,
            memberId: user.memberId,
            domain: user.domain,
        });
    } catch (error) {
        next(error);
    }
});

export { router as authRouter };
