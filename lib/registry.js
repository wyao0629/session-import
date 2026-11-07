"use strict";

// Compatibility facade. Every consumer, including declarative sources, uses the
// same registry object exported by harnesses/index.js. No builtin source.convert.
const registry = require("./harnesses");
const { loadCustomSources, CONFIG_PATH } = require("./custom-sources");
const { getDriver } = require("./drivers");
const { makeEntry, makeMessage } = require("./model");
const { exists } = require("./core/fsx");
const builtins = registry.list().slice();
const builtinGet = registry.get;
let dynamic = [];
let lastLoad = { count: 0, errors: [], configPath: CONFIG_PATH };
const labelOf = (h, locale = "zh-CN") => typeof h.label === "string" ? h.label : h.label?.[locale] ?? h.label?.en ?? h.id;

registry.list = () => [...builtins, ...dynamic];
registry.get = (id) => builtinGet(id) ?? dynamic.find((h) => h.id === id);
registry.importSources = () => new Map(registry.list().filter((h) => h.importSource && h.capabilities?.import).map((h) => [h.importSource, h]));
registry.toolHarnessEnum = () => [...new Set(builtins.flatMap((h) => [h.id, ...(h.aliases ?? [])]))].sort();

const hostSource = (id) => `session-import.${id}`;
function sessionSources() {
  const sources = [...registry.importSources()].filter(([id]) => id !== "custom").map(([id, h]) => ({ id: hostSource(id), label: h.label }));
  // Arbitrary workspace specs cannot amend a loaded manifest. Share a declared
  // source and namespace their external IDs instead.
  sources.push({ id: hostSource("custom"), label: { en: "Custom source", "zh-CN": "声明式来源" } });
  return sources;
}

function declarativeMessage(m, withThinking) {
  const thinking = withThinking === false ? [] : (Array.isArray(m.thinking) ? m.thinking : m.thinking ? [String(m.thinking)] : []);
  return makeMessage({
    ...m, role: m.role === "tool" ? "assistant" : m.role, text: m.role === "tool" ? "" : (m.text ?? m.content ?? ""), thinking,
    tools: m.role === "tool" ? [{ id: m.toolCallId, name: m.toolName ?? "tool", args: m.toolArgs, result: m.toolResult ?? m.content, status: m.toolStatus === "error" ? "error" : m.toolStatus === "running" ? "pending" : "success" }] : (m.tools ?? []),
  });
}

function makeCustomHarness(spec) {
  const driver = getDriver(spec.driver);
  const root = spec.root || spec.db;
  return {
    id: spec.id, label: spec.label, custom: true, driver: spec.driver, dataPath: root,
    importSource: "custom", aliases: [], schemes: [spec.id],
    capabilities: { import: true, nativeInHost: false, children: true },
    discover: async () => await exists(root) ? [{ root, via: "declarative" }] : [],
    async scan() {
      const rows = await driver.scan(spec, spec.id);
      return rows.map((s) => makeEntry({
        ...s, harness: spec.id, sessionId: String(s.externalId), externalId: `${spec.id}:${s.externalId}`,
        sessionPath: s.filePath, title: s.fullTitle ?? s.title, name: s.fullTitle ?? s.title,
        nameKind: s.nameKind ?? "native", workspacePath: s.projectPath, workspaceName: s.projectName,
        importSource: "custom", importable: true, visible: s.visible ?? !s.parentSessionId, summary: s,
      }));
    },
    async messages(entry, opts = {}) {
      const result = await driver.convert(spec, entry.summary);
      if (!result?.session) throw new Error(`声明式来源 ${spec.id} 未返回可读会话`);
      return result.messages.map((m) => declarativeMessage(m, opts.withThinking));
    },
  };
}

async function refreshDynamicSources(options = {}) {
  const { specs, errors, configPath } = await loadCustomSources(options);
  const next = [];
  const ids = new Set(builtins.flatMap((h) => [h.id, h.importSource, ...(h.aliases ?? [])]));
  for (const spec of specs) {
    if (ids.has(spec.id) || spec.id === "custom") { errors.push(`spec ${spec.id}: source id is already registered`); continue; }
    try { next.push(makeCustomHarness(spec)); ids.add(spec.id); }
    catch (err) { errors.push(`spec ${spec.id}: ${err.message}`); }
  }
  dynamic = next;
  lastLoad = { count: next.length, errors, configPath };
  return next;
}

const allAdapters = () => registry.list().map((h) => ({ ...h, source: h.id, label: labelOf(h) }));
const getAdapter = (id) => allAdapters().find((h) => h.id === id || h.importSource === id) ?? null;
module.exports = { registry, labelOf, hostSource, sessionSources, allAdapters, getAdapter,
  getDynamicAdapters: () => dynamic, getDynamicLoadReport: () => lastLoad, refreshDynamicSources, CONFIG_PATH };
