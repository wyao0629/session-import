"use strict";
const { path, randomUUID, createHash, exists, context, result, samePath, inserter, database, backupDatabase, transaction } = require("./common.cjs");

function appWorkspace(db, c, insert) {
  const rows = db.prepare("SELECT workspace_id,root_paths_json FROM workspaces WHERE deleted_at IS NULL AND archived=0").all();
  let selected = c.projectId ? rows.find(r => r.workspace_id === c.projectId) : rows.find(r => JSON.parse(r.root_paths_json).some(root => samePath(typeof root === "string" ? root : root.path, c.workspace)));
  if (c.projectId && !selected) throw new Error(`qoder: destination.projectId is absent from workspaces: ${c.projectId}`);
  if (selected) {
    if (!JSON.parse(selected.root_paths_json).some(root => samePath(typeof root === "string" ? root : root.path, c.workspace))) throw new Error("qoder: destination.workspace is not a root of the selected workspace_id");
    return selected.workspace_id;
  }
  const id = randomUUID();
  insert({ workspace_id: id, name: path.basename(c.workspace), workspace_source: "local", root_paths_json: JSON.stringify([c.workspace]), product_mode: "coding", extra_json: "{}", created_at: c.now, updated_at: c.now, archived: 0 });
  return id;
}
async function app(c, file) {
  const db = await database(file);
  try {
    const session = inserter(db, "chat_sessions", ["session_id", "title", "cwd", "workspace_id", "created_at", "updated_at"]);
    const message = inserter(db, "chat_session_messages", ["session_id", "message_id", "sequence", "role", "payload_json", "source"]);
    const workspace = inserter(db, "workspaces", ["workspace_id", "root_paths_json"]);
    await backupDatabase(db, file);
    await transaction(db, () => {
      const workspaceId = appWorkspace(db, c, workspace);
      session({ session_id: c.id, title: c.title, cwd: c.workspace, workspace_id: workspaceId, session_kind: "standard", product_mode: "coding", conversation_mode: "normal", created_at: c.created, updated_at: c.updated, archived: 0, deleted_at: null, message_envelope_version: 1 });
      let turn = randomUUID();
      for (const m of c.records) {
        if (m.role === "user") turn = randomUUID();
        const partId = randomUUID();
        const payload = { parts: [{ id: partId, type: "text", text: m.content }], ...(m.role === "assistant" ? { finalTextId: partId, completedAt: new Date(m.time).toISOString() } : { attachments: [], selectedSkillNames: [], selectedPluginIds: [], selectedConnectorIds: [], selectedAgentNames: [], selectedCapabilityCommands: [], referencedChatSessions: [] }) };
        const serialized = JSON.stringify(payload);
        message({ session_id: c.id, message_id: m.id, turn_id: turn, sequence: m.sequence, role: m.role, payload_json: serialized, status: "completed", source: m.role === "user" ? "host-projection" : "sdk-projection", created_at: m.time, updated_at: m.time, has_visible_content: 1, is_compaction_boundary: 0, payload_schema_version: 2, payload_bytes: Buffer.byteLength(serialized), payload_hash: createHash("sha256").update(serialized).digest("hex") });
      }
    });
    return result(c, `${file}#session_id=${encodeURIComponent(c.id)}`);
  } finally { db.close(); }
}
async function work(c, file) {
  const db = await database(file);
  try {
    const project = inserter(db, "projects", ["id", "name", "path"]);
    const chat = inserter(db, "chats", ["id", "project_id", "name"]);
    const sub = inserter(db, "sub_chats", ["id", "chat_id", "session_id", "messages"]);
    const message = inserter(db, "messages", ["id", "message_id", "chat_id", "sub_chat_id", "sequence", "role", "parts"]);
    await backupDatabase(db, file);
    await transaction(db, () => {
      let selected = c.projectId ? db.prepare("SELECT id,path FROM projects WHERE id=?").get(c.projectId) : db.prepare("SELECT id,path FROM projects WHERE path=?").get(c.workspace);
      if (c.projectId && !selected) throw new Error(`qoder: destination.projectId is absent from projects: ${c.projectId}`);
      if (selected && !samePath(selected.path, c.workspace)) throw new Error("qoder: destination.workspace does not match the selected project");
      const projectId = selected?.id || randomUUID(), chatId = randomUUID(), subId = randomUUID();
      if (!selected) project({ id: projectId, name: path.basename(c.workspace), path: c.workspace, created_at: c.now, updated_at: c.now });
      chat({ id: chatId, name: c.title, project_id: projectId, created_at: c.created, updated_at: c.updated, archived_at: null, deleted_at: null, chat_type: "task" });
      const messages = c.records.map(m => ({ id: m.id, role: m.role, parts: [{ type: "text", text: m.content }], metadata: { createdAt: m.time } }));
      sub({ id: subId, name: c.title, chat_id: chatId, session_id: c.id, mode: "agent", messages: JSON.stringify(messages), created_at: c.created, updated_at: c.updated });
      for (const [i, m] of c.records.entries()) message({ id: randomUUID(), message_id: m.id, chat_id: chatId, sub_chat_id: subId, sequence: i, role: m.role, parts: JSON.stringify(messages[i].parts), metadata: JSON.stringify(messages[i].metadata), searchable_text: m.content, search_status: "ready", created_at: m.time, updated_at: m.time });
    });
    return result(c, `${file}#session_id=${encodeURIComponent(c.id)}`);
  } finally { db.close(); }
}
module.exports = {
  id: "qoder", label: "Qoder",
  defaultRoot: ({ home, env }) => env.QODER_HOME || path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "com.qoder.app.stable"),
  async importSession(input) {
    const c = context("qoder", input);
    const appFile = path.join(c.root, "main.sqlite"), workFile = path.join(c.root, "data", "agents.db");
    if (await exists(appFile)) return app(c, appFile);
    if (await exists(workFile)) return work(c, workFile);
    throw new Error(`qoder: GUI session catalog not found at ${appFile} or ${workFile}; destination.root must name the Qoder App or QoderWork data root, not a CLI transcript-only directory`);
  }
};
