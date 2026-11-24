-- Failed runs in a row, per signed-in caller and project (task 2.1.5, FR-41).
-- A row exists only while there is something to remember: it is deleted on a
-- successful run. `closed` holds the refusal, as JSON, once the limit is hit.
CREATE TABLE IF NOT EXISTS attempt_state (
  key TEXT PRIMARY KEY NOT NULL,
  failures INTEGER NOT NULL,
  closed TEXT,
  escalation_id TEXT,
  updated_at INTEGER NOT NULL
);
