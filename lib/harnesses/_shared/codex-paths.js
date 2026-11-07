"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { cleanPath } = require("./codex-rollout");

const canon = (file) => process.platform === "win32" ? file.toLowerCase() : file;

async function rolloutRoots(roots) {
  if (!roots?.length) throw Object.assign(new Error("Codex rollout requires a discovered source root"), { code: "CODEX_ROOT_REQUIRED" });
  return Promise.all(roots.map((root) => fs.realpath(cleanPath(root))));
}

async function resolveRollout(file, roots, { allowMissing = false } = {}) {
  if (!file && allowMissing) return null;
  const full = path.resolve(roots[0], cleanPath(file));
  const candidates = full.endsWith(".zst") ? [full] : [full, full + ".zst"];
  let missing;
  for (const candidate of candidates) {
    let resolved;
    try { resolved = await fs.realpath(candidate); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      missing = error;
      continue;
    }
    const target = canon(resolved);
    if (!roots.some((root) => {
      const base = canon(root);
      return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
    })) throw Object.assign(new Error("Codex rollout is outside discovered source roots"), { code: "CODEX_ROOT_ESCAPE" });
    if ((await fs.stat(resolved)).isFile()) return resolved;
    throw Object.assign(new Error("Codex rollout is not a regular file"), { code: "CODEX_ROLLOUT_FILE" });
  }
  if (allowMissing) return null;
  throw missing;
}

module.exports = { rolloutRoots, resolveRollout };
