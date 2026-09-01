import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './jwtAuth.js';
import { BadRequestError, DuplicateError } from '../utils/errors.js';
import { loadConfig, AppConfig } from '../config.js';
import { sha256 } from '../utils/hash.js';

let cachedConfig: AppConfig | null = null;

function getConfig(): AppConfig {
    if (!cachedConfig) {
        cachedConfig = loadConfig();
    }
    return cachedConfig;
}

interface DuplicateEntry {
    hash: string;
    leadId: string;
    agentId: string;
    timestamp: number;
}

const duplicateStore: DuplicateEntry[] = [];

/**
 * A request that has claimed a duplicate slot and can give it back.
 *
 * The claim has to be made before the comment is sent, or two requests in
 * flight together would both pass the check. But a claim that outlives a failed
 * send is worse than no check at all: the agent's comment never reached
 * Bitrix24, they press the button again, and the only thing standing in their
 * way is our own record of the attempt that failed. That is the exact shape of
 * a slow or dropped connection, so the route releases the claim when the send
 * does not succeed.
 */
export interface DuplicateGuardedRequest extends Request {
    releaseDuplicate?: () => void;
}

/**
 * Middleware that validates comment body size.
 *
 * Authorization chain step covered:
 *   Step 8: Comment body size check
 *
 * Checks both character length and byte length (for multi-byte characters)
 * against config.maxCommentLength.
 */
export function validateCommentSize(req: Request, _res: Response, next: NextFunction): void {
    const body = req.body?.comment_body;

    if (!body || typeof body !== 'string') {
        throw new BadRequestError('comment_body is required and must be a string.');
    }

    const trimmed = body.trim();

    if (trimmed.length === 0) {
        throw new BadRequestError('comment_body must not be empty.');
    }

    if (trimmed.length > getConfig().maxCommentLength) {
        throw new BadRequestError(
            `Comment exceeds maximum length of ${getConfig().maxCommentLength} characters.`,
        );
    }

    const byteLength = Buffer.byteLength(trimmed, 'utf8');
    const maxBytes = getConfig().maxCommentLength * 4;

    if (byteLength > maxBytes) {
        throw new BadRequestError(
            `Comment exceeds maximum byte size. Reduce the use of multi-byte characters.`,
        );
    }

    next();
}

/**
 * Middleware that detects duplicate comments using SHA-256 hashing.
 *
 * Authorization chain step covered:
 *   Step 9: Duplicate detection
 *
 * Computes SHA-256 of the comment body and checks the in-memory store
 * for a matching { hash, leadId, agentId } entry within the configured
 * duplicate window (default 300 seconds).
 */
export function detectDuplicate(req: Request, _res: Response, next: NextFunction): void {
    const { user } = req as AuthenticatedRequest;
    const leadId = req.body?.lead_id || req.params?.id;
    const commentBody = req.body?.comment_body;

    if (!commentBody || typeof commentBody !== 'string') {
        next();
        return;
    }

    const hash = sha256(commentBody.trim());
    const agentId = user.memberId;
    const now = Date.now();
    const windowMs = getConfig().duplicateWindowSeconds * 1000;

    pruneExpiredEntries(windowMs);

    const isDuplicate = duplicateStore.some(
        (entry) =>
            entry.hash === hash &&
            entry.leadId === leadId &&
            entry.agentId === agentId &&
            now - entry.timestamp < windowMs,
    );

    if (isDuplicate) {
        throw new DuplicateError(
            'This comment was already submitted recently. Please wait before submitting again.',
        );
    }

    const entry: DuplicateEntry = { hash, leadId, agentId, timestamp: now };
    duplicateStore.push(entry);

    (req as DuplicateGuardedRequest).releaseDuplicate = () => {
        const index = duplicateStore.indexOf(entry);
        if (index !== -1) {
            duplicateStore.splice(index, 1);
        }
    };

    next();
}

/**
 * Removes expired entries from the duplicate store.
 */
function pruneExpiredEntries(windowMs: number): void {
    const cutoff = Date.now() - windowMs;

    // Entries are appended in timestamp order, so everything expired sits at
    // the front and one splice removes it. The previous filter-and-respread
    // rebuilt the whole array on every request, and `push(...remaining)` passes
    // each element as an argument, which throws RangeError once the store grows
    // past the engine's argument limit.
    let expired = 0;
    while (expired < duplicateStore.length && duplicateStore[expired].timestamp < cutoff) {
        expired++;
    }

    if (expired > 0) {
        duplicateStore.splice(0, expired);
    }
}

/**
 * Resets all duplicate detection state. Used for testing only.
 */
export function resetDuplicateState(): void {
    duplicateStore.length = 0;
}
