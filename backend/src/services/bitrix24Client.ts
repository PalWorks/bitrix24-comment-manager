import { loadConfig } from '../config.js';
import { getBitrixTokens, storeBitrixTokens } from './tokenService.js';
import { BitrixApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface BitrixApiResponse {
    result?: unknown;
    error?: string;
    error_description?: string;
}

interface BitrixTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    client_endpoint?: string;
}

/**
 * Queued request entry. Each pending call stores its resolve/reject
 * callbacks so the queue processor can settle the corresponding promise.
 */
interface QueueEntry {
    resolve: (value: BitrixApiResponse) => void;
    reject: (reason: Error) => void;
    clientEndpoint: string;
    method: string;
    payload: Record<string, unknown>;
    accessToken: string;
    memberId: string;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const BACKOFF_FACTOR = 2;
const MAX_QUEUE_SIZE = 100;
const THROTTLE_INTERVAL_MS = 500;

/**
 * Ceiling on a single Bitrix24 HTTP call.
 *
 * Without one, a portal that accepts the connection and then stops responding
 * holds the Express request open until the client gives up, and holds a socket
 * and a queue slot for as long as it takes. Node's fetch has no default
 * timeout, so the only bound would be the operating system's, which is minutes.
 * A portal that has not answered in this long is not about to.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Per-portal request queue. When a portal returns 503 QUERY_LIMIT_EXCEEDED,
 * subsequent requests are buffered here until the portal recovers.
 * Max queue size per portal: MAX_QUEUE_SIZE (100).
 */
const portalQueues = new Map<string, QueueEntry[]>();

/**
 * Tracks whether a queue drain loop is currently running for a portal.
 * Prevents duplicate drain loops from being started concurrently.
 */
const draining = new Map<string, boolean>();

/**
 * In-flight token refreshes, keyed by member id.
 *
 * Bitrix24 rotates the refresh token on every exchange: the first request
 * invalidates the token the others are still holding. Several requests for one
 * member hitting 401 together is the normal case, not an unusual one, so
 * without this they race, all but one fail, and whichever finishes last writes
 * a token pair that Bitrix24 has already superseded. Coalescing onto one
 * exchange means the rotation happens once and every caller gets the result.
 */
const refreshInFlight = new Map<string, Promise<string>>();

/**
 * Extracts the portal domain from a Bitrix24 client endpoint URL.
 * Example: "https://myportal.bitrix24.com/rest/" returns "myportal.bitrix24.com"
 */
function extractPortalDomain(clientEndpoint: string): string {
    try {
        const url = new URL(clientEndpoint);
        return url.hostname;
    } catch {
        return clientEndpoint;
    }
}

/**
 * Delays execution for the specified number of milliseconds.
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff for a zero based attempt number, capped. */
function backoffFor(attempt: number): number {
    return Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt), MAX_BACKOFF_MS);
}

/**
 * True when a fetch rejection is a transport failure rather than a decision by
 * the far end: a timeout, a reset connection, a name that would not resolve.
 * Those are worth retrying. A malformed request is not.
 */
function isTransportError(error: unknown): boolean {
    if (error instanceof BitrixApiError) {
        return false;
    }
    return error instanceof Error;
}

/**
 * Performs the token exchange. Callers go through refreshAccessToken, which
 * ensures only one of these runs per member at a time.
 */
async function exchangeRefreshToken(memberId: string): Promise<string> {
    const config = loadConfig();
    const tokens = await getBitrixTokens(memberId);

    if (!tokens) {
        throw new BitrixApiError('No stored tokens for member. Re-authentication required.');
    }

    const response = await globalThis.fetch('https://oauth.bitrix.info/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: config.bitrix24ClientId,
            client_secret: config.bitrix24ClientSecret,
            refresh_token: tokens.refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        logger.error('Bitrix24 token refresh failed in bitrix24Client', {
            memberId,
            status: response.status,
        });
        throw new BitrixApiError('Failed to refresh Bitrix24 access token.');
    }

    const data: BitrixTokenResponse = await response.json();
    const newExpiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600);

    await storeBitrixTokens(memberId, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        clientEndpoint: tokens.clientEndpoint,
        domain: tokens.domain,
        expiresAt: newExpiresAt,
    });

    return data.access_token;
}

/**
 * Refreshes the Bitrix24 access token using the stored refresh token, at most
 * once at a time per member. Concurrent callers await the same exchange and
 * receive the same new access token.
 */
async function refreshAccessToken(memberId: string): Promise<string> {
    const existing = refreshInFlight.get(memberId);
    if (existing) {
        return existing;
    }

    const attempt = exchangeRefreshToken(memberId).finally(() => {
        refreshInFlight.delete(memberId);
    });

    refreshInFlight.set(memberId, attempt);
    return attempt;
}

/**
 * Executes a single Bitrix24 REST API request without queuing logic.
 * Handles 401 token refresh and returns the parsed response.
 * Returns null when a 503 is received so the caller can apply backoff.
 */
async function executeRequest(
    clientEndpoint: string,
    method: string,
    payload: Record<string, unknown>,
    accessToken: string,
    memberId: string,
): Promise<{ data: BitrixApiResponse | null; refreshedToken?: string }> {
    const response = await globalThis.fetch(`${clientEndpoint}${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, auth: accessToken }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401) {
        logger.info('Bitrix24 token expired, refreshing', { memberId, method });
        const newToken = await refreshAccessToken(memberId);
        return { data: null, refreshedToken: newToken };
    }

    if (response.status === 503) {
        return { data: null };
    }

    if (!response.ok) {
        const errorBody = await response.text();
        logger.error('Bitrix24 API call failed', {
            method,
            status: response.status,
            body: errorBody,
        });
        throw new BitrixApiError(`Bitrix24 ${method} returned status ${response.status}.`);
    }

    const data: BitrixApiResponse = await response.json();

    if (data.error) {
        throw new BitrixApiError(
            `Bitrix24 ${method} error: ${data.error_description || data.error}`,
        );
    }

    return { data };
}

/**
 * Drains the request queue for a specific portal domain.
 * Processes entries sequentially with a throttle interval to respect
 * the Bitrix24 rate limit (2 req/sec baseline).
 */
async function drainQueue(portal: string): Promise<void> {
    if (draining.get(portal)) return;
    draining.set(portal, true);

    try {
        const queue = portalQueues.get(portal);
        if (!queue) {
            return;
        }

        while (queue.length > 0) {
            const entry = queue.shift()!;

            try {
                const result = await callBitrixApiDirect(
                    entry.clientEndpoint,
                    entry.method,
                    entry.payload,
                    entry.accessToken,
                    entry.memberId,
                );
                entry.resolve(result);
            } catch (error) {
                entry.reject(error instanceof Error ? error : new BitrixApiError(String(error)));
            }

            if (queue.length > 0) {
                await delay(THROTTLE_INTERVAL_MS);
            }
        }

        // Removed only once the queue is empty, in the same synchronous step as
        // the check above. While a call is in flight the entry stays in the map
        // and still reads as queued, so a request arriving mid-drain joins the
        // queue rather than going direct and defeating the throttle that the
        // queue exists to impose.
        portalQueues.delete(portal);
    } finally {
        draining.delete(portal);
    }
}

/**
 * Performs a Bitrix24 REST API call with automatic token refresh on 401
 * and exponential backoff retry on 503 (QUERY_LIMIT_EXCEEDED).
 *
 * This is the direct execution path without queue enrollment.
 * Returns the parsed API response on success.
 * Throws BitrixApiError on irrecoverable failure.
 */
async function callBitrixApiDirect(
    clientEndpoint: string,
    method: string,
    payload: Record<string, unknown>,
    accessToken: string,
    memberId: string,
): Promise<BitrixApiResponse> {
    let currentToken = accessToken;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const isFinalAttempt = attempt === MAX_RETRIES;
        let result: Awaited<ReturnType<typeof executeRequest>>;

        try {
            result = await executeRequest(
                clientEndpoint,
                method,
                payload,
                currentToken,
                memberId,
            );
        } catch (error) {
            // A dropped connection or a timeout says nothing about whether the
            // request was wrong, only that it did not arrive intact. On a
            // congested link that is the common failure, and giving up on the
            // first one turns a slow network into a failed comment.
            if (!isTransportError(error) || isFinalAttempt) {
                throw error;
            }
            lastError = error as Error;
            logger.warn('Bitrix24 request failed in transport, retrying', {
                memberId,
                method,
                attempt: attempt + 1,
                error: (error as Error).message,
            });
            await delay(backoffFor(attempt));
            continue;
        }

        if (result.refreshedToken) {
            currentToken = result.refreshedToken;
            continue;
        }

        if (result.data === null) {
            lastError = new BitrixApiError('Bitrix24 QUERY_LIMIT_EXCEEDED');

            // Sleeping after the last attempt delays the caller's error by up
            // to the full backoff and retries nothing.
            if (isFinalAttempt) {
                break;
            }

            const backoffDelay = backoffFor(attempt);
            logger.warn('Bitrix24 rate limited (503), retrying', {
                memberId,
                method,
                attempt: attempt + 1,
                delayMs: backoffDelay,
            });
            await delay(backoffDelay);
            continue;
        }

        return result.data;
    }

    throw lastError || new BitrixApiError(`Bitrix24 ${method} failed after retries.`);
}

/**
 * Public entry point for Bitrix24 API calls.
 *
 * When the portal queue is active (due to a previous 503), new requests
 * are queued instead of executed immediately. If the queue exceeds
 * MAX_QUEUE_SIZE (100), the request is rejected immediately.
 *
 * Otherwise, the request is executed directly with retry/backoff logic.
 * On a 503 during direct execution, subsequent requests will be queued
 * and drained sequentially with throttling.
 */
async function callBitrixApi(
    clientEndpoint: string,
    method: string,
    payload: Record<string, unknown>,
    accessToken: string,
    memberId: string,
): Promise<BitrixApiResponse> {
    const portal = extractPortalDomain(clientEndpoint);
    const existingQueue = portalQueues.get(portal);

    // Presence in the map, not a non-empty queue, is what marks a portal as
    // throttled. An empty queue during a drain still means a call is in flight,
    // and a request that went direct then would sit alongside it.
    if (existingQueue) {
        if (existingQueue.length >= MAX_QUEUE_SIZE) {
            throw new BitrixApiError(
                `Request queue full for portal ${portal}. Max ${MAX_QUEUE_SIZE} pending requests.`,
            );
        }

        return new Promise<BitrixApiResponse>((resolve, reject) => {
            existingQueue.push({
                resolve,
                reject,
                clientEndpoint,
                method,
                payload,
                accessToken,
                memberId,
            });
        });
    }

    try {
        return await callBitrixApiDirect(
            clientEndpoint,
            method,
            payload,
            accessToken,
            memberId,
        );
    } catch (error) {
        if (
            error instanceof BitrixApiError &&
            error.message.includes('QUERY_LIMIT_EXCEEDED') &&
            !portalQueues.has(portal)
        ) {
            portalQueues.set(portal, []);
            // Deliberately not awaited: the drain outlives this request. It
            // settles each queued caller itself and cannot reject, but the
            // catch keeps a future change from becoming an unhandled rejection
            // that takes the process down.
            void drainQueue(portal).catch((drainError: unknown) => {
                logger.error('Bitrix24 queue drain failed', {
                    portal,
                    error: drainError instanceof Error ? drainError.message : String(drainError),
                });
                portalQueues.delete(portal);
            });
        }
        throw error;
    }
}

/**
 * Adds a timeline comment to a CRM lead.
 */
export async function addComment(
    clientEndpoint: string,
    accessToken: string,
    memberId: string,
    leadId: string,
    commentBody: string,
): Promise<{ commentId: string }> {
    const data = await callBitrixApi(
        clientEndpoint,
        'crm.timeline.comment.add',
        {
            fields: {
                ENTITY_ID: leadId,
                ENTITY_TYPE: 'lead',
                COMMENT: commentBody,
            },
        },
        accessToken,
        memberId,
    );

    return { commentId: String(data.result) };
}

/**
 * Updates an existing timeline comment.
 */
export async function updateComment(
    clientEndpoint: string,
    accessToken: string,
    memberId: string,
    commentId: string,
    commentBody: string,
): Promise<void> {
    await callBitrixApi(
        clientEndpoint,
        'crm.timeline.comment.update',
        {
            id: commentId,
            fields: { COMMENT: commentBody },
        },
        accessToken,
        memberId,
    );
}

/**
 * Deletes a timeline comment by its ID.
 */
export async function deleteComment(
    clientEndpoint: string,
    accessToken: string,
    memberId: string,
    commentId: string,
): Promise<void> {
    await callBitrixApi(
        clientEndpoint,
        'crm.timeline.comment.delete',
        { id: commentId },
        accessToken,
        memberId,
    );
}

/**
 * Retrieves a CRM lead by ID.
 * Returns the lead title (or 'Untitled Lead' if missing).
 * Throws NotFoundError if the lead does not exist.
 */
export async function getLead(
    clientEndpoint: string,
    accessToken: string,
    memberId: string,
    leadId: string,
): Promise<{ title: string }> {
    const data = await callBitrixApi(
        clientEndpoint,
        'crm.lead.get',
        { id: leadId },
        accessToken,
        memberId,
    );

    const result = data.result as { TITLE?: string } | undefined;
    return { title: result?.TITLE || 'Untitled Lead' };
}

/**
 * Exported for testing only. Clears all portal queues and drain states.
 */
export function _resetQueuesForTesting(): void {
    portalQueues.clear();
    draining.clear();
    refreshInFlight.clear();
}
