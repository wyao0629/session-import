"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { registry, refreshDynamicSources, getDynamicLoadReport } = require("../lib/registry");
const { createHubService } = require("../lib/hub/service");
const { normalize, sanitizePatch } = require("../lib/hub/config");
const { search, resolve, brief } = require("../lib/hub/query");
const { readSession, loadMessages, descendants, clearCache } = require("../lib/hub/reader");
const { importNative } = require("./native/index.cjs");
const { refreshAfterImport } = require("./native/kimi-refresh.cjs");
const manifest = require("../manifest.json");
const text = { type: "string" };
const flag = { type: "boolean" };
const reference = { ref: { type: "string", minLength: 1 }, harness: text };
const tools = manifest.contributes.agentTools.map(({ name, description, schema }) => ({ name, description, inputSchema: schema }));
tools.push({
  name: "session_hub_import",
  description: "将历史转换为目标客户端的原生会话并登记侧边栏工作区，返回原生会话 ID。逐条保存完整历史；不会把转录塞入当前 Agent 上下文。",
  inputSchema: { type: "object", properties: { ...reference, target: text, targetRoot: text, workspace: text, projectId: text, placement: { type: "string", enum: ["project", "workspace", "standalone"] }, title: text, withThinking: flag, includeSubagents: flag, mode: { type: "string", enum: ["skip", "copy"] } }, required: ["ref"], additionalProperties: false }
}, {
  name: "session_hub_forge",
  description: "读取所选会话并生成熔炉语料和提炼指令，交给当前宿主模型生成规则/技能；传 content 与 outputPath 可保存提炼结果。不会自行调用外部模型。",
  inputSchema: { type: "object", properties: { refs: { type: "array", items: text, minItems: 1 }, harness: text, goal: text, withThinking: flag, content: text, outputPath: text }, additionalProperties: false }
}, {
  name: "session_hub_open", description: "打开原会话导入面板：自动同步、原生标题、完整预览、选择侧边栏目标并导入原生会话。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
});

const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const log = (message, error) => console.error(`[session-import] ${message}: ${error?.message ?? error ?? ""}`);

async function createRuntime(options = {}) {
  const host = options.host ?? process.env.SESSION_IMPORT_HOST ?? "universal";
  const workspace = path.resolve(options.workspace ?? process.env.SESSION_IMPORT_WORKSPACE ?? process.cwd());
  const dataDir = path.resolve(options.dataDir ?? process.env.SESSION_IMPORT_DATA_DIR ?? path.join(os.homedir(), ".session-import", digest(`${host}\0${workspace}`)));
  const configPath = path.join(dataDir, "settings.json");
  let settings = {};
  try { settings = JSON.parse(await fs.readFile(configPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (process.env.SESSION_IMPORT_HARNESSES) settings.enabledHarnesses = process.env.SESSION_IMPORT_HARNESSES;
  if (process.env.SESSION_IMPORT_ROOTS) settings.extraSearchRoots = process.env.SESSION_IMPORT_ROOTS;
  await refreshDynamicSources({ workspaceRoot: workspace });
  const hub = createHubService({ dataDir: path.join(dataDir, "index"), home: os.homedir(), env: process.env, getConfig: () => normalize(settings), log });
  const unsubscribe = hub.onChange(clearCache);
  await hub.ready();
  let initialTimer, intervalTimer, closed = false;
  const sync = async () => {
    await refreshDynamicSources({ workspaceRoot: workspace });
    const status = await hub.sync();
    return { ...status, host, workspace, customSources: getDynamicLoadReport() };
  };
  if (options.autoSync !== false && process.env.SESSION_IMPORT_AUTO_SYNC !== "false" && normalize(settings).autoSyncEnabled) {
    initialTimer = setTimeout(() => { if (!closed) sync().catch(error => log("initial sync", error)); }, 5000);
    intervalTimer = setInterval(() => { if (!closed) sync().catch(error => log("auto sync", error)); }, normalize(settings).intervalMs);
    initialTimer.unref(); intervalTimer.unref();
  }
  async function ready() {
    await hub.ready();
    if (!hub.status().lastSyncAt) await sync();
  }
  function entryFor(args) {
    const found = resolve(hub.entries(), args.ref, { harness: args.harness });
    if (!found.matches.length) throw new Error("没有匹配会话；请先同步并使用搜索结果中的 key。");
    if (found.ambiguous) throw new Error("匹配到多个会话，请同时指定 harness 和完整 key。");
    return hub.entries().find(entry => entry.key === found.matches[0].key);
  }
  const read = (entry, args = {}) => readSession(entry, { ...args, roots: hub.roots(entry.harness), entries: hub.entries(), rootsFor: hub.roots });

  async function importSession(args) {
    const entry = entryFor(args);
    const sources = [entry, ...(args.includeSubagents ? descendants(entry, hub.entries()) : [])];
    const results = [], failed = [];
    for (const source of sources) {
      try {
        const messages = await loadMessages(source, { roots: hub.roots(source.harness), withThinking: args.withThinking !== false });
        const destination = { root: args.targetRoot, workspace: args.workspace || source.workspacePath || workspace, projectId: args.projectId, placement: args.placement };
        results.push(await importNative({ target: args.target ?? host, entry: source, messages, destination,
          title: source === entry ? args.title : undefined, mode: args.mode ?? "skip", dataDir, options: args }));
      } catch (error) { failed.push({ key: source.key, sessionId: source.sessionId, error: error.message }); }
    }
    const refresh = await refreshAfterImport(results);
    const refreshNotice = refresh.status === "requested" ? "已请求目标客户端刷新会话列表，请打开返回的会话 ID。"
      : refresh.status === "not-needed" ? "请在目标客户端刷新会话列表并打开返回的会话 ID。"
        : `自动刷新未完成（${refresh.status}），请手动刷新会话列表后打开返回的会话 ID。`;
    return { ...results[0], results, failed, ok: failed.length === 0, imported: results.filter(result => result.status === "imported").length,
      skipped: results.filter(result => result.status === "skipped").length, nativeHistory: results.length > 0, refresh,
      notice: results.length ? `原生历史已写入所选工作区；${refreshNotice}` : "没有成功写入的原生会话。" };
  }

  async function forge(args) {
    if (args.content !== undefined) {
      if (!args.outputPath) throw new Error("保存提炼结果需要 outputPath。");
      const outputPath = path.resolve(workspace, args.outputPath);
      const rel = path.relative(workspace, outputPath);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("熔炉输出必须位于当前工作区内。");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      const backupPath = `${outputPath}.session-import-${randomUUID()}.bak`;
      let backup = null;
      try { await fs.copyFile(outputPath, backupPath); backup = backupPath; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.writeFile(outputPath, String(args.content), "utf8");
      return { saved: true, outputPath, backupPath: backup };
    }
    if (!args.refs?.length) throw new Error("请提供需要蒸馏的 refs。");
    const sessions = [];
    for (const ref of args.refs) {
      const entry = entryFor({ ref, harness: args.harness });
      const messages = await loadMessages(entry, { roots: hub.roots(entry.harness), withThinking: args.withThinking !== false });
      const rendered = require("./native/index.cjs").fullMessages(messages, args);
      sessions.push({ sessionId: entry.sessionId, title: entry.name || entry.title, content: rendered.map(message => `${message.role}:\n${message.content}`).join("\n\n") });
    }
    const instruction = "根据下方真实会话提炼项目约定、已验证做法、反复出现的坑和待确认事项。只记录有依据的结论，输出可复用 Markdown；完成后可调用 session_hub_forge 的 content/outputPath 保存。";
    return { kind: "forge-input", requiresHostModel: true, sessions: sessions.map(s => ({ sessionId: s.sessionId, title: s.title, truncated: false })), text: [instruction, args.goal ? `本次目标：${args.goal}` : "", ...sessions.map(s => s.content)].filter(Boolean).join("\n\n---\n\n") };
  }

  async function call(name, args = {}) {
    if (closed) throw new Error("会话服务已经关闭。");
    if (name === "session_hub_sync") return sync();
    if (name === "session_hub_open") return require("./panel-server.cjs").openPanel(api);
    if (name === "session_hub_forge" && args.content !== undefined) return forge(args);
    await ready();
    switch (name) {
      case "session_hub_search": return search(hub.entries(), args);
      case "session_hub_resolve": return resolve(hub.entries(), args.ref, { harness: args.harness });
      case "session_hub_read": return read(entryFor(args), args);
      case "session_hub_import": return importSession(args);
      case "session_hub_forge": return forge(args);
      default: throw new Error(`未知工具：${name}`);
    }
  }
  const api = { tools, call, host, workspace, dataDir, hub, ready, entryFor, read, sync,
    config: () => normalize(settings),
    async setConfig(patch) {
      settings = { ...settings, ...sanitizePatch(patch) };
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(settings, null, 2), "utf8");
      clearInterval(intervalTimer);
      if (normalize(settings).autoSyncEnabled) {
        intervalTimer = setInterval(() => sync().catch(error => log("auto sync", error)), normalize(settings).intervalMs);
        intervalTimer.unref();
      }
      return normalize(settings);
    },
    status: () => hub.status(),
    close() { closed = true; clearTimeout(initialTimer); clearInterval(intervalTimer); unsubscribe(); clearCache(); } };
  api.invoke = require("./panel-adapter.cjs").createPanelAdapter(api);
  return api;
}

module.exports = { createRuntime, tools };
