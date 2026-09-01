/**
 * Delivers support messages submitted from the extension's options page.
 *
 * Resend is called over plain fetch rather than through its SDK: the request is
 * a single JSON POST, and one less dependency on a public, unauthenticated
 * path is worth more than the convenience.
 *
 * The sender and the recipient are fixed by configuration. Only `reply_to`
 * carries the address the user typed, so this endpoint can never be used to
 * send mail to a third party. That property is what keeps a public form from
 * being an open relay, and it must hold for any future change here.
 */

import { AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 15_000;

export interface SupportAttachment {
    filename: string;
    contentType: string;
    /** Base64 encoded file bytes, without a data: URI prefix. */
    content: string;
}

export interface SupportMessage {
    /** The reporter's name, already stripped of anything an address cannot hold. */
    name: string;
    /** The reporter's address. Used only as reply_to. */
    email: string;
    /** E.164 number, or an empty string when not given. */
    phone: string;
    category: string;
    message: string;
    /** Extension version, portal host and similar diagnostics. */
    context: Record<string, string>;
    attachment?: SupportAttachment;
}

/**
 * True when the deployment has everything needed to send. A self hosted
 * instance that never sets these simply does not expose working support.
 */
export function isSupportConfigured(config: AppConfig): boolean {
    return Boolean(config.resendApiKey && config.supportFromEmail && config.supportToEmail);
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Builds the email body. Every interpolated value came from an untrusted
 * request, so all of it is escaped before it reaches the HTML part.
 */
function renderBody(message: SupportMessage): { html: string; text: string } {
    // Contact details lead, because the first thing anyone reading this needs
    // is how to reach the person. The phone line is omitted rather than shown
    // empty, so a blank never reads as a number that failed to arrive.
    const contact: Array<[string, string]> = [
        ['Name', message.name],
        ['Email', message.email],
    ];
    if (message.phone) {
        contact.push(['Phone', message.phone]);
    }
    contact.push(['Category', message.category]);

    const contactHtml = contact
        .map(([key, value]) => `<b>${escapeHtml(key)}:</b> ${escapeHtml(value)}`)
        .join('<br>');

    const contextRows = Object.entries(message.context)
        .map(([key, value]) => `<tr><td><b>${escapeHtml(key)}</b></td><td>${escapeHtml(value)}</td></tr>`)
        .join('');

    const contextLines = Object.entries(message.context)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');

    const html = [
        `<p>${contactHtml}</p>`,
        `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(message.message)}</pre>`,
        '<hr>',
        `<table>${contextRows}</table>`,
    ].join('\n');

    const text = [
        ...contact.map(([key, value]) => `${key}: ${value}`),
        '',
        message.message,
        '',
        '---',
        contextLines,
    ].join('\n');

    return { html, text };
}

/**
 * Sends one support message. Throws an AppError the route can surface; the
 * Resend response body is logged but never returned to the caller, since it
 * can name the configured recipient.
 */
export async function sendSupportEmail(
    config: AppConfig,
    message: SupportMessage,
): Promise<void> {
    if (!isSupportConfigured(config)) {
        throw new AppError(
            503,
            'SUPPORT_UNAVAILABLE',
            'This deployment has no support mailbox configured.',
        );
    }

    const { html, text } = renderBody(message);

    const payload: Record<string, unknown> = {
        from: config.supportFromEmail,
        to: [config.supportToEmail],
        // The name rides along so a reply is addressed to a person rather than
        // to an address. It has already been stripped of quotes and brackets.
        reply_to: message.name ? `${message.name} <${message.email}>` : message.email,
        subject: `[${message.category}] Support request from ${message.name || message.email}`,
        html,
        text,
    };

    if (message.attachment) {
        payload.attachments = [
            {
                filename: message.attachment.filename,
                content: message.attachment.content,
                content_type: message.attachment.contentType,
            },
        ];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.resendApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } catch (error) {
        logger.error('Support email transport failed', {
            message: error instanceof Error ? error.message : String(error),
        });
        throw new AppError(
            502,
            'SUPPORT_SEND_FAILED',
            'Could not reach the mail service. Please try again shortly.',
        );
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        logger.error('Support email rejected', { status: response.status, detail });
        throw new AppError(
            502,
            'SUPPORT_SEND_FAILED',
            'The mail service rejected the message. Please try again shortly.',
        );
    }

    logger.info('Support email sent', {
        category: message.category,
        hasAttachment: Boolean(message.attachment),
    });
}
