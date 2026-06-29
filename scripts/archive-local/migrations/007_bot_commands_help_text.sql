-- BotRegistry bot_commands.help_text (DO migration v5, PR #8 platform help).

ALTER TABLE chat.bot_commands ADD COLUMN IF NOT EXISTS help_text TEXT NOT NULL DEFAULT '';
