"use strict";
const { path, files, rows, fileOf, normalize, harness } = require("./_shared/other");
module.exports = harness({ id: "dsh", label: "DSH", order: 61, roots: ["~/.dsh", "%DSH_HOME%"], markers: ["sessions"],
  async enumerate(root) {
    const found = await files(path.join(root, "sessions"), n => /^session\.v\d+\.jsonl(?:\.zstd|\.zst)?$/.test(n), 3);
    const unique = new Map();
    for (const file of found) unique.set(path.dirname(file), file);
    return [...unique.values()].map(file => ({ sessionId: path.basename(path.dirname(file)), sessionPath: file, sourceFormat: "dsh-events" }));
  },
  async load(entry) {
    const data = await rows(fileOf(entry)), header = data.find(r => r.type === "session") ?? {};
    const records = [];
    for (const r of data) {
      const d = r.data ?? {};
      if (r.type === "user/message") records.push({ role: "user", content: d.content, timestamp: r.time });
      else if (r.type === "assistant/message") records.push({ ...d.message, role: "assistant", timestamp: r.time });
      else if (r.type === "tool/call") records.push({ type: "function_call", callId: d.callId, name: d.name, arguments: d.arguments, timestamp: r.time });
      else if (r.type === "tool/result") records.push({ role: "toolResult", ...d.message, timestamp: r.time });
    }
    return { messages: normalize(records), meta: { sessionId: header.id ?? entry.sessionId, name: data.findLast(r => r.type === "session/title")?.data?.title,
      workspacePath: header.cwd, createdAt: header.createdAt, updatedAt: data.findLast(r => r.time)?.time,
      parentSessionId: header.parentSession, subagent: !!header.parentSession || header.delegationDepth > 0, agentPreset: header.agentPreset } };
  }
});
