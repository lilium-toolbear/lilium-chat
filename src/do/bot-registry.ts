import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { handleSchemaVersionRequest } from "./sql-migrations";
import { migrateBotRegistrySchema } from "./migrations/bot-registry";
import { uuidv7 } from "../ids/uuidv7";
import { idempotencyExpiresAt } from "../contract/idempotency";
import {
  canonicalCommandDefinition,
  commandsRequestHash,
  sha256Hex,
  validateCommand,
  type CommandInput,
  type ValidatedCommand,
} from "../chat/command-options";
import { collectSlashTokens } from "../chat/slash-token";
import { hashBotToken } from "../auth/bot";
import { archiveOutboxDueTable, flushArchiveOutboxToQueue } from "../archive/queue-flush";
import { appendArchiveRecordSync } from "../archive/source-outbox";
import { archiveReplaceScope, archiveUpsert, rowVersionFromSeq } from "../archive/changes";
import { sourceKeyForBotRegistry } from "../archive/source-key";
import type { ArchiveChange } from "../archive/payload";
import { scheduleNextAlarm } from "./scheduler";

// BotRegistry is a SINGLETON DO (getByName("registry")). token plaintext ->
// hash cannot reverse-resolve bot_id, and the bot API entry point only has a
// bearer token, so token verification must happen in one place doing
// SELECT ... WHERE token_hash=? (idx_bot_tokens_hash UNIQUE). It also owns the
// GLOBAL bot command catalog (bot_commands + bot_command_aliases + bot_command_names)
// and bot profile (bot_apps).

function appendBotRegistryArchive(
  ctx: DurableObjectState,
  occurredAt: string,
  buildChanges: (sourceSeq: number) => ArchiveChange[],
): void {
  appendArchiveRecordSync(ctx, {
    sourceKind: "bot_registry",
    sourceKey: sourceKeyForBotRegistry(),
    occurredAt,
    businessEventIds: [],
    buildChanges,
  });
}

function readBotCommandArchiveRow(
  ctx: DurableObjectState,
  botCommandId: string,
): Record<string, unknown> | undefined {
  const row = ctx.storage.sql
    .exec(
      `SELECT bot_command_id, bot_id, name, description, options_json, default_member_permission,
              execution_mode, stateful_config_json, status, schema_version, definition_hash, created_at, updated_at, deleted_at
       FROM bot_commands WHERE bot_command_id=?`,
      botCommandId,
    )
    .toArray()[0] as
    | {
        bot_command_id: string;
        bot_id: string;
        name: string;
        description: string | null;
        options_json: string;
        default_member_permission: string;
        execution_mode: string;
        stateful_config_json: string | null;
        status: string;
        schema_version: number;
        definition_hash: string;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    bot_command_id: row.bot_command_id,
    bot_id: row.bot_id,
    name: row.name,
    description: row.description,
    options_json: row.options_json,
    default_member_permission: row.default_member_permission,
    execution_mode: row.execution_mode,
    stateful_config_json: row.stateful_config_json,
    status: row.status,
    schema_version: row.schema_version,
    definition_hash: row.definition_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function readBotCommandAliasRows(ctx: DurableObjectState, botCommandId: string): Array<Record<string, unknown>> {
  return (
    ctx.storage.sql
      .exec(
        "SELECT bot_command_id, bot_id, alias, created_at FROM bot_command_aliases WHERE bot_command_id=? ORDER BY alias",
        botCommandId,
      )
      .toArray() as Array<{ bot_command_id: string; bot_id: string; alias: string; created_at: string }>
  ).map((row) => ({
    bot_command_id: row.bot_command_id,
    bot_id: row.bot_id,
    alias: row.alias,
    created_at: row.created_at,
  }));
}

function buildBotCommandsSyncArchiveChanges(
  ctx: DurableObjectState,
  botCommandIds: string[],
  sourceSeq: number,
): ArchiveChange[] {
  const rowVersion = rowVersionFromSeq(sourceSeq);
  const changes: ArchiveChange[] = [];
  for (const botCommandId of botCommandIds) {
    const commandAfter = readBotCommandArchiveRow(ctx, botCommandId);
    if (commandAfter) {
      changes.push(
        archiveUpsert("chat_bot_commands", { bot_command_id: botCommandId }, rowVersion, commandAfter),
      );
    }
    changes.push(
      archiveReplaceScope(
        "chat_bot_command_aliases",
        { bot_command_id: botCommandId },
        rowVersion,
        readBotCommandAliasRows(ctx, botCommandId),
      ),
    );
  }
  return changes;
}

function readBotAppArchiveRow(ctx: DurableObjectState, botId: string): Record<string, unknown> | undefined {
  const row = ctx.storage.sql
    .exec(
      "SELECT bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at FROM bot_apps WHERE bot_id=?",
      botId,
    )
    .toArray()[0] as
    | {
        bot_id: string;
        owner_user_id: string;
        display_name: string;
        avatar_url: string | null;
        description: string | null;
        visibility: string;
        status: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    bot_id: row.bot_id,
    owner_user_id: row.owner_user_id,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class BotRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateBotRegistrySchema(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    const schemaVersion = handleSchemaVersionRequest(this.ctx, "BotRegistry", request);
    if (schemaVersion) return schemaVersion;

    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true });

    if (url.pathname === "/internal/token-verify") {
      return this.handleTokenVerify(request);
    }
    if (url.pathname === "/internal/bot-get") {
      return this.handleBotGet(url);
    }
    if (url.pathname === "/internal/commands-sync") {
      return this.handleCommandsSync(request);
    }
    if (url.pathname === "/internal/bot-commands") {
      return this.handleBotCommands(url);
    }
    if (url.pathname === "/internal/command-get") {
      return this.handleCommandGet(url);
    }
    if (url.pathname === "/internal/seed-official-bot") {
      return this.handleSeedOfficialBot(request);
    }

    return new Response("not found", { status: 404 });
  }

  /** Resolve a token hash to {bot_id, scopes}. 401 if unknown/revoked/inactive. */
  private async handleTokenVerify(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { token_hash?: unknown };
    if (typeof body?.token_hash !== "string" || body.token_hash.length === 0) {
      return Response.json({ error: { code: "UNAUTHORIZED", message: "missing token_hash" } }, { status: 401 });
    }
    const row = this.ctx.storage.sql
      .exec(
        `SELECT t.bot_id AS bot_id, t.scopes_json AS scopes_json, t.revoked_at AS revoked_at,
                t.expires_at AS expires_at, a.status AS status
         FROM bot_tokens t JOIN bot_apps a USING(bot_id)
         WHERE t.token_hash = ?`,
        body.token_hash,
      )
      .toArray()[0] as
      | {
          bot_id: string;
          scopes_json: string;
          revoked_at: string | null;
          expires_at: string | null;
          status: string;
        }
      | undefined;
    if (
      !row ||
      row.revoked_at !== null ||
      row.status !== "active" ||
      (row.expires_at !== null && row.expires_at <= new Date().toISOString())
    ) {
      return Response.json({ error: { code: "UNAUTHORIZED", message: "invalid bot token" } }, { status: 401 });
    }
    let scopes: string[];
    try {
      const parsed = JSON.parse(row.scopes_json);
      scopes = Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
    } catch {
      scopes = [];
    }
    return Response.json({ bot_id: row.bot_id, scopes });
  }

  /** Return bot profile (no callback_secret/callback_url — HTTP callback is future transport). */
  private async handleBotGet(url: URL): Promise<Response> {
    const botId = url.searchParams.get("bot_id");
    if (!botId) return Response.json({ error: { code: "BOT_NOT_FOUND", message: "bot_id required" } }, { status: 404 });
    const row = this.ctx.storage.sql
      .exec(
        `SELECT bot_id, display_name, avatar_url, status
         FROM bot_apps WHERE bot_id = ?`,
        botId,
      )
      .toArray()[0] as { bot_id: string; display_name: string; avatar_url: string | null; status: string } | undefined;
    if (!row) {
      return Response.json({ error: { code: "BOT_NOT_FOUND", message: "bot not found" } }, { status: 404 });
    }
    return Response.json({
      bot_id: row.bot_id,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      status: row.status,
    });
  }

  async scheduleArchiveAlarm(): Promise<void> {
    await scheduleNextAlarm(this.ctx, [archiveOutboxDueTable()], { respectExistingAlarm: true });
  }

  async alarm(): Promise<void> {
    const now = new Date().toISOString();
    try {
      await flushArchiveOutboxToQueue(this.ctx, this.env.CHAT_ARCHIVE_QUEUE, { now });
    } catch {
      // Archive flush failure is retried via next alarm.
    }
    await scheduleNextAlarm(this.ctx, [archiveOutboxDueTable()], { respectExistingAlarm: true });
  }

  /**
   * PUT /bot/commands catalog sync. Upserts bot_commands (reuses bot_command_id
   * for the same bot_id+name, else mints a UUIDv7), full-replaces per-command
   * aliases and global slash namespace entries in bot_command_names.
   * definition_hash detects semantic drift; schema_version increments only when
   * the hash changes. Idempotent via bot_idempotency_keys
   * (operation=bot.commands.sync).
   */
  private async handleCommandsSync(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      bot_id?: unknown;
      idempotency_key?: unknown;
      commands?: unknown;
    };
    if (
      typeof body?.bot_id !== "string" ||
      typeof body?.idempotency_key !== "string" ||
      body.idempotency_key.length === 0
    ) {
      return Response.json(
        { error: { code: "INVALID_COMMAND_OPTIONS", message: "bot_id and idempotency_key required" } },
        { status: 422 },
      );
    }
    const botId = body.bot_id;
    if (!Array.isArray(body.commands)) {
      return Response.json(
        { error: { code: "INVALID_COMMAND_OPTIONS", message: "commands must be an array" } },
        { status: 422 },
      );
    }

    const validatedCommands: ValidatedCommand[] = [];
    const slashTokens = new Set<string>();
    const slashPlans: Array<{
      command: ValidatedCommand;
      canonical: string;
      aliases: string[];
      all: string[];
    }> = [];
    for (const c of body.commands) {
      const r = validateCommand(c as CommandInput);
      if (!r.ok || !r.value) {
        return Response.json(
          { error: { code: "INVALID_COMMAND_OPTIONS", message: r.error ?? "invalid command" } },
          { status: 422 },
        );
      }
      const collected = collectSlashTokens(r.value.name, r.value.aliases);
      if (!collected.ok) {
        return Response.json(
          {
            error: {
              code: "INVALID_COMMAND_OPTIONS",
              message: `invalid slash token: ${collected.error}`,
            },
          },
          { status: 422 },
        );
      }
      for (const token of collected.all) {
        if (slashTokens.has(token)) {
          return Response.json(
            { error: { code: "INVALID_COMMAND_OPTIONS", message: `duplicate slash token: ${token}` } },
            { status: 422 },
          );
        }
        slashTokens.add(token);
      }
      const validated = {
        ...r.value,
        name: collected.canonical,
        aliases: collected.aliases,
      };
      validatedCommands.push(validated);
      slashPlans.push({
        command: validated,
        canonical: collected.canonical,
        aliases: collected.aliases,
        all: collected.all,
      });
    }

    const requestHash = await commandsRequestHash({
      commands: validatedCommands,
    });
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const idemExpiresAt = idempotencyExpiresAt(nowMs);
    const operation = "bot.commands.sync";
    const operationId = body.idempotency_key;

    // Cheap pre-check: same operation_id + same request_hash already completed.
    const cached = this.ctx.storage.sql
      .exec(
        "SELECT response_json FROM bot_idempotency_keys WHERE principal_kind='bot' AND principal_id=? AND operation=? AND operation_id=? AND request_hash=? AND response_json IS NOT NULL AND response_json != ''",
        botId,
        operation,
        operationId,
        requestHash,
      )
      .toArray()[0] as { response_json: string } | undefined;
    if (cached) return Response.json(JSON.parse(cached.response_json));

    // Conflict: same operation_id reused with a different body.
    const existing = this.ctx.storage.sql
      .exec(
        "SELECT request_hash FROM bot_idempotency_keys WHERE principal_kind='bot' AND principal_id=? AND operation=? AND operation_id=?",
        botId,
        operation,
        operationId,
      )
      .toArray()[0] as { request_hash: string } | undefined;
    if (existing && existing.request_hash !== requestHash) {
      return Response.json(
        { error: { code: "IDEMPOTENCY_CONFLICT", message: "operation_id reused with different body", retryable: false } },
        { status: 409 },
      );
    }

    // Precompute definition hashes (crypto.subtle is async; cannot run in transactionSync).
    const commandPlans: Array<{
      cmd: ValidatedCommand;
      canonical: string;
      aliases: string[];
      allTokens: string[];
      defHash: string;
    }> = [];
    for (const plan of slashPlans) {
      commandPlans.push({
        cmd: plan.command,
        canonical: plan.canonical,
        aliases: plan.aliases,
        allTokens: plan.all,
        defHash: await sha256Hex(canonicalCommandDefinition(plan.command)),
      });
    }

    const response = this.ctx.storage.transactionSync(() => {
      const outCommands: Array<{
        bot_command_id: string;
        name: string;
        aliases: string[];
        status: string;
        execution_mode: "stateless" | "stateful";
        stateful_config: unknown | null;
        definition_hash: string;
        schema_version: number;
        updated_at: string;
      }> = [];

      for (const { cmd, canonical, aliases, allTokens, defHash } of commandPlans) {
        const row = this.ctx.storage.sql
          .exec(
            "SELECT bot_command_id, schema_version, definition_hash FROM bot_commands WHERE bot_id=? AND name=?",
            botId,
            canonical,
          )
          .toArray()[0] as
          | { bot_command_id: string; schema_version: number; definition_hash: string }
          | undefined;
        let botCommandId: string;
        let schemaVersion: number;
        if (row) {
          botCommandId = row.bot_command_id;
          schemaVersion = row.definition_hash === defHash ? row.schema_version : row.schema_version + 1;
          this.ctx.storage.sql.exec(
            `UPDATE bot_commands
             SET description=?, options_json=?, default_member_permission=?,
                 execution_mode=?, stateful_config_json=?, definition_hash=?,
                 schema_version=?, status='active', deleted_at=NULL, updated_at=?
             WHERE bot_command_id=?`,
            cmd.description,
            JSON.stringify(cmd.options),
            cmd.default_member_permission,
            cmd.execution_mode,
            cmd.stateful_config ? JSON.stringify(cmd.stateful_config) : null,
            defHash,
            schemaVersion,
            nowIso,
            botCommandId,
          );
        } else {
          botCommandId = uuidv7(nowMs);
          schemaVersion = 1;
          this.ctx.storage.sql.exec(
            `INSERT INTO bot_commands (
               bot_command_id, bot_id, name, description, options_json,
               default_member_permission, execution_mode, stateful_config_json, schema_version,
               definition_hash, status, created_at, updated_at, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
            botCommandId,
            botId,
            canonical,
            cmd.description,
            JSON.stringify(cmd.options),
            cmd.default_member_permission,
            cmd.execution_mode,
            cmd.stateful_config ? JSON.stringify(cmd.stateful_config) : null,
            schemaVersion,
            defHash,
            nowIso,
            nowIso,
          );
        }

        for (const slashToken of allTokens) {
          const existingName = this.ctx.storage.sql
            .exec(
              "SELECT bot_command_id, bot_id FROM bot_command_names WHERE slash_token=?",
              slashToken,
            )
            .toArray()[0] as { bot_command_id: string; bot_id: string } | undefined;
          if (existingName && existingName.bot_command_id !== botCommandId) {
            return {
              kind: "error" as const,
              code: "COMMAND_NAME_CONFLICT",
              message: `slash token already in use: ${slashToken}`,
              conflict: {
                slash_token: slashToken,
                bot_command_id: existingName.bot_command_id,
                bot_id: existingName.bot_id,
              },
            };
          }
        }

        // full-replace aliases for this command
        this.ctx.storage.sql.exec(
          "DELETE FROM bot_command_aliases WHERE bot_command_id=?",
          botCommandId,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM bot_command_names WHERE bot_command_id=?",
          botCommandId,
        );
        for (const alias of aliases) {
          this.ctx.storage.sql.exec(
            "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
            botCommandId,
            botId,
            alias,
            nowIso,
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO bot_command_names (slash_token, bot_command_id, bot_id, kind, created_at) VALUES (?, ?, ?, 'alias', ?)",
            alias,
            botCommandId,
            botId,
            nowIso,
          );
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO bot_command_names (slash_token, bot_command_id, bot_id, kind, created_at) VALUES (?, ?, ?, 'canonical', ?)",
          canonical,
          botCommandId,
          botId,
          nowIso,
        );

        outCommands.push({
          bot_command_id: botCommandId,
          name: canonical,
          aliases,
          status: "active",
          execution_mode: cmd.execution_mode,
          stateful_config: cmd.stateful_config,
          definition_hash: defHash,
          schema_version: schemaVersion,
          updated_at: nowIso,
        });
      }

      const responseBody = { commands: outCommands };
      if (outCommands.some((c) => c.status !== "active")) {
        // unreachable sentinel to keep exhaustive return shape explicit.
        return {
          kind: "error" as const,
          code: "INVALID_COMMAND_OPTIONS",
          message: "invalid command status",
        };
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO bot_idempotency_keys (principal_kind, principal_id, operation, operation_id, request_hash, response_json, status, created_at, expires_at) VALUES ('bot', ?, ?, ?, ?, ?, 'completed', ?, ?)",
        botId,
        operation,
        operationId,
        requestHash,
        JSON.stringify(responseBody),
        nowIso,
        idemExpiresAt,
      );
      appendBotRegistryArchive(this.ctx, nowIso, (sourceSeq) =>
        buildBotCommandsSyncArchiveChanges(
          this.ctx,
          outCommands.map((command) => command.bot_command_id),
          sourceSeq,
        ),
      );
      return { kind: "ok" as const, body: responseBody };
    });

    if (response.kind === "error") {
      return Response.json(
        { error: { code: response.code, message: response.message, conflict: response.conflict } },
        { status: response.code === "COMMAND_NAME_CONFLICT" ? 409 : 422 },
      );
    }

    await this.scheduleArchiveAlarm();
    return Response.json(response.body);
  }

  /**
   * Return the bot's full enabled command catalog + aliases + event
   * capabilities + profile. Used by ChatChannel /internal/bot-install to
   * build channel_command_bindings + channel_command_names +
   * channel_bot_event_subscriptions snapshots.
   */
  private async handleBotCommands(url: URL): Promise<Response> {
    const botId = url.searchParams.get("bot_id");
    if (!botId) {
      return Response.json({ error: { code: "BOT_NOT_FOUND", message: "bot_id required" } }, { status: 404 });
    }
    const bot = this.ctx.storage.sql
      .exec("SELECT bot_id, display_name, avatar_url, status FROM bot_apps WHERE bot_id=?", botId)
      .toArray()[0] as { bot_id: string; display_name: string; avatar_url: string | null; status: string } | undefined;
    if (!bot) {
      return Response.json({ error: { code: "BOT_NOT_FOUND", message: "bot not found" } }, { status: 404 });
    }
    const commandRows = this.ctx.storage.sql
      .exec(
        "SELECT bot_command_id, name, description, options_json, default_member_permission, execution_mode, stateful_config_json, schema_version, definition_hash, status FROM bot_commands WHERE bot_id=? AND status='active' AND deleted_at IS NULL",
        botId,
      )
      .toArray() as Array<{
        bot_command_id: string;
        name: string;
        description: string | null;
        options_json: string;
        default_member_permission: string;
        execution_mode: "stateless" | "stateful";
        stateful_config_json: string | null;
        schema_version: number;
        definition_hash: string;
        status: string;
      }>;
    const aliasRows = this.ctx.storage.sql
      .exec("SELECT bot_command_id, alias FROM bot_command_aliases WHERE bot_id=?", botId)
      .toArray() as Array<{ bot_command_id: string; alias: string }>;
    const aliasesByCommand = new Map<string, string[]>();
    for (const a of aliasRows) {
      const list = aliasesByCommand.get(a.bot_command_id) ?? [];
      list.push(a.alias);
      aliasesByCommand.set(a.bot_command_id, list);
    }
    return Response.json({
      bot: { bot_id: bot.bot_id, display_name: bot.display_name, avatar_url: bot.avatar_url, status: bot.status },
      commands: commandRows.map((c) => ({
        bot_command_id: c.bot_command_id,
        name: c.name,
        description: c.description,
        options: JSON.parse(c.options_json),
        default_member_permission: c.default_member_permission,
        execution: {
          mode: c.execution_mode,
          ...(c.execution_mode === "stateful" && c.stateful_config_json
            ? { stateful: JSON.parse(c.stateful_config_json) }
            : {}),
        },
        status: c.status,
        schema_version: c.schema_version,
        definition_hash: c.definition_hash,
        aliases: aliasesByCommand.get(c.bot_command_id) ?? [],
      })),
      event_capabilities: [],
    });
  }

  /**
   * Return the current definition of a single command + its aliases. Used by
   * ChatChannel /internal/command-invoke correctness check (current catalog,
   * not the binding snapshot): disabled/deleted -> BOT_COMMAND_DISABLED,
   * drift -> refresh binding snapshot.
   */
  private async handleCommandGet(url: URL): Promise<Response> {
    const botId = url.searchParams.get("bot_id");
    const botCommandId = url.searchParams.get("bot_command_id");
    if (!botId || !botCommandId) {
      return Response.json({ error: { code: "BOT_COMMAND_DISABLED", message: "bot_id and bot_command_id required" } }, { status: 404 });
    }
    const row = this.ctx.storage.sql
      .exec(
        "SELECT bot_command_id, name, description, options_json, default_member_permission, execution_mode, stateful_config_json, schema_version, definition_hash, status, deleted_at FROM bot_commands WHERE bot_id=? AND bot_command_id=?",
        botId,
        botCommandId,
      )
      .toArray()[0] as
      | {
          bot_command_id: string;
          name: string;
          description: string | null;
          options_json: string;
          default_member_permission: string;
          execution_mode: "stateless" | "stateful";
          stateful_config_json: string | null;
          schema_version: number;
          definition_hash: string;
          status: string;
          deleted_at: string | null;
        }
      | undefined;
    if (!row || row.deleted_at !== null || row.status !== "active") {
      return Response.json({ error: { code: "BOT_COMMAND_DISABLED", message: "command disabled or deleted" } }, { status: 404 });
    }
    const aliasRows = this.ctx.storage.sql
      .exec("SELECT alias FROM bot_command_aliases WHERE bot_command_id=?", botCommandId)
      .toArray() as Array<{ alias: string }>;
    return Response.json({
      bot_command_id: row.bot_command_id,
      name: row.name,
      description: row.description,
      options: JSON.parse(row.options_json),
      default_member_permission: row.default_member_permission,
      execution: {
        mode: row.execution_mode,
        ...(row.execution_mode === "stateful" && row.stateful_config_json
          ? { stateful: JSON.parse(row.stateful_config_json) }
          : {}),
      },
      schema_version: row.schema_version,
      definition_hash: row.definition_hash,
      aliases: aliasRows.map((a) => a.alias),
    });
  }

  /**
   * Internal system seed for the official bot profile + command catalog + event
   * capabilities. Idempotent: repeated calls reuse the same bot_id and
   * re-issue token only when no active token exists.
   */
  private async handleSeedOfficialBot(request: Request): Promise<Response> {
    if (request.method !== "POST" && request.method !== "PUT") {
      return Response.json({ error: { code: "INVALID_MESSAGE", message: "seed-official-bot must be POST or PUT" } }, { status: 422 });
    }

    const OFFICIAL_BOT_ID = "00000000-0000-7000-8000-000000000601";
    const now = new Date().toISOString();

    const seedCommands: Array<{
      name: string;
      description: string;
      options: unknown;
      aliases: string[];
      default_member_permission: "member" | "admin" | "owner";
      execution: { mode: "stateless" };
    }> = [
      {
        name: "ask",
        description: "Ask a question",
        options: [
          { name: "prompt", type: "string", required: true, description: "Question text" },
        ],
        aliases: ["ai"],
        default_member_permission: "member",
        execution: { mode: "stateless" },
      },
      {
        name: "summarize",
        description: "Summarize recent messages",
        options: [
          { name: "scope", type: "string", required: false, description: "Scope of summary" },
        ],
        aliases: ["sum", "tl_dr"],
        default_member_permission: "member",
        execution: { mode: "stateless" },
      },
    ];

    const commandPlan = await Promise.all(seedCommands.map(async (command) => ({
      command,
      defHash: await sha256Hex(canonicalCommandDefinition(command as unknown as ValidatedCommand)),
    })));

    const existingToken = this.ctx.storage.sql
      .exec("SELECT token_hash, revoked_at FROM bot_tokens WHERE bot_id=? AND revoked_at IS NULL LIMIT 1", OFFICIAL_BOT_ID)
      .toArray()[0] as { token_hash: string; revoked_at: string | null } | undefined;

    let issuedToken: string | null = null;
    let newTokenId: string | null = null;
    let newTokenHash: string | null = null;
    if (!existingToken) {
      issuedToken = `lcbot_${crypto.randomUUID()}_${crypto.randomUUID()}`;
      newTokenId = uuidv7(Date.now());
      newTokenHash = await hashBotToken(issuedToken);
    }

    const seedResult = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, description, visibility, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           display_name=excluded.display_name,
           avatar_url=excluded.avatar_url,
           description=excluded.description,
           visibility=excluded.visibility,
           status='active',
           updated_at=excluded.updated_at`,
        OFFICIAL_BOT_ID,
        "system",
        "Lilium Bot",
        null,
        "Official Lilium bot",
        "official",
        now,
        now,
      );

      if (newTokenId && newTokenHash) {
        this.ctx.storage.sql.exec(
          `INSERT INTO bot_tokens (token_id, bot_id, name, token_hash, scopes_json, created_at, expires_at, last_used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
          newTokenId,
          OFFICIAL_BOT_ID,
          "default",
          newTokenHash,
          JSON.stringify(["chat:commands:manage", "chat:runtime:connect", "chat:messages:write"]),
          now,
        );
      }

      const responseCommands: Array<{
        bot_command_id: string;
        name: string;
        aliases: string[];
        status: string;
        execution_mode: "stateless" | "stateful";
        stateful_config: unknown | null;
        definition_hash: string;
        schema_version: number;
        updated_at: string;
      }> = [];

      for (const plan of commandPlan) {
        const command = plan.command;
        const existing = this.ctx.storage.sql
          .exec(
            "SELECT bot_command_id, schema_version, definition_hash FROM bot_commands WHERE bot_id=? AND name=?",
            OFFICIAL_BOT_ID,
            command.name,
          )
          .toArray()[0] as
          | { bot_command_id: string; schema_version: number; definition_hash: string }
          | undefined;

        let botCommandId: string;
        let schemaVersion: number;

        if (existing) {
          botCommandId = existing.bot_command_id;
          schemaVersion = existing.definition_hash === plan.defHash ? existing.schema_version : existing.schema_version + 1;
          this.ctx.storage.sql.exec(
            `UPDATE bot_commands
             SET description=?, options_json=?, default_member_permission=?, execution_mode=?, stateful_config_json=?,
                 schema_version=?, definition_hash=?, status='active', deleted_at=NULL, updated_at=?
             WHERE bot_command_id=?`,
            command.description,
            JSON.stringify(command.options),
            command.default_member_permission,
            command.execution.mode,
            null,
            schemaVersion,
            plan.defHash,
            now,
            botCommandId,
          );
        } else {
          botCommandId = uuidv7(Date.now());
          schemaVersion = 1;
          this.ctx.storage.sql.exec(
            `INSERT INTO bot_commands (
               bot_command_id, bot_id, name, description, options_json, default_member_permission,
               execution_mode, stateful_config_json, schema_version, definition_hash, status, created_at, updated_at, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'active', ?, ?, NULL)`,
            botCommandId,
            OFFICIAL_BOT_ID,
            command.name,
            command.description,
            JSON.stringify(command.options),
            command.default_member_permission,
            command.execution.mode,
            schemaVersion,
            plan.defHash,
            now,
            now,
          );
        }

        this.ctx.storage.sql.exec("DELETE FROM bot_command_aliases WHERE bot_command_id=?", botCommandId);
        for (const alias of command.aliases) {
          this.ctx.storage.sql.exec(
            "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
            botCommandId,
            OFFICIAL_BOT_ID,
            alias,
            now,
          );
        }

        responseCommands.push({
          bot_command_id: botCommandId,
          name: command.name,
          aliases: command.aliases,
          status: "active",
          execution_mode: command.execution.mode,
          stateful_config: null,
          definition_hash: plan.defHash,
          schema_version: schemaVersion,
          updated_at: now,
        });
      }

      appendBotRegistryArchive(this.ctx, now, (sourceSeq) => {
        const rowVersion = rowVersionFromSeq(sourceSeq);
        const changes: ArchiveChange[] = [];
        const botApp = readBotAppArchiveRow(this.ctx, OFFICIAL_BOT_ID);
        if (botApp) {
          changes.push(archiveUpsert("chat_bot_apps", { bot_id: OFFICIAL_BOT_ID }, rowVersion, botApp));
        }
        if (newTokenId && newTokenHash) {
          changes.push(
            archiveUpsert(
              "chat_bot_tokens",
              { token_id: newTokenId },
              rowVersion,
              {
                token_id: newTokenId,
                bot_id: OFFICIAL_BOT_ID,
                token_hash: newTokenHash,
                scopes: JSON.stringify(["chat:commands:manage", "chat:runtime:connect", "chat:messages:write"]),
                created_at: now,
                revoked_at: null,
              },
            ),
          );
        }
        changes.push(
          ...buildBotCommandsSyncArchiveChanges(
            this.ctx,
            responseCommands.map((command) => command.bot_command_id),
            sourceSeq,
          ),
        );
        return changes;
      });

      return { responseCommands };
    });

    await this.scheduleArchiveAlarm();

    return Response.json({
      bot: {
        bot_id: OFFICIAL_BOT_ID,
        display_name: "Lilium Bot",
        avatar_url: null,
      },
      token: issuedToken,
      commands: seedResult.responseCommands,
    });
  }
}
