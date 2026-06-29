import { parseArchiveBody } from "../archive/apply-events.js";
import { drainAffectedSources } from "./drain.js";
import type { PgQueryable } from "./pg-writer.js";
import { insertArchiveRecordIfAbsent } from "./raw-log.js";

export interface ArchiveQueueMessageLike {
  id: string;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ProcessBatchResult {
  acked: number;
  retried: number;
  skipped: number;
  drained: number;
}

const RETRY_DELAY_SECONDS = 60;

/**
 * Persist archive records to raw log, drain per-source watermarks, then ack/retry.
 * Queue ack means raw log persisted (spec §8.6–8.7), not normalized replay completed.
 */
export async function processArchiveMessageBatch(
  messages: readonly ArchiveQueueMessageLike[],
  client: PgQueryable,
): Promise<ProcessBatchResult> {
  if (messages.length === 0) {
    return { acked: 0, retried: 0, skipped: 0, drained: 0 };
  }

  const parsedRecords = [];
  const toAck: ArchiveQueueMessageLike[] = [];
  const toRetry: ArchiveQueueMessageLike[] = [];

  await client.query("BEGIN");
  try {
    for (const message of messages) {
      try {
        const record = parseArchiveBody(message.body);
        await insertArchiveRecordIfAbsent(client, record);
        parsedRecords.push(record);
        toAck.push(message);
      } catch (err) {
        console.error("archive message persist failed", {
          message_id: message.id,
          attempts: message.attempts,
          err: String(err),
        });
        toRetry.push(message);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  let drained = 0;
  try {
    drained = await drainAffectedSources(client, parsedRecords);
  } catch (err) {
    console.error("archive drain failed after raw log persist", {
      err: String(err),
      record_count: parsedRecords.length,
    });
  }

  for (const message of toAck) {
    message.ack();
  }
  for (const message of toRetry) {
    message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
  }

  return { acked: toAck.length, retried: toRetry.length, skipped: 0, drained };
}
