import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { uuidv7 } from "../../ids/uuidv7";
import { canonicalDmPairKey } from "../../chat/dm-pair";
import { migrateDmDirectorySchema } from "./migrations";
import { archiveOutboxDueTable, flushArchiveOutboxToQueue } from "../../archive/queue-flush";
import { appendArchiveRecordSync } from "../../archive/source-outbox";
import { archiveUpsert, rowVersionFromSeq } from "../../archive/changes";
import { sourceKeyForDmDirectory } from "../../archive/source-key";
import { scheduleNextAlarm } from "../shared/scheduler";
import { logSwallowedError } from "../../errors";

export class DMDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      migrateDmDirectorySchema(this.ctx);
    });
  }

  async getOrCreateDm(body: { user_a: string; user_b: string; created_by: string }): Promise<{ channel_id: string; status: "active" | "creating"; created: boolean }> {
    const { user_low, user_high } = canonicalDmPairKey(body.user_a, body.user_b);
    const pairKey = `${user_low}:${user_high}`;
    const now = new Date().toISOString();

    const result = await this.ctx.storage.transaction(async () => {
      const existing = this.ctx.storage.sql
        .exec("SELECT channel_id, status FROM dm_pairs WHERE pair_key=?", pairKey)
        .toArray()[0] as { channel_id: string; status: string } | undefined;

      if (existing) {
        return {
          channel_id: existing.channel_id,
          status: existing.status as "active" | "creating",
          created: false,
        };
      }

      const channelId = uuidv7();
      this.ctx.storage.sql.exec(
        `INSERT INTO dm_pairs (pair_key, user_low, user_high, channel_id, created_by, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'creating', ?, ?)`,
        pairKey, user_low, user_high, channelId, body.created_by, now, now,
      );
      appendArchiveRecordSync(this.ctx, {
        sourceKind: "dm_directory",
        sourceKey: sourceKeyForDmDirectory(pairKey),
        occurredAt: now,
        businessEventIds: [],
        buildChanges: (sourceSeq) => {
          const rowVersion = rowVersionFromSeq(sourceSeq);
          return [
            archiveUpsert(
              "chat_dm_pairs",
              { pair_key: pairKey },
              rowVersion,
              {
                pair_key: pairKey,
                user_low,
                user_high,
                channel_id: channelId,
                created_by: body.created_by,
                status: "creating",
                created_at: now,
                updated_at: now,
              },
            ),
          ];
        },
      });
      return { channel_id: channelId, status: "creating" as const, created: true };
    });

    if (result.created) {
      await this.scheduleArchiveAlarm();
    }

    return result;
  }

  async completeDm(body: { pair_key: string; channel_id: string }): Promise<{ ok: true }> {
    const now = new Date().toISOString();

    const archived = await this.ctx.storage.transaction(async () => {
      const row = this.ctx.storage.sql
        .exec(
          "SELECT pair_key, user_low, user_high, channel_id, created_by, status, created_at, updated_at FROM dm_pairs WHERE pair_key=?",
          body.pair_key,
        )
        .toArray()[0] as
        | {
            pair_key: string;
            user_low: string;
            user_high: string;
            channel_id: string;
            created_by: string;
            status: string;
            created_at: string;
            updated_at: string;
          }
        | undefined;
      if (!row) {
        throw new Error("dm pair not found");
      }
      if (row.channel_id !== body.channel_id) {
        throw new Error("dm pair channel_id mismatch");
      }
      if (row.status === "active") return false;
      this.ctx.storage.sql.exec(
        "UPDATE dm_pairs SET status='active', updated_at=? WHERE pair_key=?",
        now, body.pair_key,
      );
      appendArchiveRecordSync(this.ctx, {
        sourceKind: "dm_directory",
        sourceKey: sourceKeyForDmDirectory(body.pair_key),
        occurredAt: now,
        businessEventIds: [],
        buildChanges: (sourceSeq) => {
          const rowVersion = rowVersionFromSeq(sourceSeq);
          return [
            archiveUpsert(
              "chat_dm_pairs",
              { pair_key: row.pair_key },
              rowVersion,
              {
                pair_key: row.pair_key,
                user_low: row.user_low,
                user_high: row.user_high,
                channel_id: row.channel_id,
                created_by: row.created_by,
                status: "active",
                created_at: row.created_at,
                updated_at: now,
              },
            ),
          ];
        },
      });
      return true;
    });

    if (archived) {
      await this.scheduleArchiveAlarm();
    }

    return { ok: true };
  }

  async scheduleArchiveAlarm(): Promise<void> {
    await scheduleNextAlarm(this.ctx, [archiveOutboxDueTable()], { respectExistingAlarm: true });
  }

  async alarm(): Promise<void> {
    const now = new Date().toISOString();
    try {
      await flushArchiveOutboxToQueue(this.ctx, this.env.CHAT_ARCHIVE_QUEUE, { now });
    } catch (err) {
      logSwallowedError("dm_directory_archive_flush_failed", err);
    }
    await scheduleNextAlarm(this.ctx, [archiveOutboxDueTable()], { respectExistingAlarm: true });
  }
}
