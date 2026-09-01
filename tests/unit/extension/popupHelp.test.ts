// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The popup's route into Help.
 *
 * chrome.runtime.openOptionsPage cannot carry a fragment, so the popup opens
 * the options page as a tab by URL. That detail is easy to regress into
 * openOptionsPage during a tidy up, and the symptom is subtle: the page still
 * opens, just on Settings, leaving the user to go looking for Help at the
 * moment they are least willing to.
 */

function loadPopupDom(): void {
    const html = readFileSync(
        resolve(__dirname, '../../../extension/popup/popup.html'),
        'utf8',
    );
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    if (!body) {
        throw new Error('Could not find a <body> in popup.html');
    }
    document.body.innerHTML = body[1];
}

describe('popup help link', () => {
    beforeEach(() => {
        vi.resetModules();
        loadPopupDom();
    });

    afterEach(() => {
        delete (globalThis as Record<string, unknown>).chrome;
        document.body.innerHTML = '';
    });

    it('opens the options page on the Help section, not on Settings', async () => {
        const created: string[] = [];
        const closed = vi.fn();

        (globalThis as Record<string, unknown>).chrome = {
            runtime: {
                getManifest: () => ({ version: '2.0.0' }),
                getURL: (path: string) => `chrome-extension://test/${path}`,
                sendMessage: (_message: unknown, callback: (r: unknown) => void) => {
                    callback({ success: true, data: { isAuthenticated: false } });
                },
            },
            tabs: {
                create: (options: { url: string }) => {
                    created.push(options.url);
                    return Promise.resolve({});
                },
            },
            storage: {
                session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
            },
        };
        vi.stubGlobal('close', closed);

        await import('../../../extension/popup/popup');

        const buttons = document.querySelectorAll<HTMLButtonElement>('[data-open-help]');
        expect(buttons.length).toBeGreaterThan(0);

        buttons[0].click();

        expect(created).toEqual(['chrome-extension://test/options/options.html#help']);
        vi.unstubAllGlobals();
    });

    it('offers help from the setup view, where a new user gets stuck', () => {
        const setupView = document.getElementById('view-setup') as HTMLElement;
        expect(setupView.querySelector('[data-open-help]')).not.toBeNull();
    });
});
