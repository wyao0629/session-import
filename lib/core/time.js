"use strict";

/**
 * Unified time parsing for session-import 2.0.
 *
 * Single authoritative implementation. Handles:
 *   - RFC3339 / ISO8601 strings
 *   - Unix seconds (number or string 10-13 digits, heuristic)
 *   - Unix milliseconds (number > 1e12)
 *
 * Returns ISO8601 string or null when unparseable.
 */

const UNIX_SEC_MAX = 1e12; // Timestamps above this are treated as ms

/**
 * Parse any reasonable timestamp value into an ISO8601 string.
 * @param {*} value
 * @returns {string|null}
 */
function parseTime(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < UNIX_SEC_MAX ? value * 1000 : value;
    return ms <= 253402300799999 ? new Date(ms).toISOString() : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Numeric string: unix seconds or milliseconds
    if (/^\d{10,13}$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      const ms = n < UNIX_SEC_MAX ? n * 1000 : n;
      return new Date(ms).toISOString();
    }
    // ISO/RFC3339
    const t = Date.parse(trimmed);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
    return null;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : value.toISOString();
  }
  return null;
}

/**
 * Parse and return a Date object, or null.
 * @param {*} value
 * @returns {Date|null}
 */
function parseDate(value) {
  const iso = parseTime(value);
  return iso ? new Date(iso) : null;
}

/**
 * Return the later of two timestamp values. Falls back to now() when both are null.
 * @param {*} a
 * @param {*} b
 * @returns {string}
 */
function maxTime(a, b) {
  const ta = parseTime(a);
  const tb = parseTime(b);
  if (!ta && !tb) return new Date().toISOString();
  if (!ta) return tb;
  if (!tb) return ta;
  return ta > tb ? ta : tb;
}

/**
 * Return the earlier of two timestamp values. Falls back to now() when both are null.
 * @param {*} a
 * @param {*} b
 * @returns {string}
 */
function minTime(a, b) {
  const ta = parseTime(a);
  const tb = parseTime(b);
  if (!ta && !tb) return new Date().toISOString();
  if (!ta) return tb;
  if (!tb) return ta;
  return ta < tb ? ta : tb;
}

/**
 * Enforce monotonic non-decreasing timestamps over an array of values.
 * Returns an array of ISO strings. Null/unparseable values inherit the previous value.
 * @param {*[]} values
 * @param {string} [floor] Minimum start value (ISO)
 * @returns {string[]}
 */
function monotonic(values, floor) {
  let prev = parseTime(floor) ?? new Date().toISOString();
  return values.map((v) => {
    const t = parseTime(v);
    if (!t || t < prev) return prev;
    prev = t;
    return t;
  });
}

module.exports = { parseTime, parseDate, maxTime, minTime, monotonic };
