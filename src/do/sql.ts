export function execSchema(ctx: DurableObjectState, statements: string[]): void {
  for (const statement of statements) {
    ctx.storage.sql.exec(statement);
  }
}

export async function txn<T>(ctx: DurableObjectState, fn: () => T | Promise<T>): Promise<T> {
  return ctx.storage.transaction(async () => fn());
}
