# @slicevm/mcp

Slice AI Code Mode as a [Model Context Protocol](https://modelcontextprotocol.io)
server. Your AI IDE gets a sandbox that runs untrusted TypeScript and JavaScript
with deterministic fuel limits, a memory cage, deny-all networking, and egress
DLP, with nothing to install beyond Node.js 18+.

```sh
npx -y @slicevm/mcp
```

This runs `slice mcp` (JSON-RPC 2.0 over stdio) using the prebuilt binary from
[`@slicevm/cli`](https://www.npmjs.com/package/@slicevm/cli).

## Tools

| Tool | Arguments | Purpose |
| :--- | :--- | :--- |
| `slice_eval_ts` | `code`, `fuel?`, `memory?` (bytes), `allowNet?`, `allowRead?`, `allowWrite?`, `allowEnv?`, `allowExec?`, `auditSecrets?`, `deterministicSeed?`, `checkpoints?`, `maxCheckpoints?` | Run TS/JS in a fresh sandbox; returns `{ ok, value, error, violation, stdout, fuelUsed, peakMemoryBytes, spawnTimeNs, compileTimeNs, execTimeNs, totalTimeUs, checkpointsTaken, restoresPerformed }` |
| `slice_kv_set` | `key`, `value` | Write to the in-memory `Slice.kv` store |
| `slice_kv_get` | `key` | Read from `Slice.kv` |
| `slice_checkpoint` | `action` (`checkpoint` or `restore`), `snapshot_id?` | Snapshot and restore VFS + KV state |

## Flags

All flags are passed through to `slice mcp`:

| Flag | Meaning |
| :--- | :--- |
| `--allow-read=<prefix>` | Allow VFS reads under a path prefix (repeatable) |
| `--allow-write=<prefix>` | Allow VFS writes under a path prefix (repeatable) |
| `--allow-net=<host>` | Allow egress to a host (repeatable); default is deny all |
| `--audit-egress=<secret>` | Trap any egress containing this secret raw, Base64, or Base64URL (repeatable) |
| `--audit-egress=auto` | Guard every `.env` value whose name looks sensitive, see below |
| `--no-checkpoints`, `--max-checkpoints=<n>` | Disable or cap `Slice.checkpoint()` for evaluated code |

Per-call arguments can narrow what the server grants but never widen it: a host
in `allowNet` must also be allowed with `--allow-net`.

### `--audit-egress=auto`

The runtime reads `.env` in the server's working directory and guards every
value whose name contains `SECRET`, `TOKEN`, `KEY`, `PASSWORD`, or `PRIVATE`
across raw, Base64 and Base64URL egress. The values never appear on the command
line, and evaluated code cannot read them through `process.env`. If there is no
`.env`, nothing is registered.

The working directory is chosen by your IDE. Most clients start MCP servers in
the workspace root; if yours does not, set `cwd` in the server config.

## Claude Desktop

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

## Cursor

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

## Windsurf

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

## Custom binary

Set `SLICE_BINARY_PATH` in the server's `env` block to use a locally built
`slice` binary instead of the npm one.

## License

MIT
