# @slicevm/mcp

Slice AI Code Mode as a [Model Context Protocol](https://modelcontextprotocol.io)
server. Your AI IDE gets a sandbox that runs untrusted TypeScript and JavaScript
with deterministic fuel limits, a memory cage, deny-all networking, and egress
DLP, with nothing to install beyond Node.js 18+.

```sh
npx -y @slicevm/mcp                       # local mode: runs on your machine, no account
SLICE_API_KEY=<key> npx -y @slicevm/mcp   # cloud mode: runs on Slice Cloud
```

There are two modes:

- **Local mode** (the default) runs `slice mcp` (JSON-RPC 2.0 over stdio) using the
  prebuilt binary from [`@slicevm/cli`](https://www.npmjs.com/package/@slicevm/cli).
  Free, works offline, no account.
- **Cloud mode** (when an API key is set) is a stdio bridge to the hosted Slice
  Cloud MCP endpoint, `https://api.slicevm.com/mcp`. Code runs in a fresh Slice
  isolate on Slice servers, and your deployed Slice Functions appear as tools.
  Cloud mode requires @slicevm/mcp 0.14.1 or later.

## Local mode

### Tools

| Tool | Arguments | Purpose |
| :--- | :--- | :--- |
| `slice_eval_ts` | `code`, `fuel?`, `memory?` (bytes), `allowNet?`, `allowRead?`, `allowWrite?`, `allowEnv?`, `allowExec?`, `auditSecrets?`, `deterministicSeed?`, `checkpoints?`, `maxCheckpoints?`, `artifacts?` | Run TS/JS in a fresh sandbox; returns `{ ok, value, error, violation, stdout, fuelUsed, peakMemoryBytes, spawnTimeNs, compileTimeNs, execTimeNs, totalTimeUs, checkpointsTaken, restoresPerformed }`. With `artifacts: true`, files written under `/artifacts` come back as `image` content (PNG, JPEG, GIF, WebP up to 1 MB) or embedded text (up to 256 KB), listed in `artifacts` and `skippedArtifacts` |
| `slice_kv_set` | `key`, `value` | Write to the in-memory `Slice.kv` store |
| `slice_kv_get` | `key` | Read from `Slice.kv` |
| `slice_checkpoint` | `action` (`checkpoint` or `restore`), `snapshot_id?` | Snapshot and restore VFS + KV state |

### Flags

All flags are passed through to `slice mcp`:

| Flag | Meaning |
| :--- | :--- |
| `--allow-read=<prefix>` | Allow VFS reads under a path prefix (repeatable) |
| `--allow-write=<prefix>` | Allow VFS writes under a path prefix (repeatable) |
| `--allow-net=<host>` | Allow egress to a host (repeatable); default is deny all |
| `--allow-private-networks` | Let granted names reach loopback, private and link-local addresses (refused by default since runtime 0.14.7; cloud metadata stays blocked) |
| `--audit-egress=<secret>` | Trap any egress containing this secret raw, Base64, or Base64URL (repeatable) |
| `--audit-egress=auto` | Guard every `.env` value whose name looks sensitive, see below |
| `--no-checkpoints`, `--max-checkpoints=<n>` | Disable or cap `Slice.checkpoint()` for evaluated code |
| `--artifacts-dir=<dir>` | Where artifacts too big for the result (or binary) are written; the result links them as `resource_link` |
| `--smoke-test` | Run a short self-test and exit |
| `--local` | Stay in local mode even when `SLICE_API_KEY` is set (not passed to `slice mcp`) |

Per-call arguments can narrow what the server grants but never widen it: a host
in `allowNet` must also be allowed with `--allow-net`.

#### `--audit-egress=auto`

The runtime reads `.env` in the server's working directory and guards every
value whose name contains `SECRET`, `TOKEN`, `KEY`, `PASSWORD`, or `PRIVATE`
across raw, Base64 and Base64URL egress. The values never appear on the command
line, and evaluated code cannot read them through `process.env`. If there is no
`.env`, nothing is registered.

The working directory is chosen by your IDE. Most clients start MCP servers in
the workspace root; if yours does not, set `cwd` in the server config.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "slice-code-mode": {
      "command": "npx",
      "args": ["-y", "@slicevm/mcp", "--allow-read=/workspace", "--audit-egress=auto"]
    }
  }
}
```

On Windows, if `npx` is not found, use `"command": "cmd"` and
`"args": ["/c", "npx", "-y", "@slicevm/mcp", ...]`.

### Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "slice-code-mode": {
      "command": "npx",
      "args": ["-y", "@slicevm/mcp", "--allow-read=.", "--audit-egress=auto"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "slice-code-mode": {
      "command": "npx",
      "args": ["-y", "@slicevm/mcp", "--allow-read=/workspace", "--audit-egress=auto"]
    }
  }
}
```

### Custom binary

Set `SLICE_BINARY_PATH` in the server's `env` block to use a locally built
`slice` binary instead of the npm one.

## Cloud mode

Cloud mode starts when an API key is available and `--local` is not given.
Create a key in the console at https://slicevm.com/console/.

| Setting | Meaning |
| :--- | :--- |
| `SLICE_API_KEY` (env) | Your Slice Cloud API key |
| `--api-key=<key>` | The same, as a flag. Prefer the env var: command lines are visible in process lists |
| `--local` | Force local mode even when a key is set |
| `SLICE_API_URL` (env) | Base URL of the API, default `https://api.slicevm.com` |
| `--smoke-test` | Check the key and the endpoint: initialize, tools/list, then `slice_eval_ts` with `1 + 1` |

The bridge reads JSON-RPC messages from stdin, sends each one to
`POST <SLICE_API_URL>/mcp` with `Authorization: Bearer <key>`, and writes the
replies to stdout. The key is never logged. A missing or invalid key comes back
as a JSON-RPC error that says so, and a network failure comes back as a
JSON-RPC error instead of stopping the server.

### Tools in cloud mode

Tools come from Slice Cloud, and `tools/list` shows only what the key's scopes allow:

| Tool | Arguments | Purpose |
| :--- | :--- | :--- |
| `slice_eval_ts` | `code`, `allowNet?` (hosts), `fuel?`, `memoryKb?`, `timeoutMs?`, `artifacts?` | Run TS/JS in a fresh isolate on Slice Cloud; returns stdout, the return value, error, violation and telemetry. Files written under `/artifacts` come back as images or embedded text (on by default). Needs scope `sandbox:eval` |
| `fn_<name>` | `input?` | Invoke one of your deployed Slice Functions (a `-` in the name becomes `_`). Needs scope `functions:invoke` or `functions:invoke:<name>` |

Each tool call counts as one run on your plan; `initialize` and `tools/list` are
free. `slice_kv_set`, `slice_kv_get` and `slice_checkpoint` exist only in local
mode. The local sandbox flags (`--allow-read`, `--allow-write`, `--allow-net`,
`--audit-egress`) are ignored in cloud mode, with one warning on stderr: Slice
Cloud sets the sandbox policy, and `allowNet` narrows it per call.

Give an agent a key scoped to `sandbox:eval` (or to one function) rather than a
full-access key.

### Claude Desktop (cloud mode)

Claude Desktop starts MCP servers over stdio, so it uses this package with the
key in `env`:

```json
{
  "mcpServers": {
    "slice": {
      "command": "npx",
      "args": ["-y", "@slicevm/mcp"],
      "env": { "SLICE_API_KEY": "<key>" }
    }
  }
}
```

The same `env` block switches the Cursor and Windsurf examples above to cloud
mode. Check the key from a terminal first:

```sh
SLICE_API_KEY=<key> npx -y @slicevm/mcp --smoke-test
```

### Clients with remote MCP support

Clients that connect to a remote HTTP MCP server with custom headers do not
need this package. Point them at the endpoint directly. Claude Code:

```sh
claude mcp add --transport http slice https://api.slicevm.com/mcp --header "Authorization: Bearer $SLICE_API_KEY"
```

Cursor (`.cursor/mcp.json`), Windsurf, VS Code and similar clients:

```json
{
  "mcpServers": {
    "slice": {
      "url": "https://api.slicevm.com/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

## License

MIT
