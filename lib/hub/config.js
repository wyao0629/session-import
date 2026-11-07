/**
 * Sync settings. Stored as plain scalar plugin settings so the host's
 * settings page can edit them; normalized here into one internal shape.
 *   autoSyncEnabled    boolean
 *   syncIntervalValue  number
 *   syncIntervalUnit   "seconds" | "minutes" | "hours" | "days"
 *   enabledHarnesses   comma separated harness ids; empty = all
 *   extraSearchRoots   comma / semicolon / newline separated absolute dirs
 */
"use strict";

const path = require("node:path");
const { registry } = require("../registry");

const UNIT_MS = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 365 * 86_400_000;
const DEFAULTS = { autoSyncEnabled: true, syncIntervalValue: 30, syncIntervalUnit: "minutes", enabledHarnesses: "", extraSearchRoots: "" };

function splitList(v) {
  return String(v ?? "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Directory lists: a path may contain commas, so split on newline or "|" only. */
function splitPaths(v) {
  return String(v ?? "")
    .split(/[\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalize(raw = {}) {
  const src = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) src[key] = raw[`session-import.${key}`] ?? raw[key] ?? DEFAULTS[key];
  const unit = Object.hasOwn(UNIT_MS, src.syncIntervalUnit) ? src.syncIntervalUnit : DEFAULTS.syncIntervalUnit;
  const value = Number(src.syncIntervalValue);
  const safeValue = Number.isFinite(value) && value > 0 ? value : DEFAULTS.syncIntervalValue;
  const intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(safeValue * UNIT_MS[unit])));
  const ids = registry.list().map((h) => h.id);
  const listed = splitList(src.enabledHarnesses).map((id) => registry.get(id)?.id).filter(Boolean);
  return {
    autoSyncEnabled: src.autoSyncEnabled !== false,
    syncIntervalValue: safeValue,
    syncIntervalUnit: unit,
    intervalMs,
    harnesses: listed.length ? [...new Set(listed)] : ids,
    extraRoots: splitPaths(src.extraSearchRoots).filter((p) => path.isAbsolute(p)),
  };
}

/** Accept only known keys from the panel before writing them back. */
function sanitizePatch(patch = {}) {
  const out = {};
  if ("autoSyncEnabled" in patch) out.autoSyncEnabled = patch.autoSyncEnabled !== false;
  if ("syncIntervalValue" in patch) {
    const n = Number(patch.syncIntervalValue);
    if (Number.isFinite(n) && n > 0) out.syncIntervalValue = n;
  }
  if ("syncIntervalUnit" in patch && Object.hasOwn(UNIT_MS, patch.syncIntervalUnit)) out.syncIntervalUnit = patch.syncIntervalUnit;
  if ("enabledHarnesses" in patch) out.enabledHarnesses = String(patch.enabledHarnesses ?? "");
  if ("extraSearchRoots" in patch) out.extraSearchRoots = String(patch.extraSearchRoots ?? "");
  return out;
}

module.exports = { normalize, sanitizePatch, DEFAULTS, UNIT_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS };
