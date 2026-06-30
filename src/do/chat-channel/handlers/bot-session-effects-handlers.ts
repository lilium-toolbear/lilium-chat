import type { BotEffectWire } from "../../../contract/bot-gateway";
import type { BotSessionEffectsInput, BotSessionEffectsResponse } from "../../../contract/bot-api";
import { ApiError } from "../../../errors";
import {
  applyValidatedEffects,
  finalizeAppliedEffects,
  statefulSessionEffectOutboxId,
} from "./apply-bot-effects";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef } from "../handler-ref";

function sessionEffectsRejected(code: string, message: string): BotSessionEffectsResponse {
  return { status: "rejected", error: { code, message } };
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
      if (!isReplay) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "UPDATE stateful_command_sessions SET effect_last_acked_seq=? WHERE session_id=? AND effect_last_acked_seq=?",
            body.effect_seq,
            body.session_id,
            lastAcked,
          );
        });
      }

      await finalizeAppliedEffects(asHandlerRef(this), this.env, applyResult, now);
      return { status: "applied", effect_results: applyResult.effect_results };
    }
  };
}
