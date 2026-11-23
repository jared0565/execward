-- The policy table (task 1.3.1, FR-50): one row per wrapped tool.
-- A tool with no row is not callable from a script. That rule lives in the
-- broker, not here: absence is the deny.
CREATE TABLE IF NOT EXISTS policy (
  -- The function name a script calls, for example github_list_issues.
  path TEXT PRIMARY KEY NOT NULL,
  -- The whole policy record (contract 4) as JSON. Checked against the
  -- contract every time it is read; a row that does not match is an error.
  record TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
