<div align="center">

# Slice SDK, CLI and MCP server

**Run untrusted and AI-generated TypeScript safely, in microseconds.**
On your machine for free, or on Slice Cloud with one API key.

[![CI](https://github.com/slicevm/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/slicevm/sdk/actions/workflows/ci.yml)
[![@slicevm/sdk](https://img.shields.io/npm/v/@slicevm/sdk?label=%40slicevm%2Fsdk&color=cb3837)](https://www.npmjs.com/package/@slicevm/sdk)
[![@slicevm/mcp](https://img.shields.io/npm/v/@slicevm/mcp?label=%40slicevm%2Fmcp&color=cb3837)](https://www.npmjs.com/package/@slicevm/mcp)
[![@slicevm/cli](https://img.shields.io/npm/v/@slicevm/cli?label=%40slicevm%2Fcli&color=cb3837)](https://www.npmjs.com/package/@slicevm/cli)
[![npm downloads](https://img.shields.io/npm/dm/@slicevm/sdk?label=downloads)](https://www.npmjs.com/package/@slicevm/sdk)
[![npm provenance](https://img.shields.io/badge/npm-provenance-2ea44f)](https://docs.npmjs.com/generating-provenance-statements)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/types-included-3178c6)](packages/sdk/src/types.ts)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Website](https://slicevm.com) |
[Docs](https://slicevm.com/docs/cloud/) |
[Playground](https://slicevm.com/playground/) |
[Pricing](https://slicevm.com/pricing/) |
[Runtime](https://github.com/slicevm/slice)

</div>

---

Your agent writes code. Your customers upload formulas, plugins and transforms. Somebody has
to run that code, and it should not be your server, your network or your secrets.

[Slice](https://github.com/slicevm/slice) is a Rust microVM runtime for JavaScript and
TypeScript. Each run gets a fresh isolate that boots in **0.78 µs**, has no network unless you
grant it, cannot read your environment, and stops at a hard memory, CPU and time limit.
This repository holds the npm packages that put it in your hands:

| Package | Use it for |
| :--- | :--- |
| [`@slicevm/mcp`](packages/mcp) | Give Claude, Cursor, VS Code or any MCP client a safe place to run code. |
| [`@slicevm/sdk`](packages/sdk) | Run untrusted code from your Node.js or TypeScript app. Zero dependencies. |
| [`@slicevm/cli`](packages/cli) | The `slice` runtime itself: run, pack and serve TypeScript. No Rust toolchain. |

## Why Slice

- **Safe by default.** No network, filesystem, subprocess or environment access unless you
  allow it. A refused call throws a catchable error with a stable code, and every attempt is
  reported back to you.
- **Hard limits that hold.** A deterministic fuel budget, a heap cage and a wall-clock limit.
  Infinite loops, memory bombs and runaway regular expressions end as a clean `violation`,
  never as an outage.
- **Secrets cannot leak.** Name your secrets in `auditEgress` and any outgoing request that
  contains one, raw or Base64 encoded, is stopped before it leaves.
- **Fast enough to call per request.** Microsecond cold starts mean a fresh sandbox for every
  call, with no warm pool to manage and no state left over between runs.
- **Same API, local or hosted.** Develop offline against the free local runtime, then set
  `SLICE_API_KEY` and the same code runs on Slice Cloud.
- **Replayable.** Seed `Math.random` and `Date.now` to reproduce a run exactly, and roll state
  back with `Slice.checkpoint()` and `Slice.restore()`.

## Quick start

### For AI agents: the MCP server

Runs locally with no account:

```sh
claude mcp add slice -- npx -y @slicevm/mcp
```

Or add it to any MCP client (Claude Desktop, Cursor, Windsurf, VS Code):

```json
{
  "mcpServers": {
    "slice": { "command": "npx", "args": ["-y", "@slicevm/mcp"] }
  }
}
```

Prefer hosted? Point the client at Slice Cloud instead. Your deployed functions show up as
tools next to `slice_eval_ts`:

```sh
claude mcp add --transport http slice https://api.slicevm.com/mcp \
  --header "Authorization: Bearer $SLICE_API_KEY"
```

Setup for every client, OAuth and tool reference: [`@slicevm/mcp`](packages/mcp) and the
[MCP docs](https://slicevm.com/docs/cloud/mcp/).

### For apps: the SDK

```sh
npm i @slicevm/sdk
npm i -D @slicevm/cli   # only needed to run locally
```

```ts
import { createSlice } from "@slicevm/sdk";

const slice = createSlice(); // Slice Cloud if SLICE_API_KEY is set, otherwise local

// A pricing rule written by a customer, run against one order
const rule = "order.items.reduce((sum, i) => sum + i.price * i.qty, 0) * 1.2";
const order = { items: [{ price: 10, qty: 3 }] };

const res = await slice.evalSandbox(
  `const order = ${JSON.stringify(order)}; console.log("items:", order.items.length); ${rule}`,
  { timeoutMs: 1000, auditEgress: [process.env.STRIPE_SECRET_KEY ?? ""] },
);

console.log(res.ok, res.result, res.stdout); // true 36 [ 'items: 1' ]
await slice.close();
```

When the code misbehaves you get a result, not a crash:

```ts
// A regular expression that would backtrack for minutes
const bad = await slice.evalSandbox("/^(a+)+$/.test('a'.repeat(32) + 'b')", { timeoutMs: 300 });
console.log(bad.ok, bad.violation); // false, a WallClockExceeded trap after 300 ms
```

Options, errors, retries and local-mode details: [`@slicevm/sdk`](packages/sdk) and the
[SDK docs](https://slicevm.com/docs/cloud/sdk/).

### For running TypeScript: the CLI

```sh
npx @slicevm/cli run app.ts           # run a script
npx @slicevm/cli pack . app.cas       # precompile a project into a .cas bundle
npm i -D @slicevm/cli && npx slice doctor
```

See [`@slicevm/cli`](packages/cli) and the [runtime handbook](https://slicevm.com/docs/general/).

## Local or Slice Cloud

| | Local (free) | [Slice Cloud](https://slicevm.com/pricing/) |
| :--- | :--- | :--- |
| Account | None | API key from the [console](https://slicevm.com/console/) |
| Where code runs | Your machine | Fresh isolate on Slice servers |
| Sandbox, limits, egress audit | Yes | Yes |
| Deployed, versioned functions | No | Yes, callable over HTTP and as MCP tools |
| Precompiled `.cas` bundles | Yes | Pro and Scale |
| Call log, usage and key management | No | Yes |

Slice Cloud has a **free plan with 25,000 runs a month**, no card required. Pro is $9.99 a
month for 2,500,000 runs and Scale is $89.99 for 50,000,000. Every plan covers the Sandbox,
Functions and the hosted MCP server. Details on [Plans and limits](https://slicevm.com/docs/cloud/plans/).

## Supported platforms

| Platform | Binary package |
| :--- | :--- |
| Linux x64 (glibc) | `@slicevm/cli-linux-x64-gnu` |
| macOS Apple Silicon | `@slicevm/cli-darwin-arm64` |
| macOS Intel | `@slicevm/cli-darwin-x64` (0.15.1 and later) |
| Windows x64 | `@slicevm/cli-win32-x64-msvc` |

The right binary is installed automatically. Alpine (musl) is not supported yet; use a glibc
image such as `node:22-bookworm-slim`. Slice Cloud mode works anywhere Node.js 18+ runs.
All packages share one version, equal to the runtime version printed by `slice --version`,
and are published from GitHub Actions with npm provenance.

## Documentation

- [Sandbox](https://slicevm.com/docs/cloud/sandbox/): options, limits and the security model
- [SDK](https://slicevm.com/docs/cloud/sdk/) and [HTTP API](https://slicevm.com/docs/cloud/api/)
- [MCP server](https://slicevm.com/docs/cloud/mcp/) and [Functions](https://slicevm.com/docs/cloud/functions/)
- [Runtime handbook](https://slicevm.com/docs/general/) and [benchmarks](https://slicevm.com/docs/general/benchmarks-testing-and-docker-suite/)

Questions and bug reports: [open an issue](https://github.com/slicevm/sdk/issues). Problems in
the runtime itself belong in [slicevm/slice](https://github.com/slicevm/slice/issues).

## Development

Clone the runtime next to this repository so tests can find a local build:

```text
<root>/slice        https://github.com/slicevm/slice   (cargo build --release)
<root>/sdk          this repository
```

```sh
npm ci
npm run build
npm test                                   # local-mode tests skip without a binary
SLICE_TEST_BINARY=/path/to/slice npm test  # or point at any slice binary
SLICE_BINARY_PATH=../slice/target/release/slice npx slice --help
```

Text files must be plain ASCII (the micro sign in "µs" is allowed): `npm run check:text`.
Releases: see [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
