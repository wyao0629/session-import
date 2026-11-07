"use strict";
const { fs, path, json, randomUUID, context, result, writeRows, mergeJson, samePath } = require("./common.cjs");

function projectKey(cwd) {
  let readable = "", separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i], code = cwd.charCodeAt(i);
    if (ch === "/" || code === 92 || ch === ":") { if (!separatorRun) readable += "-"; separatorRun = true; }
    else { readable += /^[A-Za-z0-9._-]$/.test(ch) ? ch : "~" + code.toString(16).toUpperCase().padStart(4, "0"); separatorRun = false; }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
function* transcript(c) {
  yield { type: "session", version: 4, id: c.id, createdAt: c.created, cwd: c.workspace, isSeeded: false, delegationDepth: 0 };
  let seq = 0, turn = 0, step = 0, open = false, lastTime = c.created;
  const event = (type, time, data, surface = false) => ({ type, seq: seq++, time, data, ...(surface ? { surfaceOp: "append" } : {}) });
  yield event("session/title", c.created, { title: c.title, source: { kind: "user" }, messageSeqs: [] });
  for (const m of c.records) {
    if (m.role === "user" && open) { yield event("turn/end", lastTime, { turn, reason: { kind: "completed" } }); open = false; }
    if (!open) { turn++; step = 0; yield event("turn/start", m.time, { turn }); open = true; }
    const block = { type: "text", text: m.content };
    if (m.role === "user") {
      yield event("user/message", m.time, { id: m.id, role: "user", source: { kind: "user" }, content: [block] }, true);
    } else {
      step++;
      yield event("step/start", m.time, { turn, step });
      const source = { kind: "model", provider: c.entry.providerId || c.entry.harness || c.entry.source || "session-import", model: c.entry.modelId || "imported" };
      const stream = [
        { type: "chunk", time: m.time, chunk: { type: "block-start", index: 0, blockType: "text" } },
        { type: "chunk", time: m.time, chunk: { type: "block-end", index: 0, block } },
        { type: "chunk", time: m.time, chunk: { type: "finish", reason: "stop" } }
      ];
      yield event("assistant/message", m.time, { turn, step, message: { id: m.id, role: "assistant", source, content: [block] }, stream }, true);
      yield event("step/end", m.time, { turn, step });
    }
    lastTime = m.time;
  }
  if (open) yield event("turn/end", lastTime, { turn, reason: { kind: "completed" } });
}
function register(data, c) {
  if (data.unit?.name !== "workspace" || data.unit.version !== 2 || !data.tables?.workspaces || !Array.isArray(data.global?.workspaceIds)) throw new Error("dsh: storages/workspace.json requires workspace domain version 2, global.workspaceIds and tables.workspaces");
  const table = data.tables.workspaces;
  let id = c.projectId || Object.keys(table).find(id => samePath(table[id].path, c.workspace));
  if (c.projectId && (!table[id] || !samePath(table[id].path, c.workspace))) throw new Error("dsh: destination.projectId does not identify the selected workspace path");
  const now = new Date(c.now).toISOString();
  if (!id) {
    id = randomUUID();
    table[id] = { path: c.workspace, title: path.basename(c.workspace), sessionIds: [], createdAt: now, updatedAt: now };
    data.global.workspaceIds.unshift(id);
  }
  if (!Array.isArray(table[id].sessionIds)) throw new Error("dsh: workspace sessionIds must be an array");
  if (!table[id].sessionIds.includes(c.id)) table[id].sessionIds.unshift(c.id);
  table[id].updatedAt = now;
  data.global.initialized = true;
  data.global.defaultWorkspaceId ??= id;
  return data;
}
module.exports = {
  id: "dsh", label: "DSH",
  defaultRoot: ({ home, env }) => env.DSH_HOME || path.join(home, ".dsh"),
  async importSession(input) {
    const c = context("dsh", input);
    c.id = `session-${c.id}`;
    c.workspace = await fs.realpath(c.workspace);
    const catalog = path.join(c.root, "storages", "workspace.json");
    const initial = { unit: { name: "workspace", version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } };
    register(await json(catalog, structuredClone(initial)), c);
    const file = path.join(c.root, "sessions", projectKey(c.workspace), c.id, "session.v4.jsonl");
    await writeRows(file, transcript(c));
    await mergeJson(catalog, initial, data => register(data, c));
    return result(c, file);
  }
};
