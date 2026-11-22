import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServerTiming } from "../dist/index.js";

test("parses the contract example", () => {
  const header = 'boot;dur=0.00099;desc="Cold Boot", cas;dur=0.00042;desc="CAS mmap", vm;dur=0.0184;desc="VM Exec", total;dur=0.0312';
  assert.deepEqual(parseServerTiming(header), [
    { name: "boot", dur: 0.00099, desc: "Cold Boot" },
    { name: "cas", dur: 0.00042, desc: "CAS mmap" },
    { name: "vm", dur: 0.0184, desc: "VM Exec" },
    { name: "total", dur: 0.0312 },
  ]);
});

test("empty and missing headers give an empty list", () => {
  assert.deepEqual(parseServerTiming(null), []);
  assert.deepEqual(parseServerTiming(undefined), []);
  assert.deepEqual(parseServerTiming(""), []);
});

test("handles quoted commas and semicolons, unquoted desc, and whitespace", () => {
  assert.deepEqual(parseServerTiming('db ; dur = 12.5 ; desc="a, b; c" ,cache;desc=hit'), [
    { name: "db", dur: 12.5, desc: "a, b; c" },
    { name: "cache", desc: "hit" },
  ]);
});

test("metric with no params and first-occurrence wins", () => {
  assert.deepEqual(parseServerTiming("miss, x;dur=1;dur=2"), [{ name: "miss" }, { name: "x", dur: 1 }]);
});

test("skips malformed metrics and invalid durations", () => {
  assert.deepEqual(parseServerTiming(', "bad name";dur=1, ok;dur=abc'), [{ name: "ok" }]);
});
