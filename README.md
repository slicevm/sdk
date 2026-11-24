# Slice npm packages

npm distribution and client libraries for [Slice](https://slicevm.com), the JS/TS microVM runtime
([runtime source](https://github.com/slicevm/slice)).

| Package | What it is |
| :--- | :--- |
| [`@slicevm/cli`](packages/cli) | The `slice` command through npm, with a prebuilt native binary. No Rust toolchain. |
| [`@slicevm/mcp`](packages/mcp) | MCP server that runs TypeScript in a sandbox for AI agents: locally (`slice mcp`), or on Slice Cloud with `SLICE_API_KEY` set. |
| [`@slicevm/sdk`](packages/sdk) | TypeScript client: local mode runs the binary, cloud mode calls `api.slicevm.com`. |
| `@slicevm/cli-<target>` | Native binaries, one per platform, installed automatically by `@slicevm/cli`. |

```sh
npx @slicevm/cli run app.ts
npx -y @slicevm/mcp --smoke-test
npm install @slicevm/sdk
```

All packages share one version, equal to the runtime version printed by `slice --version`.

## Supported platforms

| Target | Package |
| :--- | :--- |
| Linux x64 (glibc) | `@slicevm/cli-linux-x64-gnu` |
| macOS Apple Silicon | `@slicevm/cli-darwin-arm64` |
| Windows x64 | `@slicevm/cli-win32-x64-msvc` |

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

MIT
