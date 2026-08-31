// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MESSAGE_TYPES } from '../../../extension/shared/constants';

/**
 * Options page module tests.
 * Tests the core logic functions by mocking chrome.runtime.sendMessage
 * for both auth status and activity data messages.
 *
 * Since options.ts executes DOM queries at import time, we set up a minimal
 * DOM scaffold and test the behavioral patterns via module-level init.
 */

function setupOptionsDom(): void {
    document.body.innerHTML = `
        <div id="options-app">
            <div id="view-loading" class="view"></div>
            <div id="config-section" class="card hidden">
                <input id="opt-backend-url" type="url">
                <button id="btn-save-backend"></button>
                <p id="backend-status" class="hidden"></p>
                <input id="opt-portal-input" type="text">
                <button id="btn-add-portal"></button>
                <p id="portal-status" class="hidden"></p>
                <ul id="portal-list"></ul>
                <p id="portal-empty"></p>
            </div>
            <div id="view-logged-out" class="view hidden"></div>
            <div id="view-logged-in" class="view hidden">
                <span id="opt-agent-domain"></span>
                <span id="opt-agent-member-id"></span>
                <span id="opt-session-status"></span>
                <span id="opt-session-expiry"></span>
                <table id="activity-table" class="activity-table">
                    <thead><tr><th>Time</th><th>Lead</th><th>Action</th><th>Status</th></tr></thead>
                    <tbody id="activity-tbody"></tbody>
                </table>
                <p id="activity-empty" class="hidden"></p>
                <p id="activity-error" class="hidden"></p>
                <button id="btn-options-logout"></button>
                <p id="logout-confirmation" class="hidden"></p>
            </div>
        </div>
    `;
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
