import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './jwtAuth.js';
import { RateLimitedError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface WindowEntry {
    count: number;
    windowStart: number;
    windowMs: number;
}

const DEFAULT_MAX_REQUESTS = 10;
const DEFAULT_WINDOW_MS = 60_000;
const PRUNE_INTERVAL_MS = 60_000;

const agentWindows = new Map<string, WindowEntry>();
const ipWindows = new Map<string, WindowEntry>();

/**
 * Removes expired entries from both rate limiter Maps.
 * An entry is expired when the current time exceeds its window start
 * plus the window duration.
 */
function pruneExpiredEntries(): void {
    const now = Date.now();
    let prunedCount = 0;

    for (const [key, entry] of agentWindows) {
        if (now - entry.windowStart > entry.windowMs) {
            agentWindows.delete(key);
            prunedCount++;
        }
    }

    for (const [key, entry] of ipWindows) {
        if (now - entry.windowStart > entry.windowMs) {
            ipWindows.delete(key);
            prunedCount++;
        }
    }

    if (prunedCount > 0) {
        logger.debug('Pruned expired rate limiter entries', { count: prunedCount });
    }
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic pruning timer. Safe to call multiple times;
 * subsequent calls are no-ops.
 */
function startPruneTimer(): void {
    if (pruneTimer) return;
    pruneTimer = setInterval(pruneExpiredEntries, PRUNE_INTERVAL_MS);
    if (pruneTimer.unref) {
        pruneTimer.unref();
    }
}

/**
 * Stops the periodic pruning timer. Used for graceful shutdown and testing.
 */
export function stopPruneTimer(): void {
    if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
    }
}

startPruneTimer();

/**
 * Creates a per-agent fixed window rate limiter middleware.
 *
 * Authorization chain step covered:
 *   Step 7: Per-agent rate limit check
 *
 * The window is fixed, not sliding: it starts at the first request and resets
 * whole. An agent can therefore send up to twice the limit across a window
 * boundary, which is the accepted cost of keeping one counter per agent rather
 * than a timestamp list. The limit exists to stop a runaway loop, not to meter
 * usage precisely, and the burst is bounded either way.
 *
 * When the limit is exceeded, throws RateLimitedError with the
 * number of seconds until the window resets.
 *
 * Must be placed after jwtAuth middleware.
 */
export function createRateLimiter(
    maxRequests: number = DEFAULT_MAX_REQUESTS,
    windowMs: number = DEFAULT_WINDOW_MS,
) {
    return function rateLimiter(req: Request, _res: Response, next: NextFunction): void {
        const { user } = req as AuthenticatedRequest;
        const agentId = user.memberId;
        const now = Date.now();

        let entry = agentWindows.get(agentId);

        if (!entry || now - entry.windowStart >= windowMs) {
            entry = { count: 0, windowStart: now, windowMs };
            agentWindows.set(agentId, entry);
        }

        entry.count += 1;

        if (entry.count > maxRequests) {
            const elapsedMs = now - entry.windowStart;
            const remainingMs = windowMs - elapsedMs;
            const retryAfterSeconds = Math.ceil(remainingMs / 1000);

            throw new RateLimitedError(
                retryAfterSeconds,
                `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
            );
        }

        next();
    };
}

/**
 * Resets all rate limiter state. Used for testing only.
 */
export function resetRateLimiterState(): void {
    agentWindows.clear();
    ipWindows.clear();
    stopPruneTimer();
}

/**
 * Creates an IP-based fixed window rate limiter middleware, with the same
 * window semantics as createRateLimiter above.
 *
 * Designed for unauthenticated endpoints (e.g. auth routes) where
 * no JWT user object is available. Keys rate limiting on the
 * client IP address from req.ip.
 *
 * `keyPrefix` namespaces the window. Two limiters with different budgets must
 * not share a counter: without a prefix, a permissive endpoint's traffic
 * increments the same entry a strict endpoint reads, and exhausts it. Give
 * every limiter its own prefix.
 */
export function createIpRateLimiter(
    maxRequests: number = DEFAULT_MAX_REQUESTS,
    windowMs: number = DEFAULT_WINDOW_MS,
    keyPrefix = '',
) {
    return function ipRateLimiter(req: Request, _res: Response, next: NextFunction): void {
        const clientIp = `${keyPrefix}:${req.ip || 'unknown'}`;
        const now = Date.now();

        let entry = ipWindows.get(clientIp);

        if (!entry || now - entry.windowStart >= windowMs) {
            entry = { count: 0, windowStart: now, windowMs };
            ipWindows.set(clientIp, entry);
        }

        entry.count += 1;

        if (entry.count > maxRequests) {
            const elapsedMs = now - entry.windowStart;
            const remainingMs = windowMs - elapsedMs;
            const retryAfterSeconds = Math.ceil(remainingMs / 1000);

            throw new RateLimitedError(
                retryAfterSeconds,
                `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`,
            );
        }

        next();
    };
}
