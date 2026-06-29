ALTER TABLE IF EXISTS chat.messages
  ADD COLUMN IF NOT EXISTS invocation_json JSONB;
