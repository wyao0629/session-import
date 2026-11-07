"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { registry } = require("../registry");
const { renderMessages, renderMessage, cut } = require("./render");
const { brief } = require("./query");
const { yieldNow } = require("../core/fsx");
const { withTimeout } = require("./entry");
const { isChildOf } = require("./service");
const cache = new Map();
const canon = (p) => process.platform === "win32" ? p.toLowerCase() : p;

async function assertInsideRoots(entry, roots) {
  if (!roots?.length) throw new Error("请先同步：没有该 Harness 的已发现目录");
  const bases = await Promise.all(roots.map(async (root) => canon(await fs.realpath(root))));
  const primary = entry.sessionPath.split("#")[0];
  let representative;
  for (const candidate of new Set([primary, ...(entry.segmentPaths ?? [])])) {
    let file;
    try { file = await fs.realpath(candidate); }
    catch (error) {
      if (entry.harness !== "codex" || error.code !== "ENOENT" || candidate.endsWith(".zst")) throw error;
      file = await fs.realpath(candidate + ".zst");
    }
    const target = canon(file);
    if (!bases.some((base) => target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep))) {
      throw new Error("会话文件不在已发现的 Harness 目录内，已拒绝读取");
    }
    if (candidate === primary) representative = file;
  }
  return representative;
}

async function loadMessages(entry, { roots, withThinking = true } = {}) {
  const h = registry.get(entry.harness);
  if (!h) throw new Error(`未注册的 Harness：${entry.harness}`);
  await assertInsideRoots(entry, roots);
  return withTimeout(Promise.resolve().then(() => h.messages(entry, { withThinking, roots })), 180000, `${h.id}.messages`);
}

function descendants(entry, entries) {
  const result = [];
  const seen = new Set([entry.key ?? `${entry.harness}:${entry.sessionId}`]);
  const pending = [entry];
  for (let i = 0; i < pending.length; i++) {
    for (const child of entries) {
      const key = child.key ?? `${child.harness}:${child.sessionId}`;
      if (!isChildOf(child, pending[i]) || seen.has(key)) continue;
      seen.add(key); result.push(child); pending.push(child);
    }
  }
  return result;
}

async function prepareImport(entry, hub, opts = {}) {
  const messages = await loadMessages(entry, { roots: hub.roots(entry.harness), withThinking: opts.withThinking !== false });
  const projectOpts = { withThinking: opts.withThinking !== false, subagentSummary: opts.subagentSummary === true };
  if (!projectOpts.subagentSummary) return { entry, messages, projectOpts };
  const childSummaries = new Map();
  const references = [];
  for (const child of descendants(entry, hub.entries())) {
    const rows = (await loadMessages(child, { roots: hub.roots(child.harness), withThinking: projectOpts.withThinking }))
      .filter((m) => m.kind !== "noise" && m.kind !== "injected");
    const task = rows.find((m) => m.role === "user" && m.text)?.text ?? child.firstPrompt ?? "未记录任务";
    const final = rows.filter((m) => m.role === "assistant" && m.text).at(-1);
    childSummaries.set(child.sessionId, `任务：${task}\nFINAL_ANSWER：${final ? renderMessage(final, { withThinking: projectOpts.withThinking, toolDetail: "none" }) : "未记录最终回复"}`);
    references.push({ harness: child.harness, sessionId: child.sessionId, label: child.agentPath ?? child.agent_path ?? child.name ?? child.title });
    await yieldNow();
  }
  // Preserve existing spawn positions; only unmatched children get an appendix.
  const linked = new Set(messages.flatMap((m) => (m.children ?? []).map((c) => c.sessionId)));
  const missing = references.filter((r) => !linked.has(r.sessionId));
  const enriched = missing.length ? [...messages, { role: "assistant", kind: "subagent", text: "子代理摘要", children: missing, createdAt: messages.at(-1)?.createdAt }] : messages;
  return { entry, messages: enriched, projectOpts: { ...projectOpts, childSummaries } };
}

async function readSession(entry, options = {}) {
  const { roots, entries = [], rootsFor = () => roots, withThinking = true, includeSubagents = false, fromEnd = false } = options;
  const detail = ["none", "brief", "full"].includes(options.toolDetail) ? options.toolDetail : "brief";
  const size = Math.max(1, Math.min(Math.floor(Number(options.maxChars) || 20000), 200000));
  const file = await assertInsideRoots(entry, roots);
  const stat = await fs.stat(file);
  const key = `${entry.key ?? entry.sessionId}|${entry.updatedAt}|${entry.sig}|${stat.mtimeMs}|${stat.size}|${detail}|${withThinking}`;
  let text = cache.get(key);
  if (!text) {
    text = renderMessages(entry, await loadMessages(entry, { roots, withThinking }), detail, { withThinking });
    // Bound retained rendered text, including very large Codex transcripts.
    if (text.length <= 2000000) { cache.set(key, text); while (cache.size > 4) cache.delete(cache.keys().next().value); }
  }
  const children = descendants(entry, entries);
  if (includeSubagents) {
    for (const child of children) {
      const messages = await loadMessages(child, { roots: rootsFor(child.harness), withThinking });
      text += `\n\n---\n\n## 子代理（父会话 ${child.parentSessionId}）\n\n${renderMessages(child, messages, detail, { withThinking })}`;
      await yieldNow();
    }
  } else if (children.length) {
    text += "\n\n## 子代理\n" + children.map((c) => `- ${c.title}（${c.harness}/${c.sessionId}），父会话：${c.parentSessionId}`).join("\n");
  }
  const start = fromEnd ? Math.max(0, text.length - size) : Math.max(0, Math.floor(Number(options.offset) || 0));
  const end = Math.min(text.length, start + size);
  return { harness: entry.harness, sessionId: entry.sessionId, title: entry.title, format: "markdown",
    toolDetail: detail, withThinking, includeSubagents, children: children.map(brief),
    offset: start, maxChars: size, totalChars: text.length, truncated: end < text.length,
    nextOffset: end < text.length ? end : null, content: text.slice(start, end) };
}

module.exports = { readSession, loadMessages, prepareImport, descendants, assertInsideRoots, clearCache: () => cache.clear() };
