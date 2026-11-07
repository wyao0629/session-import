/**
 * Message extractors for harnesses without an import adapter. Each returns a
 * normalized list: { role, content, createdAt?, toolName?, toolArgs?, toolResult?, toolStatus? }.
 * Tool calls are paired with their results by id; a call with no result is kept.
 */
"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");
const { withDb } = require("./entry");
const { readEvents } = require("./scanners/dsh");

const dbFile = (p) => p.split("#")[0];
const SKIP = new Set(["think", "thinking", "reasoning"]);

/** Text of a string / content-block array; images become a marker, reasoning is dropped. */
function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (!b || SKIP.has(b.type)) return "";
      if (b.type === "image_url" || b.type === "image") return "[图片]";
      return typeof b.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseArgs(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Pairs calls and results; `finish()` returns the unpaired calls as failed tool messages. */
function toolPairs(out) {
  const open = new Map();
  return {
    call(id, name, args, at) {
      if (id != null) open.set(id, { name: name ?? "tool", args: parseArgs(args), at });
    },
    result(id, text, isError, at, fallbackName) {
      const c = open.get(id);
      open.delete(id);
      out.push({ role: "tool", toolName: c?.name ?? fallbackName ?? "tool", toolArgs: c?.args, toolResult: text, toolStatus: isError ? "error" : "success", createdAt: at ?? c?.at });
    },
    finish() {
      for (const c of open.values()) out.push({ role: "tool", toolName: c.name, toolArgs: c.args, toolResult: "(无结果记录)", toolStatus: "error", createdAt: c.at });
    },
  };
}

function fromDsh(e) {
  const out = [];
  const tp = toolPairs(out);
  for (const r of readEvents(e.sessionPath)) {
    const d = r.data ?? {};
    if (r.type === "user/message") out.push({ role: "user", content: textOf(d.content), createdAt: r.time });
    else if (r.type === "assistant/message") out.push({ role: "assistant", content: textOf(d.message?.content), createdAt: r.time });
    else if (r.type === "tool/call") tp.call(d.callId, d.name, d.arguments, r.time);
    else if (r.type === "tool/result") tp.result(d.message?.toolCallId, textOf(d.message?.content), d.message?.isError, r.time);
  }
  tp.finish();
  return out;
}

function fromPiDesktop(e) {
  return withDb(dbFile(e.sessionPath), (db) =>
    db
      .prepare("SELECT role, tool_name, is_error, text, created_at FROM messages WHERE session_id = ? ORDER BY seq, mid")
      .all(e.sessionId)
      .map((r) => ({
        role: r.role === "tool" ? "tool" : r.role,
        content: r.text,
        createdAt: r.created_at,
        toolName: r.tool_name ?? undefined,
        toolResult: r.role === "tool" ? r.text : undefined,
        toolStatus: r.is_error ? "error" : "success",
      })),
  );
}

function fromGemini(e) {
  const out = [];
  for (const line of fs.readFileSync(e.sessionPath, "utf8").split("\n")) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    for (const m of Array.isArray(o?.$set?.messages) ? o.$set.messages : o?.type ? [o] : []) {
      if (m.type !== "user" && m.type !== "gemini") continue;
      const t = textOf(m.content);
      if (t) out.push({ role: m.type === "user" ? "user" : "assistant", content: t, createdAt: m.timestamp });
    }
  }
  return out;
}

/** Kimi Code: agents/main/wire.jsonl, conversation = agent.message.appended events. */
function fromKimiWire(e) {
  const out = [];
  const tp = toolPairs(out);
  for (const line of fs.readFileSync(e.sessionPath, "utf8").split("\n")) {
    if (!line.includes('"agent.message.appended"')) continue;
    let w;
    try {
      w = JSON.parse(line);
    } catch {
      continue;
    }
    const m = w.message?.message;
    if (!m) continue;
    if (m.role === "tool") tp.result(m.toolCallId, textOf(m.content), false, w.time);
    else if (m.role === "user" || m.role === "assistant") {
      const text = textOf(m.content);
      if (text) out.push({ role: m.role, content: text, createdAt: w.time });
      for (const c of m.toolCalls ?? []) tp.call(c.id, c.name ?? c.function?.name, c.arguments ?? c.function?.arguments ?? c.input, w.time);
    }
  }
  tp.finish();
  return out;
}

/** Legacy Kimi: context.jsonl, OpenAI-style roles; _system_prompt / _checkpoint / _usage are bookkeeping. */
function fromKimiContext(e) {
  const out = [];
  const tp = toolPairs(out);
  for (const line of fs.readFileSync(e.sessionPath, "utf8").split("\n")) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.role === "tool") tp.result(m.tool_call_id, textOf(m.content), false);
    else if (m.role === "user" || m.role === "assistant") {
      const text = textOf(m.content);
      if (text) out.push({ role: m.role, content: text });
      for (const c of m.tool_calls ?? []) tp.call(c.id, c.function?.name ?? c.name, c.function?.arguments ?? c.arguments);
    }
  }
  tp.finish();
  return out;
}

/** OpenClaw: transcript_events rows; `message` events carry role + string / block content. */
function fromOpenClaw(e) {
  const rows = withDb(dbFile(e.sessionPath), (db) =>
    db.prepare("SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq").all(e.sessionId),
  );
  const out = [];
  const tp = toolPairs(out);
  for (const r of rows) {
    let ev;
    try {
      ev = JSON.parse(r.event_json ?? (r.event_zstd ? zlib.zstdDecompressSync(r.event_zstd).toString("utf8") : "null"));
    } catch {
      continue;
    }
    const m = ev?.type === "message" ? ev.message : null;
    if (!m) continue;
    const at = ev.timestamp ?? m.timestamp;
    if (m.role === "toolResult") tp.result(m.toolCallId, textOf(m.content), m.isError, at, m.toolName);
    else if (m.role === "user" || m.role === "assistant") {
      const text = textOf(m.content);
      if (text) out.push({ role: m.role, content: text, createdAt: at });
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "toolCall") tp.call(b.id, b.name, b.arguments ?? b.input, at);
      }
    }
  }
  tp.finish();
  return out;
}

module.exports = { fromDsh, fromPiDesktop, fromGemini, fromKimiWire, fromKimiContext, fromOpenClaw, dbFile };
