# Releasing

All packages are published in lockstep with one version, equal to the runtime version
printed by `slice --version`. Publishing runs only in GitHub Actions, through npm trusted
publishing with provenance.

## How the packages fit together

```text
packages/platforms.json           single manifest of targets (edit here only)
        |
        | npm run npm:generate
        v
packages/cli-<target>/            generated; os/cpu/libc fields; bin/ gets the binary at release time
packages/cli/                     optionalDependencies on every cli-* at the exact same version
        lib/index.js              binaryPath(): SLICE_BINARY_PATH, else require.resolve of the matching cli-*
packages/mcp/                     local: execs `slice mcp`, implements --audit-egress=auto by reading .env;
                                  cloud (SLICE_API_KEY set): stdio bridge to https://api.slicevm.com/mcp
packages/sdk/                     zero runtime deps; local mode spawns `slice mcp`, remote mode calls api.slicevm.com
```

The `cli-*` packages are deliberately not npm workspaces: their `os`/`cpu` fields would make
`npm install` fail on every other platform.

To add a target (for example `linux-arm64-gnu`): add one line to `packages/platforms.json`,
run `npm run npm:generate`, and add a matrix entry in `.github/workflows/release.yml`.

## Release

The release workflow takes no version: it publishes the version committed on `main`
(`packages/cli/package.json`, kept in lockstep across packages) and builds the runtime's
release tag `v<version>`. So the version bump comes first.

1. The runtime is tagged and released first, for example `v0.14.7`.
2. Bump the version through a pull request (`main` accepts no direct pushes): on a branch,
   `npm run npm:version -- 0.14.7 && npm run npm:generate && npm install`, then open the pull
   request. `ci` downloads the runtime release that matches the new version, so the local-mode
   tests run against it. Merge once `ci` passes. The lockfile does not list the platform
   packages of an unpublished version; that is expected (they are optional, and the tests use
   the runtime binary directly), and `npm ci` accepts it.
3. Actions, `release`, Run workflow on `main` with `dry_run=true`. The `version` job reads and
   checks the committed version and that the runtime tag exists; `verify` builds, tests and
   packs. A dry run needs no approval. Builds use no cache and start clean.
4. Run again with `dry_run=false` and approve the `npm` environment (Review deployments).
   The `publish` job publishes exactly the tarballs `verify` tested. Versions that are
   already on npm are skipped, so a failed run can be re-run.
5. Smoke test on each OS:
   ```sh
   npx @slicevm/cli@0.14.0 --version
   npx -y @slicevm/mcp@0.14.0 --smoke-test --local
   # cloud mode (0.14.1 and later), with a key that has the sandbox:eval scope:
   SLICE_API_KEY=<key> npx -y @slicevm/mcp@0.14.0 --smoke-test
   ```
   Pass `--local` explicitly: with `SLICE_API_KEY` in the shell, `--smoke-test` tests cloud mode instead.

## npm setup

- npm organization `slicevm` owns the `@slicevm` scope.
- Each package has a trusted publisher: GitHub Actions, repository `slicevm/sdk`, workflow
  `release.yml`, environment `npm`, permissions publish and stage publish. No npm token is
  stored. Renaming `release.yml` or the environment breaks publishing until the trust is
  updated (`npm trust list @slicevm/<pkg>`, `npm trust github ...`).
- `stage=true` stages instead of publishing; approve each package on npmjs.com under Staged
  Packages (or `npm stage approve <id>`) with 2FA.
- A new package needs its first version published once by a maintainer (for example staged
  with a short-lived granular token), then `npm trust github @slicevm/<pkg> --repo
  slicevm/sdk --file release.yml --env npm --allow-publish`.
- 0.13.5 (2026-11-22) was the first release: staged from CI, approved with 2FA, then trust
  configured for all six packages and the token deleted.
- `@slicevm/cli-darwin-x64` (macOS Intel) was added after 0.15.0: its 0.15.0 was published once
  by hand from the runtime's `slice-macos-x86_64.tar.gz` (SHA-256 checked), packed with the
  binary at mode 0755 (a tarball packed on Windows loses the executable bit), then trusted.
  `@slicevm/cli` lists it from the next release (0.15.1); CI builds it on `macos-15-intel`.
- The `npm` environment requires a maintainer's approval and only deploys from `main`.

## macOS signing

Unsigned binaries downloaded by npm are not quarantined by Gatekeeper, but signing is still
recommended. With an Apple Developer ID, add `codesign --sign "Developer ID Application: ..."
--options runtime` and `xcrun notarytool submit` steps to the macOS build job before upload.
