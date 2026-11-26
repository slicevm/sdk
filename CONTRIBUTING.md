# Contributing

Thanks for helping improve the Slice npm packages. This guide covers what lives here, how to
build and test it, and how changes get merged.

## What lives here

| Path | Package | What it is |
| :--- | :--- | :--- |
| [`packages/sdk`](packages/sdk) | `@slicevm/sdk` | TypeScript client: local mode runs the `slice` binary, cloud mode calls `api.slicevm.com`. |
| [`packages/mcp`](packages/mcp) | `@slicevm/mcp` | MCP server: local `slice mcp`, or a bridge to the hosted endpoint. |
| [`packages/cli`](packages/cli) | `@slicevm/cli` | The `slice` command and the binary resolver the other packages use. |
| `packages/cli-<target>` | `@slicevm/cli-<target>` | Prebuilt binaries, generated from [`packages/platforms.json`](packages/platforms.json). |
| [`scripts/npm`](scripts/npm) | | Version sync, platform package generation and staging. |

The runtime itself (the `slice` binary, the sandbox, fuel and memory metering) is in
[slicevm/slice](https://github.com/slicevm/slice). Runtime bugs belong there.

## Setup

You need Node.js 18 or newer. For the local-mode tests, also a `slice` binary: either clone the
runtime next to this repository and build it, or point `SLICE_TEST_BINARY` at any binary.

```text
<root>/slice        https://github.com/slicevm/slice   (cargo build --release)
<root>/sdk          this repository
```

```sh
npm ci
npm run build
npm test                                   # local-mode tests skip without a binary
SLICE_TEST_BINARY=/path/to/slice npm test
```

## Before you open a pull request

- `npm run build` and `npm test` pass.
- `npm run check:text` passes: text files are plain ASCII (the micro sign in "µs" is allowed).
- `npm run npm:check-versions` passes. Do not change package versions in a pull request;
  versions are set when a release is cut (see [RELEASING.md](RELEASING.md)).
- New behavior has a test, and user-facing changes update the package README.
- The SDK has no runtime dependencies. Adding one needs a very good reason.

For anything larger than a small fix, open an issue first so we can agree on the approach.

## How changes are merged

- `main` is protected. Every change goes through a pull request that needs CI to pass, all
  review conversations resolved and an approval from a code owner
  ([`.github/CODEOWNERS`](.github/CODEOWNERS)).
- Workflows from first-time and outside contributors run only after a maintainer approves them.
- Changes to `.github/`, `scripts/npm/` or package manifests get extra scrutiny, because they
  affect what is published.
- Keep commits focused, with a short imperative subject line.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
