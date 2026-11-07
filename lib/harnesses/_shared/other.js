"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { makeEntry, makeMessage } = require("../../model");
const { parseTime } = require("../../core/time");
const { readJsonlAll, yieldNow } = require("../../core/fsx");
const { isInjected, userRequest } = require("../../hub/inject");

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}
async function json(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
async function files(root, test, depth = 6) {
  if (!await exists(root)) return [];
  const out = [];
  async function walk(dir, remaining) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && remaining > 0 && !e.name.endsWith(".removed")) await walk(full, remaining - 1);
      else if (e.isFile() && test(e.name, full)) out.push(full);
    }
  }
  await walk(root, depth);
  return out.sort();
}
async function rows(file) {
  if (/\.(zstd|zst)$/.test(file)) {
    const raw = await fs.readFile(file), zlib = require("node:zlib");
    if (!zlib.zstdDecompressSync) throw new Error("zstd decoding unavailable");
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), starts = [], chunks = [];
    for (let i = raw.indexOf(magic); i >= 0; i = raw.indexOf(magic, i + 4)) starts.push(i);
    let from = 0;
    for (let k = 0; k < starts.length; k++) {
      const end = starts[k + 1] ?? raw.length;
      try { chunks.push(zlib.zstdDecompressSync(raw.subarray(starts[from], end))); from = k + 1; }
      catch (error) { if (k === starts.length - 1) throw error; }
    }
    if (!chunks.length) throw new Error("No complete zstd frame");
    const lines = Buffer.concat(chunks).toString("utf8").split("\n"), out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try { out.push(JSON.parse(lines[i])); } catch (error) { if (i < lines.length - 1) throw error; }
    }
    return out;
  }
  return readJsonlAll(file);
}
function fileOf(entry) {
  return entry.filePath || entry.sessionPath.replace(/#(?:session_id|sidechain)=.*$/, "");
}
function withDb(file, fn) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function columns(db, table) {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(table)) throw new Error("Invalid table name");
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
}
function parse(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function text(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (value.text != null) return text(value.text);
    if (value.content != null) return text(value.content);
    return JSON.stringify(value);
  }
  return String(value);
}
function cleanUser(value) {
  const query = /<user_query>([\s\S]*?)<\/user_query>/i.exec(value);
  if (query) return query[1].trim();
  return userRequest(value.replace(/<(system-reminder|cb_summary|conversation_history_summary)\b[\s\S]*?<\/\1>/gi, "")).trim();
}
function injected(value) {
  return isInjected(value) || /^<(tools|heartbeat|session_context)\b/i.test(value.trimStart());
}
function status(value, result) {
  if (["error", "failed", "cancelled"].includes(value) || value === true) return "error";
  return result !== undefined || ["completed", "success", "output-available"].includes(value) ? "success" : "pending";
}

// One parser for Claude/OpenAI blocks, OpenClaw messages, Qoder parts and tool arrays.
function normalize(records) {
  const out = [], calls = new Map();
  function call(id, name, args, at, value, state, kind = "normal") {
    const known = id != null && calls.get(String(id));
    if (known) {
      if (name) known.name = name;
      if (args !== undefined) known.args = parse(args);
      if (value !== undefined) { known.result = value; known.status = status(state, value); }
      return known;
    }
    const tool = { id: String(id ?? `tool-${out.length}`), name: name || "tool", args: parse(args), status: status(state, value) };
    if (value !== undefined) tool.result = value;
    out.push(makeMessage({ role: "assistant", kind, tools: [tool], createdAt: parseTime(at) }));
    if (id != null) calls.set(String(id), tool);
    return tool;
  }
  function result(id, value, error, at, name, kind) {
    const tool = calls.get(String(id));
    if (tool) { tool.result = value; tool.status = error ? "error" : "success"; }
    else call(id, name, undefined, at, value, error ? "error" : "success", kind);
  }
  for (const row of records) {
    const m = row.message && typeof row.message === "object" ? row.message : row;
    let role = m.role || row.role || row.type;
    if (role === "gemini" || role === "model") role = "assistant";
    const at = row.timestamp ?? row.time ?? row.createdAt ?? row.created_at ?? m.timestamp;
    const kind = role === "system" || row.isMeta || row.is_meta || row.synthetic || row.synthetic_reason ? "injected" : "normal";
    if (row.type === "function_call") { call(row.callId ?? row.call_id, row.name, row.arguments, at, undefined, undefined, kind); continue; }
    if (["function_call_result", "function_call_output"].includes(row.type)) { result(row.callId ?? row.call_id, row.output, ["failed", "error"].includes(row.status), at, row.name, kind); continue; }
    if (role === "reasoning") {
      const thinking = text(row.summary ?? row.text);
      if (thinking) out.push(makeMessage({ role: "assistant", kind, thinking: [thinking], createdAt: parseTime(at) }));
      continue;
    }
    const content = m.content ?? m.parts ?? m.text;
    if (["tool", "tool_result", "toolResult"].includes(role) && !Array.isArray(m.parts)) {
      result(m.tool_call_id ?? m.toolCallId ?? m.tool_use_id ?? m.source?.callId, content ?? m.output ?? m.result, m.is_error || m.isError || m.status === "error", at, m.name ?? m.toolName, kind);
      continue;
    }
    if (!["user", "assistant", "system", "tool"].includes(role)) continue;
    let message;
    const fresh = () => makeMessage({ role: role === "tool" ? "assistant" : role, kind, createdAt: parseTime(at) });
    message = fresh();
    const flush = () => {
      message.text = role === "user" ? cleanUser(message.text.trim()) : message.text.trim();
      if (role === "user" && injected(message.text)) message.kind = "injected";
      if (message.text || message.thinking?.length || message.images?.length) out.push(message);
      message = fresh();
    };
    const addText = value => { const t = text(value); if (t) message.text += (message.text ? "\n" : "") + t; };
    const addThinking = value => { const t = text(value); if (t) (message.thinking ??= []).push(t); };
    if (typeof content === "string") addText(content);
    const blocks = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
    for (const b of blocks) {
      if (typeof b === "string") { addText(b); continue; }
      if (!b || b.synthetic) continue;
      const v = b.data && typeof b.data === "object" ? { ...b, ...b.data } : b;
      const type = v.type || b.type || "";
      if (["thinking", "reasoning", "think"].includes(type) || v.thought === true) addThinking(v.thinking ?? v.text ?? v.content);
      else if (["tool_use", "toolCall", "tool-call", "function_call"].includes(type) || v.functionCall) {
        flush(); const c = v.functionCall ?? v;
        call(c.id ?? c.callId ?? c.toolCallId, c.name ?? c.toolName, c.input ?? c.arguments ?? c.args, at, undefined, undefined, kind);
      } else if (["tool_result", "tool-result", "function_call_result"].includes(type) || v.functionResponse) {
        flush(); const r = v.functionResponse ?? v;
        result(r.tool_use_id ?? r.toolCallId ?? r.callId ?? r.id, r.content ?? r.output ?? r.result ?? r.response, r.is_error || r.isError, at, r.name, kind);
      } else if (type === "tool" || type.startsWith("tool-")) {
        flush(); const t = typeof v.tool === "object" ? v.tool : v;
        const s = typeof t.state === "object" ? t.state : {};
        call(t.id ?? t.callID ?? t.toolCallId, t.name ?? t.toolName ?? (typeof t.tool === "string" ? t.tool : type.slice(5)), s.input ?? t.input ?? t.args, at, s.output ?? s.error ?? t.response ?? t.output ?? t.result, s.status ?? t.status ?? t.state, kind);
      } else if (["image", "image_url", "input_image"].includes(type)) (message.images ??= []).push(v.url ?? v.image_url?.url ?? "来源图片");
      else if (["text", "input_text", "output_text", ""].includes(type)) addText(v.text ?? v.content);
    }
    if (m.reasoning_content) addThinking(m.reasoning_content);
    for (const t of m.thoughts ?? []) addThinking(t.text ?? t.description ?? t);
    flush();
    for (const c of m.tool_calls ?? m.toolCalls ?? []) {
      call(c.id ?? c.callId, c.function?.name ?? c.name, c.function?.arguments ?? c.arguments ?? c.args ?? c.input, at, c.result ?? c.response, c.status, kind);
    }
  }
  return out;
}

function entryFor(harness, descriptor, meta, messages) {
  const sid = String(meta.sessionId ?? descriptor.sessionId);
  const visibleMessages = messages.filter(m => !["noise", "injected"].includes(m.kind));
  const prompt = visibleMessages.find(m => m.role === "user" && m.text)?.text;
  const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : undefined;
  const hiddenReason = meta.deleted ? "deleted" : meta.hiddenReason || (meta.subagent ? "subagent" : meta.archived ? "archived" : !visibleMessages.length ? "empty" : null);
  return makeEntry({ ...descriptor, ...meta, harness: harness.id, sessionId: sid, key: `${harness.id}:${sid}`,
    name, title: [...(name || prompt || sid)].slice(0, 200).join(""), firstPrompt: prompt ? [...prompt].slice(0, 200).join("") : undefined,
    nameKind: name ? "native" : prompt ? "prompt" : "none", messageCount: visibleMessages.length,
    workspaceName: meta.workspaceName || (meta.workspacePath ? meta.workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : undefined),
    createdAt: parseTime(meta.createdAt) ?? messages.find(m => m.createdAt)?.createdAt,
    updatedAt: parseTime(meta.updatedAt) ?? messages.findLast(m => m.createdAt)?.createdAt,
    parentSessionId: meta.parentSessionId || null, hiddenReason, visible: !hiddenReason,
    importSource: harness.importSource, importable: harness.capabilities.import && visibleMessages.some(m =>
      m.text.trim() || m.thinking?.some(t => t.trim()) || m.tools?.length || m.images?.length || m.children?.length),
  });
}
async function discoverRoots(templates, markers, ctx = {}) {
  const home = ctx.home ?? os.homedir(), env = ctx.env ?? process.env;
  const expand = t => t.replace(/^~(?=[\\/]|$)/, home).replace(/%([^%]+)%/g, (_, key) => env[key] ?? "__unset__");
  const candidates = templates.map(expand);
  for (const extra of ctx.extraRoots ?? []) {
    const root = typeof extra === "string" ? extra : extra.root;
    if (!root) continue;
    candidates.push(root);
    for (const t of templates.filter(t => t.startsWith("~/"))) candidates.push(path.join(root, t.slice(2)));
  }
  const found = [], seen = new Set();
  for (const root of candidates) {
    if (!await exists(root)) continue;
    if (markers.length && !(await Promise.all(markers.map(m => exists(path.join(root, m))))).some(Boolean)) continue;
    const real = await fs.realpath(root);
    if (seen.has(real)) continue;
    seen.add(real); found.push({ root, via: "discover" });
  }
  return found;
}
async function signature(descriptor) {
  const paths = [fileOf(descriptor), ...(descriptor.dependencies ?? [])];
  const parts = [];
  for (const file of paths) {
    try { const s = await fs.stat(file); parts.push(`${s.mtimeMs}:${s.size}`); } catch (e) { if (e.code !== "ENOENT") throw e; parts.push("missing"); }
  }
  return parts.join("|");
}
function harness(config) {
  const h = { id: config.id, label: { en: config.label, "zh-CN": config.label }, order: config.order ?? 60,
    importSource: config.importSource ?? config.id, aliases: config.aliases ?? [], schemes: config.schemes ?? [],
    capabilities: { import: true, nativeInHost: false, children: true },
    discover: ctx => discoverRoots(config.roots, config.markers ?? [], ctx),
    async scan(root, ctx = {}) {
      const descriptors = await config.enumerate(root, ctx), result = [];
      for (const descriptor of descriptors.slice(0, ctx.maxSessions ?? Infinity)) {
        try {
          const sig = await signature(descriptor);
          const previous = ctx.previous?.get(`${h.id}:${descriptor.sessionId}`) ?? ctx.previous?.get(descriptor.sessionId);
          if (previous?.sig === sig && previous.sessionPath === descriptor.sessionPath && !descriptor.noCache && (!previous.importable || previous.messageCount > 0)) {
            result.push(previous);
            for (const e of ctx.previous.values()) if (e.sidechain && e.parentSessionId === previous.sessionId && fileOf(e) === fileOf(previous)) result.push(e);
          } else {
            const loaded = await config.load(descriptor, ctx);
            const entry = entryFor(h, descriptor, { ...descriptor, ...loaded.meta }, loaded.messages);
            entry.sig = sig; result.push(entry);
            for (const child of loaded.children ?? []) result.push(entryFor(h, child.descriptor, child.meta, child.messages));
          }
        } catch (error) { if (ctx.report) ctx.report(descriptor.sessionId, error); else throw error; }
        if (result.length % 20 === 0) await (ctx.yieldNow ?? yieldNow)();
      }
      const unique = new Map();
      for (const e of result) if (!unique.has(e.key) || (e.updatedAt || "") > (unique.get(e.key).updatedAt || "")) unique.set(e.key, e);
      for (const e of unique.values()) e.childCount = 0;
      for (const e of unique.values()) { const parent = unique.get(`${h.id}:${e.parentSessionId}`); if (parent) parent.childCount++; }
      return [...unique.values()];
    },
    async messages(entry, ctx = {}) {
      const loaded = await config.load(entry, ctx);
      return ctx.withThinking === false ? loaded.messages.map(({ thinking, ...m }) => m) : loaded.messages;
    },
  };
  return h;
}
module.exports = { fs, path, exists, json, files, rows, fileOf, withDb, columns, parse, text, normalize, entryFor, discoverRoots, harness };
