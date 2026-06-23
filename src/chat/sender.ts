import type { Env } from "../env";
import { resolveUserSummaries, type UserSummary } from "../profile/resolve";

export interface RawMessage {
  message_id: string;
  client_message_id: string;
  channel_id: string;
  sender: {
    kind: string;
    user_id: string | null;
    bot_id: string | null;
  };
  type: string;
  format: string;
  status: string;
  text: string | null;
  reply_to: string | null;
  reply_snapshot: unknown;
  stream_state: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  recalled_at: string | null;
  attachments: unknown[];
  components: unknown[];
  mentions: unknown[];
}

export interface ContractMessage {
  message_id: string;
  client_message_id: string;
  channel_id: string;
  sender: {
    kind: "user";
    user: UserSummary;
  } | {
    kind: "bot";
    bot: { bot_id: string; display_name: string; avatar_url: string | null };
  };
  type: string;
  format: string;
  status: string;
  text: string | null;
  reply_to: string | null;
  reply_snapshot: unknown;
  stream_state: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  recalled_at: string | null;
  attachments: unknown[];
  components: unknown[];
  mentions: unknown[];
}

function fallbackSummary(uid: string): UserSummary {
  return {
    user_id: uid,
    display_name: `user-${uid.slice(0, 8)}`,
    avatar_url: null,
  };
}

export async function attachSummaries(raw: RawMessage[], env: Env): Promise<ContractMessage[]> {
  const userIds = [...new Set(raw.filter((m) => m.sender.kind === "user" && m.sender.user_id).map((m) => m.sender.user_id as string))];
  const map = await resolveUserSummaries(userIds, env);

  return raw.map((m) => {
    let sender: ContractMessage["sender"];
    if (m.sender.kind === "bot") {
      // ponytail: bot resolution deferred to Phase 7; keep phase-1 placeholder stable.
      sender = { kind: "bot", bot: { bot_id: m.sender.bot_id ?? "", display_name: "bot", avatar_url: null } };
    } else {
      const uid = m.sender.user_id ?? "";
      sender = { kind: "user", user: map.get(uid) ?? fallbackSummary(uid) };
    }
    return { ...m, sender };
  });
}
