"use strict";

const os = require("node:os");
const path = require("node:path");
const { registry, labelOf } = require("../registry");
const { yieldNow } = require("../core/fsx");

async function discover(options = {}) {
  const ctx = { home: os.homedir(), env: process.env, extraRoots: [], ...options };
  const enabled = options.harnesses ? new Set(options.harnesses) : null;
  const found = [];
  const seen = new Set();
  for (const h of registry.list()) {
    if (enabled && !enabled.has(h.id)) continue;
    try {
      for (const hit of await h.discover(ctx)) {
        const root = path.resolve(hit.root);
        const key = `${h.id}:${process.platform === "win32" ? root.toLowerCase() : root}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ ...hit, root, harness: h.id, label: labelOf(h) });
      }
    } catch (error) {
      if (!ctx.report) throw error;
      ctx.report(h.id, error);
    }
    await yieldNow();
  }
  return found;
}

module.exports = { discover,
  get HARNESS_IDS() { return registry.list().map((h) => h.id); },
  get LABELS() { return Object.fromEntries(registry.list().map((h) => [h.id, labelOf(h)])); },
};
