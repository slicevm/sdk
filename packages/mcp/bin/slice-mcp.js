#!/usr/bin/env node
"use strict";
// `npx -y @slicevm/mcp [flags]` starts a Slice MCP server over stdio.
//
// Local mode (default, no account): runs `slice mcp [flags]` from @slicevm/cli. Flags are passed
// through unchanged; `--audit-egress=auto` is handled by the runtime itself.
//
// Cloud mode (SLICE_API_KEY or --api-key=<key>, and no --local): bridges newline-delimited
// JSON-RPC on stdin/stdout to the hosted MCP endpoint `POST <SLICE_API_URL>/mcp` with the key
// as a bearer token. Only JSON-RPC is ever written to stdout; diagnostics go to stderr.

const { version } = require("../package.json");

const DEFAULT_API_URL = "https://api.slicevm.com";
const KEY_HELP = "create a key at https://slicevm.com/console/";
const LOCAL_ONLY_FLAGS = ["--allow-read", "--allow-write", "--allow-net", "--audit-egress"];

function log(line) {
  process.stderr.write(`slice-mcp: ${line}\n`);
}

/** Splits argv into wrapper options and the flags meant for `slice mcp`. */
function parseArgs(argv) {
  const opts = { apiKey: undefined, local: false, smokeTest: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") opts.local = true;
    else if (arg.startsWith("--api-key=")) opts.apiKey = arg.slice("--api-key=".length);
    else if (arg === "--api-key" && i + 1 < argv.length) opts.apiKey = argv[++i];
    else {
      if (arg === "--smoke-test") opts.smokeTest = true;
      opts.rest.push(arg);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Cloud mode
// ---------------------------------------------------------------------------------------------

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

const isRequest = (m) => m && typeof m === "object" && !Array.isArray(m) && "method" in m && m.id !== undefined && m.id !== null;

/** Parses a text/event-stream body into the JSON values carried by its `data:` fields. */
function parseSse(text) {
  const out = [];
  let data = [];
  const flush = () => {
    if (data.length) {
      const payload = data.join("\n");
      data = [];
      try {
        out.push(JSON.parse(payload));
      } catch {
        // Not JSON (for example a keep-alive); ignore.
      }
    }
  };
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (raw === "") flush();
    else if (raw.startsWith("data:")) data.push(raw.slice(5).replace(/^ /, ""));
  }
  flush();
  return out;
}

function createCloudClient({ apiKey, baseUrl }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/mcp`;
  let protocolVersion;
  let sessionId;
  let warned401 = false;

  /**
   * Sends one JSON-RPC message (object) and resolves with the JSON-RPC messages to hand back to
   * the client: the response for a request (always exactly one), nothing for a notification.
   */
  async function send(message) {
    const id = isRequest(message) ? message.id : undefined;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": `slicevm-mcp/${version}`,
    };
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    let res;
    let body;
    try {
      res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(message) });
      body = await res.text();
    } catch (err) {
      const reason = (err && err.cause && err.cause.message) || (err && err.message) || String(err);
      const text = `cannot reach Slice Cloud at ${endpoint}: ${reason}`;
      if (id === undefined) {
        log(text);
        return [];
      }
      return [rpcError(id, -32603, text)];
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    if (res.status === 401) {
      const text = `Slice Cloud rejected the request (HTTP 401): invalid or missing SLICE_API_KEY; ${KEY_HELP}`;
      if (!warned401) {
        warned401 = true;
        log(text);
      }
      return id === undefined ? [] : [rpcError(id, -32001, text)];
    }

    const type = (res.headers.get("content-type") || "").toLowerCase();
    let messages = [];
    if (type.includes("text/event-stream")) {
      messages = parseSse(body);
    } else if (body.trim()) {
      try {
        const parsed = JSON.parse(body);
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        messages = [];
      }
    }
    messages = messages.filter((m) => m && typeof m === "object" && m.jsonrpc === "2.0");

    if (id === undefined) {
      if (!res.ok) log(`notification ${message.method} failed with HTTP ${res.status}`);
      return [];
    }

    const reply = messages.find((m) => m.id === id && ("result" in m || "error" in m));
    if (reply) {
      if (message.method === "initialize" && reply.result && typeof reply.result.protocolVersion === "string") {
        protocolVersion = reply.result.protocolVersion;
      }
      // Server-to-client messages that arrived with the reply (for example progress) come first.
      return [...messages.filter((m) => m !== reply), reply];
    }
    const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
    const text = res.ok
      ? `Slice Cloud returned no JSON-RPC response for this request (HTTP ${res.status})`
      : `Slice Cloud returned HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`;
    return [rpcError(id, -32603, text)];
  }

  return { send, endpoint };
}

function writeOut(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function runBridge(client) {
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  // Until an initialize request is answered, later messages wait for it so they carry the
  // negotiated MCP-Protocol-Version. After that, requests run concurrently.
  let initGate = Promise.resolve();

  const track = (p) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeOut(rpcError(null, -32700, "Parse error: stdin line is not valid JSON"));
      return;
    }

    if (Array.isArray(message)) {
      if (message.length === 0) {
        writeOut(rpcError(null, -32600, "Invalid Request: empty batch"));
        return;
      }
      // Batches are split into single POSTs; the replies go back as one array line.
      const gate = initGate;
      const job = gate.then(async () => {
        const replies = await Promise.all(message.map((m) => client.send(m)));
        const flat = replies.flat();
        if (flat.length) writeOut(flat);
      });
      track(job);
      return;
    }

    if (!message || typeof message !== "object") {
      writeOut(rpcError(null, -32600, "Invalid Request: expected a JSON-RPC object"));
      return;
    }

    // Responses from the client (to server requests) have no meaning for a stateless server.
    if (!("method" in message)) return;

    const gate = initGate;
    const job = gate.then(async () => {
      for (const reply of await client.send(message)) writeOut(reply);
    });
    track(job);
    if (message.method === "initialize") initGate = job.catch(() => {});
  });

  rl.on("close", async () => {
    while (pending.size) await Promise.allSettled([...pending]);
    process.stdout.write("", () => process.exit(0));
  });
}

async function runCloudSmokeTest(client) {
  const steps = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slice-mcp-smoke", version } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list", params: {} },
    { id: 3, method: "tools/call", params: { name: "slice_eval_ts", arguments: { code: "1 + 1" } } },
  ];
  const bar = "=".repeat(73);
  console.log(bar);
  console.log("  SLICE CLOUD MCP SMOKE TEST");
  console.log(`  endpoint: ${client.endpoint}`);
  console.log(bar);
  const fail = (why) => {
    console.log(bar);
    log(`smoke test FAILED: ${why}`);
    process.exit(1);
  };
  for (const step of steps) {
    const replies = await client.send({ jsonrpc: "2.0", ...step });
    if (step.id === undefined) continue;
    const reply = replies.find((m) => m.id === step.id);
    if (!reply) return fail(`${step.method} produced no response`);
    const line = JSON.stringify(reply);
    console.log(`  -> ${line.length > 400 ? `${line.slice(0, 400)}...` : line}`);
    if (reply.error) return fail(`${step.method} returned JSON-RPC error: ${reply.error.message}`);
    if (step.method === "tools/list") {
      const names = ((reply.result && reply.result.tools) || []).map((t) => t.name);
      if (!names.includes("slice_eval_ts")) {
        return fail("tools/list does not include slice_eval_ts (does the key have the sandbox:eval scope?)");
      }
    }
    if (step.method === "tools/call") {
      if (reply.result && reply.result.isError) return fail(`slice_eval_ts returned a tool error: ${line}`);
      const text = ((reply.result && reply.result.content) || []).map((c) => c.text || "").join("\n");
      if (!/\b2\b/.test(text)) return fail(`slice_eval_ts result does not contain 2: ${text.slice(0, 200)}`);
    }
  }
  console.log(bar);
  console.log("  PASS: initialize, tools/list, slice_eval_ts(1 + 1) = 2");
  process.exit(0);
}

function runCloud(opts) {
  const baseUrl = process.env.SLICE_API_URL || DEFAULT_API_URL;
  const ignored = opts.rest.filter((a) => a !== "--smoke-test" && a.startsWith("-"));
  if (ignored.length) {
    const names = [...new Set(ignored.map((a) => a.split("=")[0]))];
    const localOnly = names.some((n) => LOCAL_ONLY_FLAGS.includes(n));
    log(
      `cloud mode ignores ${names.join(", ")}${localOnly ? " (local-only flags)" : ""}; ` +
        "sandbox policy is set by Slice Cloud. Use --local to run the local runtime.",
    );
  }
  const client = createCloudClient({ apiKey: opts.apiKey, baseUrl });
  if (opts.smokeTest) {
    runCloudSmokeTest(client).catch((err) => {
      log(`smoke test FAILED: ${err && err.message}`);
      process.exit(1);
    });
  } else {
    runBridge(client);
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.SLICE_API_KEY;
  if (apiKey && !opts.local) {
    runCloud({ ...opts, apiKey });
    return;
  }
  const { runBinary } = require("@slicevm/cli");
  runBinary(["mcp", ...opts.rest]);
}

if (require.main === module) main();

module.exports = { parseArgs, parseSse, createCloudClient };
