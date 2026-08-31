import { handleMessage } from './messageRouter';
import { removeTab } from './leadState';
import { resumeSession } from './tokenManager';
import { syncRegisteredPortals } from './portalRegistry';

/**
 * Service worker entry point.
 * Registers the central message listener that routes all
 * chrome.runtime messages to the appropriate handlers.
 */
chrome.runtime.onMessage.addListener(handleMessage);

/**
 * Cleans up per-tab lead state when a tab is closed.
 * Prevents memory leaks in the leadStateMap.
 */
chrome.tabs.onRemoved.addListener((tabId: number) => {
    removeTab(tabId);
});

/**
 * Reconciles state that does not survive a service worker restart.
 *
 * Manifest V3 terminates an idle worker and starts a fresh one on the next
 * event, which discards timers and module state. This restores the JWT refresh
 * schedule and re-registers content scripts for user added portals.
 *
 * Runs on every worker startup, not only on install, because the worker is
 * torn down and recreated many times over a browsing session.
 */
async function reconcile(): Promise<void> {
    await Promise.allSettled([resumeSession(), syncRegisteredPortals()]);
}

chrome.runtime.onStartup.addListener(() => {
    void reconcile();
});

chrome.runtime.onInstalled.addListener(() => {
    void reconcile();
});

void reconcile();
