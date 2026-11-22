// Wire types from docs/architecture/01-api-contract.md. Keep in lockstep with the gateway.

/** Per-call sandbox options (`EvalRequest.options`). */
export interface SandboxEvalOptions {
  /** Deterministic instruction fuel. Default 25,000,000, capped by plan. */
  fuel?: number;
  /** Memory cage in kilobytes. Default 4,096, capped by plan. */
  memoryKb?: number;
  /** Allowed egress hosts (`host` or `host:port`). Default [] (deny all). */
  allowNet?: string[];
  /** Secrets blocked across raw, Base64 and Base64URL egress. */
  auditEgress?: string[];
  /** Seeds the PRNG and virtual clock. */
  deterministicSeed?: number;
  /** Allow guest Slice.checkpoint() / Slice.restore() (at most 1,024 per run). Default true. */
  checkpoints?: boolean;
}

export interface SandboxTelemetry {
  /** SliceIsolate::spawn wall time. */
  coldBootUs: number;
  /** .cas archive mmap + index time (0 when no casDigest). */
  casMmapUs: number;
  /** Bytecode execution wall time. */
  vmExecUs: number;
  /** Mean checkpoint restore time (0 when no rollbacks happened). */
  rollbackUs: number;
  /** Full server-side handling time, parse to serialize. */
  totalUs: number;
  /** Deterministic instruction fuel used. */
  fuelConsumed: number;
  /** Peak caged heap usage. */
  peakMemoryKb: number;
  /** e.g. "pkey_02", or "none" on hosts without Intel MPK. */
  mpkDomain: string;
  /** Checkpoints taken during the run. */
  checkpoints: number;
  /** Restores performed during the run. */
  rollbacks: number;
}

export interface SandboxResult {
  ok: boolean;
  stdout: string[];
  /** Return value parsed as JSON when possible, else the raw string. */
  result: unknown;
  /** e.g. "EgressDlpViolation: ..." when the sandbox trapped. */
  violation: string | null;
  /** Set when the guest called process.exit(n) or set process.exitCode; non-zero means ok is false. */
  exitCode?: number;
  telemetry: SandboxTelemetry;
}

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "payload_too_large"
  | "rate_limited"
  | "quota_exceeded"
  | "overloaded"
  | "not_found"
  | "internal";

/** Error body returned by the API for every non-2xx response. */
export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

/** `POST /v1/sandbox/eval` request body. */
export interface EvalRequest {
  code: string;
  casDigest?: string;
  options?: SandboxEvalOptions;
}

/** `POST /v1/cas/upload` response body. */
export interface CasUploadResult {
  casDigest: string;
  bytes: number;
  modules: number;
}

/** One metric from a `Server-Timing` header. `dur` is in milliseconds per the W3C spec. */
export interface ServerTimingEntry {
  name: string;
  dur?: number;
  desc?: string;
}
