export function execSchema(ctx: DurableObjectState, statements: string[]): void {
  for (const statement of statements) {
    ctx.storage.sql.exec(statement);
  }
}

export async function txn<T>(ctx: DurableObjectState, fn: () => T | Promise<T>): Promise<T> {
  return ctx.storage.transaction(async () => fn());
}

/** Typed view of `storage.sql.exec(...).toArray()` — SELECT columns must match T. */
export function sqlRows<T>(rows: unknown): T[] {
  return rows as T[];
}

export function sqlRow<T>(rows: unknown): T | undefined {
  return sqlRows<T>(rows)[0];
}
