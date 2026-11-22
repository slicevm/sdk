#!/usr/bin/env node
// Content rule for this repository:
// no emojis, no em or en dashes, no decorative unicode in tracked text files.
// Allowed non-ASCII: the micro sign (U+00B5) and Greek mu (U+03BC) used in "µs".
//
// Usage: node scripts/check-text.mjs   (exits 1 and lists offenders)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ALLOWED = new Set([0x00b5, 0x03bc]);
const TEXT_EXT = /\.(md|mdx|astro|ts|tsx|js|mjs|cjs|json|css|rs|toml|ya?ml|sh|ps1|service|example|html|svg|txt)$/i;
const SKIP = [/package-lock\.json$/];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f && TEXT_EXT.test(f) && !SKIP.some((re) => re.test(f)) && existsSync(f));

let problems = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp > 0x7e && !ALLOWED.has(cp)) {
        problems++;
        const hex = cp.toString(16).toUpperCase().padStart(4, "0");
        console.log(`${file}:${i + 1}: U+${hex} in: ${line.trim().slice(0, 100)}`);
        break;
      }
    }
  });
}

if (problems) {
  console.error(`\n${problems} line(s) contain disallowed characters.`);
  process.exit(1);
}
console.log(`ok: ${files.length} files checked`);
