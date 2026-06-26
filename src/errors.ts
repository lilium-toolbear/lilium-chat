export const HTTP_STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  MACHINE_TOKEN_NOT_ALLOWED: 401,
  SESSION_NOT_ALLOWED: 403,
  FORBIDDEN: 403,
  CHANNEL_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  INVITE_NOT_AVAILABLE: 409,
  CHANNEL_ARCHIVED: 409,
  CHANNEL_DISSOLVED: 409,
  MESSAGE_NOT_EDITABLE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ROUTE_INDEX_PENDING: 409,
  ATTACHMENT_TOO_LARGE: 413,
  UNSUPPORTED_ATTACHMENT_TYPE: 415,
  INVALID_MESSAGE: 422,
  INVALID_MEMBER_ROLE: 422,
  INVALID_STICKER_SOURCE: 422,
  COMMAND_NAME_CONFLICT: 409,
  COMMAND_NOT_FOUND: 404,
  INVALID_COMMAND_OPTIONS: 422,
  COMPONENT_NOT_FOUND: 404,
  COMPONENT_DISABLED: 409,
  INVALID_INTERACTION_VALUE: 422,
  RATE_LIMITED: 429,
  BOT_CALLBACK_UNAVAILABLE: 503,
  BOT_OFFLINE: 503,
  BOT_NOT_FOUND: 404,
  BOT_COMMAND_DISABLED: 409,
  BOT_EFFECT_INVALID: 422,
  BOT_EFFECT_CONFLICT: 409,
  CHAT_WORKER_UNAVAILABLE: 503,
  EVENT_GAP: 409,
  SESSION_NOT_LIVE: 409,
  STICKER_NOT_FOUND: 404,
  STICKER_LIBRARY_LIMIT_EXCEEDED: 409,
};

const RETRYABLE_CODES = new Set([
  "CHAT_WORKER_UNAVAILABLE",
  "ROUTE_INDEX_PENDING",
  "RATE_LIMITED",
  "BOT_CALLBACK_UNAVAILABLE",
  "BOT_OFFLINE",
]);

export class ApiError extends Error {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus: number;
  constructor(code: string, message: string, opts?: { retryable?: boolean; httpStatus?: number }) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.message = message;
    this.retryable = opts?.retryable ?? RETRYABLE_CODES.has(code);
    this.httpStatus = opts?.httpStatus ?? HTTP_STATUS_BY_CODE[code] ?? 500;
  }
}

export function errorResponse(err: ApiError, requestId: string): Response {
  return new Response(
    JSON.stringify({
      error: { code: err.code, message: err.message, retryable: err.retryable },
      request_id: requestId,
    }),
    {
      status: err.httpStatus,
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
      },
    },
  );
}
