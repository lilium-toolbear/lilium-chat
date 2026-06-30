import type { BotEffectWire } from "../../../contract/bot-gateway";
import type { EffectResult } from "../../../contract/bot-gateway";
import type { BotSessionEffectsInput, BotSessionEffectsResponse } from "../../../contract/bot-api";
import { computeSessionEffectsRequestHash } from "../../../chat/bot-effects";
import { ApiError } from "../../../errors";
import {
  applyValidatedEffects,
  finalizeAppliedEffects,
  rebuildFinalizePayloadFromEffectResults,
  statefulSessionEffectOutboxId,
} from "./apply-bot-effects";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef } from "../handler-ref";

function sessionEffectsRejected(code: string, message: string): BotSessionEffectsResponse {
  return { status: "rejected", error: { code, message } };
}

function loadStoredSessionEffectAck(
  sql: DurableObjectStorage["sql"],
  sessionId: string,
  effectSeq: number,
): { effects_request_hash: string; effect_results_json: string; finalize_completed_at: string | null } | undefined {
  return sql
    .exec(
      `SELECT effects_request_hash, effect_results_json, finalize_completed_at
       FROM stateful_session_effects_applied
       WHERE session_id=? AND effect_seq=?`,
      sessionId,
      effectSeq,
    )
    .toArray()[0] as
    | { effects_request_hash: string; effect_results_json: string; finalize_completed_at: string | null }
    | undefined;
}

function parseStoredEffectResults(raw: string): EffectResult[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EffectResult[]) : null;
  } catch {
    return null;
  }
}

function markSessionEffectFinalizeCompleted(
  sql: DurableObjectStorage["sql"],
  sessionId: string,
  effectSeq: number,
  completedAt: string,
): void {
  sql.exec(
    "UPDATE stateful_session_effects_applied SET finalize_completed_at=? WHERE session_id=? AND effect_seq=?",
    completedAt,
    sessionId,
    effectSeq,
  );
}

async function ensureStoredSessionEffectFinalizeCompleted(
  channel: ReturnType<typeof asHandlerRef>,
  env: Env,
  input: {
    sessionId: string;
    effectSeq: number;
    channelId: string;
    effectResults: EffectResult[];
    finalizeCompletedAt: string | null;
  },
): Promise<void> {
  if (input.finalizeCompletedAt) return;

  const finalizePayload = rebuildFinalizePayloadFromEffectResults(
    channel,
    input.channelId,
    input.effectResults,
  );
  const now = channel.nowIso();
  await finalizeAppliedEffects(
    channel,
    env,
    {
      status: "applied",
      effect_results: input.effectResults,
      ...finalizePayload,
    },
    now,
  );
  channel.ctx.storage.transactionSync(() => {
    markSessionEffectFinalizeCompleted(
      channel.ctx.storage.sql,
      input.sessionId,
      input.effectSeq,
      now,
    );
  });
}

export function BotSessionEffectsMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async botSessionEffects(body: BotSessionEffectsInput): Promise<BotSessionEffectsResponse> {
      if (
        typeof body.session_id !== "string" ||
        typeof body.bot_id !== "string" ||
        typeof body.effect_seq !== "number" ||
        !Array.isArray(body.effects)
      ) {
        throw new ApiError("INVALID_MESSAGE", "invalid payload", { httpStatus: 400 });
      }

      const sessionRow = this.ctx.storage.sql
        .exec(
          `SELECT session_id, channel_id, bot_id, status, effect_last_acked_seq
           FROM stateful_command_sessions WHERE session_id=?`,
          body.session_id,
        )
        .toArray()[0] as
        | {
            session_id: string;
            channel_id: string;
            bot_id: string;
            status: string;
            effect_last_acked_seq: number;
          }
        | undefined;

      if (!sessionRow) {
        return sessionEffectsRejected("STATEFUL_SESSION_NOT_FOUND", "session not found");
      }
      if (sessionRow.bot_id !== body.bot_id) {
        return sessionEffectsRejected("BOT_EFFECT_INVALID", "session bot mismatch");
      }
      if (sessionRow.status !== "active") {
        return sessionEffectsRejected("STATEFUL_SESSION_NOT_ACTIVE", "session is not active");
      }

      const meta = this.repo.soleChannelMetaKindStreamGate();
      if (!meta || meta.channel_id !== sessionRow.channel_id) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not found", { httpStatus: 404 });
      }
      if (meta.kind === "dm") {
        return sessionEffectsRejected(
          "UNSUPPORTED_CHANNEL_KIND",
          "operation not supported for DM channels",
        );
      }
      const dissolved = this.assertNotDissolved(meta.status);
      if (dissolved) {
        return sessionEffectsRejected(dissolved.code, dissolved.message);
      }

      const lastAcked = sessionRow.effect_last_acked_seq;
      const isReplay = body.effect_seq <= lastAcked;
      if (!isReplay && body.effect_seq !== lastAcked + 1) {
        return sessionEffectsRejected("BOT_EFFECT_INVALID", "effect sequence gap");
      }

      const effectsRequestHash = computeSessionEffectsRequestHash(body.effects as BotEffectWire[]);

      if (isReplay) {
        const stored = loadStoredSessionEffectAck(
          this.ctx.storage.sql,
          body.session_id,
          body.effect_seq,
        );
        if (!stored) {
          return sessionEffectsRejected("BOT_EFFECT_INVALID", "effect ack not found");
        }
        if (stored.effects_request_hash !== effectsRequestHash) {
          return sessionEffectsRejected(
            "BOT_EFFECT_CONFLICT",
            "effect_seq reused with different body",
          );
        }
        const effectResults = parseStoredEffectResults(stored.effect_results_json);
        if (!effectResults) {
          return sessionEffectsRejected("BOT_EFFECT_INVALID", "stored effect ack invalid");
        }
        await ensureStoredSessionEffectFinalizeCompleted(asHandlerRef(this), this.env, {
          sessionId: body.session_id,
          effectSeq: body.effect_seq,
          channelId: sessionRow.channel_id,
          effectResults,
          finalizeCompletedAt: stored.finalize_completed_at,
        });
        return { status: "applied", effect_results: effectResults };
      }

      const outboxId = statefulSessionEffectOutboxId(body.session_id, body.effect_seq);
      const applyResult = await applyValidatedEffects({
        channel: asHandlerRef(this),
        env: this.env,
        channelId: sessionRow.channel_id,
        botId: body.bot_id,
        outboxId,
        effects: body.effects as BotEffectWire[],
        membershipVersion: meta.membership_version,
      });

      if (applyResult.status === "failed") {
        return sessionEffectsRejected(applyResult.error.code, applyResult.error.message);
      }

      const now = this.nowIso();
      await finalizeAppliedEffects(asHandlerRef(this), this.env, applyResult, now);

      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE stateful_command_sessions SET effect_last_acked_seq=? WHERE session_id=? AND effect_last_acked_seq=?",
          body.effect_seq,
          body.session_id,
          lastAcked,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO stateful_session_effects_applied (
             session_id, effect_seq, effects_request_hash, effect_results_json, applied_at, finalize_completed_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          body.session_id,
          body.effect_seq,
          effectsRequestHash,
          JSON.stringify(applyResult.effect_results),
          now,
          now,
        );
      });

      return { status: "applied", effect_results: applyResult.effect_results };
    }
  };
}
