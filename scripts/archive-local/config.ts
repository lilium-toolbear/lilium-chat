export interface DaemonConfig {
  cfAccountId: string;
  cfQueueId: string;
  cfQueuesToken: string;
  databaseUrl: string;
  pullBatchSize: number;
  visibilityTimeoutMs: number;
  pollIntervalMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env: ${name}`);
  return value;
}

export function loadConfig(): DaemonConfig {
  return {
    cfAccountId: requireEnv("CF_ACCOUNT_ID"),
    cfQueueId: requireEnv("CF_QUEUE_ID"),
    cfQueuesToken: requireEnv("CF_QUEUES_TOKEN"),
    databaseUrl: requireEnv("DATABASE_URL"),
    pullBatchSize: Number(process.env.QUEUE_PULL_BATCH_SIZE ?? 100),
    visibilityTimeoutMs: Number(process.env.QUEUE_VISIBILITY_TIMEOUT_MS ?? 600_000),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1000),
  };
}
