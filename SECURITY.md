# Security Policy

This repository publishes the Slice npm packages: `@slicevm/sdk`, `@slicevm/mcp`, `@slicevm/cli`
and the `@slicevm/cli-<target>` binary packages. People install them to run untrusted code, so we
treat their integrity and their security boundaries as critical.

## Supported versions

| Version | Supported |
| :--- | :--- |
| `0.14.x` (current) | Yes |
| `< 0.14.0` | No, upgrade to the latest `0.14.x` |

All packages share one version with the runtime. Fixes ship as a new patch release of every package.

## What to report here

- **Package integrity**: a published tarball that does not match this repository, a missing or
  invalid npm provenance statement, or a way to make the release workflow publish something it
  should not.
- **Binary resolution**: a way to make `@slicevm/cli`, `@slicevm/mcp` or `@slicevm/sdk` run a
  binary other than the intended one (other than the documented `SLICE_BINARY_PATH` and
  `binaryPath` overrides).
- **MCP server**: a way for a client or for evaluated code to widen the capabilities the server
  was started with, or to read secrets registered with `--audit-egress`.
- **SDK**: an API key sent anywhere other than the configured `baseUrl`, or leaked into logs,
  errors or results.

A sandbox escape, a capability bypass, or a fuel, memory or time limit that does not hold is a
runtime issue. Report it to [slicevm/slice](https://github.com/slicevm/slice/security/advisories/new)
instead. If you are not sure which one it is, report it here and we will move it.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub:
[Security, Advisories, Report a vulnerability](https://github.com/slicevm/sdk/security/advisories/new).

Please include:

- the package, its version, your OS and your Node.js version;
- the smallest reproduction you can share (code, MCP client config or SDK call);
- what you expected and what happened.

We aim to acknowledge reports within 48 hours and to give a fix or a timeline within 7 days for
confirmed issues. We credit reporters in the advisory unless you ask us not to.

## How releases are protected

- Packages are published only from the `release` workflow in this repository, through npm trusted
  publishing (GitHub OIDC). No npm token is stored anywhere.
- Every package carries an npm provenance statement that links it to the workflow run and commit.
  Check it with `npm audit signatures`.
- Publishing requires a maintainer's approval of the `npm` environment, and only from `main`.
- Changes reach `main` only through reviewed pull requests.
