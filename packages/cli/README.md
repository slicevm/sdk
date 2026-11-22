# @slicevm/cli

Zero-install npm distribution of the [Slice](https://slicevm.com) JS/TS microVM runtime.
No Rust toolchain needed: the right prebuilt binary is pulled in through
`optionalDependencies`, the same way `esbuild` and `@biomejs/biome` ship.

```sh
npx @slicevm/cli --version
npx @slicevm/cli run app.ts
npm i -D @slicevm/cli && npx slice doctor
```

The package installs one command, `slice`. With `npx`, use the package name: `npx @slicevm/cli <args>`.

## Supported platforms

| Target | os / cpu / libc | Package |
| :--- | :--- | :--- |
| `linux-x64-gnu` | linux / x64 / glibc | `@slicevm/cli-linux-x64-gnu` |
| `darwin-arm64` | darwin / arm64 | `@slicevm/cli-darwin-arm64` |
| `win32-x64-msvc` | win32 / x64 | `@slicevm/cli-win32-x64-msvc` |

musl-based Linux (Alpine) is not supported yet; use a glibc image such as
`node:22-bookworm-slim`. On an unsupported host the wrapper exits with code 1
and prints the list above.

## Using your own binary

Set `SLICE_BINARY_PATH` to a `slice` binary (for example one built with
`cargo build --release`). It takes precedence over the platform packages.

## Programmatic API

```js
const { binaryPath, runBinary } = require("@slicevm/cli");
// or: import { binaryPath } from "@slicevm/cli";

const bin = binaryPath(); // absolute path, honors SLICE_BINARY_PATH, throws a helpful Error otherwise
```

- `binaryPath(): string` - resolve the native binary.
- `runBinary(args, { env? })` - spawn it with inherited stdio, forward SIGINT/SIGTERM/SIGHUP, and exit with the child's code.
- `supportedTargets()`, `currentTarget()`, `detectLibc()` - platform introspection.

`@slicevm/mcp` and `@slicevm/sdk` reuse this resolver.

## Troubleshooting

- "platform package ... is not installed": you installed with `--no-optional` /
  `--omit=optional`, or the lockfile was created on another OS with a package
  manager that prunes foreign optional dependencies. Reinstall on the target OS.
- Docker: run `npm ci` inside the image, not on the host.

## License

MIT
