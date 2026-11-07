"use strict";

const { registry, labelOf, refreshDynamicSources, getDynamicLoadReport } = require("../lib/registry");
const { driverNames } = require("../lib/drivers");
const { search, resolve, brief } = require("../lib/hub/query");
const { listTargets } = require("./native/index.cjs");

function createPanelAdapter(runtime) {
  let recent = { lastImportAt: null, lastImportCount: 0, lastImportSource: null };
  const imported = new Set();
  function state() {
    const config = runtime.config();
    const status = runtime.status();
    return { config: { ...config, enabledHarnesses: config.harnesses.join(","), extraSearchRoots: config.extraRoots.join("\n") }, status,
      schedule: { nextRunAt: config.autoSyncEnabled ? (Date.parse(status.lastSyncAt) || Date.now()) + config.intervalMs : null },
      harnesses: registry.list().map(h => ({ id: h.id, label: labelOf(h) })) };
  }
  const summary = entry => ({ ...brief(entry), source: entry.harness, externalId: entry.externalId ?? entry.sessionId,
    fullTitle: entry.name ?? entry.title, projectPath: entry.workspacePath ?? null, projectName: entry.workspaceName ?? entry.workspacePath ?? labelOf(registry.get(entry.harness)),
    importable: entry.messageCount !== 0 && entry.hiddenReason !== "deleted", nativeInHost: false, imported: imported.has(entry.key),
    children: runtime.hub.children(entry).map(child => ({ ...brief(child), source: child.harness, importable: child.messageCount !== 0, nativeInHost: false })) });
  return async function invoke(channel, payload = {}) {
    if (channel === "app.locale") return "zh-CN";
    if (channel === "app.getAppearance") return { theme: "dark" };
    if (channel === "hub.state") return state();
    if (channel === "hub.setConfig") { await runtime.setConfig(payload); return state(); }
    if (channel === "hub.sync") { await runtime.sync(); return state(); }
    if (channel === "import.targets") return { host: runtime.host, workspace: runtime.workspace, targets: listTargets(), native: true };
    if (channel === "import.capabilities") return { officialSessionApi: true, nativeHistory: true };
    if (channel === "import.adapters") return registry.list().map(h => ({ source: h.id, label: labelOf(h), custom: h.custom === true, dataPath: h.dataPath, importable: true, nativeInHost: false }));
    if (channel === "import.customSources") return { ...getDynamicLoadReport(), drivers: driverNames() };
    if (channel === "import.reloadCustomSources") { await refreshDynamicSources({ workspaceRoot: runtime.workspace }); await runtime.sync(); return { ...getDynamicLoadReport(), drivers: driverNames() }; }
    if (channel === "import.recent") return recent;
    await runtime.ready();
    if (channel === "hub.list") {
      const found = search(runtime.hub.entries(), payload);
      const counts = {};
      for (const entry of runtime.hub.entries()) if (entry.visible !== false) counts[entry.harness] = (counts[entry.harness] ?? 0) + 1;
      return { ...found, sessions: found.sessions.map(row => ({ ...row, nativeInHost: false })), counts };
    }
    if (channel === "hub.resolve") {
      const found = resolve(runtime.hub.entries(), payload.ref, { harness: payload.harness });
      return { ...found, matches: found.matches.map(row => ({ ...row, nativeInHost: false })) };
    }
    if (channel === "hub.read") { const entry = runtime.entryFor(payload); return { session: summary(entry), ...await runtime.read(entry, payload) }; }
    if (channel === "import.sessions" || channel === "import.scanSource") {
      if (payload.full) await runtime.sync();
      const rows = runtime.hub.entries().filter(entry => entry.harness === payload.source && (entry.visible !== false || (payload.includeArchived && entry.hiddenReason === "archived")));
      if (channel === "import.sessions") return { source: payload.source, sessions: rows.map(summary) };
      return { source: payload.source, found: rows.length > 0, count: rows.filter(row => !row.archived).length, archived: rows.filter(row => row.archived).length, partial: false };
    }
    if (channel === "import.commit") {
      const results = [], failed = [];
      let importedCount = 0, skipped = 0;
      for (const item of payload.items ?? []) {
        try {
          const entry = runtime.entryFor({ ref: item.key ?? item.sessionId ?? item.externalId, harness: item.harness ?? payload.source });
          const destinationWorkspace = payload.placement === "workspace" ? payload.workspace : payload.placement === "standalone" ? runtime.workspace : entry.workspacePath || runtime.workspace;
          const result = await runtime.call("session_hub_import", { ref: entry.key, harness: entry.harness, target: payload.target ?? runtime.host,
            targetRoot: payload.targetRoot, workspace: destinationWorkspace, projectId: payload.projectId, placement: payload.placement,
            withThinking: payload.withThinking !== false, includeSubagents: payload.subagentSummary === true, mode: payload.mode === "new" ? "copy" : "skip" });
          results.push(...result.results); failed.push(...result.failed); importedCount += result.imported; skipped += result.skipped;
          if (result.ok) imported.add(entry.key);
        } catch (error) { failed.push({ externalId: item.externalId, error: error.message }); }
      }
      if (importedCount) recent = { lastImportAt: new Date().toISOString(), lastImportCount: importedCount, lastImportSource: payload.source };
      return { ok: failed.length === 0, imported: importedCount, skipped, failed, unreadable: 0, truncated: 0, results,
        notice: results.length ? `原生会话已登记到目标工作区。会话 ID：${results.map(result => result.sessionId).join("、")}。在目标客户端刷新列表后打开即可查看历史。` : "" };
    }
    throw new Error(`未知面板调用：${channel}`);
  };
}
module.exports = { createPanelAdapter };
