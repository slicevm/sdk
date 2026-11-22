"use strict";
// Resolves and runs the native Slice binary for the current platform.
// Plain CommonJS with no dependencies so it works from `npx`, `require`, and `import`.

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const platforms = require("./platforms.json");

/** Returns "glibc", "musl", or null when not on Linux. */
function detectLibc() {
  if (process.platform !== "linux") return null;
  try {
    // Same signal as `detect-libc`: glibc builds of Node report a runtime glibc version.
    if (process.report) process.report.excludeNetwork = true;
    const header = process.report && process.report.getReport().header;
    if (header && header.glibcVersionRuntime) return "glibc";
  } catch {
    // Fall through to the filesystem check.
  }
  try {
    const ldd = require("node:fs").readFileSync("/usr/bin/ldd", "utf8");
    if (ldd.includes("musl")) return "musl";
    if (ldd.includes("GNU C Library") || ldd.includes("glibc")) return "glibc";
  } catch {
    // No ldd: most likely a minimal musl image (Alpine without ldd) or a distroless image.
  }
  return "musl";
}

function describeHost() {
  const libc = detectLibc();
  return `${process.platform}-${process.arch}${libc ? ` (${libc})` : ""}`;
}

function supportedTargets() {
  return platforms.targets.map((t) => ({ ...t }));
}

/** Finds the manifest entry for this host, or undefined. */
function currentTarget() {
  const libc = detectLibc();
  return platforms.targets.find(
    (t) => t.os === process.platform && t.cpu === process.arch && (!t.libc || t.libc === libc),
  );
}

function unsupportedMessage(reason) {
  const list = platforms.targets
    .map((t) => `  - ${t.target.padEnd(18)} ${t.os}/${t.cpu}${t.libc ? `/${t.libc}` : ""}  (${t.packageName})`)
    .join("\n");
  const lines = [
    `slice: ${reason}`,
    "",
    `Host: ${describeHost()}`,
    "Supported platforms:",
    list,
    "",
  ];
  if (process.platform === "linux" && detectLibc() === "musl") {
    lines.push("Alpine and other musl-based Linux distributions are not supported yet. Use a glibc base image (for example node:22-bookworm-slim).");
  }
  lines.push(
    "If your platform is listed, the optional dependency was probably skipped. Reinstall without",
    "`--no-optional` / `--omit=optional`, and make sure the lockfile was not generated on another OS.",
    "You can also point SLICE_BINARY_PATH at a slice binary you built yourself (cargo build --release).",
  );
  return lines.join("\n");
}

/**
 * Absolute path of the native `slice` binary for this host.
 * Honors the SLICE_BINARY_PATH environment variable. Throws an Error with a
 * helpful, multi-line message when no binary is available.
 * @returns {string}
 */
function binaryPath() {
  const override = process.env.SLICE_BINARY_PATH;
  if (override) {
    const resolved = path.resolve(override);
    if (!existsSync(resolved)) throw new Error(`slice: SLICE_BINARY_PATH points to a missing file: ${resolved}`);
    return resolved;
  }

  const target = currentTarget();
  if (!target) throw new Error(unsupportedMessage("no prebuilt binary for this platform."));

  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve(`${target.packageName}/package.json`));
  } catch {
    throw new Error(unsupportedMessage(`the platform package ${target.packageName} is not installed.`));
  }
  const bin = path.join(pkgDir, "bin", target.binaryFile);
  if (!existsSync(bin)) {
    throw new Error(unsupportedMessage(`${target.packageName} is installed but ${bin} is missing.`));
  }
  return bin;
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

/**
 * Spawns the native binary with inherited stdio, forwards termination signals,
 * and mirrors the child's exit code or signal on the current process.
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
function runBinary(args, options = {}) {
  let bin;
  try {
    bin = binaryPath();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }

  const child = spawn(bin, args, { stdio: "inherit", env: options.env || process.env, windowsHide: true });

  const handlers = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    handlers.set(signal, handler);
    try {
      process.on(signal, handler);
    } catch {
      // Signal not supported on this platform (e.g. SIGBREAK outside Windows).
    }
  }

  child.on("error", (err) => {
    process.stderr.write(`slice: failed to start ${bin}: ${err.message}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    for (const [sig, handler] of handlers) process.removeListener(sig, handler);
    if (signal) {
      // Re-raise so the parent shell sees the same termination signal.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });

  return child;
}

module.exports = { binaryPath, runBinary, supportedTargets, currentTarget, detectLibc };
