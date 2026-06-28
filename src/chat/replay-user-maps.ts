import type { UserSummary as LiveUserSummary } from "./event-broadcast";
import { fallbackUserDisplayName } from "../contract/primitives";

export function buildLiveUserMaps(rawMap: Map<string, { user_id: string; display_name: string | null; avatar_url: string | null }>): {
  liveMap: Map<string, LiveUserSummary>;
  liveSenderMap: Map<string, LiveUserSummary>;
} {
  const liveSenderMap = new Map<string, LiveUserSummary>();
  const liveMap = new Map<string, LiveUserSummary>();
  for (const [id, summary] of rawMap) {
    const resolved = {
      user_id: summary.user_id,
      display_name: summary.display_name ?? fallbackUserDisplayName(id),
      avatar_url: summary.avatar_url,
    };
    liveMap.set(id, resolved);
    liveSenderMap.set(id, resolved);
  }
  return { liveMap, liveSenderMap };
}
