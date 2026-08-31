-- Migration 006: Record the portal on every audit entry
--
-- One backend can serve several Bitrix24 portals, so an agent id alone no
-- longer identifies a row's origin. Existing rows predate multi-portal support
-- and are backfilled with the empty string rather than a guess.

ALTER TABLE comment_audit_log
    ADD COLUMN portal_domain VARCHAR(255) NOT NULL DEFAULT '' AFTER bitrix_user_id;

CREATE INDEX idx_audit_portal_domain ON comment_audit_log (portal_domain);
