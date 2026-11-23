-- The audit log (tasks 1.4.1 and 1.4.2, FR-8, FR-28): one row per event, in order.
-- Each row carries the hash of the row before it, so a changed, removed or
-- inserted row breaks the chain. The two triggers below make the table
-- append-only at the database itself.
CREATE TABLE IF NOT EXISTS audit_log (
  -- Assigned by the writer as "last + 1". Two writers cannot take the same number.
  seq INTEGER PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT NOT NULL,
  project TEXT NOT NULL,
  -- The event's details as JSON, redacted before writing (FR-21).
  content TEXT,
  -- SHA-256 of the content. The chain covers this, not the content itself.
  content_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
