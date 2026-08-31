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

/**
 * Refreshes the Bitrix24 access token using the stored refresh token.
 * Updates the in-memory token store on success.
 * Returns the new access token.
 */
async function refreshAccessToken(memberId: string): Promise<string> {
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

    const queue = portalQueues.get(portal);
    if (!queue) {
        draining.set(portal, false);
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

    portalQueues.delete(portal);
    draining.set(portal, false);
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
        const result = await executeRequest(
            clientEndpoint,
            method,
            payload,
            currentToken,
            memberId,
        );

        if (result.refreshedToken) {
            currentToken = result.refreshedToken;
            continue;
        }

        if (result.data === null) {
            const backoffDelay = Math.min(
                BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt),
                MAX_BACKOFF_MS,
            );
            logger.warn('Bitrix24 rate limited (503), retrying', {
                memberId,
                method,
                attempt: attempt + 1,
                delayMs: backoffDelay,
            });
            await delay(backoffDelay);
            lastError = new BitrixApiError('Bitrix24 QUERY_LIMIT_EXCEEDED');
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

    if (existingQueue && existingQueue.length > 0) {
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
            error.message.includes('QUERY_LIMIT_EXCEEDED')
        ) {
            const queue: QueueEntry[] = [];
            portalQueues.set(portal, queue);
            drainQueue(portal);
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
}
