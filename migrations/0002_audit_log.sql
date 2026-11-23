-- The audit log (tasks 1.4.1, 1.4.2 and 1.4.4; FR-8, FR-28, FR-21): one row per event, in order.
-- Each row carries the hash of the row before it, so a changed, removed or
-- inserted row breaks the chain. The triggers below make the table
-- append-only at the database itself, with the two exceptions retention needs.
--
-- This file was changed by task 1.4.4 before it had been applied to any
-- database. Once it has been applied anywhere, changes go in a new migration.
CREATE TABLE IF NOT EXISTS audit_log (
  -- Assigned by the writer as "last + 1". Two writers cannot take the same number.
  seq INTEGER PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT NOT NULL,
  project TEXT NOT NULL,
  -- 1 for a security event. Its run's full text is kept for the longer period.
  security INTEGER NOT NULL DEFAULT 0,
  -- The event's details as JSON, redacted before writing (FR-21). NULL once expired or erased.
  content TEXT,
  -- SHA-256 of the content. The chain covers this, not the content itself.
  content_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- Where the log now starts, after old rows were removed: the number and hash
-- of the newest removed row. One row at most.
CREATE TABLE IF NOT EXISTS audit_anchor (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL
);

-- The only change allowed to a row is removing its content.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
WHEN NEW.content IS NOT NULL OR NEW.seq IS NOT OLD.seq OR NEW.at IS NOT OLD.at OR NEW.kind IS NOT OLD.kind OR NEW.run_id IS NOT OLD.run_id OR NEW.project IS NOT OLD.project OR NEW.security IS NOT OLD.security OR NEW.content_hash IS NOT OLD.content_hash OR NEW.prev_hash IS NOT OLD.prev_hash OR NEW.hash IS NOT OLD.hash
BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;

-- The only row that may be deleted is the oldest one, once it is past the
-- retention period (90 days, the same number as RETENTION in src/limits.ts).
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
WHEN OLD.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days') OR EXISTS (SELECT 1 FROM audit_log WHERE seq < OLD.seq)
BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
