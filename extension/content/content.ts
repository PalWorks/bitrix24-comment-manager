import { MESSAGE_TYPES } from '../shared/constants';
import { createMessage } from '../shared/messages';
import { parseLeadUrl } from './urlParser';
import { startWatching } from './navigationWatcher';

/**
 * Tells the service worker about a lead, ignoring the delivery failures that
 * are normal rather than exceptional.
 *
 * These messages are one way: the worker records the lead and does not reply,
 * so the promise chrome.runtime.sendMessage returns rejects with "the message
 * port closed before a response was received" every single time. Unhandled,
 * that is an error logged to the console of the customer's Bitrix24 page on
 * every navigation. The same is true when the extension is reloaded or updated
 * while the page stays open, which leaves this script with no worker to talk
 * to at all.
 */
function notifyWorker(message: ReturnType<typeof createMessage>): void {
    try {
        void chrome.runtime.sendMessage(message)?.catch(() => {
            // Nothing is listening, or nothing answered. Either way the next
            // navigation sends a fresh message and the popup falls back to
            // reading the tab URL directly.
        });
    } catch {
        // The extension context is gone, which throws synchronously.
    }
}

/**
 * Evaluates the current URL and sends the appropriate lead detection
 * message to the service worker.
 */
function evaluateCurrentUrl(): void {
    const leadId = parseLeadUrl(window.location.href);

    if (leadId) {
        notifyWorker(createMessage(MESSAGE_TYPES.LEAD_DETECTED, { leadId }));
    } else {
        notifyWorker(createMessage(MESSAGE_TYPES.LEAD_NOT_DETECTED));
    }
}

/**
 * Content script entry point.
 * 1. Parses the current page URL for a lead ID on initial load.
 * 2. Starts the navigation watcher for SPA transitions.
 */
evaluateCurrentUrl();

startWatching(() => {
    evaluateCurrentUrl();
});
