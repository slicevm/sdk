// Shared helpers for the npm release scripts in this folder.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const packagesDir = join(repoRoot, "packages");
export const manifestPath = join(packagesDir, "platforms.json");

/** Loads packages/platforms.json and derives package names, folders, and binary file names. */
export async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const targets = manifest.targets.map((t) => ({
    ...t,
    packageName: `${manifest.scope}/${manifest.packagePrefix}${t.target}`,
    dir: join(packagesDir, `${manifest.packagePrefix}${t.target}`),
    binaryFile: t.os === "win32" ? `${manifest.binaryName}.exe` : manifest.binaryName,
  }));
  return { ...manifest, targets };
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Parses `--key=value` and bare `--flag` arguments into an object. Positional args go to `_`. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) out[match[1]] = match[2] ?? true;
    else out._.push(arg);
  }
  return out;
}
