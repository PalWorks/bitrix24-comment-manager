import { MESSAGE_TYPES } from '../shared/constants';
import { SUPPORT_URL, ISSUES_URL, SETUP_DOCS_URL } from '../shared/settings';
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
    connectionBadge: document.getElementById('connection-badge') as HTMLElement,
    appMain: document.getElementById('app-main') as HTMLElement,
    activityRow: document.getElementById('row-activity') as HTMLElement,
    planName: document.getElementById('current-plan-name') as HTMLElement,
    planBadge: document.getElementById('current-plan-badge') as HTMLElement,
    planDetail: document.getElementById('current-plan-detail') as HTMLElement,
};

const pages = {
    settings: document.getElementById('page-settings') as HTMLElement,
    billing: document.getElementById('page-billing') as HTMLElement,
    help: document.getElementById('page-help') as HTMLElement,
};

const navItems = {
    settings: document.getElementById('nav-settings') as HTMLButtonElement,
    billing: document.getElementById('nav-billing') as HTMLButtonElement,
    help: document.getElementById('nav-help') as HTMLButtonElement,
};

type PageName = keyof typeof pages;
const PAGE_ORDER: PageName[] = ['settings', 'billing', 'help'];

function isPageName(value: string): value is PageName {
    return (PAGE_ORDER as string[]).includes(value);
}

const DEPLOY_DOCS_URL =
    'https://github.com/PalWorks/bitrix24-comment-manager/blob/main/docs/deployment/docker.md';
const SECURITY_URL =
    'https://github.com/PalWorks/bitrix24-comment-manager/blob/main/SECURITY.md';
const PRIVACY_URL = 'https://palworks.github.io/bitrix24-comment-manager/privacy/';
const TERMS_URL = 'https://palworks.github.io/bitrix24-comment-manager/terms/';

/** Client side mirror of the server's attachment policy, for a fast rejection. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'application/json',
    'application/zip',
];

/**
 * Two ways to get a backend, not three.
 *
 * Deploying one and pointing at one somebody already deployed are two moments
 * in the same arrangement, not two arrangements: either way the server is
 * yours. Splitting them made the strip look like a choice where none existed.
 * The real fork is who operates it, so that is what the tabs name.
 */
const tabs = {
    cloud: document.getElementById('tab-cloud') as HTMLButtonElement,
    selfhost: document.getElementById('tab-selfhost') as HTMLButtonElement,
};

const panels = {
    cloud: document.getElementById('panel-cloud') as HTMLElement,
    selfhost: document.getElementById('panel-selfhost') as HTMLElement,
};

type TabName = keyof typeof tabs;
const TAB_ORDER: TabName[] = ['cloud', 'selfhost'];

const support = {
    section: document.getElementById('support-section') as HTMLElement,
    form: document.getElementById('support-form') as HTMLFormElement,
    name: document.getElementById('support-name') as HTMLInputElement,
    email: document.getElementById('support-email') as HTMLInputElement,
    phone: document.getElementById('support-phone') as HTMLInputElement,
    category: document.getElementById('support-category') as HTMLSelectElement,
    message: document.getElementById('support-message') as HTMLTextAreaElement,
    file: document.getElementById('support-file') as HTMLInputElement,
    company: document.getElementById('support-company') as HTMLInputElement,
    counter: document.getElementById('support-counter') as HTMLElement,
    sendBtn: document.getElementById('btn-support-send') as HTMLButtonElement,
    status: document.getElementById('support-status') as HTMLElement,
    fallback: document.getElementById('support-fallback') as HTMLElement,
    waitlistEmail: document.getElementById('waitlist-email') as HTMLInputElement,
    waitlistBtn: document.getElementById('btn-waitlist') as HTMLButtonElement,
    waitlistStatus: document.getElementById('waitlist-status') as HTMLElement,
    waitlistFallback: document.getElementById('waitlist-fallback') as HTMLElement,
};

/**
 * Shows exactly one view and hides the others.
 */
function showView(viewName: 'loading' | 'loggedOut' | 'loggedIn'): void {
    views.loading.classList.toggle('hidden', viewName !== 'loading');
    elements.appMain.classList.toggle('hidden', viewName === 'loading');

    // These two are the Account row's states now rather than whole pages, so
    // the rest of the settings stay reachable while signed out. That matters:
    // an installation with no backend cannot sign in until it has configured
    // one, and the field to do it with lives on this page.
    views.loggedOut.classList.toggle('hidden', viewName !== 'loggedOut');
    views.loggedIn.classList.toggle('hidden', viewName !== 'loggedIn');

    // Activity is read from the backend for the signed in agent, so there is
    // nothing to show, and nothing to explain, when nobody is signed in.
    elements.activityRow.classList.toggle('hidden', viewName !== 'loggedIn');

    const connected = viewName === 'loggedIn';
    elements.connectionBadge.textContent = connected ? 'Connected' : 'Not connected';
    elements.connectionBadge.className = `badge ${connected ? 'badge-connected' : 'badge-disconnected'}`;
    elements.connectionBadge.classList.toggle('hidden', viewName === 'loading');
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
    renderPlan(response.data.backendUrl);

    // Someone who already has a backend does not need a pitch for hosting, so
    // open on the tab that matches where they are. Only on load: once the user
    // has picked a tab, saving a URL must not move it under them.
    if (!tabSelectedByUser) {
        selectTab(response.data.backendUrl ? 'selfhost' : 'cloud');
    }
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

/**
 * Selects one backend route tab. Panels are toggled rather than rebuilt so the
 * waitlist field keeps whatever the user had typed.
 */
/**
 * Switches the top level page.
 *
 * The choice is mirrored into the location hash so a page can be linked to
 * directly, which is what makes "see Plans and billing" a link rather than an
 * instruction to go and find it.
 */
function selectPage(name: PageName, focus = false): void {
    for (const key of PAGE_ORDER) {
        const selected = key === name;
        navItems[key].setAttribute('aria-selected', String(selected));
        navItems[key].tabIndex = selected ? 0 : -1;
        pages[key].classList.toggle('hidden', !selected);
    }

    if (location.hash.slice(1) !== name) {
        history.replaceState(null, '', `#${name}`);
    }

    if (focus) {
        navItems[name].focus();
    }

    window.scrollTo({ top: 0 });
}

function handleNavKeydown(event: KeyboardEvent, current: PageName): void {
    const index = PAGE_ORDER.indexOf(current);
    let next: PageName | null = null;

    switch (event.key) {
        case 'ArrowRight':
            next = PAGE_ORDER[(index + 1) % PAGE_ORDER.length];
            break;
        case 'ArrowLeft':
            next = PAGE_ORDER[(index - 1 + PAGE_ORDER.length) % PAGE_ORDER.length];
            break;
        case 'Home':
            next = PAGE_ORDER[0];
            break;
        case 'End':
            next = PAGE_ORDER[PAGE_ORDER.length - 1];
            break;
        default:
            return;
    }

    event.preventDefault();
    selectPage(next, true);
}

/**
 * Describes what this installation is actually on.
 *
 * Hosted plans do not exist yet, so the honest answer is one of two states:
 * nothing configured, or pointing at a backend the user runs. Saying "Free
 * plan" here would be inventing a relationship that does not exist.
 */
function renderPlan(backendUrl: string): void {
    if (!backendUrl) {
        elements.planName.textContent = 'Not configured';
        elements.planBadge.textContent = 'No billing';
        elements.planBadge.className = 'badge badge-neutral';
        elements.planDetail.textContent =
            'No backend is set yet, so nothing is running and nothing is billed. Set one under Settings to get started.';
        return;
    }

    let host = backendUrl;
    try {
        host = new URL(backendUrl).host;
    } catch {
        // Keep the raw value: it is what the user typed, and it is what they
        // would need to correct.
    }

    elements.planName.textContent = 'Self-Hosted';
    elements.planBadge.textContent = 'No billing';
    elements.planBadge.className = 'badge badge-neutral';
    elements.planDetail.textContent =
        `You are pointing at ${host}, a backend you run. Nothing is billed, there are no limits beyond your own server, and your audit log never leaves it.`;
}

let tabSelectedByUser = false;

function selectTab(name: TabName, focus = false): void {
    for (const key of TAB_ORDER) {
        const selected = key === name;
        tabs[key].setAttribute('aria-selected', String(selected));
        tabs[key].tabIndex = selected ? 0 : -1;
        panels[key].classList.toggle('hidden', !selected);
    }
    if (focus) {
        tabs[name].focus();
    }
}

/**
 * Arrow, Home and End navigation across the tab strip, which is what the
 * tablist role promises to a keyboard or screen reader user.
 */
function handleTabKeydown(event: KeyboardEvent, current: TabName): void {
    const index = TAB_ORDER.indexOf(current);
    let next: TabName | null = null;

    switch (event.key) {
        case 'ArrowRight':
            next = TAB_ORDER[(index + 1) % TAB_ORDER.length];
            break;
        case 'ArrowLeft':
            next = TAB_ORDER[(index - 1 + TAB_ORDER.length) % TAB_ORDER.length];
            break;
        case 'Home':
            next = TAB_ORDER[0];
            break;
        case 'End':
            next = TAB_ORDER[TAB_ORDER.length - 1];
            break;
        default:
            return;
    }

    event.preventDefault();
    selectTab(next, true);
}

/**
 * Encodes a file as base64 in chunks. Building the binary string one character
 * at a time is fine for a few kilobytes and unusably slow for a few megabytes,
 * and String.fromCharCode has an argument count limit, so neither extreme
 * works on its own.
 */
async function fileToBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunkSize = 8192;
    const parts: string[] = [];

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }

    return btoa(parts.join(''));
}

/**
 * Resolves the MIME type to send. Chrome reports an empty type for extensions
 * it does not recognise, and a log file is the single most useful attachment
 * on a support request, so text files are recovered from the name.
 */
function resolveAttachmentType(file: File): string | null {
    if (ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
        return file.type;
    }
    if (!file.type && /\.(txt|log)$/i.test(file.name)) {
        return 'text/plain';
    }
    return null;
}

interface SupportPayload {
    name: string;
    email: string;
    phone: string;
    category: string;
    message: string;
    context: Record<string, string>;
    company: string;
    attachment?: { filename: string; contentType: string; content: string };
}

/**
 * Posts to the support service this build was published with. Returns a human
 * readable reason on failure, or null on success.
 */
async function postSupport(payload: SupportPayload): Promise<string | null> {
    if (!SUPPORT_URL) {
        return 'Email support is not enabled in this build.';
    }

    let response: Response;
    try {
        response = await fetch(`${SUPPORT_URL}/support`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch {
        return 'Could not reach the support service. Check your connection and try again.';
    }

    if (response.ok) {
        return null;
    }

    const body = await response.json().catch(() => null);
    const message = (body as { error?: { message?: string } } | null)?.error?.message;
    return message || 'Could not send the message. Please try again shortly.';
}

/**
 * Diagnostics attached to every support message. Deliberately limited to what
 * helps reproduce a problem: no portal contents, no lead data, no token.
 */
function supportContext(): Record<string, string> {
    return {
        extensionVersion: chrome.runtime.getManifest().version,
        backendConfigured: elements.backendInput.value ? 'yes' : 'no',
        userAgent: navigator.userAgent,
    };
}

/**
 * Reads, validates and encodes the chosen attachment.
 * Throws a message suitable for display when the file is not acceptable.
 */
async function readAttachment(): Promise<SupportPayload['attachment']> {
    const file = support.file.files?.[0];
    if (!file) {
        return undefined;
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error('That file is larger than 5 MB. Attach a smaller one.');
    }
    if (file.size === 0) {
        throw new Error('That file is empty.');
    }

    const contentType = resolveAttachmentType(file);
    if (!contentType) {
        throw new Error('That file type is not accepted. Try a PNG, PDF, text or zip file.');
    }

    return {
        filename: file.name,
        contentType,
        content: await fileToBase64(file),
    };
}

/**
 * Submits the support form.
 */
async function handleSupportSubmit(event: Event): Promise<void> {
    event.preventDefault();

    const name = support.name.value.trim();
    const email = support.email.value.trim();
    const phone = support.phone.value.trim();
    const message = support.message.value.trim();

    if (name.length < 2) {
        showSettingStatus(support.status, 'Tell us your name so we know who we are replying to.', 'error');
        return;
    }
    if (!email || !support.email.checkValidity()) {
        showSettingStatus(support.status, 'Enter an email address we can reply to.', 'error');
        return;
    }
    // Checked here as well as on the server so the correction happens while the
    // field is still in front of the person, not after a round trip.
    if (phone && !/^\+[1-9][\d\s\-().]{6,20}$/.test(phone)) {
        showSettingStatus(
            support.status,
            'Include the country code on the phone number, for example +971 50 123 4567.',
            'error',
        );
        return;
    }
    if (message.length < 10) {
        showSettingStatus(support.status, 'Tell us a little more, at least 10 characters.', 'error');
        return;
    }

    support.sendBtn.disabled = true;
    showSettingStatus(support.status, 'Sending...', 'success');

    let attachment: SupportPayload['attachment'];
    try {
        attachment = await readAttachment();
    } catch (error) {
        support.sendBtn.disabled = false;
        showSettingStatus(
            support.status,
            error instanceof Error ? error.message : 'Could not read that file.',
            'error',
        );
        return;
    }

    const failure = await postSupport({
        name,
        email,
        phone,
        category: support.category.value,
        message,
        context: supportContext(),
        company: support.company.value,
        attachment,
    });

    support.sendBtn.disabled = false;

    if (failure) {
        showSettingStatus(support.status, failure, 'error');
        return;
    }

    support.form.reset();
    updateSupportCounter();
    showSettingStatus(support.status, 'Sent. We will reply to that address.', 'success');
}

/**
 * Registers interest in hosted backends. Same endpoint as support, tagged so
 * the two land in the inbox distinguishable from each other.
 */
async function handleWaitlist(): Promise<void> {
    const email = support.waitlistEmail.value.trim();

    if (!email || !support.waitlistEmail.checkValidity()) {
        showSettingStatus(support.waitlistStatus, 'Enter a valid email address.', 'error');
        return;
    }

    support.waitlistBtn.disabled = true;

    const failure = await postSupport({
        name: 'Hosting waitlist',
        email,
        phone: '',
        category: 'hosting-waitlist',
        message: 'Requested notification when hosted backends open.',
        context: supportContext(),
        company: '',
    });

    support.waitlistBtn.disabled = false;

    if (failure) {
        showSettingStatus(support.waitlistStatus, failure, 'error');
        return;
    }

    support.waitlistEmail.value = '';
    showSettingStatus(support.waitlistStatus, 'Thanks. We will be in touch.', 'success');
}

function updateSupportCounter(): void {
    support.counter.textContent = `${support.message.value.length} / 5000`;
}

/**
 * Points every documentation link at its canonical URL and hides the support
 * form when this build has no support service to post to.
 */
function initializeStaticLinks(): void {
    const links: Array<[string, string]> = [
        ['link-setup-docs', SETUP_DOCS_URL],
        ['link-deploy-docs', DEPLOY_DOCS_URL],
        ['link-issues', ISSUES_URL],
        ['link-issues-fallback', ISSUES_URL],
        ['link-issues-waitlist', ISSUES_URL],
        ['link-setup-docs-2', SETUP_DOCS_URL],
        ['link-security', SECURITY_URL],
        ['link-privacy', PRIVACY_URL],
        ['link-terms', TERMS_URL],
    ];

    for (const [id, href] of links) {
        const anchor = document.getElementById(id) as HTMLAnchorElement | null;
        if (anchor) {
            anchor.href = href;
        }
    }

    // A build with no support service has nowhere to put a message or an
    // address, so both controls are replaced with something that still tells
    // the user what to do rather than a dead button with no explanation.
    if (!SUPPORT_URL) {
        support.form.classList.add('hidden');
        support.fallback.classList.remove('hidden');
        support.waitlistBtn.disabled = true;
        support.waitlistEmail.disabled = true;
        support.waitlistBtn.classList.add('hidden');
        support.waitlistEmail.classList.add('hidden');
        support.waitlistFallback.classList.remove('hidden');
    }
}

for (const name of PAGE_ORDER) {
    navItems[name].addEventListener('click', () => selectPage(name));
    navItems[name].addEventListener('keydown', (event) => handleNavKeydown(event, name));
}

document.getElementById('link-to-billing')?.addEventListener('click', () => {
    selectPage('billing');
});

// Opening options.html#billing lands on that page, so the popup, the docs and
// an email can all point at it directly.
const requestedPage = location.hash.slice(1);
selectPage(isPageName(requestedPage) ? requestedPage : 'settings');

window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (isPageName(name)) {
        selectPage(name);
    }
});

for (const name of TAB_ORDER) {
    tabs[name].addEventListener('click', () => {
        tabSelectedByUser = true;
        selectTab(name);
    });
    tabs[name].addEventListener('keydown', (event) => {
        tabSelectedByUser = true;
        handleTabKeydown(event, name);
    });
}

support.form.addEventListener('submit', (event) => void handleSupportSubmit(event));
support.message.addEventListener('input', updateSupportCounter);
support.waitlistBtn.addEventListener('click', () => void handleWaitlist());

initializeStaticLinks();
updateSupportCounter();

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
