import { SliceApiError, codeForStatus, isApiErrorCode } from "./errors.js";
import { parseServerTiming } from "./server-timing.js";
import type { CasUploadResult, EvalRequest, SandboxResult } from "./types.js";
import type { Backend, EvalCallOptions, EvalSandboxResult } from "./client.js";

export const DEFAULT_BASE_URL = "https://api.slicevm.com";
const MAX_RETRIES = 3;
/** `429 rate_limited` (burst bucket or runs in flight) clears within seconds; wait longer for it. */
const RATE_LIMIT_RETRIES = 8;
const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 5_000;

export interface RemoteConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter; honors a `Retry-After` header in seconds when present. */
function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_MAX_MS);
  const base = RETRY_BASE_MS * 2 ** attempt;
  return Math.min(base + Math.random() * base * 0.25, RETRY_MAX_MS);
}

async function toApiError(res: Response): Promise<SliceApiError> {
  const requestId = res.headers.get("x-slice-request-id");
  let code = codeForStatus(res.status);
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (isApiErrorCode(body?.error?.code)) code = body.error.code;
    if (typeof body?.error?.message === "string") message = body.error.message;
  } catch {
    // Non-JSON body (proxy or load balancer page): keep the status-derived code.
  }
  return new SliceApiError(code, message, res.status, requestId);
}

// A loop instead of /\/+$/, which backtracks quadratically on long runs of slashes.
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

export class RemoteBackend implements Backend {
  readonly mode = "remote" as const;
  readonly #config: RemoteConfig;

  constructor(config: RemoteConfig) {
    this.#config = { ...config, baseUrl: trimTrailingSlashes(config.baseUrl) };
  }

  async #post(path: string, body: string | Uint8Array | ArrayBuffer, contentType: string): Promise<Response> {
    const url = `${this.#config.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#config.apiKey}`,
            "content-type": contentType,
            accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.#config.timeoutMs),
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new SliceApiError("timeout", `request to ${path} timed out after ${this.#config.timeoutMs} ms`, 0, null, { cause: err });
        }
        throw new SliceApiError("network_error", `request to ${path} failed: ${(err as Error)?.message ?? err}`, 0, null, { cause: err });
      }
      if (res.status === 503 && attempt < MAX_RETRIES) {
        await res.body?.cancel().catch(() => {});
        await sleep(retryDelay(attempt, res.headers.get("retry-after")));
        continue;
      }
      if (res.status === 429) {
        const err = await toApiError(res);
        if (err.code === "rate_limited" && attempt < RATE_LIMIT_RETRIES) {
          await sleep(retryDelay(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw err;
      }
      if (!res.ok) throw await toApiError(res);
      return res;
    }
  }

  async evalSandbox(code: string, options: EvalCallOptions = {}): Promise<EvalSandboxResult> {
    const { casDigest, ...sandboxOptions } = options;
    const request: EvalRequest = { code };
    if (casDigest !== undefined) request.casDigest = casDigest;
    if (Object.keys(sandboxOptions).length > 0) request.options = sandboxOptions;

    const res = await this.#post("/v1/sandbox/eval", JSON.stringify(request), "application/json");
    const body = (await res.json()) as SandboxResult;
    return {
      ...body,
      requestId: res.headers.get("x-slice-request-id"),
      serverTiming: parseServerTiming(res.headers.get("server-timing")),
    };
  }

  async uploadCas(bytes: Uint8Array | ArrayBuffer): Promise<CasUploadResult> {
    const res = await this.#post("/v1/cas/upload", bytes, "application/octet-stream");
    return (await res.json()) as CasUploadResult;
  }

  async close(): Promise<void> {
    // Stateless: nothing to release.
  }
}
