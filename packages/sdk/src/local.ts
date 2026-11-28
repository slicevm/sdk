// Local mode: one long-lived `slice mcp` child per client, JSON-RPC 2.0 over
// newline-delimited stdio, requests multiplexed by id.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SliceApiError } from "./errors.js";
import type { Backend, EvalCallOptions, EvalSandboxResult } from "./client.js";
import type { Artifact, CasUploadResult, SandboxTelemetry, SkippedArtifact } from "./types.js";

const require = createRequire(import.meta.url);
const SDK_VERSION: string = (require("../package.json") as { version: string }).version;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const STDERR_TAIL_BYTES = 4096;

export interface LocalConfig {
  binaryPath?: string;
  args: string[];
  timeoutMs: number;
}

/** `slice_eval_ts` result as reported by `slice mcp` (runtime 0.14). */
interface McpEvalPayload {
  ok: boolean;
  /** Guest process.exit(n) or process.exitCode (runtime 0.14+); null when the guest set neither. */
  exitCode?: number | null;
  /** Display string of the value (`[object Object]` for objects); the fallback when there is no JSON. */
  value: string | null;
  /** The value's JSON serialization; null for undefined, BigInt and other values JSON cannot hold. */
  returnJson?: string | null;
  /** Uncaught exception or syntax error text. */
  error?: string | null;
  stdout: string[];
  fuelUsed: number;
  timeUs: number;
  violation: string | null;
  peakMemoryBytes?: number;
  spawnTimeNs?: number;
  compileTimeNs?: number;
  execTimeNs?: number;
  totalTimeUs?: number;
  checkpointsTaken?: number;
  restoresPerformed?: number;
  restoreTimeNs?: number;
  deniedCapabilities?: string[];
  /** With `artifacts: true` (runtime 0.15): files under /artifacts, without their bytes. */
  artifacts?: Array<{ name: string; size: number; contentType: string; sha256: string; hostPath?: string }>;
  skippedArtifacts?: SkippedArtifact[];
}

/** MCP content blocks after the first (text) one: how `slice mcp` hands over artifact bytes. */
type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
  | { type: "resource_link"; uri: string; name?: string };

/** Hosted defaults (docs/architecture/01-api-contract.md), sent on every call so local runs match. */
const DEFAULT_FUEL = 25_000_000;
const DEFAULT_MEMORY_KB = 8_192;
/**
 * `slice mcp` clamps per-call `fuel` / `memory` to the server's `--fuel` / `--memory` (at least
 * 100M fuel and 256 MB). Raise the fuel ceiling to the largest plan cap so Scale-sized budgets
 * behave as they do on the hosted API. Explicit `localArgs` flags win.
 */
const SERVER_CEILING_ARGS = ["--fuel=250000000"];

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// Children alive in this process, killed synchronously on exit so none are orphaned.
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;
function trackChild(child: ChildProcessWithoutNullStreams): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const c of liveChildren) c.kill();
    });
  }
}

/** Resolves the binary: explicit option, then SLICE_BINARY_PATH, then the optional `@slicevm/cli` peer. */
export function resolveBinary(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.SLICE_BINARY_PATH) return process.env.SLICE_BINARY_PATH;
  let sliceJs: { binaryPath(): string };
  try {
    sliceJs = require("@slicevm/cli") as { binaryPath(): string };
  } catch {
    throw new SliceApiError(
      "local_runtime_error",
      "local mode needs the Slice binary: install `@slicevm/cli` (npm i -D @slicevm/cli), set SLICE_BINARY_PATH, " +
        "pass { binaryPath }, or set SLICE_API_KEY to use the hosted API",
    );
  }
  try {
    return sliceJs.binaryPath();
  } catch (err) {
    throw new SliceApiError("local_runtime_error", (err as Error).message, 0, null, { cause: err });
  }
}

function setRef(child: ChildProcessWithoutNullStreams, ref: boolean): void {
  // Keep the event loop alive only while requests are in flight, so an
  // unclosed client never prevents a script from exiting.
  const method = ref ? "ref" : "unref";
  child[method]();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    (stream as unknown as { ref?(): void; unref?(): void })[method]?.();
  }
}

/** One `slice mcp` process. */
class McpSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  readonly ready: Promise<void>;
  #nextId = 1;
  #buffer = "";
  #stderrTail = "";
  #exited = false;
  #retired = false;

  constructor(binary: string, args: string[]) {
    this.#child = spawn(binary, ["mcp", ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    trackChild(this.#child);
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.#child.stdin.on("error", () => {
      // EPIPE after the child died; surfaced through the exit handler instead.
    });
    this.#child.on("error", (err) => this.#fail(`failed to start ${binary}: ${err.message}`, err));
    this.#child.on("exit", (code, signal) => {
      this.#exited = true;
      const tail = this.#stderrTail.trim();
      this.#fail(`slice mcp exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`);
    });
    setRef(this.#child, false);

    this.ready = this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "@slicevm/sdk", version: SDK_VERSION },
    }).then(() => this.#send({ jsonrpc: "2.0", method: "notifications/initialized" }));
    // Avoid an unhandled rejection when nobody awaits `ready` (it is re-thrown to callers).
    this.ready.catch(() => {});
  }

  get alive(): boolean {
    return !this.#exited && !this.#retired;
  }

  #send(message: object): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Not a JSON-RPC frame; ignore.
      }
      if (typeof msg.id !== "number") continue; // Notification or id-less parse error.
      const pending = this.#pending.get(msg.id);
      if (!pending) continue;
      this.#settle(msg.id);
      if (msg.error) {
        pending.reject(new SliceApiError("local_runtime_error", `slice mcp error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  #settle(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (this.#pending.size === 0) setRef(this.#child, false);
    if (this.#retired && this.#pending.size === 0) this.#child.stdin.end();
  }

  #fail(message: string, cause?: unknown): void {
    this.#exited = true;
    for (const [id, pending] of this.#pending) {
      this.#settle(id);
      pending.reject(new SliceApiError("local_runtime_error", message, 0, null, { cause }));
    }
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.#exited) return Promise.reject(new SliceApiError("local_runtime_error", "slice mcp is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The server handles one request at a time, so a stuck request blocks
        // every other one: kill the process and let the next call respawn it.
        reject(new SliceApiError("timeout", `slice mcp did not answer ${method} within ${timeoutMs} ms`));
        this.#pending.delete(id);
        this.kill();
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      setRef(this.#child, true);
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Stop accepting work; the process exits once in-flight requests finish. */
  retire(): void {
    this.#retired = true;
    if (this.#pending.size === 0) this.#child.stdin.end();
  }

  kill(): void {
    this.#retired = true;
    if (!this.#exited) this.#child.kill();
  }

  /** Closes stdin (the server exits on EOF), escalating to kill after `graceMs`. */
  async close(graceMs = 2_000): Promise<void> {
    this.#retired = true;
    if (this.#exited) return;
    const exited = new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), graceMs);
    await exited;
    clearTimeout(timer);
  }
}

/** Parses the value as JSON when possible, else returns the raw string (contract rule); undefined is null. */
function parseValue(value: string | null | undefined): unknown {
  if (value === null || value === undefined || value === "undefined") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * The run's value, as the hosted gateway builds it: the engine's JSON serialization when there is
 * one (objects and arrays come back as data, not `[object Object]`), else the display string. A
 * string result is itself parsed as JSON when possible, so code ending in JSON.stringify(...) works.
 */
function resultOf(payload: McpEvalPayload): unknown {
  if (typeof payload.returnJson === "string") {
    try {
      const v: unknown = JSON.parse(payload.returnJson);
      return typeof v === "string" ? parseValue(v) : v;
    } catch {
      // Fall through to the display string.
    }
  }
  return parseValue(payload.value);
}

/** Violation classes the hosted API puts in front of the engine text, matched on that text. */
const VIOLATION_CLASSES: Array<[RegExp, string]> = [
  [/EGRESS_SECRET_LEAK_BLOCKED|Egress DLP/i, "EgressDlpViolation"],
  [/WallClockExceeded|wall-clock/i, "WallClockExceeded"],
  [/fuel limit/i, "CpuFuelExhausted"],
  [/memory ceiling/i, "MemoryCeilingExceeded"],
  [/SES Lockdown/i, "SesLockdownViolation"],
  [/network authority/i, "NetAccessDenied"],
  [/filesystem (read|write) authority/i, "FsAccessDenied"],
  [/exec authority|Subprocess execution/i, "ExecDenied"],
  [/extension authority/i, "ExtensionDenied"],
  [/environment|env authority/i, "EnvAccessDenied"],
  [/checkpoint/i, "CheckpointDenied"],
  [/interrupt/i, "ExecutionInterrupted"],
];

/** `CpuFuelExhausted: <engine text>`, as in hosted results, so one check works in both modes. */
function classifyViolation(violation: string): string {
  const known = /^([A-Z][A-Za-z]+):/.exec(violation)?.[1];
  if (known && VIOLATION_CLASSES.some(([, c]) => c === known)) return violation;
  const match = VIOLATION_CLASSES.find(([re]) => re.test(violation));
  return `${match?.[1] ?? "SandboxViolation"}: ${violation}`;
}

function localTelemetry(payload: McpEvalPayload): SandboxTelemetry {
  // Local mode has no CAS archives and no MPK reporting: casMmapUs is 0 and mpkDomain "none".
  const restores = payload.restoresPerformed ?? 0;
  return {
    coldBootUs: (payload.spawnTimeNs ?? 0) / 1000,
    casMmapUs: 0,
    vmExecUs: payload.execTimeNs !== undefined ? payload.execTimeNs / 1000 : payload.timeUs,
    rollbackUs: restores > 0 ? (payload.restoreTimeNs ?? 0) / 1000 / restores : 0,
    totalUs: payload.totalTimeUs ?? payload.timeUs,
    fuelConsumed: payload.fuelUsed,
    peakMemoryKb: (payload.peakMemoryBytes ?? 0) / 1024,
    mpkDomain: "none",
    checkpoints: payload.checkpointsTaken ?? 0,
    rollbacks: restores,
  };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Rebuilds the hosted `artifacts` shape (Base64 `data`) from what `slice mcp` returned: images
 * up to 1 MB as image blocks (matched by hash, they carry no name), text up to 256 KB as embedded
 * resources, everything else as a file in the session's artifacts directory (read and removed).
 */
function collectArtifacts(payload: McpEvalPayload, blocks: ContentBlock[]): Artifact[] {
  const images = blocks.flatMap((b) => (b.type === "image" ? [Buffer.from(b.data, "base64")] : []));
  const texts = new Map(blocks.flatMap((b) => (b.type === "resource" && typeof b.resource.text === "string" ? [[b.resource.uri, b.resource.text] as const] : [])));
  return (payload.artifacts ?? []).map((meta) => {
    let bytes: Buffer | undefined;
    if (meta.hostPath) {
      try {
        bytes = readFileSync(meta.hostPath);
        unlinkSync(meta.hostPath);
      } catch {
        bytes = undefined;
      }
    } else if (texts.has(`slice://artifacts/${meta.name}`)) {
      bytes = Buffer.from(texts.get(`slice://artifacts/${meta.name}`) ?? "", "utf8");
    } else {
      bytes = images.find((img) => sha256(img) === meta.sha256);
    }
    if (!bytes || sha256(bytes) !== meta.sha256) {
      throw new SliceApiError(
        "local_runtime_error",
        `artifact ${meta.name} could not be read back from slice mcp (another call on this client may have written the same name at the same time)`,
      );
    }
    return { name: meta.name, size: meta.size, contentType: meta.contentType, sha256: meta.sha256, data: bytes.toString("base64") };
  });
}

export class LocalBackend implements Backend {
  readonly mode = "local" as const;
  readonly #config: LocalConfig;
  #session: McpSession | null = null;
  #seq = 0;
  /** `--artifacts-dir` of the session: where `slice mcp` writes files it cannot inline. */
  #artifactsDir: string | null = null;

  constructor(config: LocalConfig) {
    this.#config = config;
  }

  async #getSession(): Promise<McpSession> {
    if (!this.#session || !this.#session.alive) {
      const user = this.#config.args;
      const ceilings = SERVER_CEILING_ARGS.filter((a) => !user.some((u) => u.startsWith(a.split("=")[0] + "=")));
      this.#artifactsDir ??= mkdtempSync(join(tmpdir(), "slice-sdk-"));
      const dir = user.some((u) => u.startsWith("--artifacts-dir")) ? [] : [`--artifacts-dir=${this.#artifactsDir}`];
      this.#session = new McpSession(resolveBinary(this.#config.binaryPath), [...ceilings, ...dir, ...user]);
    }
    const session = this.#session;
    await session.ready;
    return session;
  }

  async evalSandbox(code: string, options: EvalCallOptions = {}): Promise<EvalSandboxResult> {
    if (options.casDigest !== undefined) {
      throw new SliceApiError("unsupported", "casDigest is only supported by the hosted API; run the bundle with `slice run` locally");
    }

    const args: Record<string, unknown> = {
      code,
      fuel: options.fuel ?? DEFAULT_FUEL,
      memory: (options.memoryKb ?? DEFAULT_MEMORY_KB) * 1024,
    };
    // Per-call hosts are attenuated against the server's own grants: a host must also be allowed
    // with createSlice({ localArgs: ["--allow-net=<host>"] }) or the call ends in NetAccessDenied.
    if (options.allowNet?.length) args.allowNet = options.allowNet;
    if (options.auditEgress?.length) args.auditSecrets = options.auditEgress;
    if (options.deterministicSeed !== undefined) args.deterministicSeed = options.deterministicSeed;
    if (options.checkpoints !== undefined) args.checkpoints = options.checkpoints;
    if (options.timeoutMs !== undefined) args.timeoutMs = options.timeoutMs;
    const mode = options.artifacts ?? true;
    if (mode !== true && mode !== false && mode !== "inline" && mode !== "none") {
      throw new SliceApiError("unsupported", `artifacts ${JSON.stringify(mode)} is not available in local mode; use true or false`);
    }
    // On by default, as in the hosted API.
    args.artifacts = mode === true || mode === "inline";

    const session = await this.#getSession();
    const result = (await session.request("tools/call", { name: "slice_eval_ts", arguments: args }, this.#config.timeoutMs)) as {
      content?: ContentBlock[];
    };
    const first = result?.content?.[0];
    const text = first?.type === "text" ? first.text : undefined;
    let payload: McpEvalPayload;
    try {
      payload = JSON.parse(text ?? "") as McpEvalPayload;
    } catch (err) {
      throw new SliceApiError("local_runtime_error", `unexpected slice_eval_ts response: ${String(text).slice(0, 200)}`, 0, null, { cause: err });
    }

    // Contract: an uncaught exception is ok:false, violation null, with the message in `result`.
    // A non-zero exit code is ok:false with `exitCode` set and the script's value in `result`,
    // as in the hosted API (runtime 0.14 also puts "Process exited with status code n" in `error`).
    // Runtime 0.14 also reports exitCode 1 for uncaught errors; the contract keeps exitCode for
    // guest process.exit / process.exitCode only, so it is dropped when the run ended uncaught.
    const uncaught = typeof payload.error === "string" && payload.error.startsWith("Uncaught");
    const exitCode = typeof payload.exitCode === "number" && !uncaught ? payload.exitCode : undefined;
    // A trap (fuel, memory, time, egress, an uncaught refusal) has a null result, as in the hosted API.
    const violation = payload.violation ? classifyViolation(payload.violation) : null;
    const error = violation || exitCode !== undefined ? null : (payload.error ?? null);
    const artifacts = collectArtifacts(payload, result?.content?.slice(1) ?? []);
    const skipped = payload.skippedArtifacts ?? [];
    return {
      ok: payload.ok,
      stdout: payload.stdout ?? [],
      result: violation ? null : (error ?? resultOf(payload)),
      violation,
      telemetry: localTelemetry(payload),
      deniedCapabilities: payload.deniedCapabilities ?? [],
      requestId: `local_${++this.#seq}`,
      serverTiming: [],
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(artifacts.length ? { artifacts } : {}),
      ...(skipped.length ? { skippedArtifacts: skipped } : {}),
    };
  }

  async uploadCas(_bytes: Uint8Array | ArrayBuffer): Promise<CasUploadResult> {
    throw new SliceApiError("unsupported", "uploadCas is only available with the hosted API (set apiKey or SLICE_API_KEY)");
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    await session?.close();
    if (this.#artifactsDir) {
      rmSync(this.#artifactsDir, { recursive: true, force: true });
      this.#artifactsDir = null;
    }
  }
}
