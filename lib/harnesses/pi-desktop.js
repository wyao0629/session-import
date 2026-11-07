"use strict";

const path = require("node:path");
const os = require("node:os");
const { makeEntry, makeMessage } = require("../model");
const { clip, baseName, iso, safeStat, sessionFiles, sessionDirectory, existingRoots, records, contentParts, resultText, prompt, injected } = require("./_shared/pi-common");
const { readMetadata } = require("./_shared/pi-desktop-db");

const id = "pi-desktop";
const label = { en: "PI-Desktop", "zh-CN": "PI-Desktop" };
const order = 31;
const importSource = null;
const aliases = [];
const schemes = [];
const capabilities = { import: false, nativeInHost: true, children: false };

async function discover(ctx = {}) {
  const home = ctx.home ?? os.homedir();
  const roots = [{ root: path.join(home, ".pi-desktop"), via: "default" }];
  for (const extra of ctx.extraRoots ?? []) {
    const root = path.resolve(extra.replace(/^~(?=[\/\\]|$)/, home));
    const host = path.basename(root) === "sessions" ? path.dirname(root) : root;
    if ((await safeStat(path.join(host, "pi.sqlite")))?.isFile() || (await safeStat(path.join(host, "sessions")))?.isDirectory()) roots.push({ root: host, via: "extra" });
  }
  return existingRoots(roots);
}

async function readSession(file, metadataOnly = false) {
  let header;
  let updatedAt;
  const messages = new Map();
  for await (const record of records(file)) {
    if (!header) {
      if (record.type !== "session" || record.schema !== 1 || typeof record.sessionId !== "string") return null;
      header = record;
      updatedAt = iso(header.createdAt);
      continue;
    }
    const time = iso(record.createdAt);
    if (time && (!updatedAt || time > updatedAt)) updatedAt = time;
    if (record.type !== "message" && record.type !== "compaction") continue;
    const key = record.id ?? `record-${messages.size}`;
    messages.set(key, metadataOnly ? {
      role: record.role, type: record.type, modelId: record.meta?.modelId,
      firstPrompt: record.role === "user" && !record.meta?.parentToolCallId ? prompt(contentParts(record.blocks, false).text.join("\n")) : undefined,
    } : record);
  }
  return header ? { header, rows: [...messages.values()], updatedAt } : null;
}

function imported(row, header = {}) {
  if (row?.origin_session != null) return { pluginId: row.origin_plugin, plugin: row.origin_plugin, source: row.origin_source, externalId: row.origin_external };
  if (row?.source) return { source: row.source };
  const origin = header.importedFrom ?? header.importOrigin;
  if (!origin) return null;
  const pluginId = origin.pluginId ?? origin.plugin;
  return pluginId == null ? origin : { ...origin, pluginId, plugin: pluginId };
}

async function scan(root, ctx = {}) {
  const dir = await sessionDirectory(root);
  const host = path.basename(dir) === "sessions" ? path.dirname(dir) : path.resolve(root);
  const files = new Map();
  for await (const file of sessionFiles(dir, { recursive: false, maxFiles: ctx.maxFiles })) files.set(path.basename(file, ".jsonl"), file);
  const meta = await readMetadata(host, ctx.maxFiles == null ? undefined : [...files.keys()]);
  const ids = new Set([...files.keys(), ...meta.keys()]);
  const entries = [];
  let count = 0;
  for (const sessionId of ids) {
    const row = meta.get(sessionId);
    const file = files.get(sessionId) ?? path.join(dir, `${sessionId}.jsonl`);
    // Database IDs are external input; never use one as a relative path.
    if (path.dirname(file) !== dir || /[\/\\]/.test(sessionId)) continue;
    try {
      const stat = await safeStat(file);
      if (ctx.maxFileBytes && stat?.size > ctx.maxFileBytes) continue;
      const origin = imported(row);
      const deleted = row?.deleted_at != null;
      const session = !deleted && stat?.isFile() ? await readSession(file, true) : null;
      if (session && session.header.sessionId !== sessionId) continue;
      if (!row && !session) continue;
      const importedFrom = origin ?? imported(null, session?.header);
      const firstPrompt = session?.rows.find((message) => message.firstPrompt)?.firstPrompt;
      const name = row?.title?.trim() || session?.header.title?.trim() || session?.header.name?.trim();
      const nameKind = name ? (row?.title_source === "generated" ? "generated" : row?.title_source === "default" ? "prompt" : "native") : firstPrompt ? "prompt" : "none";
      const messageCount = session?.rows.filter((message) => message.role === "user" || message.role === "assistant").length ?? 0;
      const hiddenReason = deleted ? "deleted" : !messageCount ? "empty" : null;
      const workspacePath = row?.cwd ?? session?.header.cwd;
      entries.push(makeEntry({
        key: `${id}:${sessionId}`, harness: id, sessionId, sessionPath: file,
        title: clip(name || firstPrompt || sessionId), name, nameKind, firstPrompt,
        workspacePath, workspaceName: baseName(workspacePath),
        createdAt: iso(row?.created_at ?? session?.header.createdAt),
        updatedAt: iso(row?.updated_at) ?? session?.updatedAt ?? iso(stat?.mtimeMs),
        modelId: row?.model_id ?? session?.rows.findLast((message) => message.modelId)?.modelId,
        messageCount, visible: hiddenReason === null, hiddenReason, internal: false,
        parentSessionId: session?.header.parentSessionId ?? null, importedFrom: importedFrom ?? undefined,
        importSource: null, importable: false, nativeInHost: true, sourceFormat: "pi-desktop-jsonl",
      }));
    } catch (error) {
      if (!ctx.report) throw error;
      ctx.report(file, error);
    }
    if (++count % 20 === 0) await ctx.yieldNow?.();
  }
  return entries;
}

async function messages(entry, ctx = {}) {
  if (entry.hiddenReason === "deleted") return [];
  const file = entry.sessionPath;
  if (!(await safeStat(file))?.isFile()) return [];
  const dir = path.dirname(file);
  const row = (await readMetadata(path.basename(dir) === "sessions" ? path.dirname(dir) : dir, [entry.sessionId])).get(entry.sessionId);
  if (row?.deleted_at != null) return [];
  const session = await readSession(file);
  if (!session || session.header.sessionId !== entry.sessionId) return [];
  const out = [];
  const tools = new Map();
  for (const source of session.rows) {
    const createdAt = iso(source.createdAt);
    if (source.type === "compaction") {
      if (source.summary) out.push(makeMessage({ role: "system", kind: "summary", text: `[上下文压缩摘要]\n${source.summary}`, createdAt }));
      continue;
    }
    const parts = contentParts(source.blocks, ctx.withThinking !== false);
    const text = parts.text.join("\n");
    const role = ["user", "assistant", "system"].includes(source.role) ? source.role : "assistant";
    const message = makeMessage({
      role, text, createdAt,
      kind: source.meta?.parentToolCallId ? "subagent" : injected(text, source.role) ? "injected" : "normal",
      ...(parts.thinking.length ? { thinking: parts.thinking } : {}),
      ...(parts.images.length ? { images: parts.images } : {}),
    });
    for (const call of parts.calls) {
      const callId = call.callId ?? call.id ?? source.id;
      let tool = tools.get(callId);
      if (!tool) {
        tool = { id: callId, name: call.name || source.toolName || "tool", status: "pending" };
        tools.set(callId, tool);
        (message.tools ??= []).push(tool);
      }
      if (call.args != null) tool.args = call.args;
      if (call.result != null) tool.result = resultText(call.result);
      tool.status = call.result?.isError || call.status === "error" || call.status === "failed" ? "error" : call.result != null ? "success" : "pending";
    }
    if (source.role === "tool" && !parts.calls.length) {
      message.tools = [{ id: source.id, name: source.toolName || "tool", result: text, status: source.isError ? "error" : "success" }];
      message.text = "";
    }
    if (["error", "aborted", "cancelled"].includes(source.meta?.status)) {
      message.kind = "error";
      message.text += `${message.text ? "\n" : ""}[${source.meta.status}]`;
    }
    if (message.text || message.thinking?.length || message.images?.length || message.tools?.length) out.push(message);
  }
  return out;
}

module.exports = { id, label, order, importSource, aliases, schemes, capabilities, discover, scan, messages };
