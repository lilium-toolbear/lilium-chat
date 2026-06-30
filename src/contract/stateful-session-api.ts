import type { UserSummary } from "./primitives";
import type { WireChatMessage } from "./message";

export interface StatefulSessionActiveSummary {
  session_id: string;
  bot_command_id: string;
  command_name: string;
  status: string;
  started_by: UserSummary;
  started_at: string;
  expires_at: string;
}

export interface GetStatefulSessionResponse {
  active_session: StatefulSessionActiveSummary | null;
}

export interface StopStatefulSessionResponse {
  session_id: string;
}

export interface StatefulSessionRefSummary {
  session_id: string;
  channel_id: string;
  bot_id: string;
  status: string;
}

export interface StatefulSessionInputItem {
  seq: number;
  event_id: string;
  event_type: string;
  occurred_at: string;
  message: WireChatMessage;
}

export interface StatefulSessionInputsResponse {
  session: StatefulSessionRefSummary;
  inputs: StatefulSessionInputItem[];
}
