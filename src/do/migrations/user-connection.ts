export function migrateUserConnectionSchema(_ctx: DurableObjectState): void {
  // UserConnection has no SQLite tables; migration is a no-op.
}
