-- Migration 004: Audit Log Immutability
--
-- Blocks UPDATE and DELETE on comment_audit_log so entries cannot be altered
-- or removed by the application or by a casual session.
--
-- The DELETE trigger honours one deliberate exception: the retention purge in
-- migration 005 sets @audit_log_retention_purge for the duration of its own
-- DELETE. Without that exception the immutability trigger and the retention
-- policy contradict each other and the purge can never run. The variable is
-- session scoped, so an ordinary connection cannot bypass the trigger by
-- accident. This defends against application bugs and casual tampering; it is
-- not a defence against someone who already holds DDL rights on the database.
--
-- Idempotent: safe to re-run. Re-run this on any database that was created
-- before the exception existed.

DROP TRIGGER IF EXISTS audit_log_immutable_update;
DROP TRIGGER IF EXISTS audit_log_immutable_delete;

DELIMITER $$

CREATE TRIGGER audit_log_immutable_update
    BEFORE UPDATE ON comment_audit_log
    FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Audit log entries cannot be modified';
END$$

CREATE TRIGGER audit_log_immutable_delete
    BEFORE DELETE ON comment_audit_log
    FOR EACH ROW
BEGIN
    IF COALESCE(@audit_log_retention_purge, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Audit log entries cannot be deleted outside the retention purge';
    END IF;
END$$

DELIMITER ;
