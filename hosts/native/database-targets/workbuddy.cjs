"use strict";
const { fs, path, randomUUID, context, result, writeRows, inserter, database, backupDatabase, transaction } = require("./common.cjs");

function projectKey(workspace) {
  const base = workspace.split(String.fromCharCode(92)).join("/").replace(/[/ :]/g, ch => ch === " " ? ch : "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  if (Buffer.byteLength(base, "utf8") <= 255) return base;
  let prefix = "", bytes = 0, hash = 5381;
  for (const ch of base) { const size = Buffer.byteLength(ch); if (bytes + size > 180) break; prefix += ch; bytes += size; }
  for (const byte of Buffer.from(base)) hash = (33 * hash) ^ byte;
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}
function* transcript(c) {
  let parentId;
  for (const m of c.records) {
    yield { id: m.id, parentId, timestamp: m.time, type: "message", role: m.role, status: "completed", content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.content }], sessionId: c.id, cwd: c.workspace };
    parentId = m.id;
  }
  yield { type: "ai-title", id: randomUUID(), sessionId: c.id, timestamp: c.updated, aiTitle: c.title };
}
module.exports = {
  id: "workbuddy", label: "WorkBuddy",
  defaultRoot: ({ home, env }) => env.WORKBUDDY_HOME || path.join(home, ".workbuddy"),
  async importSession(input) {
    const c = context("workbuddy", input);
    c.workspace = await fs.realpath(c.workspace);
    const file = path.join(c.root, "workbuddy.db"), db = await database(file);
    const sessionPath = path.join(c.root, "projects", projectKey(c.workspace), `${c.id}.jsonl`);
    try {
      const session = inserter(db, "sessions", ["id", "cwd", "user_id", "title", "created_at", "updated_at"]);
      const workspace = inserter(db, "workspaces", ["path", "last_opened_at"]);
      await backupDatabase(db, file);
      await transaction(db, async () => {
        if (!db.prepare("SELECT path FROM workspaces WHERE path=?").get(c.workspace)) workspace({ path: c.workspace, last_opened_at: c.now });
        session({ id: c.id, cwd: c.workspace, user_id: c.options.userId ?? "", title: c.title, custom_title: c.title, status: "completed", created_at: c.created, updated_at: c.updated, last_activity_at: c.updated, deleted_at: null, transport: "local", project_id: c.projectId ?? null, is_playground: 0, is_background_automation: 0 });
        await writeRows(sessionPath, transcript(c));
      });
      return result(c, sessionPath);
    } finally { db.close(); }
  }
};
