import { canonicalStringify, payloadByteLength } from "./hash";

export const ARCHIVE_FORMAT = "lilium.chat.archive.record.v1" as const;

export const ARCHIVE_MAX_PAYLOAD_BYTES = 120 * 1024;
export const ARCHIVE_BATCH_TARGET_BYTES = 240 * 1024;
export const ARCHIVE_APPEND_TARGET_BYTES = 96 * 1024;

export type ArchiveSourceKind =
  | "chat_channel"
  | "user_directory"
  | "dm_directory"
  | "bot_registry";

export type ArchiveChange =
  | {
      op: "upsert";
      table: string;
      pk: Record<string, string | number>;
      row_version: string;
      after: Record<string, unknown>;
    }
  | {
      op: "delete";
      table: string;
      pk: Record<string, string | number>;
      row_version: string;
    }
  | {
      op: "replace_scope";
      table: string;
      scope: Record<string, string | number>;
      row_version: string;
      rows: Array<Record<string, unknown>>;
    };

export interface ArchiveRecord {
  format: typeof ARCHIVE_FORMAT;
  archive_id: string;
  source_kind: ArchiveSourceKind;
  source_key: string;
  source_seq: number;
  business_event_ids: string[];
  occurred_at: string;
  changes: ArchiveChange[];
}

export type ArchiveQueueMessage = ArchiveRecord;

const ALLOWED_SOURCE_KINDS: ReadonlySet<ArchiveSourceKind> = new Set([
  "chat_channel",
  "user_directory",
  "dm_directory",
  "bot_registry",
]);

const ALLOWED_OPS: ReadonlySet<ArchiveChange["op"]> = new Set(["upsert", "delete", "replace_scope"]);

/** Normalized PG table names that may appear in archive payloads (spec §7.5). */
export const ARCHIVE_TABLE_WHITELIST: ReadonlySet<string> = new Set([
  "chat_channels",
  "chat_channel_members",
  "chat_messages",
  "chat_message_edits",
  "chat_audit_logs",
  "chat_events",
  "chat_attachments",
  "chat_message_attachments",
  "chat_message_stickers",
  "chat_mentions",
  "chat_invites",
  "chat_dm_pairs",
  "chat_personal_stickers",
  "chat_bot_apps",
  "chat_bot_tokens",
  "chat_bot_commands",
  "chat_bot_command_aliases",
  "chat_bot_event_capabilities",
  "chat_bot_installations",
  "chat_channel_command_bindings",
  "chat_channel_command_names",
  "chat_channel_bot_event_subscriptions",
  "chat_command_invocations",
  "chat_interactions",
]);

/** Runtime / projection tables that must never appear in archive payloads (spec §3.6, §12.4). */
export const RUNTIME_TABLE_BLACKLIST: ReadonlySet<string> = new Set([
  "live_sessions",
  "live_channel_leases",
  "online_sessions",
  "fanout_events",
  "fanout_queue",
  "fanout_leases",
  "bot_connection_state",
  "bot_deliveries",
  "projection_outbox",
  "bot_delivery_outbox",
  "bot_effects_applied",
  "idempotency_keys",
  "rate_buckets",
  "event_seq",
  "my_channels",
  "pending_attachments",
  "archive_outbox",
  "archive_seq",
]);

export function base64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function encodeArchiveId(
  sourceKind: ArchiveSourceKind,
  sourceKey: string,
  sourceSeq: number,
): string {
  return `${sourceKind}:${base64urlEncode(sourceKey)}:${sourceSeq}`;
}

export { canonicalStringify, payloadByteLength };

export function validateArchiveRecord(
  record: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!record || typeof record !== "object") {
    return { ok: false, error: "record must be an object" };
  }
  const r = record as Partial<ArchiveRecord>;
  if (r.format !== ARCHIVE_FORMAT) {
    return { ok: false, error: `format must be ${ARCHIVE_FORMAT}` };
  }
  if (!r.source_kind || !ALLOWED_SOURCE_KINDS.has(r.source_kind)) {
    return { ok: false, error: "invalid source_kind" };
  }
  if (typeof r.source_key !== "string" || r.source_key.length === 0) {
    return { ok: false, error: "source_key must be non-empty" };
  }
  if (typeof r.source_seq !== "number" || !Number.isInteger(r.source_seq) || r.source_seq <= 0) {
    return { ok: false, error: "source_seq must be a positive integer" };
  }
  if (typeof r.archive_id !== "string" || r.archive_id.length === 0) {
    return { ok: false, error: "archive_id required" };
  }
  const expectedId = encodeArchiveId(r.source_kind, r.source_key, r.source_seq);
  if (r.archive_id !== expectedId) {
    return { ok: false, error: "archive_id mismatch" };
  }
  if (typeof r.occurred_at !== "string" || !Number.isFinite(Date.parse(r.occurred_at))) {
    return { ok: false, error: "occurred_at must be a valid timestamp" };
  }
  if (!Array.isArray(r.changes) || r.changes.length === 0) {
    return { ok: false, error: "changes must be a non-empty array" };
  }
  if (!Array.isArray(r.business_event_ids)) {
    return { ok: false, error: "business_event_ids must be an array" };
  }
  for (const change of r.changes) {
    const err = validateChange(change);
    if (err) return { ok: false, error: err };
  }
  return { ok: true };
}

function validateChange(change: unknown): string | null {
  if (!change || typeof change !== "object") return "change must be an object";
  const c = change as Partial<ArchiveChange> & { table?: string; op?: string };
  if (!c.op || !ALLOWED_OPS.has(c.op as ArchiveChange["op"])) {
    return "invalid change op";
  }
  if (typeof c.table !== "string" || !ARCHIVE_TABLE_WHITELIST.has(c.table)) {
    return `table not whitelisted: ${String(c.table)}`;
  }
  if (typeof c.row_version !== "string" || c.row_version.length === 0) {
    return "row_version required";
  }
  if (c.op === "upsert") {
    if (!c.pk || typeof c.pk !== "object" || Object.keys(c.pk).length === 0) {
      return "upsert requires pk";
    }
    if (!c.after || typeof c.after !== "object") {
      return "upsert requires after";
    }
    return null;
  }
  if (c.op === "delete") {
    if (!c.pk || typeof c.pk !== "object" || Object.keys(c.pk).length === 0) {
      return "delete requires pk";
    }
    return null;
  }
  if (c.op === "replace_scope") {
    const rs = c as { scope?: unknown; rows?: unknown };
    if (!rs.scope || typeof rs.scope !== "object" || Object.keys(rs.scope as object).length === 0) {
      return "replace_scope requires scope";
    }
    if (!Array.isArray(rs.rows)) {
      return "replace_scope requires rows array";
    }
    return null;
  }
  return "unknown change op";
}
