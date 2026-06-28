import type { DaemonConfig } from "./config.js";

export interface PulledQueueMessage {
  lease_id: string;
  body: unknown;
  attempts?: number;
}

interface CfApiResult<T> {
  success: boolean;
  errors?: Array<{ message: string }>;
  result?: T;
}

export class QueueClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly config: DaemonConfig;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.cfAccountId}/queues/${config.cfQueueId}`;
    this.token = config.cfQueuesToken;
  }

  async pull(): Promise<PulledQueueMessage[]> {
    const res = await fetch(`${this.baseUrl}/messages/pull`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        visibility_timeout: this.config.visibilityTimeoutMs,
        batch_size: this.config.pullBatchSize,
      }),
    });
    const json = (await res.json()) as CfApiResult<{ messages?: PulledQueueMessage[] }>;
    if (!res.ok || !json.success) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? res.statusText;
      throw new Error(`queue pull failed: ${msg}`);
    }
    return json.result?.messages ?? [];
  }

  async ack(leaseIds: string[]): Promise<void> {
    if (leaseIds.length === 0) return;
    const res = await fetch(`${this.baseUrl}/messages/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        acks: leaseIds.map((lease_id) => ({ lease_id })),
        retries: [],
      }),
    });
    const json = (await res.json()) as CfApiResult<unknown>;
    if (!res.ok || !json.success) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? res.statusText;
      throw new Error(`queue ack failed: ${msg}`);
    }
  }

  async retry(leaseId: string, delaySeconds: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/messages/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        acks: [],
        retries: [{ lease_id: leaseId, delay_seconds: delaySeconds }],
      }),
    });
    const json = (await res.json()) as CfApiResult<unknown>;
    if (!res.ok || !json.success) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? res.statusText;
      throw new Error(`queue retry failed: ${msg}`);
    }
  }
}
