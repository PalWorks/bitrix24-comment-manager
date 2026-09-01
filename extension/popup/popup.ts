import { MESSAGE_TYPES, CONFIG } from '../shared/constants';
import { createMessage } from '../shared/messages';
import { getBackendUrl, getSettings, parsePortalHost } from '../shared/settings';
import type { AuthState, LeadInfo, CommentOperationResponse } from '../shared/types';

interface MessageResponse {
    success: boolean;
    data?: AuthState;
    error?: string;
}

interface LeadStateResponse {
    success: boolean;
    data?: { leadId: string | null };
}

interface CommentMessageResponse {
    success: boolean;
    data?: CommentOperationResponse;
    error?: {
        code: string;
        message: string;
    };
}

interface LocalComment {
    id: string;
    body: string;
    timestamp: string;
}

const MAX_LENGTH = CONFIG.MAX_COMMENT_LENGTH;
const STATUS_DISMISS_MS = 4000;

let currentLeadId: string | null = null;
let statusDismissTimer: ReturnType<typeof setTimeout> | null = null;
let isSubmitting = false;
const localComments: LocalComment[] = [];

const views = {
    loading: document.getElementById('view-loading') as HTMLElement,
    setup: document.getElementById('view-setup') as HTMLElement,
    loggedOut: document.getElementById('view-logged-out') as HTMLElement,
    loggedIn: document.getElementById('view-logged-in') as HTMLElement,
};

const elements = {
    btnLogin: document.getElementById('btn-login') as HTMLButtonElement,
    btnLogout: document.getElementById('btn-logout') as HTMLButtonElement,
    loginError: document.getElementById('login-error') as HTMLElement,
    logoutError: document.getElementById('logout-error') as HTMLElement,
    agentDomain: document.getElementById('agent-domain') as HTMLElement,
    agentMemberId: document.getElementById('agent-member-id') as HTMLElement,
    sessionExpiry: document.getElementById('session-expiry') as HTMLElement,
    leadDetecting: document.getElementById('lead-detecting') as HTMLElement,
    leadFound: document.getElementById('lead-found') as HTMLElement,
    leadNotFound: document.getElementById('lead-not-found') as HTMLElement,
    leadIdValue: document.getElementById('lead-id-value') as HTMLElement,
    leadNameValue: document.getElementById('lead-name-value') as HTMLElement,
    commentInput: document.getElementById('ui-comment-input') as HTMLTextAreaElement,
    charCounter: document.getElementById('ui-char-counter') as HTMLElement,
    submitBtn: document.getElementById('ui-submit-btn') as HTMLButtonElement,
    commentLoading: document.getElementById('ui-loading') as HTMLElement,
    statusMsg: document.getElementById('ui-status-msg') as HTMLElement,
    commentList: document.getElementById('comment-list') as HTMLElement,
    offlineBanner: document.getElementById('offline-banner') as HTMLElement,
    setupInput: document.getElementById('setup-backend-url') as HTMLInputElement,
    setupSaveBtn: document.getElementById('btn-setup-save') as HTMLButtonElement,
    setupError: document.getElementById('setup-error') as HTMLElement,
};

/**
 * Shows exactly one view and hides the others.
 */
function showView(viewName: 'loading' | 'setup' | 'loggedOut' | 'loggedIn'): void {
    views.loading.classList.add('hidden');
    views.setup.classList.add('hidden');
    views.loggedOut.classList.add('hidden');
    views.loggedIn.classList.add('hidden');
    views[viewName].classList.remove('hidden');
}

/**
 * Displays an error message in the specified error element.
 */
function showError(element: HTMLElement, message: string): void {
    element.textContent = message;
    element.classList.remove('hidden');
}

/**
 * Hides all error messages.
 */
function clearErrors(): void {
    elements.loginError.classList.add('hidden');
    elements.logoutError.classList.add('hidden');
}

/**
 * Shows exactly one lead state and hides the others.
 */
function showLeadState(state: 'detecting' | 'found' | 'notFound'): void {
    elements.leadDetecting.classList.add('hidden');
    elements.leadFound.classList.add('hidden');
    elements.leadNotFound.classList.add('hidden');

    if (state === 'detecting') {
        elements.leadDetecting.classList.remove('hidden');
    } else if (state === 'found') {
        elements.leadFound.classList.remove('hidden');
    } else {
        elements.leadNotFound.classList.remove('hidden');
    }
}

/**
 * Shows a status message with auto-dismiss behavior.
 */
function showStatusMessage(message: string, type: 'success' | 'error'): void {
    if (statusDismissTimer) {
        clearTimeout(statusDismissTimer);
        statusDismissTimer = null;
    }

    elements.statusMsg.textContent = message;
    elements.statusMsg.className = `md3-status ${type}`;
    elements.statusMsg.classList.remove('hidden');

    statusDismissTimer = setTimeout(() => {
        elements.statusMsg.classList.add('hidden');
        statusDismissTimer = null;
    }, STATUS_DISMISS_MS);
}

/**
 * Updates the character counter display based on current textarea content.
 */
function updateCharCounter(): void {
    const remaining = MAX_LENGTH - elements.commentInput.value.length;
    elements.charCounter.textContent = String(remaining);

    elements.charCounter.classList.remove('md3-primary');
    elements.charCounter.style.color = '';
    if (remaining <= 100) {
        elements.charCounter.style.color = 'var(--md3-error)';
    } else if (remaining <= 500) {
        elements.charCounter.style.color = 'var(--md3-warning)';
    }
}

/**
 * Updates the submit button's disabled state based on form validity.
 */
function updateSubmitState(): void {
    const hasContent = elements.commentInput.value.trim().length > 0;
    elements.submitBtn.disabled = !hasContent || isSubmitting;
}

/**
 * Sets the comment form to a loading state during submission.
 */
function setFormLoading(loading: boolean): void {
    isSubmitting = loading;
    elements.commentInput.disabled = loading;
    elements.submitBtn.disabled = loading;

    if (loading) {
        elements.commentLoading.classList.remove('hidden');
    } else {
        elements.commentLoading.classList.add('hidden');
    }
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
 * Sends a comment operation message and returns the typed response.
 */
function sendCommentMessage(
    type: typeof MESSAGE_TYPES[keyof typeof MESSAGE_TYPES],
    payload: unknown,
): Promise<CommentMessageResponse> {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            createMessage(type, payload),
            (response: CommentMessageResponse) => {
                resolve(response);
            },
        );
    });
}

/**
 * Escapes HTML special characters to prevent XSS when rendering user content.
 */
function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Escapes a value for use inside a double quoted HTML attribute.
 *
 * Comment ids are supplied by the backend rather than typed by the user, but
 * they are interpolated into markup, so they are escaped on the same principle
 * as any other untrusted value.
 */
function escapeAttr(value: string): string {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Finds a comment item element by id without interpolating the id into a
 * selector string, which would break on a value containing a quote.
 */
function findCommentElement(commentId: string): HTMLElement | null {
    const items = elements.commentList.querySelectorAll<HTMLElement>('[data-comment-id]');
    for (const item of items) {
        if (item.dataset.commentId === commentId) {
            return item;
        }
    }
    return null;
}

/**
 * Loads any previously cached comments for the given lead from chrome.storage.session.
 * This allows Edit/Delete actions to remain available across popup open/close cycles.
 */
async function loadCachedComments(leadId: string): Promise<void> {
    try {
        const key = `comments_${leadId}`;
        const result = await chrome.storage.session.get(key) as Record<string, LocalComment[]>;
        const cached = result[key];
        if (Array.isArray(cached) && cached.length > 0) {
            localComments.length = 0;
            localComments.push(...cached);
            renderCommentList();
        }
    } catch {
        // Storage unavailable - continue without cache
    }
}

/**
 * Persists the current comment list for the active lead to chrome.storage.session.
 * Called after every create, edit, or delete so the list survives popup close.
 */
function persistComments(): void {
    if (!currentLeadId) return;
    chrome.storage.session
        .set({ [`comments_${currentLeadId}`]: [...localComments] })
        .catch(() => { });
}

/**
 * Renders the local comment list from in-memory state.
 */
function renderCommentList(): void {
    if (localComments.length === 0) {
        elements.commentList.innerHTML = '';
        return;
    }

    elements.commentList.innerHTML = localComments
        .map((comment) => {
            const truncated =
                comment.body.length > 120
                    ? comment.body.substring(0, 120) + '...'
                    : comment.body;
            const timeStr = new Date(comment.timestamp).toLocaleTimeString();
            return `
                <div class="md3-comment-item" data-comment-id="${escapeAttr(comment.id)}">
                    <div class="md3-comment-item-header">
                        <span class="md3-comment-item-time">${timeStr}</span>
                        <div class="md3-comment-item-actions">
                            <button class="md3-btn-text" data-action="edit" data-id="${escapeAttr(comment.id)}">Edit</button>
                            <button class="md3-btn-text md3-danger" data-action="delete" data-id="${escapeAttr(comment.id)}">Delete</button>
                        </div>
                    </div>
                    <p class="md3-comment-item-text">${escapeHtml(truncated)}</p>
                </div>
            `;
        })
        .join('');
}

/**
 * Handles the comment submit button click.
 * Sends COMMENT_CREATE to service worker, displays result.
 */
async function handleCommentSubmit(): Promise<void> {
    const body = elements.commentInput.value.trim();
    if (!body || !currentLeadId) return;

    setFormLoading(true);

    const response = await sendCommentMessage(MESSAGE_TYPES.COMMENT_CREATE, {
        leadId: currentLeadId,
        body,
    });

    setFormLoading(false);

    if (response.success && response.data) {
        elements.commentInput.value = '';
        updateCharCounter();
        updateSubmitState();
        showStatusMessage('Comment submitted successfully.', 'success');

        localComments.unshift({
            id: response.data.comment_id || Date.now().toString(),
            body,
            timestamp: response.data.timestamp || new Date().toISOString(),
        });
        renderCommentList();
        persistComments();
    } else {
        const errorMsg =
            (response.error && typeof response.error === 'object'
                ? response.error.message
                : String(response.error)) || 'Failed to submit comment.';
        showStatusMessage(errorMsg, 'error');
    }
}

/**
 * Handles edit action on a comment item.
 * Replaces the comment text with an editable textarea and save/cancel buttons.
 */
function handleCommentEdit(commentId: string): void {
    const comment = localComments.find((c) => c.id === commentId);
    if (!comment) return;

    const itemEl = findCommentElement(commentId);
    if (!itemEl) return;

    itemEl.innerHTML = `
        <div class="md3-comment-edit-form">
            <textarea rows="3">${escapeHtml(comment.body)}</textarea>
            <div class="md3-comment-edit-actions">
                <button class="md3-btn-text" data-action="cancel-edit">Cancel</button>
                <button class="md3-btn-filled md3-btn-sm" data-action="save-edit" data-id="${escapeAttr(commentId)}">Save</button>
            </div>
        </div>
    `;
}

/**
 * Saves an edited comment by sending COMMENT_EDIT to the service worker.
 * Includes leadId in the payload so the backend can validate lead ownership.
 */
async function handleCommentSaveEdit(commentId: string): Promise<void> {
    const itemEl = findCommentElement(commentId);
    if (!itemEl) return;

    const textarea = itemEl.querySelector('textarea') as HTMLTextAreaElement;
    const newBody = textarea?.value.trim();
    if (!newBody) return;

    const saveBtn = itemEl.querySelector('[data-action="save-edit"]') as HTMLButtonElement;
    if (saveBtn) saveBtn.disabled = true;

    const response = await sendCommentMessage(MESSAGE_TYPES.COMMENT_EDIT, {
        commentId,
        body: newBody,
        leadId: currentLeadId,
    });

    if (response.success) {
        const comment = localComments.find((c) => c.id === commentId);
        if (comment) {
            comment.body = newBody;
            comment.timestamp = new Date().toISOString();
        }
        renderCommentList();
        persistComments();
        showStatusMessage('Comment updated successfully.', 'success');
    } else {
        const errorMsg =
            (response.error && typeof response.error === 'object'
                ? response.error.message
                : String(response.error)) || 'Failed to update comment.';
        showStatusMessage(errorMsg, 'error');
        if (saveBtn) saveBtn.disabled = false;
    }
}

/**
 * Handles delete action on a comment item.
 * Shows an inline confirmation dialog within the comment item,
 * then sends COMMENT_DELETE with leadId to the service worker.
 */
function handleCommentDelete(commentId: string): void {
    const itemEl = findCommentElement(commentId);
    if (!itemEl) return;

    itemEl.innerHTML = `
        <div class="md3-delete-confirm">
            <span class="md3-delete-confirm-text">Delete this comment?</span>
            <div class="md3-delete-confirm-actions">
                <button class="md3-btn-text" data-action="cancel-delete" data-id="${escapeAttr(commentId)}">Cancel</button>
                <button class="md3-btn-filled-danger" data-action="confirm-delete" data-id="${escapeAttr(commentId)}">Delete</button>
            </div>
        </div>
    `;
}

/**
 * Executes the confirmed delete operation.
 * Sends COMMENT_DELETE with both commentId and leadId to the service worker.
 */
async function executeCommentDelete(commentId: string): Promise<void> {
    const response = await sendCommentMessage(MESSAGE_TYPES.COMMENT_DELETE, {
        commentId,
        leadId: currentLeadId,
    });

    if (response.success) {
        const index = localComments.findIndex((c) => c.id === commentId);
        if (index !== -1) {
            localComments.splice(index, 1);
        }
        renderCommentList();
        persistComments();
        showStatusMessage('Comment deleted.', 'success');
    } else {
        const errorMsg =
            (response.error && typeof response.error === 'object'
                ? response.error.message
                : String(response.error)) || 'Failed to delete comment.';
        showStatusMessage(errorMsg, 'error');
        renderCommentList();
    }
}

/**
 * Queries the service worker for the current tab's lead state,
 * then fetches lead details from the backend if a lead is detected.
 */
async function loadLeadContext(): Promise<void> {
    showLeadState('detecting');

    const leadResponse = await sendMessage(MESSAGE_TYPES.GET_LEAD_STATE) as LeadStateResponse;

    if (!leadResponse.success || !leadResponse.data?.leadId) {
        currentLeadId = null;
        showLeadState('notFound');
        return;
    }

    currentLeadId = leadResponse.data.leadId;
    elements.leadIdValue.textContent = currentLeadId;
    elements.leadNameValue.textContent = 'Loading...';
    showLeadState('found');

    await loadCachedComments(currentLeadId);

    const leadInfoResult = await new Promise<{ success: boolean; data?: LeadInfo; error?: string }>(
        (resolve) => {
            chrome.runtime.sendMessage(
                createMessage(MESSAGE_TYPES.GET_LEAD_INFO, { leadId: currentLeadId }),
                (response) => resolve(response),
            );
        },
    );

    if (leadInfoResult.success && leadInfoResult.data) {
        elements.leadNameValue.textContent = leadInfoResult.data.lead_name;
    } else {
        elements.leadNameValue.textContent = 'Unable to fetch name';
    }
}

/**
 * Renders the logged-in view with user data from the auth state.
 */
function renderLoggedInView(state: AuthState): void {
    elements.agentDomain.textContent = state.domain || 'Unknown';
    elements.agentMemberId.textContent = state.memberId || 'Unknown';

    if (state.expiresAt) {
        const expiresDate = new Date(state.expiresAt * 1000);
        const now = new Date();
        const remainingMs = expiresDate.getTime() - now.getTime();
        const remainingMinutes = Math.max(0, Math.floor(remainingMs / 60000));
        elements.sessionExpiry.textContent = `${remainingMinutes} min remaining`;
    } else {
        elements.sessionExpiry.textContent = 'Active';
    }

    showView('loggedIn');
    loadLeadContext();
}

/**
 * Works out which Bitrix24 portal to authorize against.
 *
 * The active tab is the best signal, since the user is almost always looking at
 * the portal they want to connect. When the popup is opened from somewhere else
 * a previously added portal is used instead, and only if neither is available
 * does the backend fall back to its own configured default.
 */
async function detectActivePortal(): Promise<string | undefined> {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.url) {
            const fromTab = parsePortalHost(new URL(activeTab.url).hostname);
            if (fromTab) {
                return fromTab;
            }
        }
    } catch {
        // Fall through to the configured portals below.
    }

    try {
        const { portals } = await getSettings();
        return portals[0];
    } catch {
        return undefined;
    }
}

/**
 * Handles the login button click.
 * Sends AUTH_LOGIN to service worker, shows loading, then updates view.
 */
async function handleLogin(): Promise<void> {
    clearErrors();
    elements.btnLogin.disabled = true;
    showView('loading');

    const portal = await detectActivePortal();
    const response = await sendMessage(MESSAGE_TYPES.AUTH_LOGIN, { portal });

    if (response.success && response.data?.isAuthenticated) {
        renderLoggedInView(response.data);
    } else {
        showView('loggedOut');
        showError(
            elements.loginError,
            response.data?.error || response.error || 'Login failed. Please try again.',
        );
    }

    elements.btnLogin.disabled = false;
}

/**
 * Handles the logout button click.
 * Sends AUTH_LOGOUT to service worker, resets to logged-out view.
 */
async function handleLogout(): Promise<void> {
    clearErrors();
    elements.btnLogout.disabled = true;
    showView('loading');

    const response = await sendMessage(MESSAGE_TYPES.AUTH_LOGOUT);

    if (response.success) {
        chrome.storage.session.clear().catch(() => { });
        localComments.length = 0;
        showView('loggedOut');
    } else {
        showView('loggedIn');
        showError(elements.logoutError, response.error || 'Logout failed. Please try again.');
    }

    elements.btnLogout.disabled = false;
}

/**
 * Initializes the popup by querying current auth status from the service worker.
 */
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Pings the backend health endpoint to check connectivity.
 * Shows or hides the offline banner based on the result.
 */
async function checkConnectivity(): Promise<void> {
    const backendUrl = await getBackendUrl();

    if (!backendUrl) {
        elements.offlineBanner.classList.add('hidden');
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    try {
        const response = await fetch(`${backendUrl}/health`, {
            method: 'GET',
            signal: controller.signal,
        });
        if (response.ok) {
            elements.offlineBanner.classList.add('hidden');
        } else {
            elements.offlineBanner.classList.remove('hidden');
        }
    } catch {
        elements.offlineBanner.classList.remove('hidden');
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Starts periodic connectivity checks while the popup is open.
 */
function startConnectivityMonitor(): void {
    checkConnectivity();
    healthCheckTimer = setInterval(checkConnectivity, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Stops the connectivity monitor. Called on popup unload.
 */
function stopConnectivityMonitor(): void {
    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
    }
}

/**
 * Saves the backend URL entered on the setup view, then re-runs initialization
 * so the popup lands on the correct next view.
 */
async function handleSetupSave(): Promise<void> {
    elements.setupError.classList.add('hidden');
    elements.setupSaveBtn.disabled = true;

    const response = await sendMessage(MESSAGE_TYPES.SET_BACKEND_URL, {
        backendUrl: elements.setupInput.value,
    });

    elements.setupSaveBtn.disabled = false;

    if (!response.success) {
        showError(elements.setupError, response.error || 'Could not save the backend URL.');
        return;
    }

    await initialize();
}

async function initialize(): Promise<void> {
    showView('loading');

    if (!(await getBackendUrl())) {
        showView('setup');
        elements.setupInput.focus();
        return;
    }

    startConnectivityMonitor();

    const response = await sendMessage(MESSAGE_TYPES.AUTH_STATUS);

    if (response.success && response.data?.isAuthenticated) {
        renderLoggedInView(response.data);
    } else {
        showView('loggedOut');
    }
}

window.addEventListener('unload', stopConnectivityMonitor);

elements.setupSaveBtn.addEventListener('click', handleSetupSave);
elements.setupInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        void handleSetupSave();
    }
});

elements.btnLogin.addEventListener('click', handleLogin);
elements.btnLogout.addEventListener('click', handleLogout);

elements.commentInput.addEventListener('input', () => {
    updateCharCounter();
    updateSubmitState();
});

elements.submitBtn.addEventListener('click', handleCommentSubmit);

elements.commentList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.getAttribute('data-action');
    const id = target.getAttribute('data-id');

    if (action === 'edit' && id) {
        handleCommentEdit(id);
    } else if (action === 'delete' && id) {
        handleCommentDelete(id);
    } else if (action === 'save-edit' && id) {
        handleCommentSaveEdit(id);
    } else if (action === 'cancel-edit') {
        renderCommentList();
    } else if (action === 'confirm-delete' && id) {
        executeCommentDelete(id);
    } else if (action === 'cancel-delete') {
        renderCommentList();
    }
});

/**
 * Opens the Help section of the options page.
 *
 * chrome.runtime.openOptionsPage cannot carry a fragment, so the page is opened
 * as a tab by URL instead. Without that the user lands on Settings and has to
 * find Help, which is the moment they are least willing to go looking.
 */
function openHelp(): void {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#help') });
    window.close();
}

for (const button of document.querySelectorAll('[data-open-help]')) {
    button.addEventListener('click', openHelp);
}

initialize();
