import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { BOT_GATEWAY_API_VERSION } from "../../src/chat/bot-gateway-protocol";
import { createTestChannel, getNamedDo, readDoSchemaVersion } from "../helpers";
import type { BotConnection } from "../../src/do/bot-connection";

function botConnectionStub(botId: string): DurableObjectStub<BotConnection> {
  return getNamedDo<BotConnection>(env.BOT_CONNECTION, botId);
}

async function openConnection(
  botId: string,
): Promise<{ ws: WebSocket; stub: DurableObjectStub<BotConnection> }> {
  const stub = botConnectionStub(botId);
  const res = await stub.fetch(
    new Request("https://x/bot", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": BOT_GATEWAY_API_VERSION,
        "X-Verified-Bot-Id": botId,
      },
    }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return { ws, stub };
}

function nextMessageOfType<T extends string>(
  ws: WebSocket,
  type: T,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout waiting for ws frame: ${type}`)),
      timeoutMs,
    );
    const handler = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      try {
        const frame = JSON.parse(data) as { type?: unknown };
        if (frame.type === type) {
          clearTimeout(t);
          ws.removeEventListener("message", handler);
          resolve(data);
        }
      } catch {
        // ignore non-JSON and unrelated frames
      }
    };
    ws.addEventListener("message", handler);
  });
}

function noMessageOfType<T extends string>(
  ws: WebSocket,
  type: T,
  timeoutMs = 200,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.removeEventListener("message", handler);
      resolve();
    }, timeoutMs);
    const handler = (ev: MessageEvent) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      try {
        const frame = JSON.parse(data) as { type?: unknown };
        if (frame.type === type) {
          clearTimeout(t);
          ws.removeEventListener("message", handler);
          reject(new Error(`unexpected ws frame: ${type}`));
        }
      } catch {
        // ignore non-JSON and unrelated frames
      }
    };
    ws.addEventListener("message", handler);
  });
}

function enqueuePayload(overrides: Partial<Record<string, unknown>> = {}) {
  const channelId = "channel-delivery";
  const targetId = "target-delivery";
  return {
    outbox_id: `outbox-${crypto.randomUUID()}`,
    channel_id: channelId,
    kind: "command_invocation" as const,
    target_id: targetId,
    request_json: JSON.stringify({
      channel_id: channelId,
      invocation_id: targetId,
      command: { name: "ask", options: {} },
      invoker: { user_id: "user-delivery" },
    }),
    ...overrides,
  };
}

async function enqueueDelivery(
  stub: DurableObjectStub<BotConnection>,
  botId: string,
  payload: ReturnType<typeof enqueuePayload>,
) {
  return stub.enqueueDelivery(botId, payload);
}

describe("BotConnection DO delivery queue (7b)", () => {
  it("persists a pending delivery row through enqueueDelivery RPC", async () => {
    const botId = `bot-delivery-persist-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const payload = enqueuePayload();

    const res = await enqueueDelivery(stub, botId, payload);
    const out = { delivery_id: res.delivery_id, status: res.status };
    expect(out.delivery_id).toBeTruthy();

    const { runInDurableObject } = await import("cloudflare:test");
    let row:
      | { status: string; kind: string; target_id: string; bot_id: string }
      | undefined;
    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => {
                  toArray: () => Array<{
                    status: string;
                    kind: string;
                    target_id: string;
                    bot_id: string;
                  }>;
                };
              };
            };
          };
        }
      ).ctx.storage.sql;
      row = sql
        .exec(
          "SELECT bot_id, status, kind, target_id FROM bot_deliveries WHERE delivery_id=?",
          out.delivery_id,
        )
        .toArray()[0];
    });
    expect(row).toBeDefined();
    expect(row?.bot_id).toBe(botId);
    expect(row?.status).toBe("pending");
    expect(row?.kind).toBe("command_invocation");
    expect(row?.target_id).toBe(payload.target_id);
  });

  it("sends delivery over websocket when connected and marks sent", async () => {
    const botId = `bot-delivery-connected-${crypto.randomUUID()}`;
    const { ws, stub } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    const payload = enqueuePayload();
    const enq = await enqueueDelivery(stub, botId, payload);
    
    const deliveryFrame = JSON.parse(
      await nextMessageOfType(ws, "delivery"),
    ) as {
      type: string;
      kind: string;
      delivery_id: string;
      channel_id: string;
      invocation_id?: string;
      command?: { name?: string };
      invoker?: { user_id?: string };
      request_json?: unknown;
      target_id?: unknown;
      source_outbox_id?: unknown;
    };
    expect(deliveryFrame.type).toBe("delivery");
    expect(deliveryFrame.kind).toBe("command_invocation");
    expect(deliveryFrame.delivery_id).toBeTruthy();
    expect(deliveryFrame.channel_id).toBe(payload.channel_id);
    expect(deliveryFrame.invocation_id).toBe(payload.target_id);
    expect(deliveryFrame.command?.name).toBe("ask");
    expect(deliveryFrame.invoker?.user_id).toBe("user-delivery");
    expect(deliveryFrame.request_json).toBeUndefined();
    expect(deliveryFrame.target_id).toBeUndefined();
    expect(deliveryFrame.source_outbox_id).toBeUndefined();
    ws.close();

    const { runInDurableObject } = await import("cloudflare:test");
    let status: string | null = null;
    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (query: string) => {
                  toArray: () => Array<{ status: string }>;
                };
              };
            };
          };
        }
      ).ctx.storage.sql;
      status =
        sql
          .exec(
            "SELECT status FROM bot_deliveries ORDER BY created_at DESC LIMIT 1",
          )
          .toArray()[0]?.status ?? null;
    });
    expect(status).toBe("sent");
  });

  it("marks known deliveries completed when empty delivery_result is received", async () => {
    const botId = `bot-delivery-result-terminal-${crypto.randomUUID()}`;
    await createTestChannel(env, { channelId: "channel-delivery", ownerId: "owner-delivery" });
    const { ws, stub } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    const payload = enqueuePayload();
    const enq = await enqueueDelivery(stub, botId, payload);
    
    const deliveryFrame = JSON.parse(
      await nextMessageOfType(ws, "delivery"),
    ) as { delivery_id: string };
    ws.send(
      JSON.stringify({
        type: "delivery_result",
        api_version: BOT_GATEWAY_API_VERSION,
        delivery_id: deliveryFrame.delivery_id,
        status: "ok",
        effects: [],
      }),
    );
    await nextMessageOfType(ws, "delivery_ack");

    const { runInDurableObject } = await import("cloudflare:test");
    let status: string | null = null;
    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => { toArray: () => Array<{ status: string }> };
              };
            };
          };
        }
      ).ctx.storage.sql;
      status =
        sql
          .exec(
            "SELECT status FROM bot_deliveries WHERE delivery_id=?",
            deliveryFrame.delivery_id,
          )
          .toArray()[0]?.status ?? null;
    });
    expect(status).toBe("completed");
    ws.close();
  });

  it("sends delivery only to the current websocket after reconnect", async () => {
    const botId = `bot-delivery-reconnect-${crypto.randomUUID()}`;
    const first = await openConnection(botId);
    first.ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(first.ws, "ready");

    const second = await openConnection(botId);
    second.ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(second.ws, "ready");

    const payload = enqueuePayload({
      target_id: "target-current-session",
      request_json: JSON.stringify({
        channel_id: "channel-delivery",
        invocation_id: "target-current-session",
        command: { name: "ask" },
        invoker: { user_id: "user-delivery" },
      }),
    });
    const oldSocketIdle = noMessageOfType(first.ws, "delivery", 2000);
    const enq = await enqueueDelivery(first.stub, botId, payload);
    
    const deliveryFrame = JSON.parse(
      await nextMessageOfType(second.ws, "delivery"),
    ) as { invocation_id?: string };
    expect(deliveryFrame.invocation_id).toBe("target-current-session");
    await oldSocketIdle;
    first.ws.close();
    second.ws.close();
  });

  it("keeps disconnected enqueue rows pending", async () => {
    const botId = `bot-delivery-disconnected-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const payload = enqueuePayload({ outbox_id: "outbox-disconnected" });

    const res = await enqueueDelivery(stub, botId, payload);
    
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => { toArray: () => Array<{ status: string }> };
              };
            };
          };
        }
      ).ctx.storage.sql;
      const row = sql
        .exec(
          "SELECT status FROM bot_deliveries WHERE source_outbox_id=?",
          payload.outbox_id,
        )
        .toArray()[0];
      expect(row).toBeDefined();
      expect(row?.status).toBe("pending");
    });
  });

  it("dedupes repeated enqueue for the same source outbox", async () => {
    const botId = `bot-delivery-dedupe-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const payload = enqueuePayload({ outbox_id: `outbox-dedupe-${crypto.randomUUID()}` });

    const first = await enqueueDelivery(stub, botId, payload);
    const second = await enqueueDelivery(stub, botId, payload);
    expect(second.delivery_id).toBe(first.delivery_id);

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => { toArray: () => Array<{ c: number | bigint }> };
              };
            };
          };
        }
      ).ctx.storage.sql;
      const row = sql
        .exec(
          "SELECT COUNT(*) AS c FROM bot_deliveries WHERE bot_id=? AND source_outbox_id=?",
          botId,
          payload.outbox_id,
        )
        .toArray()[0];
      expect(Number(row?.c ?? 0)).toBe(1);
    });
  });

  it("closes stale connected state during enqueue when no websocket exists", async () => {
    const botId = `bot-delivery-stale-online-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const now = new Date().toISOString();
    await readDoSchemaVersion(stub);
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: { exec: (query: string, ...params: unknown[]) => void };
            };
          };
        }
      ).ctx.storage.sql;
      sql.exec(
        `INSERT INTO bot_connection_state (
          bot_id, session_id, status, connected_at, disconnected_at, last_seen_at, expires_at
        ) VALUES (?, ?, 'connected', ?, NULL, ?, ?)`,
        botId,
        "missing-session",
        now,
        now,
        new Date(Date.now() + 60000).toISOString(),
      );
    });

    const payload = enqueuePayload();
    const res = await enqueueDelivery(stub, botId, payload);
    const body = { status: res.status };
    expect(body.status).toBe("pending");

    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => { toArray: () => Array<{ status: string; delivery_status: string }> };
              };
            };
          };
        }
      ).ctx.storage.sql;
      const row = sql
        .exec(
          `SELECT c.status, d.status AS delivery_status
           FROM bot_connection_state c
           JOIN bot_deliveries d ON d.bot_id = c.bot_id
           WHERE c.bot_id=? AND d.source_outbox_id=?`,
          botId,
          payload.outbox_id,
        )
        .toArray()[0];
      expect(row?.status).toBe("disconnected");
      expect(row?.delivery_status).toBe("pending");
    });
  });

  it("redelivers both pending and sent deliveries from alarm", async () => {
    const botId = `bot-delivery-redeliver-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const outboxPending = `outbox-redeliver-pending-${crypto.randomUUID()}`;
    const outboxSent = `outbox-redeliver-sent-${crypto.randomUUID()}`;

    const payloadPending = enqueuePayload({
      outbox_id: outboxPending,
      target_id: "target-delivery-pending",
      request_json: JSON.stringify({
        channel_id: "channel-delivery",
        invocation_id: "target-delivery-pending",
        command: { name: "pending" },
        invoker: { user_id: "user-delivery" },
      }),
    });
    const payloadSent = enqueuePayload({
      outbox_id: outboxSent,
      target_id: "target-delivery-sent",
      request_json: JSON.stringify({
        channel_id: "channel-delivery",
        invocation_id: "target-delivery-sent",
        command: { name: "sent" },
        invoker: { user_id: "user-delivery" },
      }),
    });
    const enqPending = await enqueueDelivery(stub, botId, payloadPending);
    const enqSent = await enqueueDelivery(stub, botId, payloadSent);
        
    const { runInDurableObject } = await import("cloudflare:test");
    const out = {
      pending: { delivery_id: enqPending.delivery_id },
      sent: { delivery_id: enqSent.delivery_id },
    };
    await runInDurableObject(stub, async (instance: unknown) => {
      const nowDue = String(Date.now() - 1000);
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: { exec: (query: string, ...params: unknown[]) => void };
            };
          };
        }
      ).ctx.storage.sql;
      sql.exec(
        "UPDATE bot_deliveries SET status='sent', next_attempt_at=?, updated_at=? WHERE delivery_id=?",
        nowDue,
        new Date().toISOString(),
        out.sent.delivery_id,
      );
      sql.exec(
        "UPDATE bot_deliveries SET next_attempt_at=? WHERE delivery_id=?",
        nowDue,
        out.pending.delivery_id,
      );
    });

    const { ws } = await openConnection(botId);
    ws.send(
      JSON.stringify({
        type: "hello",
        api_version: BOT_GATEWAY_API_VERSION,
        last_received_delivery_id: null,
      }),
    );
    await nextMessageOfType(ws, "ready");

    const { runDurableObjectAlarm } = (await import("cloudflare:test")) as {
      runInDurableObject: (
        stub: unknown,
        cb: (instance: unknown) => Promise<void>,
      ) => Promise<void>;
      runDurableObjectAlarm: (stub: unknown) => Promise<void>;
    };
    await runDurableObjectAlarm(stub);

    const first = JSON.parse(await nextMessageOfType(ws, "delivery")) as {
      invocation_id: string;
    };
    const second = JSON.parse(await nextMessageOfType(ws, "delivery")) as {
      invocation_id: string;
    };
    expect(new Set([first.invocation_id, second.invocation_id])).toEqual(
      new Set(["target-delivery-pending", "target-delivery-sent"]),
    );
    ws.close();

    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => {
                  toArray: () => Array<{
                    status: string;
                    source_outbox_id: string;
                  }>;
                };
              };
            };
          };
        }
      ).ctx.storage.sql;
      const rows = sql
        .exec(
          "SELECT source_outbox_id, status FROM bot_deliveries WHERE bot_id=?",
          botId,
        )
        .toArray();
      const rowStatuses = new Map(
        rows.map((r) => [r.source_outbox_id, r.status] as const),
      );
      expect(rowStatuses.get(outboxPending)).toBe("sent");
      expect(rowStatuses.get(outboxSent)).toBe("sent");
    });
  });

  it("expires message_event deliveries when offline TTL passes", async () => {
    const botId = `bot-delivery-expire-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const { runInDurableObject, runDurableObjectAlarm } =
      (await import("cloudflare:test")) as {
        runInDurableObject: (
          stub: unknown,
          cb: (instance: unknown) => Promise<void>,
        ) => Promise<void>;
        runDurableObjectAlarm: (stub: unknown) => Promise<void>;
      };

    const payload = enqueuePayload({
      kind: "message_event",
      outbox_id: "outbox-event-expired",
      target_id: "target-event",
    });
    const enq = await enqueueDelivery(stub, botId, payload);
    const out = { delivery_id: enq.delivery_id };

    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => { toArray: () => never[] };
              };
            };
          };
        }
      ).ctx.storage.sql;
      sql.exec(
        "UPDATE bot_deliveries SET created_at=?, next_attempt_at=? WHERE delivery_id=?",
        new Date(Date.now() - 60_000).toISOString(),
        String(Date.now() - 60_000),
        out.delivery_id,
      );
    });

    await runDurableObjectAlarm(stub);

    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => { toArray: () => Array<{ status: string }> };
              };
            };
          };
        }
      ).ctx.storage.sql;
      const row = sql
        .exec(
          "SELECT status FROM bot_deliveries WHERE source_outbox_id='outbox-event-expired'",
        )
        .toArray()[0];
      expect(row).toBeDefined();
      expect(row?.status).toBe("expired");
    });
  });

  it("keeps offline message_event pending until TTL instead of failing retries", async () => {
    const botId = `bot-delivery-event-pending-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const { runInDurableObject, runDurableObjectAlarm } =
      (await import("cloudflare:test")) as {
        runInDurableObject: (
          stub: unknown,
          cb: (instance: unknown) => Promise<void>,
        ) => Promise<void>;
        runDurableObjectAlarm: (stub: unknown) => Promise<void>;
      };

    const payload = enqueuePayload({
      kind: "message_event",
      outbox_id: "outbox-event-pending",
      target_id: "target-event-pending",
    });
    const enq = await enqueueDelivery(stub, botId, payload);
    
    for (let i = 0; i < 4; i += 1) {
      await runInDurableObject(stub, async (instance: unknown) => {
        const sql = (
          instance as {
            ctx: {
              storage: {
                sql: { exec: (query: string, ...params: unknown[]) => void };
              };
            };
          }
        ).ctx.storage.sql;
        sql.exec(
          "UPDATE bot_deliveries SET next_attempt_at=? WHERE source_outbox_id=?",
          String(Date.now() - 1000),
          "outbox-event-pending",
        );
      });
      await runDurableObjectAlarm(stub);
    }

    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: {
                exec: (
                  query: string,
                  ...params: unknown[]
                ) => { toArray: () => Array<{ status: string }> };
              };
            };
          };
        }
      ).ctx.storage.sql;
      const row = sql
        .exec(
          "SELECT status FROM bot_deliveries WHERE source_outbox_id='outbox-event-pending'",
        )
        .toArray()[0];
      expect(row).toBeDefined();
      expect(row?.status).toBe("pending");
    });
  });

  it("retries command_invocation delivery and marks failed after max attempts", async () => {
    const botId = `bot-delivery-retry-${crypto.randomUUID()}`;
    const stub = botConnectionStub(botId);
    const { runInDurableObject, runDurableObjectAlarm } =
      (await import("cloudflare:test")) as {
        runInDurableObject: (
          stub: unknown,
          cb: (instance: unknown) => Promise<void>,
        ) => Promise<void>;
        runDurableObjectAlarm: (stub: unknown) => Promise<void>;
      };

    const payload = enqueuePayload({
      kind: "command_invocation",
      outbox_id: "outbox-command-retry",
      target_id: "target-retry",
    });
    const enq = await enqueueDelivery(stub, botId, payload);
    const out = { delivery_id: enq.delivery_id };
    const nowIso = new Date().toISOString();

    await runInDurableObject(stub, async (instance: unknown) => {
      const sql = (
        instance as {
          ctx: {
            storage: {
              sql: { exec: (query: string, ...params: unknown[]) => void };
            };
          };
        }
      ).ctx.storage.sql;
      sql.exec(
        "UPDATE bot_deliveries SET next_attempt_at=?, created_at=?, updated_at=? WHERE delivery_id=?",
        String(Date.now() - 1000),
        new Date(Date.now() - 1000).toISOString(),
        nowIso,
        out.delivery_id,
      );
    });

    let status = "pending";
    for (let i = 0; i < 8; i++) {
      await runDurableObjectAlarm(stub);
      await runInDurableObject(stub, async (instance: unknown) => {
        const sql = (
          instance as {
            ctx: {
              storage: {
                sql: {
                  exec: (
                    query: string,
                    ...params: unknown[]
                  ) => { toArray: () => Array<{ status: string; delivery_id: string }> };
                };
              };
            };
          }
        ).ctx.storage.sql;
        status =
          sql
            .exec(
              "SELECT status FROM bot_deliveries WHERE source_outbox_id='outbox-command-retry'",
            )
            .toArray()[0]?.status ?? "missing";

        if (status === "pending") {
          const row = sql
            .exec(
              "SELECT delivery_id FROM bot_deliveries WHERE source_outbox_id='outbox-command-retry'",
            )
            .toArray()[0];
          expect(row).toBeDefined();
          sql.exec(
            "UPDATE bot_deliveries SET next_attempt_at=? WHERE delivery_id=?",
            String(Date.now() - 1000),
            row?.delivery_id,
          );
        }
      });
      if (status === "failed") break;
    }

    expect(status).toBe("failed");
  });
});
