import { MESSAGE_TYPES } from '../shared/constants';
import { createMessage } from '../shared/messages';
import { parseLeadUrl } from './urlParser';
import { startWatching } from './navigationWatcher';

/**
 * Evaluates the current URL and sends the appropriate lead detection
 * message to the service worker.
 */
function evaluateCurrentUrl(): void {
    const leadId = parseLeadUrl(window.location.href);

    if (leadId) {
        chrome.runtime.sendMessage(
            createMessage(MESSAGE_TYPES.LEAD_DETECTED, { leadId }),
        );
    } else {
        chrome.runtime.sendMessage(
            createMessage(MESSAGE_TYPES.LEAD_NOT_DETECTED),
        );
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
