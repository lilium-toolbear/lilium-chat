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
  validateEventCapability,
  type CommandInput,
  type EventCapabilityInput,
  type ValidatedCommand,
  type ValidatedEventCapability,
} from "../chat/command-options";
import { hashBotToken } from "../auth/bot";

// BotRegistry is a SINGLETON DO (getByName("registry")). token plaintext ->
// hash cannot reverse-resolve bot_id, and the bot API entry point only has a
// bearer token, so token verification must happen in one place doing
// SELECT ... WHERE token_hash=? (idx_bot_tokens_hash UNIQUE). It also owns the
// GLOBAL bot command catalog (bot_commands + bot_command_aliases),
// bot_event_capabilities, and bot profile (bot_apps).
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
        `SELECT t.bot_id AS bot_id, t.scopes AS scopes, t.revoked_at AS revoked_at, a.status AS status
         FROM bot_tokens t JOIN bot_apps a USING(bot_id)
         WHERE t.token_hash = ?`,
        body.token_hash,
      )
      .toArray()[0] as { bot_id: string; scopes: string; revoked_at: string | null; status: string } | undefined;
    if (!row || row.revoked_at !== null || row.status !== "active") {
      return Response.json({ error: { code: "UNAUTHORIZED", message: "invalid bot token" } }, { status: 401 });
    }
    let scopes: string[];
    try {
      const parsed = JSON.parse(row.scopes);
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

  async alarm(): Promise<void> {
    // Phase 7a: no due jobs yet (delivery outbox lives in ChatChannel + BotConnection).
  }

  /**
   * PUT /bot/commands catalog sync. Upserts bot_commands (reuses bot_command_id
   * for the same bot_id+name, else mints a UUIDv7), full-replaces per-command
   * aliases, upserts bot_event_capabilities. definition_hash detects semantic
   * drift; schema_version increments only when the hash changes. Idempotent via
   * bot_idempotency_keys (operation=bot.commands.sync). This only writes the
   * global catalog — it does NOT enable commands in any channel (that is the
   * channel binding layer in ChatChannel).
   */
  private async handleCommandsSync(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      bot_id?: unknown;
      idempotency_key?: unknown;
      commands?: unknown;
      event_capabilities?: unknown;
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
    for (const c of body.commands) {
      const r = validateCommand(c as CommandInput);
      if (!r.ok || !r.value) {
        return Response.json(
          { error: { code: "INVALID_COMMAND_OPTIONS", message: r.error ?? "invalid command" } },
          { status: 422 },
        );
      }
      for (const token of [r.value.name, ...r.value.aliases]) {
        if (slashTokens.has(token)) {
          return Response.json(
            { error: { code: "INVALID_COMMAND_OPTIONS", message: `duplicate slash token: ${token}` } },
            { status: 422 },
          );
        }
        slashTokens.add(token);
      }
      validatedCommands.push(r.value);
    }

    const capsRaw = body.event_capabilities ?? [];
    if (!Array.isArray(capsRaw)) {
      return Response.json(
        { error: { code: "INVALID_COMMAND_OPTIONS", message: "event_capabilities must be an array" } },
        { status: 422 },
      );
    }
    const validatedCaps: ValidatedEventCapability[] = [];
    const capTypes = new Set<string>();
    for (const cap of capsRaw) {
      const r = validateEventCapability(cap as EventCapabilityInput);
      if (!r.ok || !r.value) {
        return Response.json(
          { error: { code: "INVALID_COMMAND_OPTIONS", message: r.error ?? "invalid event_capability" } },
          { status: 422 },
        );
      }
      if (capTypes.has(r.value.event_type)) {
        return Response.json(
          { error: { code: "INVALID_COMMAND_OPTIONS", message: `duplicate event_capability: ${r.value.event_type}` } },
          { status: 422 },
        );
      }
      capTypes.add(r.value.event_type);
      validatedCaps.push(r.value);
    }

    const requestHash = await commandsRequestHash({
      commands: validatedCommands,
      event_capabilities: validatedCaps,
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
    const commandPlans: Array<{ cmd: ValidatedCommand; defHash: string }> = [];
    for (const cmd of validatedCommands) {
      commandPlans.push({ cmd, defHash: await sha256Hex(canonicalCommandDefinition(cmd)) });
    }

    const response = this.ctx.storage.transactionSync(() => {
      const outCommands: Array<{
        bot_command_id: string;
        name: string;
        aliases: string[];
        enabled: boolean;
        default_enabled_on_install: boolean;
        updated_at: string;
      }> = [];

      for (const { cmd, defHash } of commandPlans) {
        const row = this.ctx.storage.sql
          .exec(
            "SELECT bot_command_id, schema_version, definition_hash FROM bot_commands WHERE bot_id=? AND name=?",
            botId,
            cmd.name,
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
                 default_enabled_on_install=?, definition_hash=?, schema_version=?,
                 enabled=1, deleted_at=NULL, updated_at=?
             WHERE bot_command_id=?`,
            cmd.description,
            JSON.stringify(cmd.options),
            cmd.default_member_permission,
            cmd.default_enabled_on_install ? 1 : 0,
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
               default_member_permission, default_enabled_on_install, schema_version,
               definition_hash, enabled, created_at, updated_at, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
            botCommandId,
            botId,
            cmd.name,
            cmd.description,
            JSON.stringify(cmd.options),
            cmd.default_member_permission,
            cmd.default_enabled_on_install ? 1 : 0,
            schemaVersion,
            defHash,
            nowIso,
            nowIso,
          );
        }

        // full-replace aliases for this command
        this.ctx.storage.sql.exec(
          "DELETE FROM bot_command_aliases WHERE bot_command_id=?",
          botCommandId,
        );
        for (const alias of cmd.aliases) {
          this.ctx.storage.sql.exec(
            "INSERT INTO bot_command_aliases (bot_command_id, bot_id, alias, created_at) VALUES (?, ?, ?, ?)",
            botCommandId,
            botId,
            alias,
            nowIso,
          );
        }

        outCommands.push({
          bot_command_id: botCommandId,
          name: cmd.name,
          aliases: cmd.aliases,
          enabled: true,
          default_enabled_on_install: cmd.default_enabled_on_install,
          updated_at: nowIso,
        });
      }

      const outCaps: Array<{
        event_type: string;
        default_enabled_on_install: boolean;
        updated_at: string;
      }> = [];
      for (const cap of validatedCaps) {
        this.ctx.storage.sql.exec(
          `INSERT INTO bot_event_capabilities (bot_id, event_type, filters_json, default_enabled_on_install, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(bot_id, event_type) DO UPDATE SET
             filters_json=excluded.filters_json,
             default_enabled_on_install=excluded.default_enabled_on_install,
             updated_at=excluded.updated_at`,
          botId,
          cap.event_type,
          JSON.stringify(cap.default_filters),
          cap.default_enabled_on_install ? 1 : 0,
          nowIso,
          nowIso,
        );
        outCaps.push({
          event_type: cap.event_type,
          default_enabled_on_install: cap.default_enabled_on_install,
          updated_at: nowIso,
        });
      }

      const responseBody = { commands: outCommands, event_capabilities: outCaps };
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
      return responseBody;
    });

    return Response.json(response);
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
        "SELECT bot_command_id, name, description, options_json, default_member_permission, default_enabled_on_install, schema_version, definition_hash FROM bot_commands WHERE bot_id=? AND enabled=1 AND deleted_at IS NULL",
        botId,
      )
      .toArray() as Array<{
        bot_command_id: string;
        name: string;
        description: string | null;
        options_json: string;
        default_member_permission: string;
        default_enabled_on_install: number;
        schema_version: number;
        definition_hash: string;
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
    const capRows = this.ctx.storage.sql
      .exec("SELECT event_type, filters_json, default_enabled_on_install FROM bot_event_capabilities WHERE bot_id=?", botId)
      .toArray() as Array<{ event_type: string; filters_json: string; default_enabled_on_install: number }>;

    return Response.json({
      bot: { bot_id: bot.bot_id, display_name: bot.display_name, avatar_url: bot.avatar_url, status: bot.status },
      commands: commandRows.map((c) => ({
        bot_command_id: c.bot_command_id,
        name: c.name,
        description: c.description,
        options: JSON.parse(c.options_json),
        default_member_permission: c.default_member_permission,
        default_enabled_on_install: c.default_enabled_on_install === 1,
        schema_version: c.schema_version,
        definition_hash: c.definition_hash,
        aliases: aliasesByCommand.get(c.bot_command_id) ?? [],
      })),
      event_capabilities: capRows.map((cap) => ({
        event_type: cap.event_type,
        filters: JSON.parse(cap.filters_json),
        default_enabled_on_install: cap.default_enabled_on_install === 1,
      })),
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
        "SELECT bot_command_id, name, description, options_json, default_member_permission, schema_version, definition_hash, enabled, deleted_at FROM bot_commands WHERE bot_id=? AND bot_command_id=?",
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
          schema_version: number;
          definition_hash: string;
          enabled: number;
          deleted_at: string | null;
        }
      | undefined;
    if (!row || row.deleted_at !== null || row.enabled !== 1) {
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
      default_enabled_on_install: boolean;
    }> = [
      {
        name: "ask",
        description: "Ask a question",
        options: [
          { name: "prompt", type: "string", required: true, description: "Question text" },
        ],
        aliases: ["ai"],
        default_member_permission: "member",
        default_enabled_on_install: true,
      },
      {
        name: "summarize",
        description: "Summarize recent messages",
        options: [
          { name: "scope", type: "string", required: false, description: "Scope of summary" },
        ],
        aliases: ["sum", "tl_dr"],
        default_member_permission: "member",
        default_enabled_on_install: true,
      },
    ];

    const seedEventCapabilities: Array<{ event_type: string; default_filters: unknown; default_enabled_on_install: boolean }> = [
      {
        event_type: "message.created",
        default_filters: {
          message_types: ["text"],
          include_bot_messages: false,
          include_own_messages: false,
          only_when_mentioned: false,
        },
        default_enabled_on_install: false,
      },
    ];

    const commandPlan = await Promise.all(seedCommands.map(async (command) => ({
      command,
      defHash: await sha256Hex(canonicalCommandDefinition(command as unknown as ValidatedCommand)),
    })));

    let issuedToken: string | null = null;

    this.ctx.storage.sql.exec(
      `INSERT INTO bot_apps (bot_id, owner_user_id, display_name, avatar_url, callback_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET
         display_name=excluded.display_name,
         avatar_url=excluded.avatar_url,
         status='active',
         updated_at=excluded.updated_at`,
      OFFICIAL_BOT_ID,
      "system",
      "Lilium Bot",
      null,
      "https://example.test/callback",
      now,
      now,
    );

    const existingToken = this.ctx.storage.sql
      .exec("SELECT token_hash, revoked_at FROM bot_tokens WHERE bot_id=? AND revoked_at IS NULL LIMIT 1", OFFICIAL_BOT_ID)
      .toArray()[0] as { token_hash: string; revoked_at: string | null } | undefined;

    if (!existingToken) {
      issuedToken = `lcbot_${crypto.randomUUID()}_${crypto.randomUUID()}`;
      const tokenHash = await hashBotToken(issuedToken);
      this.ctx.storage.sql.exec(
        `INSERT INTO bot_tokens (token_id, bot_id, token_hash, scopes, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        uuidv7(Date.now()),
        OFFICIAL_BOT_ID,
        tokenHash,
        JSON.stringify(["chat:commands:manage", "chat:runtime:connect", "chat:messages:write"]),
        now,
      );
    }

    const responseCommands: Array<{
      bot_command_id: string;
      name: string;
      aliases: string[];
      enabled: boolean;
      default_enabled_on_install: boolean;
      schema_version: number;
      updated_at: string;
    }> = [];

    for (const plan of commandPlan) {
      const command = plan.command;
      const canonical = canonicalCommandDefinition(command as unknown as ValidatedCommand);
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
           SET description=?, options_json=?, default_member_permission=?, default_enabled_on_install=?,
               schema_version=?, definition_hash=?, enabled=1, deleted_at=NULL, updated_at=?
           WHERE bot_command_id=?`,
          command.description,
          JSON.stringify(command.options),
          command.default_member_permission,
          command.default_enabled_on_install ? 1 : 0,
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
             default_enabled_on_install, schema_version, definition_hash, enabled, created_at, updated_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          botCommandId,
          OFFICIAL_BOT_ID,
          command.name,
          command.description,
          JSON.stringify(command.options),
          command.default_member_permission,
          command.default_enabled_on_install ? 1 : 0,
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
        enabled: true,
        default_enabled_on_install: command.default_enabled_on_install,
        schema_version: schemaVersion,
        updated_at: now,
      });
    }

    const responseCaps = [] as Array<{ event_type: string; default_enabled_on_install: boolean; updated_at: string }>;
    for (const cap of seedEventCapabilities) {
      this.ctx.storage.sql.exec(
        `INSERT INTO bot_event_capabilities (bot_id, event_type, filters_json, default_enabled_on_install, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, event_type) DO UPDATE SET
           filters_json=excluded.filters_json,
           default_enabled_on_install=excluded.default_enabled_on_install,
           updated_at=excluded.updated_at`,
        OFFICIAL_BOT_ID,
        cap.event_type,
        JSON.stringify(cap.default_filters),
        cap.default_enabled_on_install ? 1 : 0,
        now,
        now,
      );
      responseCaps.push({
        event_type: cap.event_type,
        default_enabled_on_install: cap.default_enabled_on_install,
        updated_at: now,
      });
    }

    return Response.json({
      bot: {
        bot_id: OFFICIAL_BOT_ID,
        display_name: "Lilium Bot",
        avatar_url: null,
      },
      token: issuedToken,
      commands: responseCommands,
      event_capabilities: responseCaps,
    });
  }
}
