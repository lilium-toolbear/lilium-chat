declare module "pg" {
  export interface QueryResult<T = any> {
    rows: T[];
  }

  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query<T = Record<string, unknown>>(text: string): Promise<QueryResult<T>>;
    end(): Promise<void>;
  }
}

declare module "cloudflare:test" {
  export function runInDurableObject(
    stub: unknown,
    callback: (instance: unknown, state: { getWebSockets: () => WebSocket[] }) => Promise<void>,
  ): Promise<void>;
}
