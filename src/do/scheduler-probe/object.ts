import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { execSchema } from "../shared/sql";
import { runDueJobs, scheduleNextAlarm, type DueTable } from "../shared/scheduler";

export class SchedulerProbe extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    execSchema(this.ctx, [
      `CREATE TABLE IF NOT EXISTS due_rows (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         due_at INTEGER NOT NULL,
         status TEXT NOT NULL DEFAULT 'pending',
         payload TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_due ON due_rows(status, due_at)`,
    ]);
  }

  setup(rows: number[]): { ok: true } {
    this.ctx.storage.sql.exec("DELETE FROM due_rows");
    for (const dueAt of rows) {
      this.ctx.storage.sql.exec("INSERT INTO due_rows (due_at, status) VALUES (?, 'pending')", dueAt);
    }
    return { ok: true };
  }

  async run(now: number): Promise<{ processed: number[]; nextAlarm: number | null }> {
    const processed: number[] = [];
    const dueTable: DueTable = {
      table: "due_rows",
      dueColumn: "due_at",
      statusColumn: "status",
      pendingStatus: "pending",
      handler: async (rows) => {
        for (const row of rows) {
          processed.push(Number(row.due_at));
          this.ctx.storage.sql.exec("UPDATE due_rows SET status='done' WHERE id=?", row.id);
        }
      },
    };
    await runDueJobs(this.ctx, now, [dueTable]);
    await scheduleNextAlarm(this.ctx, [dueTable]);
    const row = this.ctx.storage.sql
      .exec("SELECT MIN(due_at) AS due_at FROM due_rows WHERE status='pending'")
      .toArray()[0] as { due_at: number | null } | undefined;
    const nextAlarm = row?.due_at ?? null;
    return { processed, nextAlarm: nextAlarm === null ? null : Number(nextAlarm) };
  }

  async alarm(): Promise<void> {
    const dueTable: DueTable = {
      table: "due_rows",
      dueColumn: "due_at",
      statusColumn: "status",
      pendingStatus: "pending",
      handler: async (rows) => {
        for (const row of rows) {
          this.ctx.storage.sql.exec("UPDATE due_rows SET status='done' WHERE id=?", row.id);
        }
      },
    };

    await runDueJobs(this.ctx, Date.now(), [dueTable]);
    await scheduleNextAlarm(this.ctx, [dueTable]);
  }
}
