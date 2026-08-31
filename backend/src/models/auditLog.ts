export type AuditActionType = 'CREATE' | 'EDIT' | 'DELETE' | 'AUTH_FAILURE';

export type AuditStatus = 'SUCCESS' | 'FAILED';

/**
 * Represents a single audit log entry written to the comment_audit_log table.
 * Every comment operation and authentication failure produces one entry.
 *
 * Fields align 1:1 with BRD section 8 and migration 003.
 */
export interface AuditLogEntry {
    agent_id: string;
    bitrix_user_id: string | null;
    /** Bitrix24 portal the action targeted. Empty when it could not be determined. */
    portal_domain: string;
    lead_id: string;
    comment_id: string | null;
    action_type: AuditActionType;
    comment_hash: string;
    timestamp: string;
    ip_address: string | null;
    status: AuditStatus;
    failure_reason: string | null;
}

/**
 * Shape returned by the activity endpoint query.
 * Includes only the fields relevant for an agent's action history.
 */
export interface ActivityLogRow {
    timestamp: string;
    portal_domain: string;
    lead_id: string;
    action_type: AuditActionType;
    status: AuditStatus;
}
