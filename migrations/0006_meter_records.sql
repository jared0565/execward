-- One row per metered run, for the stats report (task 2.3.1, FR-20). Sizes,
-- counts and labels only: never a script, a result or any other content.
-- Rows older than 90 days are removed by the daily round. Losing a row loses
-- one line of a report and nothing else; the table is not backed up.
CREATE TABLE IF NOT EXISTS meter_records (
  run_id TEXT PRIMARY KEY NOT NULL,
  at INTEGER NOT NULL,
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  client TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  estimated_saving INTEGER NOT NULL,
  verified INTEGER NOT NULL,
  verification_tokens INTEGER NOT NULL
);
