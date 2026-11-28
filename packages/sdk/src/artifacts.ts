// Helpers for `result.artifacts`: the files a run wrote under /artifacts. Results stay plain JSON
// (the bytes are Base64 in `data`), so they serialize and compare the same in local and remote mode.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { SliceApiError } from "./errors.js";
import type { Artifact } from "./types.js";

/** The artifact's bytes. */
export function artifactBytes(artifact: Artifact): Uint8Array {
  return new Uint8Array(Buffer.from(artifact.data, "base64"));
}

/** The artifact's bytes decoded as UTF-8 (logs, CSV, JSON, SVG source). */
export function artifactText(artifact: Artifact): string {
  return Buffer.from(artifact.data, "base64").toString("utf8");
}

/** True when `name` stays inside the target directory: relative, no `..`, no drive or device names. */
function safeName(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes(":") || name.includes("\0")) return false;
  return name.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Writes every artifact of a result under `dir`, keeping subdirectories, and returns the paths
 * written. Refuses a name that would escape `dir` (the runtime never produces one; this guards
 * results that came from elsewhere).
 */
export async function saveArtifacts(result: { artifacts?: Artifact[] }, dir: string): Promise<string[]> {
  const root = resolve(dir);
  const written: string[] = [];
  for (const a of result.artifacts ?? []) {
    const target = resolve(join(root, a.name));
    if (!safeName(a.name) || !target.startsWith(root + sep)) {
      throw new SliceApiError("bad_request", `refusing to write artifact ${JSON.stringify(a.name)} outside ${root}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifactBytes(a));
    written.push(target);
  }
  return written;
}
