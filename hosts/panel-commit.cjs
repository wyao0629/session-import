"use strict";
const { resolve } = require("../lib/hub/query");
const { loadMessages, descendants } = require("../lib/hub/reader");
const { importNative } = require("./native/index.cjs");

async function commitTarget(hub, payload, dataDir, workspace) {
  const results = [], failed = [], seen = new Set();
  for (const item of payload.items ?? []) {
    try {
      const found = resolve(hub.entries(), item.key ?? item.sessionId ?? item.externalId, { harness: item.harness ?? payload.source });
      const entry = hub.entries().find(row => row.key === found.matches[0]?.key);
      if (!entry || found.ambiguous) throw new Error("请使用预览列表中的完整会话引用。");
      const sources = [entry, ...(payload.subagentSummary ? descendants(entry, hub.entries()) : [])];
      for (const source of sources) {
        if (seen.has(source.key)) continue; seen.add(source.key);
        const messages = await loadMessages(source, { roots: hub.roots(source.harness), withThinking: payload.withThinking !== false });
        const targetWorkspace = payload.placement === "workspace" ? payload.workspace : payload.placement === "standalone" ? workspace : source.workspacePath || workspace;
        results.push(await importNative({ target: payload.target, entry: source, messages, destination: { root: payload.targetRoot, workspace: targetWorkspace, projectId: payload.projectId },
          mode: payload.mode === "new" ? "copy" : "skip", dataDir, options: payload }));
      }
    } catch (error) { failed.push({ externalId: item.externalId, error: error.message }); }
  }
  return { ok: failed.length === 0, imported: results.filter(row => row.status === "imported").length, skipped: results.filter(row => row.status === "skipped").length,
    results, failed, unreadable: 0, truncated: 0, nativeHistory: true, notice: results.length ? `原生会话已登记到 ${payload.target}：${results.map(row => row.sessionId).join("、")}。请在目标客户端刷新对应工作区的会话列表。` : "" };
}
module.exports = { commitTarget };
