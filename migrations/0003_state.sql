-- State that must outlive one Worker instance and be shared by all of them
-- (tasks 1.3.8, 1.3.7, 1.6.3, 1.6.6): quota counters, concurrent-run slots,
-- the owner's switches, the escalation queue and project records.

-- One row per counter per window, for example "runs:acme@60000:29999999".
CREATE TABLE IF NOT EXISTS quota_counters (
  id TEXT PRIMARY KEY NOT NULL,
  total INTEGER NOT NULL,
  -- When the window ends, in milliseconds. Rows past it can be swept.
  expires_at INTEGER NOT NULL
);

-- One row per run that holds a concurrent-run slot.
CREATE TABLE IF NOT EXISTS quota_slots (
  key TEXT NOT NULL,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key, holder)
);

-- The owner's switches. One row at most. No row means everything is off.
CREATE TABLE IF NOT EXISTS control_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  -- The whole control state as JSON.
  state TEXT NOT NULL
);

-- The escalation queue. The item is JSON; status and time are columns so the
-- open items can be listed without reading every row.
CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  item TEXT NOT NULL
);

-- The data class of each project. A project with no row is public.
CREATE TABLE IF NOT EXISTS projects (
  project TEXT PRIMARY KEY NOT NULL,
  data_class TEXT NOT NULL
);
