/**
 * PI-Desktop: sessions live in pi.sqlite. `title_source` tells a name the user
 * (or the title generator) set from the default first-message preview.
 */
"use strict";

const { mkEntry, withDb, columnsOf } = require("../entry");
const { iso, text, cleanPath } = require("../fsx");

async function scan(root, ctx, hit) {
  const db = hit.db;
  const rows = withDb(db, (conn) => {
    const cols = columnsOf(conn, "sessions");
    const has = (c) => cols.has(c);
    const deleted = has("deleted_at") ? "WHERE s.deleted_at IS NULL" : "";
    const origins = conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_import_origins'")
      .all().length
      ? "LEFT JOIN session_import_origins o ON o.session_id = s.id"
      : "";
    const o = origins ? "o.source_id AS origin_source, o.external_id AS origin_external, o.plugin_id AS origin_plugin" : "NULL AS origin_source, NULL AS origin_external, NULL AS origin_plugin";
    return conn
      .prepare(
        `SELECT s.id, s.title, ${has("title_source") ? "s.title_source" : "NULL AS title_source"},
           s.created_at, s.updated_at, ${has("model_id") ? "s.model_id" : "NULL AS model_id"},
           p.path AS cwd, ${o},
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role IN ('user','assistant')) AS n
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id ${origins} ${deleted}`,
      )
      .all();
  });
  const out = [];
  for (const r of rows) {
    try {
      const title = text(r.title);
      const derived = !r.title_source || r.title_source === "default";
      out.push(
        mkEntry("pi-desktop", String(r.id), `${db}#session_id=${encodeURIComponent(r.id)}`, {
          name: derived ? undefined : title,
          firstPrompt: derived ? title : undefined,
          workspacePath: cleanPath(r.cwd),
          sourceFormat: "pi-desktop-sqlite",
          createdAt: iso(r.created_at),
          updatedAt: iso(r.updated_at),
          messageCount: Number(r.n) || 0,
          modelId: text(r.model_id),
          importedFrom: r.origin_source ? { plugin: r.origin_plugin, source: r.origin_source, externalId: r.origin_external } : undefined,
          importSource: null,
        }),
      );
    } catch (error) {
      ctx.report(String(r.id), error);
    }
  }
  return out;
}

module.exports = { scan };
