import { SliceApiError } from "./errors.js";
import { LocalBackend } from "./local.js";
import { DEFAULT_BASE_URL, RemoteBackend } from "./remote.js";
import type { CasUploadResult, SandboxEvalOptions, SandboxResult, ServerTimingEntry } from "./types.js";

export interface CreateSliceOptions {
  /** API key for the hosted API. Falls back to `process.env.SLICE_API_KEY`. */
  apiKey?: string;
  /** Hosted API origin. Default `https://api.slicevm.com`. */
  baseUrl?: string;
  /** Force local mode even when an API key is available. */
  local?: boolean;
  /** Local mode: path to the `slice` binary. Default: `SLICE_BINARY_PATH`, then the `@slicevm/cli` resolver. */
  binaryPath?: string;
  /**
   * Local mode: extra flags for `slice mcp`, applied to the whole process,
   * e.g. `["--allow-net=api.example.com", "--audit-egress=sk_live_123"]`.
   */
  localArgs?: string[];
  /** Per-request timeout in milliseconds. Default 30,000. */
  timeoutMs?: number;
}

/** Per-call options: the contract's `SandboxEvalOptions` plus the top-level `casDigest`. */
export interface EvalCallOptions extends SandboxEvalOptions {
  /** 64 hex digest of a bundle uploaded with `uploadCas` (remote mode only). */
  casDigest?: string;
}

/** `SandboxResult` plus transport metadata. */
export interface EvalSandboxResult extends SandboxResult {
  /** `X-Slice-Request-Id` in remote mode; a local sequence id (`local_<n>`) in local mode. */
  requestId: string | null;
  /** Parsed `Server-Timing` header in remote mode; empty in local mode. */
  serverTiming: ServerTimingEntry[];
}

export interface SliceClient {
  readonly mode: "local" | "remote";
  evalSandbox(code: string, options?: EvalCallOptions): Promise<EvalSandboxResult>;
  /** Uploads a `.cas` bundle produced by `slice pack`. Remote mode only. */
  uploadCas(bytes: Uint8Array | ArrayBuffer): Promise<CasUploadResult>;
  /** Releases resources (stops the local `slice mcp` process). Safe to call twice. */
  close(): Promise<void>;
}

/** Internal interface implemented by the local and remote transports. */
export interface Backend {
  readonly mode: "local" | "remote";
  evalSandbox(code: string, options?: EvalCallOptions): Promise<EvalSandboxResult>;
  uploadCas(bytes: Uint8Array | ArrayBuffer): Promise<CasUploadResult>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Creates a client. Mode selection:
 * 1. `local: true` forces local mode.
 * 2. Otherwise remote when `apiKey` or `SLICE_API_KEY` is set.
 * 3. Otherwise local.
 */
export function createSlice(options: CreateSliceOptions = {}): SliceClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey ?? process.env.SLICE_API_KEY;
  const backend: Backend =
    !options.local && apiKey
      ? new RemoteBackend({ apiKey, baseUrl: options.baseUrl ?? DEFAULT_BASE_URL, timeoutMs })
      : new LocalBackend({ binaryPath: options.binaryPath, args: options.localArgs ?? [], timeoutMs });

  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new SliceApiError("unsupported", "client is closed");
  };

  return {
    mode: backend.mode,
    async evalSandbox(code, callOptions) {
      ensureOpen();
      if (typeof code !== "string" || code.length === 0) {
        throw new SliceApiError("bad_request", "code must be a non-empty string");
      }
      return backend.evalSandbox(code, callOptions);
    },
    async uploadCas(bytes) {
      ensureOpen();
      return backend.uploadCas(bytes);
    },
    async close() {
      if (closed) return;
      closed = true;
      await backend.close();
    },
  };
}
