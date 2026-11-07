"use strict";
const { fs, path, randomUUID, context, result, samePath, columns, inserter, database, backupDatabase, transaction } = require("./common.cjs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const installedVersion = require("./version.cjs");

async function nativeProject(db, c) {
  const rows = db.prepare("SELECT id,worktree,sandboxes FROM project").all();
  if (c.projectId) {
    const selected = rows.find(row => row.id === c.projectId);
    if (!selected) throw new Error(`opencode: destination.projectId is absent from project: ${c.projectId}`);
    if (selected.id !== "global" && !samePath(selected.worktree, c.workspace) && !JSON.parse(selected.sandboxes || "[]").some(root => samePath(root, c.workspace)) && !inside(selected.worktree, c.workspace)) throw new Error("opencode: destination.workspace is not within the selected project or its sandboxes");
    return { ...selected, existing: true };
  }
  const selected = rows.find(row => samePath(row.worktree, c.workspace) || JSON.parse(row.sandboxes || "[]").some(root => samePath(root, c.workspace)));
  if (selected) return { ...selected, existing: true };
  let directory = c.workspace;
  while (true) {
    try {
      await fs.stat(path.join(directory, ".git"));
      const cwd = c.workspace;
      const { stdout: worktree } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
      const { stdout: roots } = await exec("git", ["rev-list", "--max-parents=0", "--all"], { cwd });
      const id = roots.trim().split(/\r?\n/).filter(Boolean).sort()[0];
      if (!id) throw new Error("opencode: Git project has no root commit; select its existing destination.projectId");
      return { id, worktree: worktree.trim(), vcs: "git", existing: rows.some(row => row.id === id) };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { id: "global", worktree: path.parse(c.workspace).root, existing: rows.some(row => row.id === "global") };
}
function inside(root, directory) {
  const relative = path.relative(root, directory);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
module.exports = {
  id: "opencode", label: "OpenCode",
  defaultRoot: ({ home, env }) => env.OPENCODE_DATA_DIR || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "opencode", "data") : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode")),
  async importSession(input) {
    const c = context("opencode", input);
    c.id = `ses_${c.id.replaceAll("-", "")}`;
    const file = path.join(c.root, "opencode.db"), db = await database(file);
    try {
      const project = inserter(db, "project", ["id", "worktree", "sandboxes", "time_created", "time_updated"]);
      const session = inserter(db, "session", ["id", "project_id", "directory", "title", "version", "time_created", "time_updated"]);
      const message = inserter(db, "message", ["id", "session_id", "data", "time_created", "time_updated"]);
      const part = inserter(db, "part", ["id", "message_id", "session_id", "data", "time_created", "time_updated"]);
      const hasSequence = columns(db, "message").some(column => column.name === "sequence");
      const selected = await nativeProject(db, c);
      const version = c.options.version || db.prepare("SELECT version FROM session ORDER BY time_updated DESC LIMIT 1").get()?.version || await installedVersion("opencode");
      const modelID = c.entry.modelId || "imported", providerID = c.entry.providerId || "session-import";
      await backupDatabase(db, file);
      await transaction(db, () => {
        if (!selected.existing) project({ id: selected.id, worktree: selected.worktree, vcs: selected.vcs, name: path.basename(c.workspace), sandboxes: "[]", time_created: c.now, time_updated: c.now });
        session({ id: c.id, project_id: selected.id, slug: c.id, directory: c.workspace, title: c.title, version, time_created: c.created, time_updated: c.updated, time_archived: null });
        let parent;
        for (const m of c.records) {
          const id = `msg_${m.sequence.toString(36).padStart(12, "0")}_${m.id.replaceAll("-", "")}`;
          const partId = `prt_${randomUUID().replaceAll("-", "")}`;
          const time = hasSequence ? m.time : c.created + m.sequence;
          const data = m.role === "user"
            ? { role: "user", time: { created: m.time }, agent: "build", model: { providerID, modelID } }
            : { role: "assistant", time: { created: m.time, completed: m.time }, parentID: parent || id, modelID, providerID, mode: "build", agent: "build", path: { cwd: c.workspace, root: selected.worktree }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" };
          if (m.role === "user") parent = id;
          message({ id, session_id: c.id, time_created: time, time_updated: time, sequence: m.sequence, data: JSON.stringify(data) });
          part({ id: partId, message_id: id, session_id: c.id, time_created: time, time_updated: time, sequence: 0, data: JSON.stringify({ type: "text", text: m.content, time: { start: m.time, end: m.time } }) });
        }
      });
      return result(c, `${file}#session_id=${encodeURIComponent(c.id)}`);
    } finally { db.close(); }
  }
};
