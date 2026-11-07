"use strict";
const { path, exists, fileOf, withDb, columns, normalize, harness } = require("./other");
function create(config) {
  return harness({ ...config,
    async enumerate(root) {
      let file;
      for (const name of config.databases) if (await exists(path.join(root, name))) { file = path.join(root, name); break; }
      if (!file) return [];
      return withDb(file, db => {
        const cols = columns(db, "session");
        const optional = name => cols.has(name) ? name : `NULL AS ${name}`;
        return db.prepare(`SELECT id,title,directory,time_created,time_updated,${optional("parent_id")},${optional("task_type")},${optional("time_archived")} FROM session`).all().map(r => ({
          sessionId: String(r.id), sessionPath: `${file}#session_id=${encodeURIComponent(r.id)}`, filePath: file, sourceFormat: `${config.id}-sqlite`,
          name: r.title, workspacePath: r.directory, createdAt: r.time_created, updatedAt: r.time_updated,
          parentSessionId: r.parent_id, subagent: r.task_type === "subagent_child", archived: !!r.time_archived, branchKind: r.task_type,
          dependencies: [file + "-wal"],
        }));
      });
    },
    async load(entry) {
      return withDb(fileOf(entry), db => {
        const order = table => ["sequence", "time_created", "id"].filter(c => columns(db, table).has(c)).join(",");
        const msgs = db.prepare(`SELECT id,data,time_created FROM message WHERE session_id=? ORDER BY ${order("message")}`).all(entry.sessionId);
        const parts = db.prepare(`SELECT message_id,data FROM part WHERE session_id=? ORDER BY ${order("part")}`).all(entry.sessionId);
        const byMessage = new Map();
        for (const p of parts) { const bucket = byMessage.get(p.message_id) ?? []; bucket.push(JSON.parse(p.data)); byMessage.set(p.message_id, bucket); }
        const records = msgs.map(r => { const m = JSON.parse(r.data); return { ...m, content: byMessage.get(r.id) ?? m.content, timestamp: m.time?.created ?? r.time_created }; });
        return { meta: { modelId: records.findLast(m => m.modelID)?.modelID }, messages: normalize(records) };
      });
    }
  });
}
module.exports = { create };
