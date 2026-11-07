"use strict";

/**
 * Harness registry for session-import 2.0.
 *
 * Auto-loads all *.js files in this directory except index.js, generic.js,
 * and anything under _shared/. Each file must export an object conforming
 * to the Harness interface defined in lib/model.js.
 *
 * Harness interface:
 *   id          string           — matches the filename stem
 *   label       { en, "zh-CN" } — display name
 *   order       number           — lower = first in lists
 *   importSource string|null     — sessionSource id declared in manifest (null = not importable)
 *   aliases     string[]         — alternate harness ids
 *   schemes     string[]         — URI schemes (e.g. "codex://")
 *   capabilities { import, nativeInHost, children }
 *
 *   discover(ctx) -> Promise<{ root, via }[]>
 *     Find candidate root directories (one per install/account).
 *     ctx = { home, env, extraRoots }
 *
 *   scan(root, ctx) -> Promise<Entry[]>
 *     Enumerate all sessions under a root directory.
 *     ctx = { previous: Map<sessionId,Entry>, yieldNow }
 *
 *   messages(entry, ctx) -> Promise<Message[]>
 *     Read and parse all messages for one session.
 *     ctx = { withThinking: boolean }
 */

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Load harnesses
// ---------------------------------------------------------------------------

const SKIP = new Set(["index.js", "generic.js"]);

/** @type {Map<string, object>} */
const _byId = new Map();
/** @type {object[]} */
const _list = [];

(function loadAll() {
  const dir = __dirname;
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const toLoad = files
    .filter((f) => f.endsWith(".js") && !SKIP.has(f) && !f.startsWith("_"))
    .sort();

  for (const file of toLoad) {
    try {
      const mod = require(path.join(dir, file));
      if (!mod || typeof mod !== "object" || typeof mod.id !== "string") continue;
      _byId.set(mod.id, mod);
      for (const alias of mod.aliases ?? []) _byId.set(alias, mod);
      _list.push(mod);
    } catch (err) {
      console.error(`[session-import] harness load failed: ${file}`, err?.message);
    }
  }
  // Sort by order field, then by id for stable ordering
  _list.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.id.localeCompare(b.id));
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * All registered harnesses, in display order.
 * @returns {object[]}
 */
function list() {
  return _list;
}

/**
 * Get a harness by id (or alias).
 * @param {string} id
 * @returns {object|undefined}
 */
function get(id) {
  return _byId.get(id);
}

/**
 * Return all importable harnesses, keyed by their importSource id.
 * Used to build the manifest sessionSources list and the tool harness enum.
 * @returns {Map<string, object>}
 */
function importSources() {
  const result = new Map();
  for (const h of _list) {
    if (h.importSource && h.capabilities?.import) {
      result.set(h.importSource, h);
    }
  }
  return result;
}

/**
 * Return the list of harness ids exposed in the tool harness enum.
 * Includes all harness ids + aliases that have sessions on disk
 * (we include all registered ids regardless — the tool just filters).
 * @returns {string[]}
 */
function toolHarnessEnum() {
  const ids = new Set();
  for (const h of _list) {
    ids.add(h.id);
    for (const alias of h.aliases ?? []) ids.add(alias);
  }
  return [...ids].sort();
}

module.exports = { list, get, importSources, toolHarnessEnum };
