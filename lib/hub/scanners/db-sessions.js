/**
 * ZCode and OpenCode share a `session` / `message` SQLite layout: `session.title`
 * is the name the app shows, `directory` the workspace.
 */
"use strict";

const { mkEntry, withDb, columnsOf } = require("../entry");
const { statSig, text, iso, cleanPath } = require("../fsx");

function scanDb(harness, format) {
  return async function scan(root, ctx, hit) {
    const file = hit.db;
    const st = await statSig(file);
    const rows = withDb(file, (db) => {
      const cols = columnsOf(db, "session");
      const parent = cols.has("parent_id") ? "s.parent_id" : "NULL";
      const filter = cols.has("task_type") ? "WHERE s.task_type <> 'subagent_child'" : "";
      const archived = cols.has("time_archived") ? "s.time_archived" : "NULL";
      return db
        .prepare(
          `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, ${parent} AS parent, ${archived} AS archived,
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS n
           FROM session s ${filter}`,
        )
        .all();
    });
    const out = [];
    for (const r of rows) {
      if (!r.id || !r.n) continue;
      try {
        out.push(
          mkEntry(harness, String(r.id), `${file}#session_id=${encodeURIComponent(r.id)}`, {
            name: text(r.title),
            workspacePath: cleanPath(r.directory),
            sourceFormat: format,
            createdAt: iso(r.time_created),
            updatedAt: iso(r.time_updated) ?? (st ? new Date(st.mtimeMs).toISOString() : undefined),
            messageCount: Number(r.n),
            parentSessionId: text(r.parent),
            archived: Boolean(r.archived),
            sig: `${r.time_updated}:${r.n}`,
          }),
        );
      } catch (error) {
        ctx.report(String(r.id), error);
      }
    }
    return out;
  };
}

module.exports = {
  scanZcode: scanDb("zcode", "zcode-sqlite"),
  scanOpencode: scanDb("opencode", "opencode-sqlite"),
};
