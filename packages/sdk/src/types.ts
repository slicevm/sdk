// Wire types from docs/architecture/01-api-contract.md. Keep in lockstep with the gateway.

/** Per-call sandbox options (`EvalRequest.options`). */
export interface SandboxEvalOptions {
  /**
   * Fuel: guest steps, function calls and work inside built-ins. Cloud: default and maximum
   * are the plan's. Local mode: default 25,000,000.
   */
  fuel?: number;
  /** Memory cage in kilobytes; every object, array and string counts. Cloud: default and maximum are the plan's. Local mode: default 4,096. */
  memoryKb?: number;
  /**
   * Wall-clock limit of the run in milliseconds (runtime 0.14.3). Cloud: default and maximum are
   * the plan's (Free 10,000, Pro 30,000, Scale 60,000). Not the client's `timeoutMs`, which
   * bounds the whole request.
   */
  timeoutMs?: number;
  /** Allowed egress hosts (`host` or `host:port`). Default [] (deny all). */
  allowNet?: string[];
  /** Secrets blocked across raw, Base64 and Base64URL egress. */
  auditEgress?: string[];
  /** Seeds the PRNG and virtual clock. */
  deterministicSeed?: number;
  /** Allow guest Slice.checkpoint() / Slice.restore() (at most 1,024 per run). Default true. */
  checkpoints?: boolean;
  /**
   * Files the code writes under `/artifacts` come back in `result.artifacts` (runtime 0.15,
   * gateway 0.7.0). Default `true` (same as `"inline"`); `false` or `"none"` leaves `/artifacts`
   * unavailable, so writes there are refused like any other path.
   */
  artifacts?: boolean | "inline" | "none";
}

/** One file the run wrote under `/artifacts`. */
export interface Artifact {
  /** Path relative to `/artifacts`, with forward slashes, e.g. `charts/revenue.png`. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Sniffed from the bytes (extension as a hint); `application/octet-stream` when unknown. */
  contentType: string;
  /** SHA-256 of the bytes, lowercase hex. */
  sha256: string;
  /** The bytes, Base64. */
  data: string;
}

/** Why a file under `/artifacts` was not returned. */
export type ArtifactSkipReason = "symlink" | "tooLarge" | "overTotal" | "tooMany" | "pathTooLong" | "auditedSecret";

export interface SkippedArtifact {
  path: string;
  reason: ArtifactSkipReason;
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
  /** The fuel, memory and time the run got after defaults and plan caps (cloud, gateway 0.6.0). */
  limits?: { fuel: number; memoryKb: number; timeoutMs: number };
  /**
   * Requested limits that were above the plan and were reduced, as asked, e.g. `{ memoryKb: 131072 }`
   * on Free (cloud, gateway 0.6.3). Absent when nothing was reduced; `limits` holds what the run got.
   */
  limitsCapped?: { fuel?: number; memoryKb?: number; timeoutMs?: number };
  /** Capability attempts the sandbox refused, including ones the code caught (runtime 0.14.3). */
  deniedCapabilities?: string[];
  /** Files written under `/artifacts`, sorted by name; absent when there are none. */
  artifacts?: Artifact[];
  /** Files under `/artifacts` that were not returned (over a cap, a symlink, an audited secret). */
  skippedArtifacts?: SkippedArtifact[];
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
