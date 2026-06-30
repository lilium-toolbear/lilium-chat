/** Bot stream buffer / fanout tuning (spec §5). */
export const WS_ATTACHMENT_MAX_BYTES = 16_384;
export const STREAM_PENDING_FLUSH_THRESHOLD_BYTES = 8_192;
export const STREAM_FANOUT_INTERVAL_MS = 100;
export const STREAM_FANOUT_MAX_PENDING_BYTES = 4_096;
export const STREAM_ACK_FLUSH_INTERVAL_MS = 250;
export const STREAM_DEFAULT_TTL_SECONDS = 300;
