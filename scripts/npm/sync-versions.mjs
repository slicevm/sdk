#!/usr/bin/env node
// Sets one version across every published package in lockstep.
//
// Usage:
//   node scripts/npm/sync-versions.mjs 0.9.92     set the version everywhere
//   node scripts/npm/sync-versions.mjs --check    exit 1 if versions disagree
//
// Pinning rules:
//   @slicevm/cli optionalDependencies -> exact version (binaries must match the wrapper)
//   @slicevm/mcp dependency on @slicevm/cli -> exact version
//   @slicevm/sdk optional peer on @slicevm/cli -> ^version
import { join } from "node:path";
import { loadManifest, packagesDir, parseArgs, readJson, writeJson } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const manifest = await loadManifest();

const paths = [
  join(packagesDir, "cli", "package.json"),
  join(packagesDir, "mcp", "package.json"),
  join(packagesDir, "sdk", "package.json"),
  ...manifest.targets.map((t) => join(t.dir, "package.json")),
];

if (args.check) {
  const versions = new Map();
  for (const p of paths) {
    const pkg = await readJson(p);
    versions.set(pkg.name, pkg.version);
    for (const [name, range] of Object.entries(pkg.optionalDependencies ?? {})) versions.set(`${pkg.name} -> ${name}`, range);
    if (pkg.dependencies?.["@slicevm/cli"]) versions.set(`${pkg.name} -> @slicevm/cli`, pkg.dependencies["@slicevm/cli"]);
  }
  const distinct = new Set(versions.values());
  for (const [k, v] of versions) console.log(`${k}: ${v}`);
  if (distinct.size !== 1) {
    console.error(`\nversion mismatch: ${[...distinct].join(", ")}`);
    process.exit(1);
  }
  console.log(`\nall packages at ${[...distinct][0]}`);
  process.exit(0);
}

const version = args._[0];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/npm/sync-versions.mjs <semver> | --check");
  process.exit(2);
}

for (const p of paths) {
  const pkg = await readJson(p);
  pkg.version = version;
  if (pkg.name === "@slicevm/cli") {
    pkg.optionalDependencies = Object.fromEntries(manifest.targets.map((t) => [t.packageName, version]));
  }
  if (pkg.dependencies?.["@slicevm/cli"]) pkg.dependencies["@slicevm/cli"] = version;
  if (pkg.peerDependencies?.["@slicevm/cli"]) pkg.peerDependencies["@slicevm/cli"] = `^${version}`;
  await writeJson(p, pkg);
  console.log(`${pkg.name} -> ${version}`);
}
