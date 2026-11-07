"use strict";
const { path, files, json, rows, fileOf, normalize, harness } = require("./_shared/other");
const { matchesGlob } = require("../drivers/fsutil");
const { makeMessage } = require("../model");

// Trusted code factory; user JSON is validated separately by custom-sources.
function createGenericHarness(config) {
  if (config.driver) return require("../sources/declarative").makeDeclarativeSource(config);
  const patterns = (config.glob ?? "*.json").split(",").map(g => g.trim());
  const h = harness({ ...config, label: typeof config.label === "string" ? config.label : config.label?.en ?? config.id, roots: config.roots ?? [],
    async enumerate(root) {
      const paths = await files(root, (name, full) => {
        const relative = path.relative(root, full).replace(/\\/g, "/");
        return patterns.some(g => matchesGlob(g.includes("/") ? relative : name, g)) && !(config.exclude && matchesGlob(relative, config.exclude));
      }, config.maxDepth ?? 6);
      return paths.map(file => ({ sessionId: path.basename(file).replace(/\.jsonl?(?:\.zstd?|\.zst)?$/, ""), sessionPath: file,
        noCache: !!(config.metadata || config.title || config.sessionId || config.parentSessionId || config.messages) }));
    },
    async load(entry, ctx) {
      const file = fileOf(entry);
      const record = /\.jsonl(?:\.zstd?|\.zst)?$/.test(file) ? await rows(file) : await json(file);
      const records = Array.isArray(record) ? record : record.messages ?? [];
      const messages = config.messages ? (await config.messages(record, ctx)).map(m => makeMessage({ ...m, text: m.text ?? m.content ?? "" })) : normalize(records);
      const meta = { sessionId: record.id ?? entry.sessionId, name: record.title, parentSessionId: record.parentSessionId ?? null,
        subagent: record.subagent, archived: record.archived, deleted: record.deleted, workspacePath: record.cwd ?? record.directory,
        createdAt: record.createdAt, updatedAt: record.updatedAt, ...(config.metadata ? await config.metadata(record, file) : {}) };
      if (config.sessionId) meta.sessionId = await config.sessionId(record, file);
      if (config.title) meta.name = await config.title(record, file);
      if (config.parentSessionId) meta.parentSessionId = await config.parentSessionId(record, file);
      return { messages, meta };
    },
  });
  h.label = typeof config.label === "object" ? config.label : h.label;
  h.capabilities = { ...h.capabilities, ...(config.capabilities ?? {}) };
  h.importSource = config.importSource === undefined ? config.id : config.importSource;
  return h;
}
module.exports = { createGenericHarness };
