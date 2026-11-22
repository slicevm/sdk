#!/usr/bin/env node
// Copies release binaries into packages/cli-<target>/bin/ before `npm publish`.
//
// Usage:
//   node scripts/npm/stage-binaries.mjs --from=<dir> [--strict]
//   node scripts/npm/stage-binaries.mjs --target=win32-x64-msvc --binary=path/to/slice.exe
//
// With --from, the directory is searched (up to 3 levels deep) for an extracted
// binary per target. A file matches a target when its relative path contains the
// npm target name (e.g. `linux-x64-gnu`) or the Rust triple (e.g.
// `x86_64-unknown-linux-gnu`) and its file name is `slice`, `slice.exe`, or
// starts with `slice-`. Archives and checksum files are ignored, so extract
// release tarballs first. Typical layouts that work:
//   dist/x86_64-unknown-linux-gnu/slice
//   dist/slice-aarch64-apple-darwin
//   dist/win32-x64-msvc/slice.exe
// --strict fails unless every target in packages/platforms.json was staged.
import { chmod, copyFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { loadManifest, parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const manifest = await loadManifest();
const byTarget = new Map(manifest.targets.map((t) => [t.target, t]));

async function stage(target, source) {
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) throw new Error(`binary not found: ${source}`);
  const dest = join(target.dir, "bin", target.binaryFile);
  await copyFile(source, dest);
  if (target.os !== "win32") await chmod(dest, 0o755);
  console.log(`${target.target}: ${source} -> ${relative(process.cwd(), dest)} (${info.size} bytes)`);
}

async function walk(dir, depth = 0) {
  if (depth > 3) return [];
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, depth + 1)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const isBinaryName = (name) =>
  /^slice(\.exe)?$/.test(name) || (/^slice-/.test(name) && !/\.(tar\.gz|tgz|zip|sha256|sig|txt|json)$/.test(name));

if (args.target || args.binary) {
  const target = byTarget.get(args.target);
  if (!target) {
    console.error(`unknown --target=${args.target}. Known: ${[...byTarget.keys()].join(", ")}`);
    process.exit(2);
  }
  if (typeof args.binary !== "string") {
    console.error("--binary=<path> is required with --target");
    process.exit(2);
  }
  await stage(target, resolve(args.binary));
} else if (typeof args.from === "string") {
  const root = resolve(args.from);
  const files = await walk(root);
  const missing = [];
  for (const target of manifest.targets) {
    const matches = files.filter((f) => {
      const rel = relative(root, f).split(sep).join("/");
      const name = rel.split("/").pop();
      return isBinaryName(name) && (rel.includes(target.target) || rel.includes(target.rustTriple));
    });
    if (matches.length === 0) {
      missing.push(target.target);
      continue;
    }
    if (matches.length > 1) {
      console.error(`${target.target}: ambiguous, found ${matches.length} candidates:\n  ${matches.join("\n  ")}`);
      process.exit(1);
    }
    await stage(target, matches[0]);
  }
  if (missing.length) {
    const msg = `no binary found for: ${missing.join(", ")}`;
    if (args.strict) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(`warning: ${msg}`);
  }
} else {
  console.error("usage: stage-binaries.mjs --from=<dir> [--strict] | --target=<target> --binary=<path>");
  process.exit(2);
}
