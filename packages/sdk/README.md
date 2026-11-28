# @slicevm/sdk

One TypeScript API for running untrusted JS/TS in a [Slice](https://slicevm.com)
sandbox, locally during development and on `https://api.slicevm.com` in
production. Zero runtime dependencies, ESM, Node.js 18+.

```sh
npm i @slicevm/sdk
npm i -D @slicevm/cli   # only needed for local mode
```

```ts
import { createSlice, SliceApiError } from "@slicevm/sdk";

const slice = createSlice(); // remote if SLICE_API_KEY is set, else local

try {
  const res = await slice.evalSandbox("const x: number = 21 * 2; console.log(x); x", {
    fuel: 1_000_000,
    memoryKb: 4096,
    auditEgress: [process.env.STRIPE_SECRET_KEY!],
  });
  console.log(res.ok, res.result, res.stdout, res.telemetry.vmExecUs);
  if (res.violation) console.warn("sandbox trapped:", res.violation);
} catch (err) {
  if (err instanceof SliceApiError && err.code === "quota_exceeded") {
    // upgrade plan
  }
  throw err;
} finally {
  await slice.close();
}
```

## Mode selection

`createSlice({ apiKey?, baseUrl?, local?, binaryPath?, localArgs?, timeoutMs? })`

1. `local: true` always uses local mode.
2. Otherwise, remote mode when `apiKey` or `process.env.SLICE_API_KEY` is set.
3. Otherwise, local mode.

`client.mode` tells you which one was chosen.

## API

- `evalSandbox(code, options?)` returns `SandboxResult` plus `requestId` and
  `serverTiming`. Options are the contract's `SandboxEvalOptions`
  (`fuel`, `memoryKb`, `timeoutMs`, `allowNet`, `auditEgress`,
  `deterministicSeed`, `checkpoints`, `artifacts`) plus `casDigest`. On Slice Cloud a run
  that asks for nothing gets the plan maximum, and `limits` reports the fuel,
  memory and time it got. A request above the plan is reduced to it, and
  `limitsCapped` lists what you asked for (`{ memoryKb: 131072 }`); it is
  absent when nothing was reduced. `deniedCapabilities` lists every refused
  network, file, subprocess or environment attempt, including ones the code
  caught. Refusals throw a catchable error with `e.code` (`ERR_SLICE_NET_DENIED`
  and so on) and the message `OCap Violation: lacks <kind> authority for <target>`. Local mode returns the same shape: objects as data, `null` as the
  result of a trapped run, and violations with the same class prefix
  (`CpuFuelExhausted: ...`).
- `result.artifacts` lists the files the code wrote under `/artifacts` (see
  [Artifacts](#artifacts)).
- `uploadCas(bytes)` uploads a `.cas` bundle from `slice pack` (remote only,
  Pro and Scale plans) and returns `{ casDigest, bytes, modules }`.
- `close()` stops the local child process. Safe to call more than once.
- `parseServerTiming(header)` parses a `Server-Timing` header into
  `{ name, dur?, desc? }[]` (`dur` in milliseconds, per the W3C spec).

### Artifacts

Code can write files under `/artifacts` with plain `node:fs` (a chart, a CSV, a
log), and they come back with the result, in both modes, with the same names,
sizes, types and hashes:

```ts
import { createSlice, artifactText, saveArtifacts } from "@slicevm/sdk";

const slice = createSlice();
const res = await slice.evalSandbox(`
  const fs = require("node:fs");
  fs.writeFileSync("/artifacts/report.csv", "region,total\\nus,42\\n");
  "done";
`);
// [{ name: "report.csv", size: 19, contentType: "text/csv", sha256: "...", data: "<base64>" }]
console.log(res.artifacts);
console.log(artifactText(res.artifacts![0]));
await saveArtifacts(res, "./out"); // writes ./out/report.csv
```

- `/artifacts` starts empty in every run and shows only what the run wrote
  there, never a real directory on the machine. Every other path stays refused.
- Files are returned whatever the outcome, so a log written before a run ran out
  of fuel still comes back.
- A file that holds an `auditEgress` secret is dropped, listed in
  `skippedArtifacts` with reason `auditedSecret` and named in
  `deniedCapabilities` as `artifact:<name>`. Symlinks are never followed.
- Caps per run on Slice Cloud: Free 10 files, 1 MB each, 2 MB in total; Pro 20,
  4 MB, 8 MB; Scale 50, 8 MB, 16 MB. A file over a cap is listed in
  `skippedArtifacts` (`tooMany`, `tooLarge`, `overTotal`) and the run still
  succeeds. Locally the runtime's caps apply (64 files, 4 MB each, 16 MB).
- `artifacts: false` (or `"none"`) turns it off for a call: `/artifacts` is
  then refused like any other path.
- Helpers: `artifactBytes(a)` (Uint8Array), `artifactText(a)` (UTF-8) and
  `saveArtifacts(result, dir)`, which refuses names that would escape `dir`.

A sandbox violation (fuel, memory, OCap, egress DLP) is not an exception: you get
`ok: false` and `violation` set, exactly like the HTTP API's `200` response.

### Errors

Every failure is a `SliceApiError` with `code`, `status`, and `requestId`.
API codes follow the contract: `bad_request`, `unauthorized`, `forbidden`,
`payload_too_large`, `rate_limited`, `quota_exceeded`, `overloaded`,
`not_found`, `internal`. The client adds `timeout`, `network_error`,
`local_runtime_error`, and `unsupported` (with `status` 0).

Remote mode retries `503 overloaded` up to 3 times and `429 rate_limited` (burst
limit, or the key's runs in flight are all taken) up to 8 times, with exponential
backoff (200, 400, 800 ms plus jitter, capped at 5 s) or `Retry-After` when sent.
`quota_exceeded` and other errors are not retried.

## Remote mode

Calls `POST {baseUrl}/v1/sandbox/eval` and `POST {baseUrl}/v1/cas/upload`
with `Authorization: Bearer <apiKey>`. `baseUrl` defaults to
`https://api.slicevm.com`. Uses the global `fetch`.

## Local mode

Spawns one long-lived `slice mcp` process per client, performs the MCP
`initialize` handshake, and multiplexes concurrent calls by JSON-RPC id. The
binary is found in this order: `binaryPath` option, `SLICE_BINARY_PATH`, the
`@slicevm/cli` package. The child does not keep your process alive when idle and is
killed when your process exits; call `close()` for a graceful shutdown.

Local mode requires the `slice` binary 0.15 or newer (the client passes
`--artifacts-dir` to a temporary directory it removes on `close()`). Every call sends the
hosted defaults (25,000,000 fuel, 4,096 KB) unless you pass your own, and the
server is started with a fuel ceiling of 250,000,000 so Scale-sized budgets
work; your own `localArgs` flags take precedence.

Differences from the hosted API:

| Field or option | Local behavior |
| :--- | :--- |
| `telemetry` | Measured by the runtime; `casMmapUs` is `0` and `mpkDomain` is `"none"` |
| `serverTiming` | Always `[]` |
| `allowNet` | Honored per call, but only for hosts the server also allows: start it with `localArgs: ["--allow-net=<host>"]` |
| Private networks | As on the hosted API, a granted name that resolves to a loopback, private or link-local address is refused (`ERR_SLICE_NET_DENIED`, runtime 0.14.7). To reach local services from a trusted script, add `localArgs: ["--allow-private-networks"]`; cloud metadata addresses stay blocked |
| `auditEgress`, `deterministicSeed`, `checkpoints` | Same as the hosted API |
| `exitCode` | Same as the hosted API (runtime 0.14 or newer) |
| `artifacts` | Same shape as the hosted API; the runtime's own caps apply. Two concurrent calls on one client that write the same artifact name can make one of them fail with `local_runtime_error` |
| `Slice.kv` | Shared by all calls of one client (the hosted API starts every run empty) |
| `casDigest`, `uploadCas` | Throw `unsupported` |

## License

MIT
