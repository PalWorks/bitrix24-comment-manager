/**
 * Public support endpoint.
 *
 * This is the only unauthenticated route that causes an outbound email, so it
 * is the one an abuser would reach for. Four properties keep it from being a
 * relay, and none of them may be relaxed:
 *
 *   1. The recipient and the sender come from configuration. Nothing in the
 *      request body can redirect a message.
 *   2. Rate limited per IP, on its own namespace so other endpoints cannot
 *      spend its budget or have theirs spent.
 *   3. Body and attachment are size capped before anything is decoded.
 *   4. Attachment types are an allowlist, not a denylist.
 *
 * A deployment with no mail configuration answers 503 rather than failing
 * obscurely, which is the normal state for a self hosted instance.
 */

import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { loadConfig, AppConfig } from '../config.js';
import { AppError, BadRequestError } from '../utils/errors.js';
import { createIpRateLimiter } from '../middleware/rateLimiter.js';
import {
    isSupportConfigured,
    sendSupportEmail,
    SupportAttachment,
} from '../services/supportMailer.js';

/**
 * Config is read on first use, not at import time, matching every other module
 * here. Reading it at import time makes the module impossible to load before
 * the environment is in place, which is exactly the position a test is in.
 */
let cachedConfig: AppConfig | null = null;

function getConfig(): AppConfig {
    if (!cachedConfig) {
        cachedConfig = loadConfig();
    }
    return cachedConfig;
}

/** Test seam: drops the cached config so a suite can change the environment. */
export function resetSupportConfig(): void {
    cachedConfig = null;
    jsonParser = null;
}

export const CATEGORIES = ['bug', 'question', 'billing', 'hosting-waitlist'] as const;
type Category = (typeof CATEGORIES)[number];

const ALLOWED_ATTACHMENT_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'application/json',
    'application/zip',
]);

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 80;
const MIN_MESSAGE_LENGTH = 10;
const MAX_MESSAGE_LENGTH = 5000;
const MAX_EMAIL_LENGTH = 254;
const MAX_FILENAME_LENGTH = 120;
const MAX_CONTEXT_ENTRIES = 12;
const MAX_CONTEXT_VALUE_LENGTH = 200;

/**
 * The JSON body carries a base64 attachment, so the cap is the decoded limit
 * plus base64's one third overhead plus room for the rest of the envelope.
 * Built on first request, since the limit comes from configuration.
 */
let jsonParser: ReturnType<typeof express.json> | null = null;

function parseJsonBody(req: Request, res: Response, next: NextFunction): void {
    if (!jsonParser) {
        const limit = Math.ceil(getConfig().supportMaxAttachmentBytes * 1.4) + 64 * 1024;
        jsonParser = express.json({ limit });
    }

    jsonParser(req, res, (error?: unknown) => {
        // A body over the limit is the ordinary consequence of attaching too
        // large a file. Left to the generic handler it surfaces as a 500 and an
        // "unexpected error", which tells the person nothing about the file
        // they just chose.
        if (error && (error as { type?: string }).type === 'entity.too.large') {
            const limitMb = Math.floor(getConfig().supportMaxAttachmentBytes / (1024 * 1024));
            next(
                new AppError(
                    413,
                    'PAYLOAD_TOO_LARGE',
                    `That message is too large. Attachments are limited to ${limitMb} MB.`,
                ),
            );
            return;
        }
        next(error);
    });
}

const supportRateLimiter = createIpRateLimiter(3, 60 * 60_000, 'support');

/**
 * Deliberately permissive but anchored. Address validity is ultimately decided
 * by whether a reply reaches it, not by a regular expression.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/**
 * A reachable international number, which is the only kind worth collecting:
 * a bare local number cannot be dialled from anywhere else. Presentation
 * characters are stripped first, leaving E.164's plus and 7 to 15 digits.
 */
const PHONE_DIGITS = /^\+[1-9]\d{6,14}$/;

/**
 * Normalises a typed number to E.164. Returns null when what is left is not a
 * dialable international number.
 */
export function normalizePhone(input: string): string | null {
    const stripped = input.replace(/[\s\-().]/g, '');
    return PHONE_DIGITS.test(stripped) ? stripped : null;
}

/**
 * Makes a value safe to sit in an email display name.
 *
 * Resend is given JSON rather than raw SMTP, so this is not header injection
 * defence. It stops a name containing a quote or an angle bracket from
 * producing an address Resend parses as something other than intended.
 */
function sanitizeDisplayName(name: string): string {
    return name
        .replace(/[\r\n]+/g, ' ')
        .replace(/["<>,;:]/g, '')
        .trim()
        .slice(0, MAX_NAME_LENGTH);
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new BadRequestError(`${field} is required.`);
    }
    return value.trim();
}

function parseCategory(value: unknown): Category {
    const category = requireString(value, 'category');
    if (!(CATEGORIES as readonly string[]).includes(category)) {
        throw new BadRequestError('Unknown category.');
    }
    return category as Category;
}

/**
 * Strips anything that could steer a mail client or a filesystem: path
 * separators, control characters and leading dots.
 */
function sanitizeFilename(name: string): string {
    // Control characters are stripped with an explicit escape range so the
    // literal never depends on how this file was transported.
    const base = name
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/]/g, '_')
        .replace(/^\.+/, '')
        .trim();
    return base.slice(0, MAX_FILENAME_LENGTH) || 'attachment';
}

/**
 * Validates the optional attachment and returns it ready for the mailer.
 * Size is checked against the decoded length, since base64 inflates by a third
 * and a caller could otherwise sit just under a byte cap applied to the string.
 */
function parseAttachment(raw: unknown): SupportAttachment | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }

    if (typeof raw !== 'object') {
        throw new BadRequestError('attachment must be an object.');
    }

    const candidate = raw as Record<string, unknown>;
    const filename = requireString(candidate.filename, 'attachment.filename');
    const contentType = requireString(candidate.contentType, 'attachment.contentType');
    const content = requireString(candidate.content, 'attachment.content');

    if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
        throw new BadRequestError(
            'That file type is not accepted. Send a PNG, JPEG, GIF, WebP, PDF, text, JSON or zip file.',
        );
    }

    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) {
        throw new BadRequestError('attachment.content must be base64.');
    }

    const decodedBytes = Buffer.byteLength(content, 'base64');
    if (decodedBytes === 0) {
        throw new BadRequestError('The attachment is empty.');
    }
    if (decodedBytes > getConfig().supportMaxAttachmentBytes) {
        const limitMb = Math.floor(getConfig().supportMaxAttachmentBytes / (1024 * 1024));
        throw new BadRequestError(`The attachment is too large. The limit is ${limitMb} MB.`);
    }

    return { filename: sanitizeFilename(filename), contentType, content };
}

/**
 * Copies a bounded, stringified subset of the diagnostics the client sent.
 * Unbounded client supplied maps end up in an inbox, so both the number of
 * entries and each value are clipped.
 */
function parseContext(raw: unknown): Record<string, string> {
    const context: Record<string, string> = {};

    if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (Object.keys(context).length >= MAX_CONTEXT_ENTRIES) {
                break;
            }
            if (typeof value === 'string' || typeof value === 'number') {
                context[key.slice(0, 40)] = String(value).slice(0, MAX_CONTEXT_VALUE_LENGTH);
            }
        }
    }

    return context;
}

export const supportRouter = Router();

/**
 * Lets the options page decide whether to offer the form at all, and what
 * attachment size to enforce client side, without attempting a send first.
 */
supportRouter.get('/config', (_req: Request, res: Response) => {
    res.json({
        available: isSupportConfigured(getConfig()),
        categories: CATEGORIES,
        maxMessageLength: MAX_MESSAGE_LENGTH,
        maxAttachmentBytes: getConfig().supportMaxAttachmentBytes,
        allowedAttachmentTypes: [...ALLOWED_ATTACHMENT_TYPES],
    });
});

supportRouter.post(
    '/',
    supportRateLimiter,
    parseJsonBody,
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;

            // Honeypot. A real form leaves this empty because it is hidden;
            // a bot that fills every input gets a plausible success instead of
            // a signal that it was detected.
            if (typeof body.company === 'string' && body.company.trim() !== '') {
                res.status(202).json({ success: true });
                return;
            }

            const name = requireString(body.name, 'name');
            if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
                throw new BadRequestError('Tell us your name so we know who we are replying to.');
            }

            const email = requireString(body.email, 'email');
            if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
                throw new BadRequestError('Enter an email address we can reply to.');
            }

            // Optional, but if given it has to be dialable, or it is worse than
            // nothing: it looks like a way to reach someone and is not one.
            const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
            let phone = '';
            if (rawPhone) {
                const normalized = normalizePhone(rawPhone);
                if (!normalized) {
                    throw new BadRequestError(
                        'Include the country code on the phone number, for example +971 50 123 4567.',
                    );
                }
                phone = normalized;
            }

            const category = parseCategory(body.category);
            const message = requireString(body.message, 'message');

            if (message.length < MIN_MESSAGE_LENGTH) {
                throw new BadRequestError(
                    `Tell us a little more. At least ${MIN_MESSAGE_LENGTH} characters.`,
                );
            }
            if (message.length > MAX_MESSAGE_LENGTH) {
                throw new BadRequestError(
                    `That message is too long. The limit is ${MAX_MESSAGE_LENGTH} characters.`,
                );
            }

            await sendSupportEmail(getConfig(), {
                name: sanitizeDisplayName(name),
                email,
                phone,
                category,
                message,
                context: parseContext(body.context),
                attachment: parseAttachment(body.attachment),
            });

            res.status(202).json({ success: true });
        } catch (error) {
            next(error);
        }
    },
);
