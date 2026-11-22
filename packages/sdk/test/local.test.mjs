// Integration test for local mode against a real `slice` binary.
// Uses SLICE_TEST_BINARY, else the sibling repo build; skipped when absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSlice, SliceApiError } from "../dist/index.js";

// The runtime repo is a sibling checkout: <root>/slice next to <root>/<this repo>.
const exe = process.platform === "win32" ? "slice.exe" : "slice";
const DEFAULT_BINARY = fileURLToPath(new URL(`../../../../slice/target/release/${exe}`, import.meta.url));
const binaryPath = process.env.SLICE_TEST_BINARY ?? DEFAULT_BINARY;
const skip = existsSync(binaryPath) ? false : `slice binary not found at ${binaryPath} (set SLICE_TEST_BINARY)`;

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

  await t.test("multiplexes concurrent requests by id", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => slice.evalSandbox(`${i} * 10`)));
    assert.deepEqual(results.map((r) => r.result), [0, 10, 20, 30, 40, 50, 60, 70]);
  });

  await t.test("fuel exhaustion is a violation and the next call still works", async () => {
    const trapped = await slice.evalSandbox("while (true) {}", { fuel: 1000 });
    assert.equal(trapped.ok, false);
    assert.match(trapped.violation, /fuel/i);
    const after = await slice.evalSandbox("1 + 1");
    assert.equal(after.ok, true);
    assert.equal(after.result, 2);
  });

  await t.test("uncaught exceptions follow the contract: ok false, violation null, message in result", async () => {
    const res = await slice.evalSandbox('throw new Error("boom")');
    assert.equal(res.ok, false);
    assert.equal(res.violation, null);
    assert.match(String(res.result), /boom/);
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
    assert.match(blocked.violation, /EGRESS_SECRET_LEAK_BLOCKED|Egress DLP/);
  });

  await t.test("deterministicSeed, checkpoints and checkpoint telemetry", async () => {
    const a = await slice.evalSandbox("Math.random()", { deterministicSeed: 7 });
    const b = await slice.evalSandbox("Math.random()", { deterministicSeed: 7 });
    assert.equal(a.result, b.result);
    const off = await slice.evalSandbox("Slice.checkpoint(); 1", { checkpoints: false });
    assert.equal(off.ok, false);
    assert.match(off.violation, /checkpoint/i);
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
