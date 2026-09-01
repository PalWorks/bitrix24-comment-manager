// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MESSAGE_TYPES } from '../../../extension/shared/constants';

/**
 * Options page module tests.
 * Tests the core logic functions by mocking chrome.runtime.sendMessage
 * for both auth status and activity data messages.
 *
 * options.ts executes DOM queries at import time, so each case loads the real
 * options.html into jsdom before importing the module.
 */

/**
 * Loads the real options page markup rather than a hand written copy of it.
 *
 * A duplicated scaffold drifts the moment the page gains an element, and the
 * failure it produces is a null dereference at import time, far from the change
 * that caused it. Reading the shipped HTML makes that impossible: if the page
 * and the script disagree, these tests say so.
 */
function setupOptionsDom(): void {
    const htmlPath = resolve(__dirname, '../../../extension/options/options.html');
    const html = readFileSync(htmlPath, 'utf8');
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);

    if (!body) {
        throw new Error('Could not find a <body> in options.html');
    }

    // Scripts inserted through innerHTML never execute in jsdom, so the module
    // under test is still imported explicitly by each case.
    document.body.innerHTML = body[1];
}

/**
 * Sets up a chrome mock that responds to messages based on their type.
 * The responseMap maps message types to their responses.
 */
function setupChromeMockWithResponses(responseMap: Record<string, unknown>): void {
    const withSettings: Record<string, unknown> = {
        [MESSAGE_TYPES.GET_SETTINGS]: {
            success: true,
            data: { backendUrl: 'https://api.example.com', portals: [] },
        },
        ...responseMap,
    };

    const chromeMock = {
        runtime: {
            getManifest: vi.fn(() => ({ version: '2.0.0' })),
            sendMessage: vi.fn((message: { type: string }, callback: (response: unknown) => void) => {
                const response = withSettings[message.type];
                if (response !== undefined) {
                    callback(response);
                } else {
                    callback({ success: false, error: 'Unknown message type' });
                }
            }),
        },
    };
    (globalThis as Record<string, unknown>).chrome = chromeMock;
}

/**
 * Simple chrome mock that returns the same response for all messages.
 */
function setupChromeMock(authResponse: unknown): void {
    const chromeMock = {
        runtime: {
            getManifest: vi.fn(() => ({ version: '2.0.0' })),
            sendMessage: vi.fn((message: { type: string }, callback: (response: unknown) => void) => {
                if (message.type === MESSAGE_TYPES.GET_SETTINGS) {
                    callback({
                        success: true,
                        data: { backendUrl: 'https://api.example.com', portals: [] },
                    });
                    return;
                }
                callback(authResponse);
            }),
        },
    };
    (globalThis as Record<string, unknown>).chrome = chromeMock;
}

describe('options page', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        setupOptionsDom();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as Record<string, unknown>).chrome;
        document.body.innerHTML = '';
    });

    describe('page navigation', () => {
        function nav(name: string): HTMLButtonElement {
            return document.getElementById(`nav-${name}`) as HTMLButtonElement;
        }

        function page(name: string): HTMLElement {
            return document.getElementById(`page-${name}`) as HTMLElement;
        }

        function visiblePages(): string[] {
            return ['settings', 'billing', 'help'].filter(
                (name) => !page(name).classList.contains('hidden'),
            );
        }

        it('opens on settings and shows exactly one page', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(visiblePages()).toEqual(['settings']);
            expect(nav('settings').getAttribute('aria-selected')).toBe('true');
        });

        it('switches to plans and billing on click', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            nav('billing').click();

            expect(visiblePages()).toEqual(['billing']);
            expect(nav('billing').tabIndex).toBe(0);
            expect(nav('settings').tabIndex).toBe(-1);
        });

        it('moves between pages with the arrow keys', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            nav('settings').dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
            );
            expect(visiblePages()).toEqual(['billing']);

            nav('billing').dispatchEvent(
                new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
            );
            expect(visiblePages()).toEqual(['help']);
        });

        it('opens the page named in the location hash', async () => {
            location.hash = '#help';
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(visiblePages()).toEqual(['help']);
            location.hash = '';
        });

        it('falls back to settings when the hash names nothing real', async () => {
            location.hash = '#not-a-page';
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(visiblePages()).toEqual(['settings']);
            location.hash = '';
        });

        it('sends the hosted tab cross link to plans and billing', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.GET_SETTINGS]: {
                    success: true,
                    data: { backendUrl: '', portals: [] },
                },
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            (document.getElementById('link-to-billing') as HTMLButtonElement).click();

            expect(visiblePages()).toEqual(['billing']);
        });
    });

    describe('plan status', () => {
        it('reports nothing configured when no backend is set', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.GET_SETTINGS]: {
                    success: true,
                    data: { backendUrl: '', portals: [] },
                },
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(
                (document.getElementById('current-plan-name') as HTMLElement).textContent,
            ).toBe('Not configured');
            expect(
                (document.getElementById('current-plan-detail') as HTMLElement).textContent,
            ).toMatch(/nothing is billed/i);
        });

        it('names the host it is pointing at when one is set', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.GET_SETTINGS]: {
                    success: true,
                    data: { backendUrl: 'https://api.example.com', portals: [] },
                },
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(
                (document.getElementById('current-plan-name') as HTMLElement).textContent,
            ).toBe('Self-Hosted');
            expect(
                (document.getElementById('current-plan-detail') as HTMLElement).textContent,
            ).toContain('api.example.com');
        });
    });

    describe('account row', () => {
        it('keeps the settings reachable while signed out', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            // The whole point of the row layout: an installation with no
            // backend cannot sign in until it configures one, and the field to
            // do that with is on this page.
            const config = document.getElementById('config-section') as HTMLElement;
            expect(config.classList.contains('hidden')).toBe(false);
            expect(
                (document.getElementById('view-logged-out') as HTMLElement).classList.contains(
                    'hidden',
                ),
            ).toBe(false);
        });

        it('hides the activity row when nobody is signed in', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(
                (document.getElementById('row-activity') as HTMLElement).classList.contains(
                    'hidden',
                ),
            ).toBe(true);
        });

        it('shows the activity row once signed in', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: {
                    success: true,
                    data: {
                        isAuthenticated: true,
                        memberId: 'm-1',
                        domain: 'acme.bitrix24.com',
                        expiresAt: Math.floor(Date.now() / 1000) + 3600,
                    },
                },
                [MESSAGE_TYPES.GET_ACTIVITY_LOG]: { success: true, data: { actions: [] } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(
                (document.getElementById('row-activity') as HTMLElement).classList.contains(
                    'hidden',
                ),
            ).toBe(false);
            expect(
                (document.getElementById('connection-badge') as HTMLElement).textContent,
            ).toBe('Connected');
        });
    });

    describe('backend route tabs', () => {
        function tab(name: string): HTMLButtonElement {
            return document.getElementById(`tab-${name}`) as HTMLButtonElement;
        }

        function panel(name: string): HTMLElement {
            return document.getElementById(`panel-${name}`) as HTMLElement;
        }

        it('opens on the hosted route when no backend is configured', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.GET_SETTINGS]: {
                    success: true,
                    data: { backendUrl: '', portals: [] },
                },
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(tab('cloud').getAttribute('aria-selected')).toBe('true');
            expect(panel('cloud').classList.contains('hidden')).toBe(false);
            expect(panel('selfhost').classList.contains('hidden')).toBe(true);
        });

        it('opens on the self hosted route when a backend is already set', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            expect(tab('selfhost').getAttribute('aria-selected')).toBe('true');
            expect(panel('cloud').classList.contains('hidden')).toBe(true);
        });

        it('shows exactly one panel when a tab is clicked', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            tab('cloud').click();

            const visible = ['cloud', 'selfhost'].filter(
                (name) => !panel(name).classList.contains('hidden'),
            );
            expect(visible).toEqual(['cloud']);
            expect(tab('cloud').getAttribute('aria-selected')).toBe('true');
            expect(tab('cloud').tabIndex).toBe(0);
            expect(tab('selfhost').tabIndex).toBe(-1);
        });

        it('moves between tabs with the arrow keys', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            tab('cloud').click();
            tab('cloud').dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
            );

            expect(tab('selfhost').getAttribute('aria-selected')).toBe('true');

            // Two tabs, so ArrowLeft wraps straight back round.
            tab('selfhost').dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
            );

            expect(tab('cloud').getAttribute('aria-selected')).toBe('true');
        });

        it('does not move the tab when the user saves a backend URL', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.GET_SETTINGS]: {
                    success: true,
                    data: { backendUrl: '', portals: [] },
                },
                [MESSAGE_TYPES.SET_BACKEND_URL]: {
                    success: true,
                    data: { backendUrl: 'https://api.example.com', portals: [] },
                },
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            (document.getElementById('tab-cloud') as HTMLButtonElement).click();
            (document.getElementById('btn-save-backend') as HTMLButtonElement).click();
            await vi.runAllTimersAsync();

            expect(tab('cloud').getAttribute('aria-selected')).toBe('true');
        });

        it('offers two routes, since deploying one and pointing at one are the same arrangement', () => {
            expect(document.getElementById('tab-deploy')).toBeNull();
            expect(document.querySelectorAll('.tabs .tab')).toHaveLength(2);
        });
    });

    describe('support form', () => {
        it('hides the form and offers the issue tracker when the build has no support service', async () => {
            vi.stubEnv('VITE_SUPPORT_URL', '');
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const form = document.getElementById('support-form') as HTMLFormElement;
            const fallback = document.getElementById('support-fallback') as HTMLElement;

            expect(form.classList.contains('hidden')).toBe(true);
            expect(fallback.classList.contains('hidden')).toBe(false);

            // The waitlist control is replaced with guidance rather than left
            // on the page as a button that cannot do anything.
            const waitlistBtn = document.getElementById('btn-waitlist') as HTMLButtonElement;
            const waitlistFallback = document.getElementById('waitlist-fallback') as HTMLElement;
            expect(waitlistBtn.disabled).toBe(true);
            expect(waitlistBtn.classList.contains('hidden')).toBe(true);
            expect(waitlistFallback.classList.contains('hidden')).toBe(false);
            expect(
                (document.getElementById('link-issues-waitlist') as HTMLAnchorElement).href,
            ).toMatch(/github\.com/);
            vi.unstubAllEnvs();
        });

        it('posts a valid report to the support service the build names', async () => {
            vi.stubEnv('VITE_SUPPORT_URL', 'https://support.example.com');
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                status: 202,
                json: async () => ({ success: true }),
            });
            vi.stubGlobal('fetch', fetchMock);

            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const form = document.getElementById('support-form') as HTMLFormElement;
            expect(form.classList.contains('hidden')).toBe(false);

            (document.getElementById('support-name') as HTMLInputElement).value = 'Jane Cooper';
            (document.getElementById('support-email') as HTMLInputElement).value =
                'someone@example.com';
            (document.getElementById('support-phone') as HTMLInputElement).value =
                '+971 50 123 4567';
            (document.getElementById('support-message') as HTMLTextAreaElement).value =
                'The popup will not open on a lead page.';
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await vi.runAllTimersAsync();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('https://support.example.com/support');

            const body = JSON.parse((init as { body: string }).body);
            expect(body.name).toBe('Jane Cooper');
            expect(body.email).toBe('someone@example.com');
            expect(body.phone).toBe('+971 50 123 4567');
            expect(body.category).toBe('bug');
            expect(body.company).toBe('');
            expect(body.context.extensionVersion).toBe('2.0.0');

            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
        });

        it('points every documentation link at a real URL', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            for (const id of ['link-setup-docs', 'link-deploy-docs', 'link-issues']) {
                const anchor = document.getElementById(id) as HTMLAnchorElement;
                expect(anchor.getAttribute('href')).toMatch(/^https:\/\/github\.com\//);
            }
        });

        it('keeps the character counter in step with the message', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const message = document.getElementById('support-message') as HTMLTextAreaElement;
            message.value = 'hello';
            message.dispatchEvent(new Event('input'));

            expect((document.getElementById('support-counter') as HTMLElement).textContent).toBe(
                '5 / 5000',
            );
        });

        it('catches a phone number with no country code before any round trip', async () => {
            vi.stubEnv('VITE_SUPPORT_URL', 'https://support.example.com');
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            (document.getElementById('support-name') as HTMLInputElement).value = 'Jane Cooper';
            (document.getElementById('support-email') as HTMLInputElement).value =
                'someone@example.com';
            (document.getElementById('support-phone') as HTMLInputElement).value = '0501234567';
            (document.getElementById('support-message') as HTMLTextAreaElement).value =
                'The popup will not open on a lead page.';
            (document.getElementById('support-form') as HTMLFormElement).dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
            await vi.runAllTimersAsync();

            expect(fetchMock).not.toHaveBeenCalled();
            expect((document.getElementById('support-status') as HTMLElement).textContent).toMatch(
                /country code/i,
            );

            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
        });

        it('rejects a message that is too short without calling the service', async () => {
            vi.stubEnv('VITE_SUPPORT_URL', 'https://support.example.com');
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: { success: true, data: { isAuthenticated: false } },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            (document.getElementById('support-name') as HTMLInputElement).value = 'Jane Cooper';
            (document.getElementById('support-email') as HTMLInputElement).value =
                'someone@example.com';
            (document.getElementById('support-message') as HTMLTextAreaElement).value = 'help';
            (document.getElementById('support-form') as HTMLFormElement).dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
            await vi.runAllTimersAsync();

            expect(fetchMock).not.toHaveBeenCalled();
            const status = document.getElementById('support-status') as HTMLElement;
            expect(status.classList.contains('hidden')).toBe(false);
            expect(status.textContent).toMatch(/at least 10/i);

            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
        });
    });

    describe('initialization with authenticated state', () => {
        it('should show logged-in view when authenticated', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: {
                    success: true,
                    data: {
                        isAuthenticated: true,
                        memberId: 'test-member-123',
                        domain: 'test.bitrix24.com',
                        expiresAt: Math.floor(Date.now() / 1000) + 3600,
                    },
                },
                [MESSAGE_TYPES.GET_ACTIVITY_LOG]: {
                    success: true,
                    data: { actions: [] },
                },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const loggedInView = document.getElementById('view-logged-in') as HTMLElement;
            expect(loggedInView.classList.contains('hidden')).toBe(false);

            const domain = document.getElementById('opt-agent-domain') as HTMLElement;
            expect(domain.textContent).toBe('test.bitrix24.com');

            const memberId = document.getElementById('opt-agent-member-id') as HTMLElement;
            expect(memberId.textContent).toBe('test-member-123');
        });
    });

    describe('initialization with unauthenticated state', () => {
        it('should show logged-out view when not authenticated', async () => {
            setupChromeMock({
                success: true,
                data: { isAuthenticated: false },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const loggedOutView = document.getElementById('view-logged-out') as HTMLElement;
            expect(loggedOutView.classList.contains('hidden')).toBe(false);
        });
    });

    describe('activity table rendering', () => {
        it('should render activity rows with correct data', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: {
                    success: true,
                    data: {
                        isAuthenticated: true,
                        memberId: 'test-member',
                        domain: 'test.bitrix24.com',
                        expiresAt: Math.floor(Date.now() / 1000) + 3600,
                    },
                },
                [MESSAGE_TYPES.GET_ACTIVITY_LOG]: {
                    success: true,
                    data: {
                        actions: [
                            {
                                timestamp: '2026-03-04T10:00:00Z',
                                lead_id: '12345',
                                action_type: 'CREATE',
                                status: 'SUCCESS',
                            },
                            {
                                timestamp: '2026-03-04T09:30:00Z',
                                lead_id: '67890',
                                action_type: 'DELETE',
                                status: 'FAILED',
                            },
                        ],
                    },
                },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const tbody = document.getElementById('activity-tbody') as HTMLTableSectionElement;
            const rows = tbody.querySelectorAll('tr');
            expect(rows.length).toBe(2);

            const firstRowCells = rows[0].querySelectorAll('td');
            expect(firstRowCells[1].textContent).toBe('12345');
            expect(firstRowCells[3].textContent).toBe('SUCCESS');
            expect(firstRowCells[3].classList.contains('status-success')).toBe(true);

            const secondRowCells = rows[1].querySelectorAll('td');
            expect(secondRowCells[1].textContent).toBe('67890');
            expect(secondRowCells[3].textContent).toBe('FAILED');
            expect(secondRowCells[3].classList.contains('status-failed')).toBe(true);
        });

        it('should show empty message when no activity exists', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: {
                    success: true,
                    data: {
                        isAuthenticated: true,
                        memberId: 'test-member',
                        domain: 'test.bitrix24.com',
                        expiresAt: Math.floor(Date.now() / 1000) + 3600,
                    },
                },
                [MESSAGE_TYPES.GET_ACTIVITY_LOG]: {
                    success: true,
                    data: { actions: [] },
                },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const emptyMsg = document.getElementById('activity-empty') as HTMLElement;
            expect(emptyMsg.classList.contains('hidden')).toBe(false);
        });

        it('should show error message when activity fetch fails', async () => {
            setupChromeMockWithResponses({
                [MESSAGE_TYPES.AUTH_STATUS]: {
                    success: true,
                    data: {
                        isAuthenticated: true,
                        memberId: 'test-member',
                        domain: 'test.bitrix24.com',
                        expiresAt: Math.floor(Date.now() / 1000) + 3600,
                    },
                },
                [MESSAGE_TYPES.GET_ACTIVITY_LOG]: {
                    success: false,
                    error: 'Connection failed',
                },
            });

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const errorMsg = document.getElementById('activity-error') as HTMLElement;
            expect(errorMsg.classList.contains('hidden')).toBe(false);
            expect(errorMsg.textContent).toBe('Connection failed');
        });
    });

    describe('logout', () => {
        it('should clear data and show confirmation on successful logout', async () => {
            const chromeMock = {
                runtime: {
                    sendMessage: vi.fn((message: { type: string }, callback: (response: unknown) => void) => {
                        if (message.type === MESSAGE_TYPES.AUTH_STATUS) {
                            callback({
                                success: true,
                                data: {
                                    isAuthenticated: true,
                                    memberId: 'test-member',
                                    domain: 'test.bitrix24.com',
                                    expiresAt: Math.floor(Date.now() / 1000) + 3600,
                                },
                            });
                        } else if (message.type === MESSAGE_TYPES.GET_ACTIVITY_LOG) {
                            callback({
                                success: true,
                                data: { actions: [] },
                            });
                        } else if (message.type === MESSAGE_TYPES.AUTH_LOGOUT) {
                            callback({ success: true });
                        } else {
                            callback({ success: false });
                        }
                    }),
                },
            };
            (globalThis as Record<string, unknown>).chrome = chromeMock;

            await import('../../../extension/options/options');
            await vi.runAllTimersAsync();

            const logoutBtn = document.getElementById('btn-options-logout') as HTMLButtonElement;
            logoutBtn.click();
            await vi.runAllTimersAsync();

            const confirmation = document.getElementById('logout-confirmation') as HTMLElement;
            expect(confirmation.classList.contains('hidden')).toBe(false);

            const domain = document.getElementById('opt-agent-domain') as HTMLElement;
            expect(domain.textContent).toBe('');
        });
    });
});
