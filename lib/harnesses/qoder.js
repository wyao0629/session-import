"use strict";
const { path, exists, json, files, rows, fileOf, withDb, normalize, harness } = require("./_shared/other");
const claude = require("./_shared/other-claude");
module.exports = harness({ id: "qoder", label: "Qoder", order: 41, aliases: ["qoder-cli", "qoder-ide", "qoder-app", "qoderworkcn"],
  roots: ["~/.qoder", "~/.qoder-cn", "~/.qoderworkcn", "~/.qoderwork", "%APPDATA%/Qoder/SharedClientCache/cli", "%APPDATA%/com.qoder.app.stable", "%APPDATA%/QoderWork CN", "%APPDATA%/QoderWork"],
  markers: ["projects", "main.sqlite", "data/agents.db"],
  async enumerate(root) {
    const out = (await claude.enumerate(root)).map(e => ({ ...e, variant: path.basename(path.dirname(e.sessionPath)) === "transcript" ? "ide" : "cli" }));
    for (const file of await files(path.join(root, "projects"), n => n.endsWith(".session.execution.jsonl"), 2)) {
      const sidecar = file.replace(/\.jsonl$/, "-session.json"), meta = await json(sidecar, {});
      out.push({ sessionId: meta.id ?? path.basename(file, ".session.execution.jsonl"), sessionPath: file, variant: "quest", sidecar,
        sourceFormat: "qoder-quest", dependencies: [sidecar], name: meta.title, workspacePath: meta.working_dir,
        createdAt: meta.created_at, updatedAt: meta.updated_at, parentSessionId: meta.parent_id || null });
    }
    const app = path.join(root, "main.sqlite");
    if (await exists(app)) out.push(...withDb(app, db => db.prepare("SELECT session_id,title,cwd,created_at,updated_at,archived,deleted_at,owner_session_id,origin_session_id,model FROM chat_sessions").all().map(r => ({
      sessionId: r.session_id, sessionPath: `${app}#session_id=${encodeURIComponent(r.session_id)}`, filePath: app, variant: "app", sourceFormat: "qoder-app-sqlite",
      name: r.title, workspacePath: r.cwd, createdAt: r.created_at, updatedAt: r.updated_at, modelId: r.model, archived: !!r.archived, deleted: r.deleted_at != null,
      parentSessionId: r.owner_session_id || r.origin_session_id, subagent: !!r.owner_session_id, dependencies: [app + "-wal"]
    }))));
    const work = path.join(root, "data", "agents.db");
    if (await exists(work)) out.push(...withDb(work, db => {
      const chats = db.prepare("SELECT c.id,c.name,c.created_at,c.updated_at,c.archived_at,c.deleted_at,p.path FROM chats c LEFT JOIN projects p ON p.id=c.project_id").all();
      const subs = db.prepare("SELECT id,chat_id,session_id,name,created_at,updated_at FROM sub_chats").all();
      // Work uses sub_chats as conversation tabs, not necessarily sub-agents.
      return subs.map(r => { const c = chats.find(c => c.id === r.chat_id) ?? {}; return {
        sessionId: r.session_id || r.id, sessionPath: `${work}#session_id=${encodeURIComponent(r.session_id || r.id)}`, filePath: work, variant: "work", subChatId: r.id,
        sourceFormat: "qoderwork-sqlite", name: c.name || r.name, workspacePath: c.path, createdAt: r.created_at, updatedAt: r.updated_at,
        archived: !!c.archived_at, deleted: c.deleted_at != null, dependencies: [work + "-wal"] }; });
    }));
    return out;
  },
  async load(entry) {
    if (entry.variant === "app") return withDb(fileOf(entry), db => {
      const records = db.prepare("SELECT role,payload_json,created_at FROM chat_session_messages WHERE session_id=? ORDER BY sequence,message_id").all(entry.sessionId);
      return { meta: {}, messages: normalize(records.map(r => ({ ...JSON.parse(r.payload_json), role: r.role, timestamp: r.created_at }))) };
    });
    if (entry.variant === "work") return withDb(fileOf(entry), db => {
      let records = db.prepare("SELECT role,parts,created_at FROM messages WHERE sub_chat_id=? ORDER BY sequence,id").all(entry.subChatId).map(r => ({ role: r.role, parts: JSON.parse(r.parts), timestamp: r.created_at }));
      if (!records.length) { const r = db.prepare("SELECT messages FROM sub_chats WHERE id=?").get(entry.subChatId); records = r?.messages ? JSON.parse(r.messages) : []; }
      return { meta: {}, messages: normalize(records) };
    });
    if (entry.variant === "quest" || entry.sessionPath.endsWith(".session.execution.jsonl")) {
      const file = fileOf(entry), meta = await json(file.replace(/\.jsonl$/, "-session.json"), {});
      return { meta: { name: meta.title, workspacePath: meta.working_dir }, messages: normalize(await rows(file)) };
    }
    return claude.load(entry);
  }
});
