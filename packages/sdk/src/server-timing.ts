import type { ServerTimingEntry } from "./types.js";

/** Splits on `sep` outside double-quoted strings. */
function splitOutsideQuotes(input: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "\\" && quoted && i + 1 < input.length) {
      current += ch + input[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  return v;
}

/**
 * Parses a W3C `Server-Timing` header into entries.
 * Example: `boot;dur=0.00099;desc="Cold Boot", total;dur=0.0312`.
 * Malformed metrics are skipped; `dur` stays in milliseconds as sent.
 */
export function parseServerTiming(header: string | null | undefined): ServerTimingEntry[] {
  if (!header) return [];
  const entries: ServerTimingEntry[] = [];
  for (const metric of splitOutsideQuotes(header, ",")) {
    const [rawName, ...params] = splitOutsideQuotes(metric, ";");
    const name = rawName?.trim();
    if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    const entry: ServerTimingEntry = { name };
    for (const param of params) {
      const eq = param.indexOf("=");
      const key = (eq === -1 ? param : param.slice(0, eq)).trim().toLowerCase();
      const value = eq === -1 ? "" : unquote(param.slice(eq + 1));
      // Per spec, only the first occurrence of each parameter counts.
      if (key === "dur" && entry.dur === undefined) {
        const n = Number(value);
        if (value !== "" && Number.isFinite(n)) entry.dur = n;
      } else if (key === "desc" && entry.desc === undefined) {
        entry.desc = value;
      }
    }
    entries.push(entry);
  }
  return entries;
}
