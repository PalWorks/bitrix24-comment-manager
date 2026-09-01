import { MESSAGE_TYPES } from '../shared/constants';
import type { ExtensionMessage } from '../shared/messages';
import type { CommentOperationResponse } from '../shared/types';
import { initiateLogin, initiateLogout, getAuthStatus } from './auth';
import { setLeadForTab, getLeadForTab } from './leadState';
import { parseLeadUrl } from '../content/urlParser';
import { apiRequest } from './apiClient';
import { addPortal, removePortal } from './portalRegistry';
import { getSettings, updateSettings, validateBackendUrl, parsePortalHost } from '../shared/settings';

type SendResponse = (response: unknown) => void;

/**
 * Central message handler for the service worker.
 * Routes incoming messages from the popup, content scripts, and other
 * extension contexts to the appropriate handler based on the message type.
 *
 * Returns true from the listener to indicate async response handling.
 */
export function handleMessage(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: SendResponse,
): boolean {
    switch (message.type) {
        case MESSAGE_TYPES.AUTH_LOGIN: {
            const loginPayload = message.payload as { portal?: string } | undefined;
            initiateLogin(loginPayload?.portal)
                .then((authState) => sendResponse({ success: true, data: authState }))
                .catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : 'Login failed';
                    sendResponse({ success: false, error: errorMessage });
                });
            return true;
        }

        case MESSAGE_TYPES.AUTH_LOGOUT:
            initiateLogout()
                .then(() => sendResponse({ success: true }))
                .catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : 'Logout failed';
                    sendResponse({ success: false, error: errorMessage });
                });
            return true;

        case MESSAGE_TYPES.AUTH_STATUS:
            getAuthStatus()
                .then((status) => sendResponse({ success: true, data: status }))
                .catch(() => sendResponse({ success: true, data: { isAuthenticated: false } }));
            return true;

        case MESSAGE_TYPES.LEAD_DETECTED: {
            const tabId = sender.tab?.id;
            if (tabId !== undefined) {
                const payload = message.payload as { leadId: string } | undefined;
                setLeadForTab(tabId, payload?.leadId ?? null);
            }
            return false;
        }

        case MESSAGE_TYPES.LEAD_NOT_DETECTED: {
            const tabId = sender.tab?.id;
            if (tabId !== undefined) {
                setLeadForTab(tabId, null);
            }
            return false;
        }

        case MESSAGE_TYPES.GET_LEAD_STATE:
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const activeTab = tabs[0];
                if (!activeTab?.id) {
                    sendResponse({ success: true, data: { leadId: null } });
                    return;
                }

                const tracked = getLeadForTab(activeTab.id);

                // undefined means this worker has never heard about the tab,
                // which is the ordinary state rather than an error: the map
                // lives in the service worker, Manifest V3 discards the worker
                // after about thirty seconds of idleness, and the content
                // script only speaks on navigation. Sitting on a lead, pausing
                // to read it, then opening the popup is therefore the exact
                // sequence that used to report no lead at all.
                //
                // The tab's own URL is the same evidence the content script
                // would have sent, and it is authoritative right now, so the
                // popup is answered from that instead of from a gap in memory.
                // null, by contrast, is a real answer: the tab was checked and
                // is not on a lead.
                if (tracked === undefined) {
                    const derived = parseLeadUrl(activeTab.url ?? '');
                    if (derived) {
                        setLeadForTab(activeTab.id, derived);
                    }
                    sendResponse({ success: true, data: { leadId: derived } });
                    return;
                }

                sendResponse({ success: true, data: { leadId: tracked } });
            });
            return true;

        case MESSAGE_TYPES.COMMENT_CREATE: {
            const createPayload = message.payload as { leadId: string; body: string } | undefined;
            if (!createPayload?.leadId || !createPayload?.body) {
                sendResponse({ success: false, error: 'Lead ID and comment body are required.' });
                return false;
            }
            apiRequest<CommentOperationResponse>('/api/comments', {
                method: 'POST',
                body: { lead_id: createPayload.leadId, comment_body: createPayload.body },
            })
                .then((result) => sendResponse(result))
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Comment creation failed';
                    sendResponse({ success: false, error: msg });
                });
            return true;
        }

        case MESSAGE_TYPES.COMMENT_EDIT: {
            const editPayload = message.payload as { commentId: string; body: string; leadId: string } | undefined;
            if (!editPayload?.commentId || !editPayload?.body || !editPayload?.leadId) {
                sendResponse({ success: false, error: 'Comment ID, body, and lead ID are required.' });
                return false;
            }
            apiRequest<CommentOperationResponse>(`/api/comments/${editPayload.commentId}`, {
                method: 'PUT',
                body: { comment_body: editPayload.body, lead_id: editPayload.leadId },
            })
                .then((result) => sendResponse(result))
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Comment edit failed';
                    sendResponse({ success: false, error: msg });
                });
            return true;
        }

        case MESSAGE_TYPES.COMMENT_DELETE: {
            const deletePayload = message.payload as { commentId: string; leadId: string } | undefined;
            if (!deletePayload?.commentId || !deletePayload?.leadId) {
                sendResponse({ success: false, error: 'Comment ID and lead ID are required.' });
                return false;
            }
            apiRequest<CommentOperationResponse>(`/api/comments/${deletePayload.commentId}`, {
                method: 'DELETE',
                body: { lead_id: deletePayload.leadId },
            })
                .then((result) => sendResponse(result))
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Comment delete failed';
                    sendResponse({ success: false, error: msg });
                });
            return true;
        }

        case MESSAGE_TYPES.GET_LEAD_INFO: {
            const leadPayload = message.payload as { leadId: string } | undefined;
            if (!leadPayload?.leadId) {
                sendResponse({ success: false, error: 'Lead ID is required.' });
                return false;
            }
            apiRequest(`/api/leads/${leadPayload.leadId}`)
                .then((result) => sendResponse(result))
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Lead info fetch failed';
                    sendResponse({ success: false, error: msg });
                });
            return true;
        }

        case MESSAGE_TYPES.GET_ACTIVITY_LOG: {
            const activityPayload = message.payload as { limit?: number } | undefined;
            const limit = activityPayload?.limit ?? 20;
            apiRequest(`/api/activity?limit=${limit}`)
                .then((result) => sendResponse(result))
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Activity log fetch failed';
                    sendResponse({ success: false, error: msg });
                });
            return true;
        }

        case MESSAGE_TYPES.GET_SETTINGS:
            getSettings()
                .then((settings) => sendResponse({ success: true, data: settings }))
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Could not read settings';
                    sendResponse({ success: false, error: msg });
                });
            return true;

        case MESSAGE_TYPES.SET_BACKEND_URL: {
            const payload = message.payload as { backendUrl?: string } | undefined;
            const candidate = payload?.backendUrl ?? '';
            const invalidReason = validateBackendUrl(candidate);

            if (invalidReason) {
                sendResponse({ success: false, error: invalidReason });
                return false;
            }

            updateSettings({ backendUrl: candidate })
                .then((settings) => sendResponse({ success: true, data: settings }))
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Could not save the backend URL';
                    sendResponse({ success: false, error: msg });
                });
            return true;
        }

        case MESSAGE_TYPES.ADD_PORTAL: {
            const payload = message.payload as { portal?: string } | undefined;
            const host = parsePortalHost(payload?.portal ?? '');

            if (!host) {
                sendResponse({
                    success: false,
                    error: 'Enter a portal hostname, for example acme.bitrix24.de',
                });
                return false;
            }

            addPortal(host)
                .then((granted) =>
                    granted
                        ? sendResponse({ success: true, data: { portal: host } })
                        : sendResponse({
                            success: false,
                            error: 'Permission for that portal was not granted.',
                        }),
                )
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Could not add the portal';
                    sendResponse({ success: false, error: msg });
                });
            return true;
        }

        case MESSAGE_TYPES.REMOVE_PORTAL: {
            const payload = message.payload as { portal?: string } | undefined;
            const host = payload?.portal;

            if (!host) {
                sendResponse({ success: false, error: 'No portal specified.' });
                return false;
            }

            removePortal(host)
                .then(() => sendResponse({ success: true }))
                .catch((error) => {
                    const msg = error instanceof Error ? error.message : 'Could not remove the portal';
                    sendResponse({ success: false, error: msg });
                });
            return true;
        }

        default:
            return false;
    }
}
