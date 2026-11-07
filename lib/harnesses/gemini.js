"use strict";
const { path, json, files, rows, fileOf, normalize, harness } = require("./_shared/other");
module.exports = harness({ id: "gemini", label: "Gemini", order: 60, roots: ["~/.gemini", "%GEMINI_CLI_HOME%/.gemini"], markers: ["tmp"],
  async enumerate(root) {
    return (await files(path.join(root, "tmp"), n => /^session-.*\.jsonl?$/.test(n), 4)).map(file => ({ sessionId: path.basename(file).replace(/\.jsonl?$/, ""), sessionPath: file, sourceFormat: "gemini-jsonl" }));
  },
  async load(entry) {
    const file = fileOf(entry), data = file.endsWith(".json") ? [await json(file)] : await rows(file);
    const header = {};
    let records = [];
    for (const r of data) {
      if (r.sessionId) Object.assign(header, r);
      if (Array.isArray(r.messages)) records = r.messages.slice();
      if (r.$set) {
        Object.assign(header, r.$set);
        if (Array.isArray(r.$set.messages)) records = r.$set.messages.slice();
      } else if (["user", "gemini"].includes(r.type)) records.push(r);
    }
    const unique = new Map();
    records.forEach((m, i) => unique.set(m.id ?? `row-${i}`, m));
    return { messages: normalize([...unique.values()]), meta: { sessionId: header.sessionId ?? entry.sessionId, name: header.title || header.summary,
      workspacePath: header.cwd, createdAt: header.startTime, updatedAt: header.lastUpdated, modelId: records.findLast(r => r.model)?.model } };
  }
});
