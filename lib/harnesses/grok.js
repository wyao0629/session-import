"use strict";
const { path, json, files, rows, fileOf, normalize, harness } = require("./_shared/other");
module.exports = harness({ id: "grok", label: "Grok", order: 70, roots: ["~/.grok", "%GROK_HOME%"], markers: ["sessions"],
  async enumerate(root) {
    const base = path.join(root, "sessions");
    const parents = new Map();
    for (const file of await files(base, (n, f) => n === "meta.json" && f.includes(path.sep + "subagents" + path.sep), 4)) {
      const m = await json(file);
      if (m?.child_session_id && m?.parent_session_id) parents.set(m.child_session_id, m.parent_session_id);
    }
    return (await files(base, n => n === "chat_history.jsonl", 4)).map(file => {
      const sid = path.basename(path.dirname(file));
      return { sessionId: sid, sessionPath: file, parentSessionId: parents.get(sid), subagent: parents.has(sid),
        sourceFormat: "grok-jsonl", dependencies: [path.join(path.dirname(file), "summary.json")], noCache: true };
    });
  },
  async load(entry) {
    const file = fileOf(entry), summary = await json(path.join(path.dirname(file), "summary.json"), {});
    const data = await rows(file);
    let cwd = summary.info?.cwd;
    if (!cwd) { try { cwd = decodeURIComponent(path.basename(path.dirname(path.dirname(file)))); } catch { /* retain missing workspace */ } }
    return { messages: normalize(data), meta: { name: summary.generated_title || summary.session_summary, workspacePath: cwd,
      createdAt: summary.created_at, updatedAt: summary.updated_at, modelId: summary.current_model_id } };
  }
});
