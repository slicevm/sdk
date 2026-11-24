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

1. The runtime is tagged and released first, for example `v0.14.0`.
2. Actions, `release`, Run workflow with `version=0.14.0`, `runtime_ref=v0.14.0`,
   `dry_run=true`. The `verify` job builds, tests and packs; check its output. A dry run
   needs no approval.
3. Run again with `dry_run=false` and approve the `npm` environment (Review deployments).
   The `publish` job publishes exactly the tarballs `verify` tested. Versions that are
   already on npm are skipped, so a failed run can be re-run.
4. Commit the version bump: `npm run npm:version -- 0.14.0 && npm run npm:generate`.
5. Smoke test on each OS:
   ```sh
   npx @slicevm/cli@0.14.0 --version
   npx -y @slicevm/mcp@0.14.0 --smoke-test --local
   # cloud mode (0.15 and later), with a key that has the sandbox:eval scope:
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
- The `npm` environment requires a maintainer's approval and only deploys from `main`.

## macOS signing

Unsigned binaries downloaded by npm are not quarantined by Gatekeeper, but signing is still
recommended. With an Apple Developer ID, add `codesign --sign "Developer ID Application: ..."
--options runtime` and `xcrun notarytool submit` steps to the macOS build job before upload.
