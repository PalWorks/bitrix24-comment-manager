import { MESSAGE_TYPES } from '../shared/constants';
import { createMessage } from '../shared/messages';
import type {
    AuthState,
    ActivityEntry,
    ActivityResponse,
    ExtensionSettings,
} from '../shared/types';

interface MessageResponse {
    success: boolean;
    data?: AuthState;
    error?: string;
}

interface SettingsResponse {
    success: boolean;
    data?: ExtensionSettings;
    error?: string;
}

const views = {
    loading: document.getElementById('view-loading') as HTMLElement,
    loggedOut: document.getElementById('view-logged-out') as HTMLElement,
    loggedIn: document.getElementById('view-logged-in') as HTMLElement,
};

const elements = {
    agentDomain: document.getElementById('opt-agent-domain') as HTMLElement,
    agentMemberId: document.getElementById('opt-agent-member-id') as HTMLElement,
    sessionStatus: document.getElementById('opt-session-status') as HTMLElement,
    sessionExpiry: document.getElementById('opt-session-expiry') as HTMLElement,
    activityTable: document.getElementById('activity-table') as HTMLTableElement,
    activityTbody: document.getElementById('activity-tbody') as HTMLTableSectionElement,
    activityEmpty: document.getElementById('activity-empty') as HTMLElement,
    activityError: document.getElementById('activity-error') as HTMLElement,
    btnLogout: document.getElementById('btn-options-logout') as HTMLButtonElement,
    logoutConfirmation: document.getElementById('logout-confirmation') as HTMLElement,
    configSection: document.getElementById('config-section') as HTMLElement,
    backendInput: document.getElementById('opt-backend-url') as HTMLInputElement,
    backendSaveBtn: document.getElementById('btn-save-backend') as HTMLButtonElement,
    backendStatus: document.getElementById('backend-status') as HTMLElement,
    portalInput: document.getElementById('opt-portal-input') as HTMLInputElement,
    portalAddBtn: document.getElementById('btn-add-portal') as HTMLButtonElement,
    portalStatus: document.getElementById('portal-status') as HTMLElement,
    portalList: document.getElementById('portal-list') as HTMLUListElement,
    portalEmpty: document.getElementById('portal-empty') as HTMLElement,
};

/**
 * Shows exactly one view and hides the others.
 */
function showView(viewName: 'loading' | 'loggedOut' | 'loggedIn'): void {
    views.loading.classList.add('hidden');
    views.loggedOut.classList.add('hidden');
    views.loggedIn.classList.add('hidden');
    views[viewName].classList.remove('hidden');
}

/**
 * Sends a typed message to the service worker and returns the response.
 */
function sendMessage(
    type: typeof MESSAGE_TYPES[keyof typeof MESSAGE_TYPES],
    payload?: unknown,
): Promise<MessageResponse> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(createMessage(type, payload), (response: MessageResponse) => {
            resolve(response);
        });
    });
}

/**
 * Formats a UTC timestamp string into a locale-friendly display string.
 */
function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * Returns the CSS class name for a given action type.
 */
function getActionClass(action: string): string {
    switch (action) {
        case 'CREATE': return 'action-create';
        case 'EDIT': return 'action-edit';
        case 'DELETE': return 'action-delete';
        default: return '';
    }
}

/**
 * Escapes HTML special characters to prevent XSS when rendering content.
 */
function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Renders the activity table rows from the provided entries.
 */
function renderActivityTable(actions: ActivityEntry[]): void {
    elements.activityError.classList.add('hidden');

    if (actions.length === 0) {
        elements.activityTable.classList.add('hidden');
        elements.activityEmpty.classList.remove('hidden');
        return;
    }

    elements.activityTable.classList.remove('hidden');
    elements.activityEmpty.classList.add('hidden');

    elements.activityTbody.innerHTML = actions
        .map((entry) => {
            const timeStr = formatTimestamp(entry.timestamp);
            const actionClass = getActionClass(entry.action_type);
            const statusClass = entry.status === 'SUCCESS' ? 'status-success' : 'status-failed';

            return `
                <tr>
                    <td>${escapeHtml(timeStr)}</td>
                    <td>${escapeHtml(entry.lead_id)}</td>
                    <td><span class="action-badge ${actionClass}">${escapeHtml(entry.action_type)}</span></td>
                    <td class="${statusClass}">${escapeHtml(entry.status)}</td>
                </tr>
            `;
        })
        .join('');
}

/**
 * Fetches activity data from the backend and renders it.
 */
async function loadActivity(): Promise<void> {
    const result = await new Promise<{
        success: boolean;
        data?: ActivityResponse;
        error?: string;
    }>((resolve) => {
        chrome.runtime.sendMessage(
            createMessage(MESSAGE_TYPES.GET_ACTIVITY_LOG, { limit: 20 }),
            (response) => resolve(response),
        );
    });

    if (result.success && result.data) {
        renderActivityTable(result.data.actions);
    } else {
        elements.activityTable.classList.add('hidden');
        elements.activityEmpty.classList.add('hidden');
        elements.activityError.textContent =
            (typeof result.error === 'string' ? result.error : null) || 'Failed to load activity.';
        elements.activityError.classList.remove('hidden');
    }
}

/**
 * Renders the authenticated view with agent info and session data.
 */
function renderLoggedInView(state: AuthState): void {
    elements.agentDomain.textContent = state.domain || 'Unknown';
    elements.agentMemberId.textContent = state.memberId || 'Unknown';

    elements.sessionStatus.textContent = 'Authenticated';
    elements.sessionStatus.classList.add('status-active');

    if (state.expiresAt) {
        const expiresDate = new Date(state.expiresAt * 1000);
        elements.sessionExpiry.textContent = expiresDate.toLocaleString();
    } else {
        elements.sessionExpiry.textContent = 'Active';
    }

    elements.logoutConfirmation.classList.add('hidden');
    showView('loggedIn');
    loadActivity();
}

/**
 * Clears all displayed data from the logged-in view.
 * Used before transitioning to the logged-out state.
 */
function clearDisplayedData(): void {
    elements.agentDomain.textContent = '';
    elements.agentMemberId.textContent = '';
    elements.sessionStatus.textContent = '';
    elements.sessionExpiry.textContent = '';
    elements.activityTbody.innerHTML = '';
    elements.activityError.classList.add('hidden');
    elements.activityEmpty.classList.add('hidden');
}

/**
 * Handles the logout button click.
 * Sends AUTH_LOGOUT to service worker, clears data, shows confirmation.
 */
async function handleLogout(): Promise<void> {
    elements.btnLogout.disabled = true;

    const response = await sendMessage(MESSAGE_TYPES.AUTH_LOGOUT);

    if (response.success) {
        clearDisplayedData();
        elements.logoutConfirmation.classList.remove('hidden');

        setTimeout(() => {
            showView('loggedOut');
        }, 1500);
    } else {
        elements.btnLogout.disabled = false;
    }
}


/**
 * Sends a settings related message and returns the typed response.
 */
function sendSettingsMessage(
    type: typeof MESSAGE_TYPES[keyof typeof MESSAGE_TYPES],
    payload?: unknown,
): Promise<SettingsResponse> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            createMessage(type, payload),
            (response: SettingsResponse) => resolve(response),
        );
    });
}

/**
 * Shows a transient status line under a settings control.
 */
function showSettingStatus(
    element: HTMLElement,
    message: string,
    kind: 'success' | 'error',
): void {
    element.textContent = message;
    element.className = `setting-status ${kind === 'success' ? 'status-success' : 'status-failed'}`;
    element.classList.remove('hidden');
}

/**
 * Renders the list of user added portals.
 */
function renderPortals(portals: string[]): void {
    if (portals.length === 0) {
        elements.portalList.innerHTML = '';
        elements.portalEmpty.classList.remove('hidden');
        return;
    }

    elements.portalEmpty.classList.add('hidden');
    elements.portalList.innerHTML = portals
        .map(
            (host) => `
                <li class="portal-item">
                    <span class="portal-host">${escapeHtml(host)}</span>
                    <button class="btn-link-danger" type="button" data-remove-portal="${escapeHtml(host)}">Remove</button>
                </li>
            `,
        )
        .join('');
}

/**
 * Loads settings into the configuration card.
 */
async function loadSettings(): Promise<void> {
    const response = await sendSettingsMessage(MESSAGE_TYPES.GET_SETTINGS);

    if (!response.success || !response.data) {
        showSettingStatus(
            elements.backendStatus,
            response.error || 'Could not load settings.',
            'error',
        );
        return;
    }

    elements.backendInput.value = response.data.backendUrl;
    renderPortals(response.data.portals);
}

/**
 * Saves the backend URL entered in the configuration card.
 */
async function handleSaveBackend(): Promise<void> {
    elements.backendSaveBtn.disabled = true;

    const response = await sendSettingsMessage(MESSAGE_TYPES.SET_BACKEND_URL, {
        backendUrl: elements.backendInput.value,
    });

    elements.backendSaveBtn.disabled = false;

    if (response.success && response.data) {
        elements.backendInput.value = response.data.backendUrl;
        showSettingStatus(elements.backendStatus, 'Backend URL saved.', 'success');
        await initialize();
    } else {
        showSettingStatus(
            elements.backendStatus,
            response.error || 'Could not save the backend URL.',
            'error',
        );
    }
}

/**
 * Adds a portal. The permission prompt Chrome raises requires a user gesture,
 * which this click handler provides.
 */
async function handleAddPortal(): Promise<void> {
    elements.portalAddBtn.disabled = true;

    const response = await sendSettingsMessage(MESSAGE_TYPES.ADD_PORTAL, {
        portal: elements.portalInput.value,
    });

    elements.portalAddBtn.disabled = false;

    if (response.success) {
        elements.portalInput.value = '';
        showSettingStatus(elements.portalStatus, 'Portal added.', 'success');
        await loadSettings();
    } else {
        showSettingStatus(
            elements.portalStatus,
            response.error || 'Could not add the portal.',
            'error',
        );
    }
}

/**
 * Removes a previously added portal.
 */
async function handleRemovePortal(host: string): Promise<void> {
    const response = await sendSettingsMessage(MESSAGE_TYPES.REMOVE_PORTAL, { portal: host });

    if (response.success) {
        showSettingStatus(elements.portalStatus, `Removed ${host}.`, 'success');
        await loadSettings();
    } else {
        showSettingStatus(
            elements.portalStatus,
            response.error || 'Could not remove the portal.',
            'error',
        );
    }
}

/**
 * Initializes the options page by checking current auth status.
 * The configuration card is independent of authentication and is always shown.
 */
async function initialize(): Promise<void> {
    showView('loading');

    const response = await sendMessage(MESSAGE_TYPES.AUTH_STATUS);

    if (response.success && response.data?.isAuthenticated) {
        renderLoggedInView(response.data);
    } else {
        showView('loggedOut');
    }

    elements.configSection.classList.remove('hidden');
}

elements.btnLogout.addEventListener('click', handleLogout);
elements.backendSaveBtn.addEventListener('click', handleSaveBackend);
elements.portalAddBtn.addEventListener('click', handleAddPortal);

elements.portalList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const host = target.getAttribute('data-remove-portal');
    if (host) {
        void handleRemovePortal(host);
    }
});

void loadSettings();
void initialize();
