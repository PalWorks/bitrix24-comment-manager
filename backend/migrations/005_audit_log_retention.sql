-- Migration 005: Audit Log Retention Policy
--
-- Deletes audit entries past the retention window. Requires migration 004,
-- whose DELETE trigger permits deletion only while @audit_log_retention_purge
-- is set, which this procedure does for the duration of its own statement.
--
-- Minimum retention: 60 days.
--
-- The scheduled event needs the MySQL event scheduler to be running:
--   SHOW VARIABLES LIKE 'event_scheduler';
--   SET GLOBAL event_scheduler = ON;      -- requires SUPER, may not be available
-- Where the scheduler cannot be enabled, drop the event and call the procedure
-- from an external cron instead:
--   mysql -e "CALL purge_expired_audit_logs(60)"
--
-- Idempotent: safe to re-run.
--
-- Note: comment_audit_log already carries an index on `timestamp` from
-- migration 003 (idx_audit_timestamp), which serves the range scan below.

DROP EVENT IF EXISTS evt_purge_audit_logs;
DROP PROCEDURE IF EXISTS purge_expired_audit_logs;

DELIMITER $$

CREATE PROCEDURE purge_expired_audit_logs(IN retention_days INT)
BEGIN
    DECLARE deleted_rows INT DEFAULT 0;

    -- Refuse to purge inside the minimum retention window.
    IF retention_days IS NULL OR retention_days < 60 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Retention must be at least 60 days';
    END IF;

    SET @audit_log_retention_purge = 1;

    DELETE FROM comment_audit_log
    WHERE timestamp < NOW() - INTERVAL retention_days DAY;

    SET deleted_rows = ROW_COUNT();

    SET @audit_log_retention_purge = 0;

    SELECT deleted_rows AS deleted_count;
END$$

CREATE EVENT evt_purge_audit_logs
    ON SCHEDULE EVERY 1 DAY
    STARTS TIMESTAMP(CURDATE(), '03:00:00')
    DO
        CALL purge_expired_audit_logs(60)$$

DELIMITER ;
