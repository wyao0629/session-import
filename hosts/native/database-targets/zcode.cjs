"use strict";
const { path, randomUUID, context, result, exists, samePath, inserter, database, backupDatabase, transaction } = require("./common.cjs");
const installedVersion = require("./version.cjs");

function projectFor(db, c, insertProject, insertRoot, insertHost) {
  const rows = db.prepare("SELECT p.project_id,p.host_id,r.root_path FROM gui.projects p JOIN gui.project_roots r USING(project_id) WHERE p.deleted=0 AND p.host_id='local'").all();
  const match = rows.find(row => (!c.projectId || row.project_id === c.projectId) && samePath(row.root_path, c.workspace));
  if (c.projectId && !match) throw new Error(`zcode: project ${c.projectId} has no local root matching destination.workspace`);
  if (match) return match.project_id;
  if (!db.prepare("SELECT host_id FROM gui.hosts WHERE host_id=?").get("local")) insertHost({ host_id: "local", kind: "local", position: 0 });
  const id = randomUUID();
  const position = db.prepare("SELECT coalesce(min(position),1)-1 AS position FROM gui.projects WHERE host_id=?").get("local").position;
  insertProject({ project_id: id, host_id: "local", name: path.basename(c.workspace), name_overridden: 0, position, pinned: 0, deleted: 0, created_at: c.now, updated_at: c.now });
  insertRoot({ project_id: id, root_path: c.workspace, position: 0, is_primary: 1 });
  return id;
}
module.exports = {
  id: "zcode", label: "ZCode",
  defaultRoot: ({ home, env }) => env.ZCODE_HOME || path.join(env.ZCODE_DATA_BASE_DIR || home, ".zcode"),
  async importSession(input) {
    const c = context("zcode", input);
    c.id = `sess_${c.id}`;
    const file = path.join(c.root, "cli", "db", "db.sqlite");
    const catalog = path.join(c.root, "v2", "tasks-index.sqlite");
    if (!await exists(catalog)) throw new Error(`zcode: GUI task/project catalog is missing: ${catalog}`);
    const db = await database(file);
    try {
      db.prepare("ATTACH DATABASE ? AS gui").run(catalog);
      const session = inserter(db, "session", ["id", "project_id", "directory", "version", "title", "time_created", "time_updated", "task_type", "title_source"]);
      const message = inserter(db, "message", ["id", "session_id", "data", "sequence", "time_created", "time_updated"]);
      const part = inserter(db, "part", ["id", "session_id", "message_id", "data", "sequence", "time_created", "time_updated"]);
      const task = inserter(db, "tasks", ["workspace_key", "workspace_path", "task_id", "meta_json", "project_id", "host_id", "root_path", "cli_created_at", "cli_updated_at", "cli_title", "provider"], "gui");
      const project = inserter(db, "projects", ["project_id", "host_id", "position"], "gui");
      const root = inserter(db, "project_roots", ["project_id", "root_path"], "gui");
      const host = inserter(db, "hosts", ["host_id", "kind"], "gui");
      const version = c.options.version || db.prepare("SELECT version FROM session ORDER BY time_updated DESC LIMIT 1").get()?.version || await installedVersion("zcode");
      await backupDatabase(db, file);
      await backupDatabase(db, catalog, "gui");
      await transaction(db, () => {
        const projectId = projectFor(db, c, project, root, host);
        const cliProjectId = "proj_" + (c.workspace.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default");
        const traceId = randomUUID();
        session({ id: c.id, project_id: cliProjectId, slug: c.id, directory: c.workspace, path: c.workspace, title: c.title, version, task_type: "interactive", title_source: "custom", trace_id: traceId, permission: JSON.stringify({ mode: "build" }), time_created: c.created, time_updated: c.updated, time_title_updated: c.updated, time_archived: null, time_deleted: null, last_outcome: "completed" });
        let parent;
        for (const m of c.records) {
          const id = `msg_${m.sequence.toString(36).padStart(12, "0")}_${m.id}`;
          const semantics = { origin: m.role === "user" ? "real_user" : "agent_runtime", kind: m.role === "user" ? "user_prompt" : "assistant_response", uiVisibility: "visible", providerVisibility: "visible", transcriptVisibility: "visible" };
          const data = { role: m.role, time: { created: m.time }, agent: "zcode-agent", semantics };
          if (m.role === "assistant") Object.assign(data, { parentID: parent || id, time: { created: m.time, completed: m.time }, mode: "build", path: { cwd: c.workspace, root: c.workspace }, cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop", ...(c.entry.modelId ? { modelId: c.entry.modelId, modelID: c.entry.modelId } : {}), ...(c.entry.providerId ? { providerId: c.entry.providerId, providerID: c.entry.providerId } : {}) });
          else parent = id;
          message({ id, session_id: c.id, time_created: m.time, time_updated: m.time, sequence: m.sequence, data: JSON.stringify(data) });
          part({ id: `part_${randomUUID()}`, message_id: id, session_id: c.id, time_created: m.time, time_updated: m.time, sequence: 0, data: JSON.stringify({ type: "text", text: m.content, time: { start: m.time, end: m.time } }) });
        }
        const meta = { taskId: c.id, traceId, title: c.title, titleOverridden: true, workspacePath: c.workspace, projectId, hostId: "local", createdAt: c.created, updatedAt: c.updated, mode: "build", provider: "glm", status: "completed", target: null };
        task({ workspace_key: c.workspace, workspace_path: c.workspace, task_id: c.id, title: c.title, task_status: "completed", provider: "glm", mode: "build", created_at: c.created, updated_at: c.updated, pinned: 0, archived: 0, deleted: 0, title_overridden: 1, meta_json: JSON.stringify(meta), searchable_text: c.records.map(m => m.content).join("\n"), host_id: "local", root_path: c.workspace, project_id: projectId, execution_directories: "[]", cli_title: c.title, cli_title_source: "custom", cli_created_at: c.created, cli_updated_at: c.updated, cli_last_outcome: "completed", cli_deleted: 0, handoff_pending: 0 });
      });
      return result(c, `${file}#session_id=${encodeURIComponent(c.id)}`);
    } finally { db.close(); }
  }
};
