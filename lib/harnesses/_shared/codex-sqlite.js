"use strict";

const { execFile } = require("node:child_process");

const THREAD_FIELDS = [
  "id", "rollout_path", "name", "title", "first_user_message", "cwd",
  "created_at", "updated_at", "created_at_ms", "updated_at_ms", "archived",
  "has_user_event", "source", "thread_source", "parent_thread_id",
  "agent_path", "agent_nickname", "agent_role", "model", "reasoning_effort",
];

function readNative(file, DatabaseSync, kind = "state") {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    if (kind === "catalog") {
      const columns = new Set(db.prepare("PRAGMA table_info(local_thread_catalog)").all().map((row) => row.name));
      if (!["host_id", "thread_id", "display_title"].every((name) => columns.has(name))) return { available: false, threads: [] };
      const missing = columns.has("missing_candidate") ? ', missing_candidate' : '';
      const threads = db.prepare(`SELECT thread_id, display_title${missing} FROM local_thread_catalog WHERE host_id='local'`).all();
      return { available: true, threads: threads.filter((row) => !row.missing_candidate) };
    }
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
    if (!columns.has("id")) throw Object.assign(new Error("Codex state database has no threads.id"), { code: "CODEX_STATE_SCHEMA" });
    const selected = THREAD_FIELDS.filter((name) => columns.has(name)).map((name) => `"${name}"`).join(",");
    const threads = db.prepare(`SELECT ${selected} FROM threads`).all();
    const edgeColumns = new Set(db.prepare("PRAGMA table_info(thread_spawn_edges)").all().map((row) => row.name));
    const edges = edgeColumns.has("parent_thread_id") && edgeColumns.has("child_thread_id")
      ? db.prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all() : [];
    return { threads, edges };
  } finally { db.close(); }
}

// Electron may lack node:sqlite. Run only this fixed, read-only metadata query
// under the installed Node, never a shell, Codex CLI, or a copied live database.
async function readStateDb(file, options = {}) {
  if (!options.external) {
    let DatabaseSync;
    try { ({ DatabaseSync } = require("node:sqlite")); }
    catch (error) {
      if (!["ERR_UNKNOWN_BUILTIN_MODULE", "MODULE_NOT_FOUND", "ERR_NO_SUCH_BUILTIN_MODULE"].includes(error.code)) throw error;
    }
    if (DatabaseSync) return readNative(file, DatabaseSync, options.kind);
  }
  return new Promise((resolve, reject) => {
    execFile("node", [__filename, file, options.kind ?? "state"], { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(Object.assign(new Error("Codex state read failed: host needs node:sqlite or a Node with node:sqlite on PATH"), { code: "CODEX_SQLITE_HELPER_FAILED" }));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(Object.assign(new Error("Codex SQLite helper returned invalid metadata"), { code: "CODEX_SQLITE_HELPER_PROTOCOL" })); }
    });
  });
}

function readCatalogDb(file, options = {}) {
  return readStateDb(file, { ...options, kind: "catalog" });
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(readNative(process.argv[2], require("node:sqlite").DatabaseSync, process.argv[3]))); }
  catch { process.stderr.write("Codex read-only SQLite query failed\n"); process.exitCode = 1; }
}

module.exports = { readStateDb, readCatalogDb };
