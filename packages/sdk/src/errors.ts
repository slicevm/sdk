import type { ApiErrorCode } from "./types.js";

/**
 * Codes produced by the client itself, never sent by the API:
 * - `timeout`: the request exceeded `timeoutMs`
 * - `network_error`: fetch failed before an HTTP response arrived
 * - `local_runtime_error`: the local `slice mcp` process failed or exited
 * - `unsupported`: the operation or option is not available in the current mode
 */
export type ClientErrorCode = "timeout" | "network_error" | "local_runtime_error" | "unsupported";

export type SliceErrorCode = ApiErrorCode | ClientErrorCode;

const API_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  "bad_request",
  "unauthorized",
  "forbidden",
  "payload_too_large",
  "rate_limited",
  "quota_exceeded",
  "overloaded",
  "not_found",
  "internal",
]);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && API_CODES.has(value);
}

/** Fallback when the body is not a valid `ApiError` (e.g. a proxy error page). */
export function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    case 503:
      return "overloaded";
    default:
      return "internal";
  }
}

/** Typed error thrown by every client method. */
export class SliceApiError extends Error {
  override readonly name = "SliceApiError";
  /** Contract error code, or a client-side code (see `ClientErrorCode`). */
  readonly code: SliceErrorCode;
  /** HTTP status, or 0 when no HTTP response was received. */
  readonly status: number;
  /** Value of `X-Slice-Request-Id`, when the server sent one. */
  readonly requestId: string | null;

  constructor(code: SliceErrorCode, message: string, status = 0, requestId: string | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}
