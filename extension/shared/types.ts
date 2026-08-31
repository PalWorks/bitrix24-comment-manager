export interface AuthState {
    isAuthenticated: boolean;
    memberId?: string;
    domain?: string;
    expiresAt?: number;
    /** Present when a login attempt failed, describing why. */
    error?: string;
}

export interface AuthLoginResponse {
    jwt: string;
    expiresAt: number;
    memberId: string;
    domain: string;
}

export interface AuthStatusResponse {
    authenticated: boolean;
    memberId?: string;
    domain?: string;
    expiresAt?: number;
}

export interface LeadState {
    tabId: number;
    leadId: string | null;
}

export interface LeadInfo {
    lead_id: string;
    lead_name: string;
    exists: boolean;
}

export interface CommentCreateRequest {
    lead_id: string;
    comment_body: string;
}

export interface CommentEditRequest {
    comment_body: string;
}

export interface CommentOperationResponse {
    success: boolean;
    comment_id?: string;
    lead_id?: string;
    action: 'CREATE' | 'EDIT' | 'DELETE';
    timestamp: string;
}

export interface ActivityEntry {
    timestamp: string;
    portal_domain?: string;
    lead_id: string;
    action_type: 'CREATE' | 'EDIT' | 'DELETE';
    status: 'SUCCESS' | 'FAILED';
}

export interface ExtensionSettings {
    backendUrl: string;
    portals: string[];
}

export interface ActivityResponse {
    actions: ActivityEntry[];
}

export interface ApiErrorResponse {
    error: {
        code: string;
        message: string;
        retry_after_seconds?: number;
    };
}
