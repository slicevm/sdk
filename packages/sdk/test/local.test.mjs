// Integration test for local mode against a real `slice` binary.
// Uses SLICE_TEST_BINARY, else the sibling repo build; skipped when absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSlice, SliceApiError } from "../dist/index.js";

// The runtime repo is a sibling checkout: <root>/slice next to <root>/<this repo>.
const exe = process.platform === "win32" ? "slice.exe" : "slice";
const DEFAULT_BINARY = fileURLToPath(new URL(`../../../../slice/target/release/${exe}`, import.meta.url));
const binaryPath = process.env.SLICE_TEST_BINARY ?? DEFAULT_BINARY;
const skip = existsSync(binaryPath) ? false : `slice binary not found at ${binaryPath} (set SLICE_TEST_BINARY)`;

// Checks that need a newer runtime are skipped on older binaries (CI tests the released one).
const runtime = skip ? [0, 0, 0] : (execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const needs = (version) => {
  const want = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((runtime[i] ?? 0) !== want[i]) return (runtime[i] ?? 0) > want[i] ? false : `needs runtime ${version}`;
  return false;
};

test("local mode", { skip }, async (t) => {
  const slice = createSlice({ local: true, binaryPath, timeoutMs: 20_000, localArgs: ["--allow-net=example.com"] });
  t.after(() => slice.close());
  assert.equal(slice.mode, "local");

  await t.test("evaluates TypeScript and maps the result shape", async () => {
    const res = await slice.evalSandbox("const x: number = 21 * 2; console.log('v=' + x); x");
    assert.equal(res.ok, true);
    assert.deepEqual(res.stdout, ["v=42"]);
    assert.equal(res.result, 42);
    assert.equal(res.violation, null);
    assert.equal(res.telemetry.mpkDomain, "none");
    assert.ok(res.telemetry.totalUs > 0);
    assert.ok(res.telemetry.vmExecUs > 0);
    assert.ok(res.telemetry.peakMemoryKb > 0);
    assert.ok(res.telemetry.fuelConsumed > 0);
    assert.match(res.requestId, /^local_\d+$/);
    assert.deepEqual(res.serverTiming, []);
  });

  await t.test("JSON results are parsed, other values stay raw strings", async () => {
    assert.deepEqual((await slice.evalSandbox("JSON.stringify({ a: 1, b: [2] })")).result, { a: 1, b: [2] });
    assert.equal((await slice.evalSandbox("'plain text'")).result, "plain text");
  });

  await t.test("objects and arrays come back as data, not [object Object]", async () => {
    assert.deepEqual((await slice.evalSandbox("({ a: 1, b: [2, 'x'] })")).result, { a: 1, b: [2, "x"] });
    assert.deepEqual((await slice.evalSandbox("const r = { n: 1 }; return r;")).result, { n: 1 });
    assert.deepEqual((await slice.evalSandbox("[1, 2, 3].map((n) => n * 2)")).result, [2, 4, 6]);
    assert.equal((await slice.evalSandbox("undefined")).result, null);
  });

  await t.test("a string containing require( survives a top-level return (runtime 0.14.5)", { skip: needs("0.14.5") }, async () => {
    const res = await slice.evalSandbox('const results = {}; try { require("fs").readFileSync("/etc/hostname", "utf8") } catch (e) { results["require(fs)"] = e.code } return results;');
    assert.deepEqual(res.result, { "require(fs)": "ERR_SLICE_FS_DENIED" });
  });

  await t.test("multiplexes concurrent requests by id", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => slice.evalSandbox(`${i} * 10`)));
    assert.deepEqual(results.map((r) => r.result), [0, 10, 20, 30, 40, 50, 60, 70]);
  });

  await t.test("fuel exhaustion is a violation and the next call still works", async () => {
    const trapped = await slice.evalSandbox("while (true) {}", { fuel: 1000 });
    assert.equal(trapped.ok, false);
    assert.match(trapped.violation, /^CpuFuelExhausted: .*fuel/);
    assert.equal(trapped.result, null, "a trapped run has a null result, as in the hosted API");
    const after = await slice.evalSandbox("1 + 1");
    assert.equal(after.ok, true);
    assert.equal(after.result, 2);
  });

  await t.test("timeoutMs ends a run with WallClockExceeded (runtime 0.14.3)", async () => {
    const res = await slice.evalSandbox("let i = 0; while (true) { i++ }", { fuel: 10_000_000_000, timeoutMs: 200 });
    assert.equal(res.ok, false);
    assert.match(res.violation, /^WallClockExceeded: /);
    assert.equal(res.result, null);
  });

  await t.test("a refused fetch is a catchable error with a stable code (runtime 0.14.3)", async () => {
    const res = await slice.evalSandbox('let c = ""; try { await fetch("https://denied.example.org/") } catch (e) { c = e.code } c');
    assert.equal(res.ok, true);
    assert.equal(res.result, "ERR_SLICE_NET_DENIED");
    assert.ok(Array.isArray(res.deniedCapabilities));
  });

  await t.test("deniedCapabilities lists refused attempts (runtime 0.14.5)", { skip: needs("0.14.5") }, async () => {
    const res = await slice.evalSandbox('try { await fetch("https://denied.example.org/") } catch {} 1');
    assert.deepEqual(res.deniedCapabilities, ["lacks outbound network authority for host 'denied.example.org:443'"]);
  });

  await t.test("each caught refusal reports its own message (runtime 0.14.5)", { skip: needs("0.14.5") }, async () => {
    const res = await slice.evalSandbox(
      'const m = []; for (const p of ["/etc/hostname", "/etc/passwd"]) { try { require("fs").readFileSync(p, "utf8") } catch (e) { m.push(e.message) } } m',
    );
    assert.match(res.result[0], /\/etc\/hostname/);
    assert.match(res.result[1], /\/etc\/passwd/);
    assert.equal(res.deniedCapabilities.length, 2);
  });

  await t.test("an uncaught refusal is a classified violation with a null result", async () => {
    const res = await slice.evalSandbox('await fetch("https://denied.example.org/")');
    assert.equal(res.ok, false);
    assert.match(res.violation, /^NetAccessDenied: /);
    assert.equal(res.result, null);
  });

  await t.test("uncaught exceptions follow the contract: ok false, violation null, message in result", async () => {
    const res = await slice.evalSandbox('throw new Error("boom")');
    assert.equal(res.ok, false);
    assert.equal(res.violation, null);
    assert.match(String(res.result), /boom/);
    assert.equal(res.exitCode, undefined);
  });

  await t.test("exit codes follow the contract: non-zero is ok false with exitCode, zero stays ok", async () => {
    const failed = await slice.evalSandbox("process.exit(3)");
    assert.equal(failed.ok, false);
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.violation, null);
    const viaProperty = await slice.evalSandbox("process.exitCode = 2; 7");
    assert.equal(viaProperty.ok, false);
    assert.equal(viaProperty.exitCode, 2);
    assert.equal(viaProperty.result, 7);
    const clean = await slice.evalSandbox("process.exit(0)");
    assert.equal(clean.ok, true);
    assert.equal(clean.exitCode, 0);
    assert.equal((await slice.evalSandbox("1")).exitCode, undefined);
  });

  await t.test("per-call allowNet and several audit secrets", async () => {
    const mock = 'Slice.mockFetch("https://example.com/x", {status:200, body:"ok"}); ';
    const allowed = await slice.evalSandbox(mock + 'Slice.fetchSync("https://example.com/x").status', { allowNet: ["example.com"] });
    assert.equal(allowed.result, 200);
    const blocked = await slice.evalSandbox(mock + 'Slice.fetchSync("https://example.com/x?k=pw_two_42").status', {
      allowNet: ["example.com"],
      auditEgress: ["pw_one_41", "pw_two_42"],
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.violation, /^EgressDlpViolation: /);
  });

  await t.test("deterministicSeed, checkpoints and checkpoint telemetry", async () => {
    const a = await slice.evalSandbox("Math.random()", { deterministicSeed: 7 });
    const b = await slice.evalSandbox("Math.random()", { deterministicSeed: 7 });
    assert.equal(a.result, b.result);
    const off = await slice.evalSandbox("Slice.checkpoint(); 1", { checkpoints: false });
    assert.equal(off.ok, false);
    assert.match(off.violation, /^CheckpointDenied: /);
    const tt = await slice.evalSandbox('Slice.kv.set("a","1"); const id = Slice.checkpoint(); Slice.kv.set("a","2"); Slice.restore(id); Slice.kv.get("a")');
    assert.equal(tt.telemetry.checkpoints, 1);
    assert.equal(tt.telemetry.rollbacks, 1);
  });

  await t.test("budgets above the runtime's default MCP ceiling are honored", async () => {
    const res = await slice.evalSandbox("let i = 0; while (i < 150000000) i++; i", { fuel: 200_000_000 });
    assert.equal(res.ok, true, res.violation ?? "");
  });

  await t.test("remote-only features are rejected with typed errors", async () => {
    await assert.rejects(slice.uploadCas(new Uint8Array([1])), (err) => err instanceof SliceApiError && err.code === "unsupported");
    await assert.rejects(slice.evalSandbox("1", { casDigest: "a".repeat(64) }), { code: "unsupported" });
  });
});

test("a missing binary gives a local_runtime_error", { skip }, async () => {
  const slice = createSlice({ local: true, binaryPath: binaryPath + ".missing" });
  try {
    await assert.rejects(slice.evalSandbox("1"), { code: "local_runtime_error" });
  } finally {
    await slice.close();
  }
});
