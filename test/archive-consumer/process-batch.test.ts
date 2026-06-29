import { describe, expect, it, vi } from "vitest";
import { ARCHIVE_FORMAT, encodeArchiveId, type ArchiveRecord } from "../../src/archive/payload";
import { processArchiveMessageBatch } from "../../src/archive-consumer/process-batch";
import { applyArchiveRecord } from "../../src/archive-consumer/replay";

function chatEventsRecord(overrides?: Partial<ArchiveRecord>): ArchiveRecord {
  const sourceKind = "chat_channel";
  const sourceKey = "01900000-0000-7000-8000-000000000001";
  const sourceSeq = 1;
  return {
    format: ARCHIVE_FORMAT,
    archive_id: encodeArchiveId(sourceKind, sourceKey, sourceSeq),
    source_kind: sourceKind,
    source_key: sourceKey,
    source_seq: sourceSeq,
    business_event_ids: ["evt-1"],
    occurred_at: "2026-06-28T00:00:00.000Z",
    changes: [
      {
        op: "upsert",
        table: "chat_messages",
        pk: { message_id: "msg-1" },
        row_version: "evt-1",
        after: {
          message_id: "msg-1",
          command_id: "cmd-1",
          dedupe_principal_key: "user:u1",
          channel_id: sourceKey,
          sender_kind: "user",
          sender_user_id: "u1",
          type: "text",
          format: "plain",
          status: "normal",
          text: "oi",
          stream_state: "none",
          created_at: "2026-06-28T00:00:00.000Z",
          updated_at: "2026-06-28T00:00:00.000Z",
        },
      },
      {
        op: "upsert",
        table: "chat_events",
        pk: { event_id: "evt-1" },
        row_version: "evt-1",
        after: {
          event_id: "evt-1",
          event_type: "message.created",
          channel_id: sourceKey,
          occurred_at: "2026-06-28T00:00:00.000Z",
          payload_json: '{"message":{"message_id":"msg-1"}}',
          membership_version_at_event: 1,
        },
      },
    ],
    ...overrides,
  };
}

function makeMessage(body: unknown) {
  return {
    id: crypto.randomUUID(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makePgClient() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("FROM chat_archive_source_watermarks") && sql.includes("FOR UPDATE")) {
        return { rows: [{ last_applied_seq: 0 }] };
      }
      if (sql.includes("FROM chat_archive_records") && sql.includes("source_seq = $3")) {
        const record = chatEventsRecord();
        return { rows: [{ archive_id: record.archive_id, payload: record }] };
      }
      if (sql.includes("applied_at IS NULL") && sql.includes("DISTINCT source_kind")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return client;
}

describe("processArchiveMessageBatch", () => {
  it("persists raw log, drains replay, then acks on commit", async () => {
    const client = makePgClient();
    const msg = makeMessage(chatEventsRecord());

    const result = await processArchiveMessageBatch([msg], client);

    expect(result.acked).toBe(1);
    expect(result.retried).toBe(0);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(client.queries.some((q) => q.sql.includes("INSERT INTO chat_archive_records"))).toBe(true);
    expect(client.queries.some((q) => q.sql.includes("INSERT INTO chat.messages"))).toBe(true);
    expect(client.queries.some((q) => q.sql.includes("INSERT INTO chat.events"))).toBe(true);
  });

  it("retries when archive body is invalid", async () => {
    const client = makePgClient();
    const msg = makeMessage({ bad: true });

    const result = await processArchiveMessageBatch([msg], client);

    expect(result).toEqual({ acked: 0, retried: 1, skipped: 0, drained: 0 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });
});

describe("applyArchiveRecord", () => {
  it("soft-deletes scoped rows on empty replace_scope", async () => {
    const client = makePgClient();
    const record = chatEventsRecord({
      changes: [
        {
          op: "replace_scope",
          table: "chat_mentions",
          scope: { message_id: "msg-1" },
          row_version: "evt-1",
          rows: [],
        },
      ],
    });

    const applied = await applyArchiveRecord(client, record);

    expect(applied).toBe(1);
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]!.sql).toContain("UPDATE chat.mentions");
    expect(client.queries[0]!.sql).toContain("deleted_at");
    expect(client.queries[0]!.sql).not.toContain("DELETE FROM");
  });

  it("upserts pk-only junction rows without empty UPDATE SET", async () => {
    const client = makePgClient();
    const record = chatEventsRecord({
      changes: [
        {
          op: "replace_scope",
          table: "chat_message_attachments",
          scope: { message_id: "msg-1" },
          row_version: "evt-1",
          rows: [{ message_id: "msg-1", attachment_id: "att-1" }],
        },
      ],
    });

    await applyArchiveRecord(client, record);

    const softDelete = client.queries.find((q) => q.sql.includes("UPDATE chat.message_attachments"));
    expect(softDelete).toBeDefined();
    expect(softDelete!.sql).toContain("deleted_at");

    const insert = client.queries.find((q) => q.sql.includes("INSERT INTO chat.message_attachments"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/DO UPDATE SET[\s\S]+archived_source_seq/);
    expect(insert!.sql).not.toMatch(/DO UPDATE SET\s+WHERE/);
  });

  it("soft-deletes channel members via delete op", async () => {
    const client = makePgClient();
    const record = chatEventsRecord({
      changes: [
        {
          op: "delete",
          table: "chat_channel_members",
          pk: { channel_id: "ch-1", user_id: "u1" },
          row_version: "evt-2",
        },
      ],
    });

    await applyArchiveRecord(client, record);

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]!.sql).toContain("UPDATE chat.channel_members");
    expect(client.queries[0]!.sql).toContain("left_at");
    expect(client.queries[0]!.sql).not.toContain("DELETE FROM");
  });
});
