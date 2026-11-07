"use strict";
const { path, exists, files, rows, fileOf, withDb, normalize, harness, fs } = require("./_shared/other");
module.exports = harness({ id: "workbuddy", label: "WorkBuddy", order: 50, roots: ["~/.workbuddy", "%WORKBUDDY_HOME%"], markers: ["projects", "workbuddy.db"],
  async enumerate(root) {
    const db = path.join(root, "workbuddy.db");
    const gui = await exists(db) ? withDb(db, d => d.prepare("SELECT id, custom_title, title, deleted_at, cwd, created_at, updated_at FROM sessions").all()) : [];
    const byId = new Map(gui.map(r => [r.id, r]));
    return (await files(path.join(root, "projects"), n => n.endsWith(".jsonl"), 1)).map(file => {
      const sessionId = path.basename(file, ".jsonl"), r = byId.get(sessionId);
      return { sessionId, sessionPath: file, sourceFormat: "workbuddy-jsonl", gui: r, noCache: true,
        name: r?.custom_title || r?.title, deleted: r?.deleted_at != null, workspacePath: r?.cwd, createdAt: r?.created_at, updatedAt: r?.updated_at };
    });
  },
  async load(entry) {
    const data = await rows(fileOf(entry));
    const messages = normalize(data);
    const base = await fs.realpath(path.dirname(path.dirname(fileOf(entry))));
    for (const m of messages) for (const t of m.tools ?? []) {
      const value = typeof t.result === "string" ? t.result : JSON.stringify(t.result ?? "");
      const match = /Full output saved to:\s*([^\s<]+)/.exec(value);
      if (!match) continue;
      const target = path.resolve(match[1]);
      if (!target.startsWith(base + path.sep) || !await exists(target)) continue;
      const real = await fs.realpath(target);
      if (real.startsWith(base + path.sep) && (await fs.stat(real)).size <= 32 * 1024 * 1024) t.result = await fs.readFile(real, "utf8");
    }
    return { messages, meta: { name: entry.gui?.custom_title || data.findLast(r => r.type === "ai-title")?.aiTitle || entry.gui?.title,
      workspacePath: entry.gui?.cwd || data.find(r => r.cwd)?.cwd,
      modelId: data.findLast(r => r.providerData?.model)?.providerData.model,
      createdAt: entry.gui?.created_at ?? data[0]?.timestamp, updatedAt: entry.gui?.updated_at ?? data.at(-1)?.timestamp } };
  }
});
