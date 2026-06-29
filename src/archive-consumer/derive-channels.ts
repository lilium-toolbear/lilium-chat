import type { PgQueryable } from "./pg-writer.js";
import {
  deriveChannelMemberState,
  type DerivedChannelRow,
  type DerivedMemberRow,
} from "./derive-channel-state.js";

const DERIVED_KIND = "backfill_derived";
const DERIVED_KEY = "events_and_messages";
const DERIVED_SEQ = 0;

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

async function upsertDerivedChannel(client: PgQueryable, row: DerivedChannelRow): Promise<void> {
  const columns = [
    "channel_id",
    "kind",
    "visibility",
    "title",
    "topic",
    "avatar_url",
    "status",
    "created_by",
    "created_at",
    "updated_at",
    "member_count",
    "membership_version",
    "archived_source_kind",
    "archived_source_key",
    "archived_source_seq",
    "archived_at",
  ] as const;
  const values = [
    row.channel_id,
    row.kind,
    row.visibility,
    row.title,
    row.topic,
    row.avatar_url,
    row.status,
    row.created_by,
    row.created_at,
    row.updated_at,
    row.member_count,
    row.membership_version,
    DERIVED_KIND,
    DERIVED_KEY,
    DERIVED_SEQ,
    row.updated_at,
  ];
  const placeholders = columns.map((col, i) => {
    if (col.endsWith("_at")) return `$${i + 1}::timestamptz`;
    return `$${i + 1}`;
  });
  const colSql = columns.map(quoteIdent).join(", ");
  const setSql = columns
    .filter((c) => c !== "channel_id")
    .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
    .join(", ");
  await client.query(
    `INSERT INTO chat.channels (${colSql})
     VALUES (${placeholders.join(", ")})
     ON CONFLICT (channel_id) DO UPDATE SET ${setSql}
     WHERE chat.channels.archived_source_kind = $${columns.length + 1}
        OR chat.channels.archived_source_seq IS NULL
        OR chat.channels.archived_source_seq <= $${columns.length + 2}`,
    [...values, DERIVED_KIND, DERIVED_SEQ],
  );
}

async function upsertDerivedMember(client: PgQueryable, row: DerivedMemberRow): Promise<void> {
  const columns = [
    "channel_id",
    "user_id",
    "role",
    "joined_at",
    "left_at",
    "archived_source_kind",
    "archived_source_key",
    "archived_source_seq",
    "archived_at",
  ] as const;
  const archivedAt = row.left_at ?? row.joined_at;
  const values = [
    row.channel_id,
    row.user_id,
    row.role,
    row.joined_at,
    row.left_at,
    DERIVED_KIND,
    DERIVED_KEY,
    DERIVED_SEQ,
    archivedAt,
  ];
  const placeholders = columns.map((col, i) => {
    if (col.endsWith("_at")) return `$${i + 1}::timestamptz`;
    return `$${i + 1}`;
  });
  const colSql = columns.map(quoteIdent).join(", ");
  const setSql = columns
    .filter((c) => c !== "channel_id" && c !== "user_id")
    .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
    .join(", ");
  await client.query(
    `INSERT INTO chat.channel_members (${colSql})
     VALUES (${placeholders.join(", ")})
     ON CONFLICT (channel_id, user_id) DO UPDATE SET ${setSql}
     WHERE chat.channel_members.archived_source_kind = $${columns.length + 1}
        OR chat.channel_members.archived_source_seq IS NULL
        OR chat.channel_members.archived_source_seq <= $${columns.length + 2}`,
    [...values, DERIVED_KIND, DERIVED_SEQ],
  );
}

export interface DeriveChannelsResult {
  channels: number;
  members: number;
}

/**
 * Fill gaps in chat.channels / chat.channel_members from normalized events and
 * message senders. Does not overwrite rows replayed from real archive payloads.
 */
export async function deriveChannelsAndMembers(client: PgQueryable): Promise<DeriveChannelsResult> {
  const eventsResult = await client.query(
    `SELECT event_type, channel_id, occurred_at, membership_version_at_event, payload
     FROM chat.events
     ORDER BY channel_id, occurred_at, event_id`,
  );
  const eventRows =
    (eventsResult as {
      rows?: Array<{
        event_type: string;
        channel_id: string;
        occurred_at: string;
        membership_version_at_event: number;
        payload: unknown;
      }>;
    }).rows ?? [];

  const sendersResult = await client.query(
    `SELECT channel_id, sender_user_id, MIN(created_at) AS first_at
     FROM chat.messages
     WHERE sender_kind = 'user' AND sender_user_id IS NOT NULL
     GROUP BY channel_id, sender_user_id`,
  );
  const senderRows =
    (sendersResult as {
      rows?: Array<{ channel_id: string; sender_user_id: string; first_at: string }>;
    }).rows ?? [];

  const { channels, members } = deriveChannelMemberState(
    eventRows,
    senderRows.map((r) => ({
      channel_id: r.channel_id,
      sender_user_id: r.sender_user_id,
      first_at: r.first_at,
    })),
  );

  for (const channel of channels) {
    await upsertDerivedChannel(client, channel);
  }
  for (const member of members) {
    await upsertDerivedMember(client, member);
  }

  return { channels: channels.length, members: members.length };
}
