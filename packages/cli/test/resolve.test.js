"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { binaryPath, supportedTargets, currentTarget } = require("../lib/index.js");

const BIN = path.join(__dirname, "..", "bin", "slice.js");

test("manifest lists the three launch targets", () => {
  const names = supportedTargets().map((t) => t.target);
  for (const name of ["linux-x64-gnu", "darwin-arm64", "darwin-x64", "win32-x64-msvc"]) assert.ok(names.includes(name), name);
  const linux = supportedTargets().find((t) => t.os === "linux");
  assert.equal(linux.libc, "glibc");
});

test("SLICE_BINARY_PATH overrides resolution", () => {
  const prev = process.env.SLICE_BINARY_PATH;
  process.env.SLICE_BINARY_PATH = __filename;
  try {
    assert.equal(binaryPath(), path.resolve(__filename));
  } finally {
    if (prev === undefined) delete process.env.SLICE_BINARY_PATH;
    else process.env.SLICE_BINARY_PATH = prev;
  }
});

test("missing SLICE_BINARY_PATH target is a clear error", () => {
  const prev = process.env.SLICE_BINARY_PATH;
  process.env.SLICE_BINARY_PATH = path.join(__dirname, "does-not-exist");
  try {
    assert.throws(() => binaryPath(), /SLICE_BINARY_PATH points to a missing file/);
  } finally {
    if (prev === undefined) delete process.env.SLICE_BINARY_PATH;
    else process.env.SLICE_BINARY_PATH = prev;
  }
});

test("bin forwards the exit code of the native binary", () => {
  // Use node itself as the "native binary" so the test runs everywhere.
  const res = spawnSync(process.execPath, [BIN, "-e", "process.exit(7)"], {
    env: { ...process.env, SLICE_BINARY_PATH: process.execPath },
    encoding: "utf8",
  });
  assert.equal(res.status, 7);
});

test("bin passes args and inherits stdio", () => {
  const res = spawnSync(process.execPath, [BIN, "-e", "console.log(process.argv.slice(1).join(','))", "a", "b"], {
    env: { ...process.env, SLICE_BINARY_PATH: process.execPath },
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "a,b");
});

test("unsupported or uninstalled platform prints the supported list", (t) => {
  const env = { ...process.env };
  delete env.SLICE_BINARY_PATH;
  const res = spawnSync(process.execPath, [BIN, "--version"], { env, encoding: "utf8" });
  if (res.status === 0) {
    t.skip(`platform package for ${currentTarget()?.target} is installed with a binary`);
    return;
  }
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Supported platforms:/);
  assert.match(res.stderr, /win32-x64-msvc/);
  assert.match(res.stderr, /SLICE_BINARY_PATH/);
});
