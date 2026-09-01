import { CONFIG } from '../shared/constants';

let popstateHandler: (() => void) | null = null;
let hashchangeHandler: (() => void) | null = null;
let observer: MutationObserver | null = null;
let throttleTimerId: ReturnType<typeof setTimeout> | null = null;
let lastCheckedUrl: string = '';

/**
 * Starts watching for navigation changes in Bitrix24 SPA pages.
 *
 * Uses three mechanisms to detect navigation:
 * 1. popstate: browser back/forward buttons
 * 2. hashchange: hash-based routing
 * 3. MutationObserver: DOM mutations that indicate SPA page transitions
 *    (throttled to check URL every NAVIGATION_THROTTLE_MS)
 *
 * There used to be a fourth: history.pushState was reassigned here so that a
 * Bitrix24 route change would announce itself immediately. It never fired. A
 * content script runs in an isolated world, which shares the page's DOM but not
 * its JavaScript objects, so the patch applied to this world's `history` while
 * Bitrix24 went on calling its own untouched one. The MutationObserver was
 * silently doing all the work, and the only real effect of the patch was to
 * leave a listener that stopWatching had no reference to remove.
 *
 * Detection is therefore bounded by NAVIGATION_THROTTLE_MS, which is what it
 * has always been in practice.
 *
 * @param callback Invoked with the new URL whenever a navigation change is detected
 */
export function startWatching(callback: (url: string) => void): void {
    stopWatching();
    lastCheckedUrl = window.location.href;

    popstateHandler = () => {
        callback(window.location.href);
    };

    hashchangeHandler = () => {
        callback(window.location.href);
    };

    window.addEventListener('popstate', popstateHandler);
    window.addEventListener('hashchange', hashchangeHandler);

    observer = new MutationObserver(() => {
        if (throttleTimerId !== null) {
            return;
        }

        throttleTimerId = setTimeout(() => {
            throttleTimerId = null;
            const currentUrl = window.location.href;
            if (currentUrl !== lastCheckedUrl) {
                lastCheckedUrl = currentUrl;
                callback(currentUrl);
            }
        }, CONFIG.NAVIGATION_THROTTLE_MS);
    });

    observer.observe(document.body, {
        subtree: true,
        childList: true,
    });
}

/**
 * Stops watching for navigation changes.
 * Disconnects all event listeners and the MutationObserver.
 */
export function stopWatching(): void {
    if (popstateHandler) {
        window.removeEventListener('popstate', popstateHandler);
        popstateHandler = null;
    }

    if (hashchangeHandler) {
        window.removeEventListener('hashchange', hashchangeHandler);
        hashchangeHandler = null;
    }

    if (observer) {
        observer.disconnect();
        observer = null;
    }

    if (throttleTimerId !== null) {
        clearTimeout(throttleTimerId);
        throttleTimerId = null;
    }

    lastCheckedUrl = '';
}
