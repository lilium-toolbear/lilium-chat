# Task 3 Report: `session.effects` / `session.effects_ack`

## Critical review fix: effect_seq replay idempotency

**Problem:** When `effect_seq <= effect_last_acked_seq`, `bot-session-effects-handlers` still called `applyValidatedEffects`, allowing duplicate side effects when the bot retried with new `client_effect_id` values (bypassing per-effect `bot_effects_applied` idempotency).

**Fix:**
- On replay (`effect_seq <= effect_last_acked_seq`): skip `applyValidatedEffects`; load stored ack from `stateful_session_effects_applied` keyed by `(session_id, effect_seq)`.
- Compare semantic effects snapshot (hash excludes `client_effect_id`); mismatch → `BOT_EFFECT_CONFLICT`.
- On first apply: persist `effects_request_hash` + `effect_results_json` atomically with `effect_last_acked_seq` bump.
- Schema: new `stateful_session_effects_applied` table (migration `2026070101`).

**Tests added/updated:**
- `replays ack without re-applying when effect_seq <= effect_last_acked_seq` — resend `effect_seq=1` with different `client_effect_id`, same message body → one channel message, same `message_id` in ack.
- `rejects replay when effect_seq body differs from stored snapshot` — different message text → `BOT_EFFECT_CONFLICT`.

**Targeted test run (post-fix):**
```
npm test -- test/do/chat-channel-session-effects.test.ts test/do/bot-connection-session-effects.test.ts test/chat/bot-gateway-session-effects.test.ts
```
Result: **3 files, 11 tests — all passed**

**Commit:** `fix(bot): replay session.effects without re-applying`
