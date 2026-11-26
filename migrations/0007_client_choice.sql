-- What a project's client has asked for (the client notice, "Your choices").
-- Both columns are empty until a choice is recorded.

-- 'off' when the client has asked that AI tools are not used on their work.
-- Empty means no such request. Any other value is refused when read.
ALTER TABLE projects ADD COLUMN client_ai_use TEXT;

-- The highest data class the client lets AI tools handle, when they set one.
-- A run gets the lowest of this, the project's own class and the provider's ceiling.
ALTER TABLE projects ADD COLUMN client_limit TEXT;
