"use strict";

const path = require("node:path");
const { safeStat } = require("./pi-common");

async function readMetadata(root, ids) {
  const file = path.join(root, "pi.sqlite");
  if (!(await safeStat(file))?.isFile()) return new Map();
  for (const suffix of ["-wal", "-shm"]) {
    // Refuse linked sidecars as well as a linked database.
    const fs = require("node:fs/promises");
    try {
      if ((await fs.lstat(file + suffix)).isSymbolicLink()) throw new Error("Linked PI-Desktop database sidecar");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (!tables.has("sessions")) throw new Error("Missing PI-Desktop sessions table");
    const columns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name));
    const fields = ["title", "title_source", "created_at", "updated_at", "model_id", "source", "deleted_at"].map((name) => columns.has(name) ? `s.${name}` : `NULL AS ${name}`);
    const projects = tables.has("projects") && columns.has("project_id");
    const origins = tables.has("session_import_origins");
    const query = `SELECT s.id, ${fields.join(", ")}, ${projects ? "p.path" : "NULL"} AS cwd,
      ${origins ? "o.session_id AS origin_session, o.plugin_id AS origin_plugin, o.source_id AS origin_source, o.external_id AS origin_external" : "NULL AS origin_session, NULL AS origin_plugin, NULL AS origin_source, NULL AS origin_external"}
      FROM sessions s ${projects ? "LEFT JOIN projects p ON p.id=s.project_id" : ""}
      ${origins ? "LEFT JOIN session_import_origins o ON o.session_id=s.id" : ""}`;
    const rows = [];
    if (ids) {
      for (let i = 0; i < ids.length; i += 300) {
        const batch = ids.slice(i, i + 300);
        rows.push(...db.prepare(`${query} WHERE s.id IN (${batch.map(() => "?").join(",")})`).all(...batch));
      }
    } else rows.push(...db.prepare(query).all());
    return new Map(rows.map((row) => [String(row.id), row]));
  } finally { db.close(); }
}

module.exports = { readMetadata };
