CREATE TABLE comment_audit_log (
    log_id         CHAR(36)     NOT NULL DEFAULT (UUID()),
    agent_id       VARCHAR(255) NOT NULL,
    bitrix_user_id VARCHAR(255),
    lead_id        VARCHAR(255) NOT NULL,
    comment_id     VARCHAR(255),
    action_type    VARCHAR(20)  NOT NULL,
    comment_hash   VARCHAR(64)  NOT NULL,
    timestamp      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    ip_address     VARCHAR(45),
    status         VARCHAR(10)  NOT NULL,
    failure_reason TEXT,
    created_at     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (log_id),
    CONSTRAINT chk_action_type CHECK (action_type IN ('CREATE', 'EDIT', 'DELETE', 'AUTH_FAILURE')),
    CONSTRAINT chk_status      CHECK (status IN ('SUCCESS', 'FAILED'))
);

CREATE INDEX idx_audit_agent_id     ON comment_audit_log (agent_id);
CREATE INDEX idx_audit_lead_id      ON comment_audit_log (lead_id);
CREATE INDEX idx_audit_timestamp    ON comment_audit_log (timestamp);
CREATE INDEX idx_audit_comment_hash ON comment_audit_log (comment_hash, lead_id, agent_id);
CREATE INDEX idx_audit_status       ON comment_audit_log (status);
