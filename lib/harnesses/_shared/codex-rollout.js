"use strict";

const fs = require("node:fs");
const { readZstdJsonl, readJsonlChunks } = require("../../core/zstd");
const { parseTime } = require("../../core/time");
const { isInjected } = require("../../core/inject");

function cleanPath(value) {
  if (typeof value !== "string") return "";
  if (/^\\\\\?\\UNC\\/i.test(value)) return "\\\\" + value.slice(8);
  return value.replace(/^\\\\\?\\/, "");
}

function sourceInfo(value) {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return value; }
}

function userRequest(text) {
  const marker = /^#{1,3} My request(?: for Codex)?:\s*$/im.exec(text);
  return marker ? text.slice(marker.index + marker[0].length).trim() || text : text;
}

function injected(text) {
  const value = text.trimStart();
  return isInjected(value, "user") || /^# AGENTS\.md\b|^You are Codex[,. ]/.test(value) ||
    /^<(?:app-context|environment_context|user_instructions|permissions|instructions|system-reminder|relevant-memories|model_switch|codex_apps_client_time_context|external_codex_apps_open_page|recommended_plugins|collaboration_mode|turn_aborted|skills_instructions|plugins_instructions|session_context)\b/i.test(value);
}

// Deliberately ignore encrypted blocks and image bytes/URLs.
function contentText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("\n");
  if (content.type === "encrypted_content") return "";
  if (["input_image", "output_image", "image", "image_url"].includes(content.type)) return "[image]";
  if (typeof content.text === "string") return content.text;
  if (content.content != null) return contentText(content.content);
  return "";
}

async function* readRows(file, opts = {}) {
  if (file.endsWith(".zst")) { yield* readZstdJsonl(file, opts); return; }
  yield* readJsonlChunks(fs.createReadStream(file), opts);
}

function inherited(row) {
  return row.metadata?.inherited_user_message === true || row.payload?.metadata?.inherited_user_message === true;
}

// Eligibility uses the same source types that the message adapter renders,
// excluding inherited/injected content and encrypted-only records.
function recordEvidence(row) {
  if (inherited(row)) return { meaningful: false, user: false };
  const p = row.payload;
  if (!p) return { meaningful: false, user: false };
  if (row.type === "response_item") {
    if (p.type === "message") {
      const text = contentText(p.content);
      const user = p.role === "user" && !!text.trim() && !injected(userRequest(text));
      return { meaningful: user || (p.role === "assistant" && !!text.trim()), user, text: user ? userRequest(text) : "" };
    }
    if (p.type === "reasoning") return { meaningful: !!(contentText(p.summary) || contentText(p.content)).trim(), user: false };
    if (p.type === "agent_message") return { meaningful: !!contentText(p.content).trim(), user: false };
    if (["function_call", "custom_tool_call", "tool_search_call", "web_search_call",
      "function_call_output", "custom_tool_call_output", "tool_search_output"].includes(p.type)) return { meaningful: true, user: false };
  }
  if (row.type === "event_msg" && ["user_message", "agent_message", "agent_reasoning"].includes(p.type)) {
    const text = contentText(p.message ?? p.text);
    const user = p.type === "user_message" && !!text.trim() && !injected(userRequest(text));
    return { meaningful: user || (p.type !== "user_message" && !!text.trim()), user, text: user ? userRequest(text) : "" };
  }
  return { meaningful: false, user: false };
}

async function inspectRollout(file, options = false) {
  const opts = typeof options === "boolean" ? { full: options } : options;
  let meta, ordinal, firstPrompt = "", createdAt, updatedAt, modelId, reasoningEffort;
  let meaningful = false, hasUserEvent = false, complete = true;
  const boundedHeader = !opts.full && !opts.probe;
  for await (const row of readRows(file, boundedHeader ? { maxLines: 64 } : {})) {
    const timestamp = parseTime(row.timestamp);
    if (timestamp) { createdAt ??= timestamp; if (!updatedAt || timestamp > updatedAt) updatedAt = timestamp; }
    ordinal ??= typeof row.ordinal === "number" ? row.ordinal : undefined;
    if (row.type === "session_meta" && !meta) {
      meta = row.payload;
      if (boundedHeader) { complete = false; break; }
    }
    const evidence = recordEvidence(row);
    meaningful ||= evidence.meaningful;
    hasUserEvent ||= evidence.user;
    if (!firstPrompt && evidence.user) firstPrompt = [...evidence.text].slice(0, 200).join("");
    if (!inherited(row) && row.type === "turn_context") {
      modelId = row.payload?.model ?? modelId;
      reasoningEffort = row.payload?.effort ?? row.payload?.collaboration_mode?.settings?.reasoning_effort ?? reasoningEffort;
    }
    if (opts.probe && !opts.full && meta && meaningful && (!opts.needUser || hasUserEvent)) { complete = false; break; }
  }
  return { meta: meta ?? {}, ordinal, firstPrompt, createdAt, updatedAt, modelId, reasoningEffort, meaningful, hasUserEvent, complete };
}

module.exports = { cleanPath, sourceInfo, userRequest, injected, contentText, readRows, inherited, inspectRollout, recordEvidence };
