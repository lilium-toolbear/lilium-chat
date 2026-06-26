/** Vitest/miniflare stub — production uses pg-client.ts (real `pg`). */
export class Client {
  constructor(_opts: { connectionString: string }) {}

  async connect(): Promise<void> {}

  async query(): Promise<{ rows: never[] }> {
    return { rows: [] };
  }

  async end(): Promise<void> {}
}
