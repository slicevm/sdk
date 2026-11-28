import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { artifactBytes, artifactText, createSlice, SliceApiError } from "../dist/index.js";

const TIMING = 'boot;dur=0.00099;desc="Cold Boot", cas;dur=0.00042;desc="CAS mmap", vm;dur=0.0184;desc="VM Exec", total;dur=0.0312';

const RESULT = {
  ok: true,
  stdout: ["hello"],
  result: { answer: 42 },
  violation: null,
  telemetry: {
    coldBootUs: 0.99,
    casMmapUs: 0,
    vmExecUs: 18.4,
    rollbackUs: 0,
    totalUs: 31.2,
    fuelConsumed: 1234,
    peakMemoryKb: 512,
    mpkDomain: "pkey_02",
    checkpoints: 0,
    rollbacks: 0,
  },
};

let calls;
let responses;
const realFetch = globalThis.fetch;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return typeof next === "function" ? next() : next;
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("mode selection: apiKey or SLICE_API_KEY means remote, local: true wins", async () => {
  assert.equal(createSlice({ apiKey: "k" }).mode, "remote");
  assert.equal(createSlice({ apiKey: "k", local: true }).mode, "local");
  const prev = process.env.SLICE_API_KEY;
  process.env.SLICE_API_KEY = "env_key";
  try {
    assert.equal(createSlice().mode, "remote");
  } finally {
    if (prev === undefined) delete process.env.SLICE_API_KEY;
    else process.env.SLICE_API_KEY = prev;
  }
  if (!process.env.SLICE_API_KEY) assert.equal(createSlice().mode, "local");
});

test("evalSandbox sends the contract request and returns the result with timing", async () => {
  responses.push(json(200, RESULT, { "x-slice-request-id": "req_01", "server-timing": TIMING }));
  const slice = createSlice({ apiKey: "slice_live_test", baseUrl: "https://api.example.test/" });
  const res = await slice.evalSandbox("1 + 1", { fuel: 1000, memoryKb: 4096, auditEgress: ["sk_1"], casDigest: "a".repeat(64) });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/sandbox/eval");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer slice_live_test");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    code: "1 + 1",
    casDigest: "a".repeat(64),
    options: { fuel: 1000, memoryKb: 4096, auditEgress: ["sk_1"] },
  });

  assert.deepEqual(res.result, { answer: 42 });
  assert.deepEqual(res.telemetry, RESULT.telemetry);
  assert.equal(res.requestId, "req_01");
  assert.equal(res.serverTiming.length, 4);
  assert.deepEqual(res.serverTiming[0], { name: "boot", dur: 0.00099, desc: "Cold Boot" });
});

test("options are omitted when empty", async () => {
  responses.push(json(200, RESULT));
  await createSlice({ apiKey: "k" }).evalSandbox("x");
  assert.deepEqual(JSON.parse(calls[0].init.body), { code: "x" });
});

test("a sandbox violation is a 200 with ok false, not an error", async () => {
  const violated = { ...RESULT, ok: false, result: null, violation: "EgressDlpViolation: blocked" };
  responses.push(json(200, violated));
  const res = await createSlice({ apiKey: "k" }).evalSandbox("x");
  assert.equal(res.ok, false);
  assert.equal(res.violation, "EgressDlpViolation: blocked");
});

test("503 overloaded is retried with backoff and then succeeds", async () => {
  const overloaded = () => json(503, { error: { code: "overloaded", message: "queue full" } });
  responses.push(overloaded, overloaded, json(200, RESULT));
  const res = await createSlice({ apiKey: "k" }).evalSandbox("x");
  assert.equal(res.ok, true);
  assert.equal(calls.length, 3);
});

test("503 gives up after 3 retries with a typed overloaded error", async () => {
  for (let i = 0; i < 4; i++) responses.push(() => json(503, { error: { code: "overloaded", message: "queue full" } }, { "x-slice-request-id": `req_${i}` }));
  await assert.rejects(createSlice({ apiKey: "k" }).evalSandbox("x"), (err) => {
    assert.ok(err instanceof SliceApiError);
    assert.equal(err.code, "overloaded");
    assert.equal(err.status, 503);
    assert.equal(err.message, "queue full");
    assert.equal(err.requestId, "req_3");
    return true;
  });
  assert.equal(calls.length, 4);
});

test("429 rate_limited (runs in flight) is retried and then succeeds", async () => {
  const busy = () => json(429, { error: { code: "rate_limited", message: "in flight" } }, { "retry-after": "0" });
  responses.push(busy, busy, json(200, RESULT));
  const res = await createSlice({ apiKey: "k" }).evalSandbox("x");
  assert.equal(res.ok, true);
  assert.equal(calls.length, 3);
});

test("429 rate_limited gives up after 8 retries", async () => {
  for (let i = 0; i < 9; i++) responses.push(() => json(429, { error: { code: "rate_limited", message: "in flight" } }, { "retry-after": "0" }));
  await assert.rejects(createSlice({ apiKey: "k" }).evalSandbox("x"), (err) => err instanceof SliceApiError && err.code === "rate_limited");
  assert.equal(calls.length, 9);
});

const ERROR_CASES = [
  [400, "bad_request"],
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [413, "payload_too_large"],
  [429, "quota_exceeded"],
];

for (const [status, code] of ERROR_CASES) {
  test(`HTTP ${status} ${code} maps to SliceApiError without retry`, async () => {
    responses.push(json(status, { error: { code, message: `msg ${code}` } }));
    await assert.rejects(createSlice({ apiKey: "k" }).evalSandbox("x"), (err) => {
      assert.ok(err instanceof SliceApiError);
      assert.equal(err.code, code);
      assert.equal(err.status, status);
      assert.equal(err.message, `msg ${code}`);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

test("non-JSON error bodies fall back to a status-derived code", async () => {
  responses.push(new Response("<html>bad gateway</html>", { status: 502 }));
  await assert.rejects(createSlice({ apiKey: "k" }).evalSandbox("x"), { name: "SliceApiError", code: "internal", status: 502 });
});

test("network failures become network_error", async () => {
  responses.push(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(createSlice({ apiKey: "k" }).evalSandbox("x"), { code: "network_error", status: 0 });
});

test("timeouts become timeout errors", async () => {
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  // AbortSignal.timeout uses an unref'd timer; a real fetch holds a socket open, the mock does not.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(createSlice({ apiKey: "k", timeoutMs: 50 }).evalSandbox("x"), { code: "timeout" });
  } finally {
    clearTimeout(keepAlive);
  }
});

test("uploadCas posts raw bytes and returns the digest", async () => {
  const digest = "f".repeat(64);
  responses.push(json(201, { casDigest: digest, bytes: 3, modules: 1 }));
  const res = await createSlice({ apiKey: "k" }).uploadCas(new Uint8Array([1, 2, 3]));
  assert.equal(calls[0].url, "https://api.slicevm.com/v1/cas/upload");
  assert.equal(calls[0].init.headers["content-type"], "application/octet-stream");
  assert.deepEqual([...calls[0].init.body], [1, 2, 3]);
  assert.deepEqual(res, { casDigest: digest, bytes: 3, modules: 1 });
});

test("empty code is rejected client-side", async () => {
  await assert.rejects(createSlice({ apiKey: "k" }).evalSandbox(""), { code: "bad_request" });
  assert.equal(calls.length, 0);
});

test("closed clients reject new calls", async () => {
  const slice = createSlice({ apiKey: "k" });
  await slice.close();
  await assert.rejects(slice.evalSandbox("x"), { code: "unsupported" });
});

test("artifacts: the option is sent and inline files decode", async () => {
  const csv = Buffer.from("a,b;1,2;").toString("base64");
  responses.push(
    json(200, {
      ...RESULT,
      artifacts: [{ name: "data/rows.csv", size: 8, contentType: "text/csv", sha256: "x", data: csv }],
      skippedArtifacts: [{ path: "big.bin", reason: "tooLarge" }],
    }),
  );
  const slice = createSlice({ apiKey: "k", baseUrl: "https://api.test" });
  const res = await slice.evalSandbox("1", { artifacts: "inline" });
  assert.deepEqual(JSON.parse(calls[0].init.body).options, { artifacts: "inline" });
  assert.equal(artifactText(res.artifacts[0]), "a,b;1,2;");
  assert.equal(artifactBytes(res.artifacts[0]).length, 8);
  assert.deepEqual(res.skippedArtifacts, [{ path: "big.bin", reason: "tooLarge" }]);
});
