import type { BotEffectWire } from "../../../contract/bot-gateway";
import type { BotDeliveryResultInput, BotDeliveryResultResponse } from "../../../contract/bot-api";
import { ApiError } from "../../../errors";
import {
  applyValidatedEffects,
  finalizeAppliedEffects,
  resolveInteractionDeliveryContext,
} from "./apply-bot-effects";
import type { Constructor } from "../mixin";
import { ChatChannelCore } from "../core";
import { asHandlerRef } from "../handler-ref";

function botDeliveryFailed(code: string, message: string): BotDeliveryResultResponse {
  return { status: "failed", error: { code, message } };
}

export function BotDeliveryMixin<T extends Constructor<ChatChannelCore>>(Base: T) {
  return class extends Base {
    async botDeliveryResult(body: BotDeliveryResultInput): Promise<BotDeliveryResultResponse> {
      if (
        typeof body.delivery_id !== "string" ||
        typeof body.outbox_id !== "string" ||
        typeof body.bot_id !== "string" ||
        typeof body.channel_id !== "string" ||
        !Array.isArray(body.effects)
      ) {
        throw new ApiError("INVALID_MESSAGE", "invalid payload", { httpStatus: 400 });
      }

      const deliveryId = body.delivery_id;
      const outboxId = body.outbox_id;
      const botId = body.bot_id;
      const channelId = body.channel_id;

      const meta = this.repo.soleChannelMetaKindStreamGate();
      if (!meta || meta.channel_id !== channelId) {
        throw new ApiError("CHANNEL_NOT_FOUND", "channel not found", { httpStatus: 404 });
      }
      if (meta.kind === "dm") {
        throw new ApiError("UNSUPPORTED_CHANNEL_KIND", "operation not supported for DM channels", {
          httpStatus: 409,
        });
      }
      const dissolved = this.assertNotDissolved(meta.status);
      if (dissolved) {
        throw new ApiError(dissolved.code, dissolved.message, { httpStatus: 409 });
      }

      const interactionDeliveryContext = resolveInteractionDeliveryContext(
        asHandlerRef(this),
        outboxId,
        meta.membership_version,
      );

      const effects = body.effects as BotEffectWire[];
      const applyResult = await applyValidatedEffects({
        channel: asHandlerRef(this),
        env: this.env,
        channelId,
        botId,
        outboxId,
        effects,
        membershipVersion: meta.membership_version,
        interactionDeliveryContext,
      });

      if (applyResult.status === "failed") {
        if (applyResult.error.code === "BOT_EFFECT_CONFLICT") {
          throw new ApiError("BOT_EFFECT_CONFLICT", applyResult.error.message, { httpStatus: 409 });
        }
        return botDeliveryFailed(applyResult.error.code, applyResult.error.message);
      }

      const now = this.nowIso();
      await finalizeAppliedEffects(asHandlerRef(this), this.env, applyResult, now);
      return { status: "applied", effect_results: applyResult.effect_results };
    }
  };
}
