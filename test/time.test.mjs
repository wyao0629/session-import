// test/time.test.mjs — core/time.js unit tests
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseTime, maxTime, minTime, monotonic } = require("../lib/core/time.js");

test("parseTime: ISO string", () => {
  const t = parseTime("2024-01-15T10:00:00.000Z");
  assert.ok(t && t.startsWith("2024-01-15"));
});

test("parseTime: unix seconds", () => {
  const t = parseTime(1700000000);
  assert.ok(t && t.includes("2023"));
});

test("parseTime: unix ms", () => {
  const t = parseTime(1700000000000);
  assert.ok(t && t.includes("2023"));
});

test("parseTime: numeric string seconds", () => {
  const t = parseTime("1700000000");
  assert.ok(t && t.includes("2023"));
});

test("parseTime: null returns null", () => {
  assert.equal(parseTime(null), null);
  assert.equal(parseTime(""), null);
  assert.equal(parseTime("garbage"), null);
});

test("maxTime: returns later value", () => {
  const a = "2024-01-01T00:00:00.000Z";
  const b = "2024-06-01T00:00:00.000Z";
  assert.equal(maxTime(a, b), b);
  assert.equal(maxTime(b, a), b);
});

test("maxTime: one null falls back to the other", () => {
  const a = "2024-01-01T00:00:00.000Z";
  assert.equal(maxTime(a, null), a);
  assert.equal(maxTime(null, a), a);
});

test("minTime: returns earlier value", () => {
  const a = "2024-01-01T00:00:00.000Z";
  const b = "2024-06-01T00:00:00.000Z";
  assert.equal(minTime(a, b), a);
});

test("monotonic: enforces non-decreasing", () => {
  const values = ["2024-03-01T00:00:00Z", "2024-01-01T00:00:00Z", "2024-06-01T00:00:00Z"];
  const result = monotonic(values);
  assert.equal(result[0], result[0]);           // first is the floor
  assert.ok(result[1] >= result[0]);            // jumped back, clamped
  assert.ok(result[2] >= result[1]);            // normal advance
});
