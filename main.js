"use strict";

const { registry, labelOf, hostSource, refreshDynamicSources, getDynamicLoadReport, CONFIG_PATH } = require("./lib/registry");
const { driverNames } = require("./lib/drivers");
const forge = require("./lib/forge");
const bus = require("./lib/bus");
const history = require("./lib/history");
const saveModes = require("./lib/save-modes");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const manifest = require("./manifest.json");
const hubConfig = require("./lib/hub/config");
const { createHubService } = require("./lib/hub/service");
const { createScheduler } = require("./lib/hub/scheduler");
const { createTools } = require("./lib/hub/tools");
const { search, resolve, brief } = require("./lib/hub/query");
const { readSession, prepareImport, assertInsideRoots, clearCache } = require("./lib/hub/reader");
const { project, stableExternalId } = require("./lib/import/project");
const { commit } = require("./lib/import/commit");
const { yieldNow } = require("./lib/core/fsx");
const IMPORT_NOTICE = "导入后请先在该会话发送一条普通消息，再使用 /learn 等扩展命令。runtime 未创建属于宿主限制；本插件不能创建运行时，也不能设置 provider/model/thinking。";
let hub = null, scheduler = null, initialTimer = null, offSettings = null;
let currentSettings = {}, dataDir = null, unloaded = true;
const registeredCommands = [], tools = [], imported = new Set();
const log = (name, error) => console.error(`[session-import] ${name}`, error?.message ?? "");
const cfg = () => hubConfig.normalize(currentSettings);

async function readSettings() {
  try { return await pi.plugin.getSettings() || {}; }
  catch (error) { log("settings unavailable", error); return {}; }
}
function applySchedule() {
  if (!scheduler || initialTimer || unloaded) return;
  const c = cfg();
  scheduler.configure({ enabled: c.autoSyncEnabled, intervalMs: c.intervalMs, lastRunAt: Date.parse(hub.status().lastSyncAt ?? "") || Date.now() });
}
function ownSettingsEvent(event) {
  if (event?.pluginId != null) return event.pluginId === manifest.id;
  // PI-Desktop 0.21 dispatches [nextSettings] to this plugin's child process.
  return event && Object.keys(event).some((key) => key.startsWith("session-import."));
}
async function startHub() {
  dataDir = await pi.plugin.getDataPath();
  currentSettings = await readSettings();
  hub = createHubService({ dataDir, home: os.homedir(), env: process.env, getConfig: cfg, log });
  hub.onChange(clearCache);
  scheduler = createScheduler({ task: () => hub.sync(), onError: (e) => log("auto sync failed", e) });
  try { for (const key of JSON.parse(await fs.readFile(path.join(dataDir, "imported.json"), "utf8"))) imported.add(key); }
  catch (error) { if (error.code !== "ENOENT") log("import markers unavailable", error); }
  initialTimer = setTimeout(async () => {
    initialTimer = null;
    try { if (!unloaded && cfg().autoSyncEnabled) { await hub.sync(); scheduler.noteRun(); } }
    catch (error) { log("initial sync failed", error); }
    finally { applySchedule(); }
  }, 5000);
  if (typeof pi.events?.on === "function") {
    offSettings = async (event) => {
      if (!ownSettingsEvent(event) || unloaded) return;
      try { currentSettings = await readSettings(); applySchedule(); } catch (error) { log("settings change failed", error); }
    };
    pi.events.on("plugin:settingsChanged", offSettings);
  }
}
async function reloadCustomSources() {
  const workspace = await pi.workspace?.get?.();
  return refreshDynamicSources({ workspaceRoot: workspace?.path ?? null, readText: (rel) => pi.fs.readText(rel) });
}
async function onLoad() {
  unloaded = false; imported.clear();
  // Commands are independent and precede all IO and agent registration.
  for (const command of manifest.contributes.commands) {
    try {
      await pi.commands.register({ ...command, run: async () => {
        try {
          if (command.id.includes("forge")) {
            if (typeof pi.ui.revealView !== "function") throw new Error("请在右侧工作面板打开「会话熔炉」");
            await pi.ui.revealView({ viewId: "session-import-forge" });
          } else await pi.ui.openPanel({ title: command.title });
        } catch (error) { log(command.id, error); await pi.ui.showToast(String(error.message ?? error), "warn"); }
      } });
      registeredCommands.push(command.id);
    } catch (error) { log(`register ${command.id}`, error); }
  }
  try { await reloadCustomSources(); } catch (error) { log("custom sources failed", error); }
  try { await startHub(); } catch (error) { log("hub startup failed", error); }
  for (const tool of createTools(hub)) {
    try { await pi.agent.registerTool(tool); tools.push(tool); }
    catch (error) { log(`registerTool ${tool.name}`, error); }
  }
}
async function onUnload() {
  unloaded = true;
  if (initialTimer) clearTimeout(initialTimer);
  initialTimer = null;
  scheduler?.stop();
  if (offSettings) { try { pi.events.off("plugin:settingsChanged", offSettings); } catch (error) { log("unsubscribe", error); } }
  offSettings = null;
  for (const tool of tools.splice(0)) { try { await pi.agent.unregisterTool(tool.name); } catch (error) { log("unregister tool", error); } }
  for (const id of registeredCommands.splice(0)) { try { await pi.commands.unregister(id); } catch (error) { log("unregister command", error); } }
  clearCache();
}
async function readyIndex() {
  if (!hub) throw new Error("会话索引初始化失败，请重新加载插件");
  await hub.ready();
  if (!hub.status().lastSyncAt) await hub.sync();
}
function syncState() {
  if (!hub) throw new Error("会话索引初始化失败");
  const c = cfg();
  return { config: { autoSyncEnabled: c.autoSyncEnabled, syncIntervalValue: c.syncIntervalValue, syncIntervalUnit: c.syncIntervalUnit,
    enabledHarnesses: c.harnesses.join(","), extraSearchRoots: c.extraRoots.join("\n"), intervalMs: c.intervalMs },
    schedule: scheduler.state(), status: hub.status(), harnesses: registry.list().map((h) => ({ id: h.id, label: labelOf(h) })) };
}
function entryOf(payload) {
  const found = resolve(hub.entries(), payload?.key ?? payload?.ref ?? payload?.sessionId ?? payload?.externalId ?? "", { harness: payload?.harness ?? payload?.source });
  if (!found.matches.length) throw new Error("未找到匹配的会话，请先同步");
  if (found.ambiguous) throw new Error("匹配到多个会话，请指定 Harness 与完整 ID");
  return hub.entries().find((e) => e.key === found.matches[0].key);
}
async function openNative(payload) {
  await readyIndex();
  const entry = entryOf(payload);
  if (entry.harness !== "pi") throw new Error("仅 Pi 会话支持原生打开");
  const real = await assertInsideRoots(entry, hub.roots(entry.harness));
  const sessionId = entry.nativeSessionId ?? `native-pi:${createHash("sha256").update(`${real}\0${entry.sessionId}`).digest("base64url").slice(0, 24)}`;
  if (typeof pi.desktop?.invoke !== "function") throw new Error("宿主未提供原生打开接口，请在宿主侧栏打开该 Pi 会话，或显式选择导入");
  await pi.desktop.invoke({ operation: "session/open", args: [sessionId] });
  return { opened: true, sessionId };
}
async function hubInvoke(channel, payload = {}) {
  if (channel === "hub.state") { if (hub) await hub.ready(); return syncState(); }
  if (channel === "hub.setConfig") {
    const patch = Object.fromEntries(Object.entries(hubConfig.sanitizePatch(payload)).map(([key, value]) => [`session-import.${key}`, value]));
    await pi.plugin.setSettings(patch);
    currentSettings = { ...currentSettings, ...patch }; applySchedule(); return syncState();
  }
  if (channel === "hub.sync") { await hub.sync({ force: true }); scheduler.noteRun(); return syncState(); }
  await readyIndex();
  if (channel === "hub.list") {
    const q = search(hub.entries(), { ...payload, maxLimit: 500, limit: payload.limit ?? 100 });
    const counts = {};
    for (const e of hub.entries()) if (e.visible !== false) counts[e.harness] = (counts[e.harness] ?? 0) + 1;
    return { ...q, sessions: q.sessions.map((s) => ({ ...s, imported: isImported(hub.entries().find((e) => e.key === s.key)) })), counts };
  }
  if (channel === "hub.resolve") return resolve(hub.entries(), payload.ref, { harness: payload.harness });
  if (channel === "hub.openNative") return openNative(payload);
  if (channel === "hub.read") {
    const entry = entryOf(payload);
    return { session: brief(entry), ...await readSession(entry, { ...payload, roots: hub.roots(entry.harness), entries: hub.entries(), rootsFor: hub.roots }) };
  }
  throw new Error(`unknown channel: ${channel}`);
}
async function onPanelInvoke(channel, payload = {}) {
  if (channel.startsWith("hub.")) return hubInvoke(channel, payload);
  switch (channel) {
    case "import.adapters": return registry.list().map((h) => ({ source: h.id, label: labelOf(h), custom: h.custom === true, dataPath: h.dataPath ?? null,
      importable: Boolean(h.importSource && h.capabilities?.import), nativeInHost: h.capabilities?.nativeInHost === true }));
    case "import.customSources": return { ...getDynamicLoadReport(), configPath: CONFIG_PATH, drivers: driverNames() };
    case "import.reloadCustomSources":
      await reloadCustomSources();
      await hub.sync({ force: true });
      return { ...getDynamicLoadReport(), drivers: driverNames() };
    case "import.scanSource": return scanSource(payload);
    case "import.sessions": return sessions(payload);
    case "import.convertBatch": return convertBatch(payload);
    case "import.capabilities": return { officialSessionApi: true, nativeHistory: true };
    case "import.targets": return { host: "pi-desktop", workspace: (await pi.workspace?.get?.())?.path, targets: require("./hosts/native/index.cjs").listTargets(), native: false };
    case "import.commit": return commitItems(payload);
    case "import.recent": return { lastImportAt: bus.recentImport.at?.toISOString() ?? null, lastImportCount: bus.recentImport.count, lastImportSource: bus.recentImport.source };
    case "app.locale": return bestEffortLocale();
    case "forge.capabilities": return forgeCapabilities();
    case "forge.sessions": return forgeSessions(payload);
    case "forge.messages": return forgeMessages(payload);
    case "forge.models": return forgeModels();
    case "forge.distill": return forgeDistill(payload);
    case "forge.save": return forgeSave(payload);
    case "forge.history.load": return { entries: await loadHistory() };
    case "forge.history.record": return { count: await recordHistory(payload.entry ?? {}) };
    default: throw new Error(`unknown channel: ${channel}`);
  }
}

// ---------------------------------------------------------------------------
// Locale — P1-U1
// ---------------------------------------------------------------------------

/** Resolve the host's UI locale, preferring SDK-provided values. */
function bestEffortLocale() {
  const raw = pi?.i18n?.locale || pi?.app?.locale || pi?.locale;
  if (typeof raw === "string" && /^(en|zh-CN|zh)$/i.test(raw.trim())) {
    const v = raw.trim().toLowerCase();
    return v === "zh" ? "zh-CN" : v;
  }
  return "zh-CN";
}

// ---------------------------------------------------------------------------
// Forge — 会话熔炉
// ---------------------------------------------------------------------------

function forgeCapabilities() {
  return {
    listSessions: typeof pi?.session?.list === "function",
    listMessages: typeof pi?.session?.listMessages === "function",
    complete: typeof pi?.agent?.complete === "function",
    models: typeof pi?.models?.list === "function",
    writeText: typeof pi?.fs?.writeText === "function",
  };
}

async function forgeSessions(payload) {
  const sessions = await forge.listImported({
    source: payload?.source ? String(payload.source) : undefined,
    limit: payload?.limit,
  });
  return { sessions };
}

async function forgeMessages(payload) {
  const sessionId = String(payload?.sessionId ?? "");
  if (!sessionId) throw new Error("sessionId required");
  const messages = await forge.readMessages(sessionId, { limit: payload?.limit });
  return { sessionId, messages };
}

async function forgeModels() {
  const rows = await pi.models.list();
  return { models: Array.isArray(rows) ? rows : (rows?.models ?? []) };
}

async function forgeDistill(payload) {
  const sessionIds = Array.isArray(payload?.sessionIds) ? payload.sessionIds : [];
  if (sessionIds.length === 0) throw new Error("no sessions selected");

  // P1#3: 蒸馏必须显式带非空的 modelKey，否则宿主拒收 INVALID_ARGUMENT
  const modelKey = payload?.modelKey || undefined;
  if (!modelKey) throw new Error("请先在上方选择一个蒸馏模型（modelKey 不能为空）");

  // 逐个取回消息；单会话失败不阻断整批。
  const sessions = [];
  let unreadable = 0;
  for (const id of sessionIds) {
    try {
      const meta = payload?.sessions?.find((s) => String(s.id) === String(id)) ?? { id };
      const messages = await forge.readMessages(String(id));
      sessions.push({ ...meta, id: String(id), messages });
    } catch {
      unreadable += 1;
    }
  }
  if (sessions.length === 0) throw new Error("selected sessions could not be read");

  const result = await forge.distill({
    sessions,
    modelKey,
    thinkingLevel: payload?.thinkingLevel || undefined,
    goal: payload?.goal ? String(payload.goal) : undefined,
  });

  return { ok: true, distilled: result.text, usage: result.usage, unreadable };
}

async function forgeSave(payload) {
  const path = String(payload?.path ?? "");
  const content = String(payload?.content ?? "");
  const mode = saveModes.normalize(payload?.mode);
  if (!path) throw new Error("path required");
  if (!content.trim()) throw new Error("nothing to save");
  // P1-F4: overwrite replaces; append/merge need the current file content.
  let existing = "";
  if (mode !== "overwrite") {
    try {
      existing = await pi.fs.readText(path);
    } catch {
      existing = ""; // file not present yet, or read denied — start fresh
    }
  }
  const final = saveModes.combine(existing, content, mode);
  await pi.fs.writeText(path, final);
  const bytes = Buffer.byteLength(final, "utf8");
  // P1-F3: record a history entry for every successful save.
  await recordHistory({
    path,
    mode,
    bytes,
    at: new Date().toISOString(),
    modelKey: payload?.modelKey || null,
    goal: payload?.goal || null,
  });
  return { ok: true, path, bytes, mode };
}

// --- P1-F3: history persistence (read-modify-write under docs/**) ---

async function loadHistory() {
  try {
    return history.parseJsonl(await pi.fs.readText(history.HISTORY_PATH));
  } catch {
    return [];
  }
}

async function recordHistory(entry) {
  const entries = history.addEntry(await loadHistory(), entry);
  try {
    await pi.fs.writeText(history.HISTORY_PATH, history.toJsonl(entries));
  } catch {
    // persistence is best-effort; in-memory entries still returned
  }
  return entries.length;
}

function sourceHarness(source) {
  const h = registry.get(source) ?? registry.importSources().get(source);
  if (!h) throw new Error(`unknown source: ${source}`);
  return h;
}
function markerKey(entry) {
  return `${hostSource(entry.importSource)}:${stableExternalId(entry.externalId ?? entry.sessionId)}`;
}
function isImported(entry) {
  if (!entry?.importSource) return false;
  if (imported.has(markerKey(entry))) return true;
  const externalId = stableExternalId(entry.externalId ?? entry.sessionId);
  return hub.entries().some((e) => e.harness === "pi-desktop" && e.importedFrom?.source === hostSource(entry.importSource) &&
    (!e.importedFrom.pluginId || e.importedFrom.pluginId === manifest.id) && String(e.importedFrom.externalId) === externalId);
}
function summaryFromEntry(e) {
  return { ...brief(e), source: e.harness, externalId: e.externalId ?? e.sessionId, fullTitle: e.name ?? e.title,
    projectName: e.workspaceName ?? labelOf(registry.get(e.harness)), projectPath: e.workspacePath ?? null, modelId: e.modelId ?? null,
    imported: isImported(e), children: hub.children(e).map((child) => ({ ...brief(child), source: child.harness, imported: isImported(child) })) };
}
async function sessions(payload) {
  await readyIndex();
  const h = sourceHarness(payload.source);
  // Archived records may be requested explicitly, but hidden subagents stay
  // under their parent; their exact ID remains readable/importable.
  const rows = hub.entries().filter((e) => e.harness === h.id && (e.visible !== false || (payload.includeArchived && e.hiddenReason === "archived")));
  return { source: h.id, sessions: rows.map(summaryFromEntry) };
}
async function scanSource(payload) {
  if (payload.full) await hub.sync({ force: true });
  const result = await sessions({ ...payload, includeArchived: true });
  const h = sourceHarness(payload.source);
  const errors = hub.status().errors.filter((e) => e.harness === h.id);
  return { source: h.id, found: result.sessions.length > 0, count: result.sessions.filter((s) => !s.archived).length,
    archived: result.sessions.filter((s) => s.archived).length, partial: false, error: errors.length ? { code: "SCAN_FAILED", message: errors.map((e) => e.message).join("; ") } : null };
}
async function convertBatch(payload) {
  await readyIndex();
  const sessions = [], errors = [];
  for (const item of payload.items ?? []) {
    try {
      const entry = entryOf({ ...item, source: payload.source });
      const prepared = await prepareImport(entry, hub, payload);
      const projected = require("./lib/import/full").projectFull(entry, prepared.messages, prepared.projectOpts);
      sessions.push({ ...projected, messages: projected.messages.map((m) => ({ ...m, content: m.text })), children: hub.children(entry).map(summaryFromEntry) });
    } catch (error) { errors.push({ externalId: item.externalId, error: String(error.message ?? error) }); }
    await yieldNow();
  }
  return { ok: errors.length === 0, source: payload.source, sessions, unreadable: errors.length, errors };
}
async function commitItems(payload) {
  const selectedTarget = payload.target || "pi-desktop";
  const nativeRoot = require("./hosts/native/pi-desktop.cjs").targets[0].defaultRoot({ home: os.homedir(), env: process.env });
  const rootKey = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (selectedTarget !== "pi-desktop" || payload.source === "pi-desktop" || (payload.targetRoot && rootKey(payload.targetRoot) !== rootKey(nativeRoot))) {
    await readyIndex();
    return require("./hosts/panel-commit.cjs").commitTarget(hub, { ...payload, target: selectedTarget }, dataDir, (await pi.workspace?.get?.())?.path);
  }
  await readyIndex();
  const mode = payload.mode ?? "skip";
  if (!["skip", "new"].includes(mode)) throw new Error("mode 必须为 skip 或 new");
  const prepared = [], readFailures = [], seen = new Set();
  const started = Date.now();
  const pendingItems = [...(payload.items ?? [])];
  for (const item of pendingItems) {
    try {
      const entry = entryOf({ ...item, source: payload.source });
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      if (!entry.importable || entry.harness === "pi-desktop") throw new Error("此来源仅支持预览");
      if (entry.nativeInHost && payload.importNative !== true) throw new Error("Pi 默认在宿主原生打开；请显式选择导入后再提交");
      const source = hostSource(entry.importSource);
      if (!manifest.contributes.sessionSources.some((s) => s.id === source)) throw new Error(`来源未在 manifest 声明：${source}`);
      const pending = { entry, source, projectOpts: {}, messages: async () => {
        const parsed = await prepareImport(entry, hub, payload);
        pending.projectOpts = parsed.projectOpts;
        return parsed.messages;
      } };
      prepared.push(pending);
      if (payload.subagentSummary && !item.fromParent) {
        for (const child of require("./lib/hub/reader").descendants(entry, hub.entries())) {
          if (child.importable && child.messageCount !== 0) pendingItems.push({ ...brief(child), fromParent: true });
        }
      }
    } catch (error) { readFailures.push({ externalId: item.externalId, error: String(error.message ?? error) }); }
    await yieldNow();
  }
  const convertedAt = Date.now();
  const result = await commit(prepared, { mode, bindProjects: payload.placement !== "standalone", projectPath: payload.placement === "workspace" ? payload.workspace : undefined, targetRoot: payload.targetRoot, dataDir, projectOpts: { withThinking: payload.withThinking !== false, subagentSummary: payload.subagentSummary === true } }, pi, bus);
  // Mark only confirmed receipts; aggregate-only hosts can confirm the whole
  // selection when every item succeeded or was skipped.
  const allConfirmed = !result.failed?.length && !result.unreadable && result.imported + result.skipped === prepared.length;
  let markersChanged = false;
  for (const item of prepared) {
    const base = stableExternalId(item.entry.externalId ?? item.entry.sessionId);
    let copyPrefix = base.slice(0, 222);
    if (/[\uD800-\uDBFF]/.test(copyPrefix.at(-1))) copyPrefix = copyPrefix.slice(0, -1);
    const confirmed = allConfirmed || (result.results ?? []).some((r) =>
      r.source === item.source && ["imported", "skipped"].includes(r.status) &&
      (r.externalId === base || (mode === "new" && r.externalId?.startsWith(copyPrefix + "~r") && /^~r[0-9a-f]{32}$/.test(r.externalId.slice(copyPrefix.length)))));
    if (confirmed) { imported.add(markerKey(item.entry)); markersChanged = true; }
  }
  if (markersChanged) {
    try { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(dataDir, "imported.json"), JSON.stringify([...imported]), "utf8"); }
    catch (error) { log("save import markers failed", error); }
  }
  return { ...result, ok: result.ok && readFailures.length === 0, failed: [...(result.failed ?? []), ...readFailures],
    unreadable: (result.unreadable ?? 0) + readFailures.length, notice: IMPORT_NOTICE,
    timings: { ...result.timings, convertMs: convertedAt - started, buildMs: 0, importMs: Date.now() - convertedAt } };
}

module.exports = { onLoad, onUnload, onPanelInvoke, ownSettingsEvent };
