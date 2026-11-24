-- The switch settings each signed-in caller last saw, per project (task 2.1.4,
-- FR-18). Used only to tell a caller when the settings changed between two of
-- their calls. Losing a row loses one notice and nothing else.
CREATE TABLE IF NOT EXISTS switches_seen (
  key TEXT PRIMARY KEY NOT NULL,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
