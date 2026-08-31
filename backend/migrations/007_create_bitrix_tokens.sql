-- Migration 007: Persist Bitrix24 OAuth tokens
--
-- Tokens previously lived only in process memory, so every backend restart
-- de-authenticated every user. They are stored here instead, keyed by the
-- Bitrix24 member id.
--
-- access_token and refresh_token are stored encrypted (AES-256-GCM) under
-- TOKEN_ENCRYPTION_KEY. The database never sees plaintext credentials.

CREATE TABLE bitrix_tokens (
    member_id        VARCHAR(255) NOT NULL,
    portal_domain    VARCHAR(255) NOT NULL,
    client_endpoint  VARCHAR(512) NOT NULL,
    access_token     TEXT         NOT NULL,
    refresh_token    TEXT         NOT NULL,
    expires_at       BIGINT       NOT NULL,
    created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (member_id)
);

CREATE INDEX idx_bitrix_tokens_portal ON bitrix_tokens (portal_domain);
