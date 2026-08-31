import { CONFIG } from '../shared/constants';

let popstateHandler: (() => void) | null = null;
let hashchangeHandler: (() => void) | null = null;
let observer: MutationObserver | null = null;
let throttleTimerId: ReturnType<typeof setTimeout> | null = null;
let lastCheckedUrl: string = '';

/**
 * Starts watching for navigation changes in Bitrix24 SPA pages.
 * Uses three mechanisms to detect navigation:
 * 1. popstate: browser back/forward buttons
 * 2. hashchange: hash-based routing
 * 3. MutationObserver: DOM mutations that indicate SPA page transitions
 *    (throttled to check URL every NAVIGATION_THROTTLE_MS)
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

    // Bitrix24 navigates via history.pushState. Patch it to emit a custom
    // event so we detect lead-page transitions immediately, without waiting
    // for a MutationObserver tick.
    const _pushState = history.pushState.bind(history);
    const _replaceState = history.replaceState.bind(history);

    history.pushState = function (...args: Parameters<typeof history.pushState>) {
        _pushState(...args);
        window.dispatchEvent(new Event('locationchange'));
    };

    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
        _replaceState(...args);
        window.dispatchEvent(new Event('locationchange'));
    };

    const locationChangeHandler = () => {
        const currentUrl = window.location.href;
        if (currentUrl !== lastCheckedUrl) {
            lastCheckedUrl = currentUrl;
            callback(currentUrl);
        }
    };
    window.addEventListener('locationchange', locationChangeHandler);

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
