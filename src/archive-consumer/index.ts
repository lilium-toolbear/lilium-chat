import { Client } from "../profile/pg-client.js";
import type { ArchiveRecord } from "../archive/payload.js";
import type { ArchiveConsumerEnv } from "./env.js";
import { pingPg } from "./pg-writer.js";
import { processArchiveMessageBatch } from "./process-batch.js";

const PG_RETRY_DELAY_SECONDS = 60;

export default {
  async queue(batch: MessageBatch<ArchiveRecord>, env: ArchiveConsumerEnv): Promise<void> {
    if (batch.messages.length === 0) return;

    const client = new Client({ connectionString: env.LILIUM_DB.connectionString });
    try {
      await client.connect();
      await pingPg(client);
    } catch (err) {
      console.error("archive consumer: pg unhealthy, retrying batch", { err: String(err) });
      batch.retryAll({ delaySeconds: PG_RETRY_DELAY_SECONDS });
      return;
    }

    try {
      const result = await processArchiveMessageBatch(batch.messages, client);
      if (result.acked > 0 || result.retried > 0) {
        console.log("archive consumer batch", result);
      }
    } catch (err) {
      console.error("archive consumer: batch transaction failed, retrying all", { err: String(err) });
      batch.retryAll({ delaySeconds: PG_RETRY_DELAY_SECONDS });
    } finally {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  },
};
