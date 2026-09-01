import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock } from '../../helpers/chromeMock';
import { MESSAGE_TYPES } from '../../../extension/shared/constants';

/**
 * What the popup is told when the service worker has forgotten which lead the
 * agent is looking at.
 *
 * The lead map lives in the worker's module scope, and Manifest V3 terminates
 * an idle worker after about thirty seconds. The content script only speaks on
 * navigation, so opening a lead, reading it for a minute, then clicking the
 * extension icon is the ordinary sequence in which that map is empty. Reporting
 * "no lead" there is wrong: the tab is on a lead and its URL says so.
 */

type QueryResult = Array<{ id?: number; url?: string }>;

function stubTabsQuery(tabs: QueryResult): void {
    (globalThis as unknown as {
        chrome: { tabs: { query: unknown } };
    }).chrome.tabs.query = vi.fn(
        (_query: unknown, callback: (result: QueryResult) => void) => {
            callback(tabs);
        },
    );
}

async function askForLeadState(): Promise<{ leadId: string | null }> {
    const { handleMessage } = await import('../../../extension/background/messageRouter');

    return new Promise((resolve) => {
        handleMessage(
            { type: MESSAGE_TYPES.GET_LEAD_STATE } as never,
            {} as chrome.runtime.MessageSender,
            (response: unknown) => {
                resolve((response as { data: { leadId: string | null } }).data);
            },
        );
    });
}

describe('lead state after the service worker has restarted', () => {
    beforeEach(() => {
        vi.resetModules();
        installChromeMock();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        uninstallChromeMock();
    });

    it('reads the lead from the active tab URL when nothing was recorded', async () => {
        stubTabsQuery([
            { id: 7, url: 'https://acme.bitrix24.com/crm/lead/details/4821/' },
        ]);

        const result = await askForLeadState();

        expect(result.leadId).toBe('4821');
    });

    it('answers null for a tab that is genuinely not on a lead', async () => {
        stubTabsQuery([{ id: 7, url: 'https://acme.bitrix24.com/crm/deal/details/12/' }]);

        const result = await askForLeadState();

        expect(result.leadId).toBeNull();
    });

    it('prefers what the content script reported over the URL', async () => {
        const { handleMessage } = await import('../../../extension/background/messageRouter');

        // The content script has already told the worker this tab left the lead
        // page. That is a real observation and outranks a URL read later.
        handleMessage(
            { type: MESSAGE_TYPES.LEAD_NOT_DETECTED } as never,
            { tab: { id: 7 } } as chrome.runtime.MessageSender,
            () => undefined,
        );

        stubTabsQuery([
            { id: 7, url: 'https://acme.bitrix24.com/crm/lead/details/4821/' },
        ]);

        const result = await askForLeadState();

        expect(result.leadId).toBeNull();
    });

    it('does not invent a lead from a tab with no URL to read', async () => {
        stubTabsQuery([{ id: 7 }]);

        const result = await askForLeadState();

        expect(result.leadId).toBeNull();
    });

    it('answers null when there is no active tab at all', async () => {
        stubTabsQuery([]);

        const result = await askForLeadState();

        expect(result.leadId).toBeNull();
    });
});
