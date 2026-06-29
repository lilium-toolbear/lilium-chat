import { parseArchiveBody } from "../archive/apply-events.js";
import { applyArchiveRecord } from "./replay.js";
import type { PgQueryable } from "./pg-writer.js";

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
}

const RETRY_DELAY_SECONDS = 60;

/**
 * Replay archive queue messages into normalized PG tables inside one transaction.
 * Ack/retry individual messages only after COMMIT succeeds.
 */
export async function processArchiveMessageBatch(
  messages: readonly ArchiveQueueMessageLike[],
  client: PgQueryable,
): Promise<ProcessBatchResult> {
  if (messages.length === 0) {
    return { acked: 0, retried: 0, skipped: 0 };
  }

  const toAck: ArchiveQueueMessageLike[] = [];
  const toRetry: ArchiveQueueMessageLike[] = [];
  let skipped = 0;

  await client.query("BEGIN");
  try {
    for (const message of messages) {
      try {
        const record = parseArchiveBody(message.body);
        const applied = await applyArchiveRecord(client, record);
        if (applied === 0) {
          skipped += 1;
        }
        toAck.push(message);
      } catch (err) {
        console.error("archive message replay failed", {
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

  for (const message of toAck) {
    message.ack();
  }
  for (const message of toRetry) {
    message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
  }

  return { acked: toAck.length, retried: toRetry.length, skipped };
}
