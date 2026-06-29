import { collectSlashTokens } from "../../chat/slash-token";
import {
  columnExists,
  indexExists,
  tableExists,
} from "../sql-migrations";

type MigrationCtx = DurableObjectState;

function migrateBotApps(ctx: MigrationCtx): void {
  if (!tableExists(ctx, "bot_apps")) return;
  if (!columnExists(ctx, "bot_apps", "description")) {
    ctx.storage.sql.exec("ALTER TABLE bot_apps ADD COLUMN description TEXT");
  }
  if (!columnExists(ctx, "bot_apps", "visibility")) {
    ctx.storage.sql.exec(
      "ALTER TABLE bot_apps ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'",
    );
  }
}

function migrateBotTokens(ctx: MigrationCtx): void {
  if (!tableExists(ctx, "bot_tokens")) return;
  if (!columnExists(ctx, "bot_tokens", "name")) {
    ctx.storage.sql.exec(
      "ALTER TABLE bot_tokens ADD COLUMN name TEXT NOT NULL DEFAULT 'default'",
    );
  }
  if (!columnExists(ctx, "bot_tokens", "scopes_json")) {
    ctx.storage.sql.exec("ALTER TABLE bot_tokens ADD COLUMN scopes_json TEXT");
    if (columnExists(ctx, "bot_tokens", "scopes")) {
      ctx.storage.sql.exec("UPDATE bot_tokens SET scopes_json = scopes WHERE scopes_json IS NULL");
    }
    ctx.storage.sql.exec(
      "UPDATE bot_tokens SET scopes_json = '[]' WHERE scopes_json IS NULL OR scopes_json = ''",
    );
  }
  if (!columnExists(ctx, "bot_tokens", "expires_at")) {
    ctx.storage.sql.exec("ALTER TABLE bot_tokens ADD COLUMN expires_at TEXT");
  }
  if (!columnExists(ctx, "bot_tokens", "last_used_at")) {
    ctx.storage.sql.exec("ALTER TABLE bot_tokens ADD COLUMN last_used_at TEXT");
  }
  if (!indexExists(ctx, "idx_bot_tokens_bot")) {
    ctx.storage.sql.exec("CREATE INDEX idx_bot_tokens_bot ON bot_tokens(bot_id)");
  }
  if (!indexExists(ctx, "idx_bot_tokens_hash")) {
    ctx.storage.sql.exec(
      "CREATE UNIQUE INDEX idx_bot_tokens_hash ON bot_tokens(token_hash)",
    );
  }
}

function migrateBotCommands(ctx: MigrationCtx): void {
  if (!tableExists(ctx, "bot_commands")) return;
  if (!columnExists(ctx, "bot_commands", "execution_mode")) {
    ctx.storage.sql.exec(
      "ALTER TABLE bot_commands ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'stateless'",
    );
  }
  if (!columnExists(ctx, "bot_commands", "stateful_config_json")) {
    ctx.storage.sql.exec("ALTER TABLE bot_commands ADD COLUMN stateful_config_json TEXT");
  }
  if (!columnExists(ctx, "bot_commands", "status")) {
    ctx.storage.sql.exec(
      "ALTER TABLE bot_commands ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    );
    if (columnExists(ctx, "bot_commands", "enabled")) {
      ctx.storage.sql.exec(
        "UPDATE bot_commands SET status = CASE WHEN enabled = 1 THEN 'active' ELSE 'disabled' END",
      );
    }
  }
  if (indexExists(ctx, "idx_bot_commands_bot")) {
    ctx.storage.sql.exec("DROP INDEX idx_bot_commands_bot");
  }
  if (!indexExists(ctx, "idx_bot_commands_bot")) {
    ctx.storage.sql.exec(
      "CREATE INDEX idx_bot_commands_bot ON bot_commands(bot_id, status, name)",
    );
  }
}

function ensureBotCommandNamesTable(ctx: MigrationCtx): void {
  if (!tableExists(ctx, "bot_command_names")) {
    ctx.storage.sql.exec(`CREATE TABLE bot_command_names (
      slash_token TEXT PRIMARY KEY,
      bot_command_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }
}

function backfillBotCommandNames(ctx: MigrationCtx): void {
  if (!tableExists(ctx, "bot_commands")) return;
  ensureBotCommandNamesTable(ctx);

  const commands = ctx.storage.sql
    .exec(
      "SELECT bot_command_id, bot_id, name, created_at FROM bot_commands WHERE deleted_at IS NULL",
    )
    .toArray() as Array<{
      bot_command_id: string;
      bot_id: string;
      name: string;
      created_at: string;
    }>;

  for (const command of commands) {
    const aliasRows = ctx.storage.sql
      .exec(
        "SELECT alias FROM bot_command_aliases WHERE bot_command_id=? ORDER BY alias",
        command.bot_command_id,
      )
      .toArray() as Array<{ alias: string }>;
    const collected = collectSlashTokens(
      command.name,
      aliasRows.map((row) => row.alias),
    );
    if (!collected.ok) continue;

    for (const token of collected.all) {
      const kind = token === collected.canonical ? "canonical" : "alias";
      ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO bot_command_names (slash_token, bot_command_id, bot_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        token,
        command.bot_command_id,
        command.bot_id,
        kind,
        command.created_at,
      );
    }
  }
}

function dropBotEventCapabilities(ctx: MigrationCtx): void {
  if (tableExists(ctx, "bot_event_capabilities")) {
    ctx.storage.sql.exec("DROP TABLE bot_event_capabilities");
  }
}

function ensureBotIdempotencyKeys(ctx: MigrationCtx): void {
  if (!tableExists(ctx, "bot_idempotency_keys")) {
    ctx.storage.sql.exec(`CREATE TABLE bot_idempotency_keys (
      principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL,
      operation TEXT NOT NULL, operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, response_json TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      PRIMARY KEY (principal_kind, principal_id, operation, operation_id)
    )`);
  }
  if (!indexExists(ctx, "idx_bot_idem_expires")) {
    ctx.storage.sql.exec(
      "CREATE INDEX idx_bot_idem_expires ON bot_idempotency_keys(expires_at)",
    );
  }
}

/** True when this DO already has the slash-catalog schema (fresh baseline or reapplied). */
export function isSlashCatalogSchemaCurrent(ctx: MigrationCtx): boolean {
  return (
    tableExists(ctx, "bot_command_names") &&
    tableExists(ctx, "bot_commands") &&
    columnExists(ctx, "bot_commands", "execution_mode") &&
    columnExists(ctx, "bot_tokens", "scopes_json")
  );
}

/**
 * Upgrade a v3 Phase-7 BotRegistry schema to slash-catalog v4 without dropping live rows.
 * Fresh installs that already received the v4 baseline only need cleanup/backfill guards.
 */
export function migrateBotRegistryToSlashCatalogV4(ctx: MigrationCtx): void {
  migrateBotApps(ctx);
  migrateBotTokens(ctx);
  migrateBotCommands(ctx);
  ensureBotCommandNamesTable(ctx);
  backfillBotCommandNames(ctx);
  ensureBotIdempotencyKeys(ctx);
  dropBotEventCapabilities(ctx);
}
