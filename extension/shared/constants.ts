export const MESSAGE_TYPES = {
    AUTH_LOGIN: 'AUTH_LOGIN',
    AUTH_LOGOUT: 'AUTH_LOGOUT',
    AUTH_STATUS: 'AUTH_STATUS',

    LEAD_DETECTED: 'LEAD_DETECTED',
    LEAD_NOT_DETECTED: 'LEAD_NOT_DETECTED',
    GET_LEAD_STATE: 'GET_LEAD_STATE',
    GET_LEAD_INFO: 'GET_LEAD_INFO',
    GET_ACTIVITY_LOG: 'GET_ACTIVITY_LOG',
    COMMENT_CREATE: 'COMMENT_CREATE',
    COMMENT_EDIT: 'COMMENT_EDIT',
    COMMENT_DELETE: 'COMMENT_DELETE',

    GET_SETTINGS: 'GET_SETTINGS',
    SET_BACKEND_URL: 'SET_BACKEND_URL',
    ADD_PORTAL: 'ADD_PORTAL',
    REMOVE_PORTAL: 'REMOVE_PORTAL',
} as const;

export const CONFIG = {
    JWT_REFRESH_BUFFER_SECONDS: 300,
    MAX_COMMENT_LENGTH: 5000,
    /**
     * Matches the CRM lead detail path. Applied to a URL's pathname rather than
     * the whole URL so that portals served under a path prefix, as some self
     * hosted installations are, are detected as well.
     */
    LEAD_PATH_PATTERN: /\/crm\/lead\/details\/(\d+)/,
    NAVIGATION_THROTTLE_MS: 500,
    API_TIMEOUT_MS: 30_000,
} as const;
