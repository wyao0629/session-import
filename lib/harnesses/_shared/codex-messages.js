"use strict";

const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { makeMessage } = require("../../model");
const { parseTime } = require("../../core/time");
const { yieldNow } = require("../../core/fsx");
const { contentText, readRows, inherited, injected, userRequest, inspectRollout } = require("./codex-rollout");
const { rolloutRoots, resolveRollout } = require("./codex-paths");

function parseArgs(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return { input: value }; }
}

function resultText(value) {
  if (typeof value === "string" || Array.isArray(value) || value?.content) return contentText(value);
  return value == null ? "" : JSON.stringify(value, (key, item) => key === "encrypted_content" ? undefined : item);
}

function toolNames(value) {
  const parsed = typeof value === "string" ? parseArgs(value) : value;
  const tools = Array.isArray(parsed) ? parsed : parsed?.tools ?? parsed?.results ?? [];
  const names = Array.isArray(tools) ? tools.map((tool) => typeof tool === "string" ? tool : tool?.name ?? tool?.function?.name ?? tool?.tool?.name).filter(Boolean) : [];
  return names.join("\n") || resultText(value);
}

function failed(payload, text) {
  return payload.is_error === true || payload.status === "failed" || payload.status === "error" ||
    (typeof payload.exit_code === "number" && payload.exit_code !== 0) ||
    /(?:exit(?:ed)?(?: with)? code|Process exited with code)[:\s]+[1-9]\d*|Script failed/i.test(text);
}


async function messages(entry, ctx = {}) {
  if (entry.missingRollout || entry.segmentPaths?.length === 0) {
    throw Object.assign(new Error("Codex session has no readable rollout; synchronize after the source is restored"), { code: "CODEX_ROLLOUT_MISSING" });
  }
  const roots = await rolloutRoots(ctx.roots ?? (entry.sourceRoot ? [entry.sourceRoot] : []));
  const files = [];
  // Validate every segment before opening even the first segment's header.
  for (const candidate of new Set(entry.segmentPaths ?? [entry.sessionPath])) {
    files.push(await resolveRollout(candidate, roots));
  }
  const segments = [];
  for (const file of new Set(files)) {
    const stats = await fs.stat(file);
    const fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
    const cached = entry.rolloutScan?.find((segment) => segment.path === file && segment.fingerprint === fingerprint && !segment.info.readError);
    const header = cached?.info ?? await inspectRollout(file);
    if (header.meta.id && header.meta.id !== entry.sessionId) {
      throw Object.assign(new Error("Codex rollout identity differs from indexed session"), { code: "CODEX_ROLLOUT_ID" });
    }
    segments.push({ file, ...header });
  }
  segments.sort((a, b) => (a.ordinal != null && b.ordinal != null ? a.ordinal - b.ordinal : 0) ||
    String(a.createdAt ?? a.file).localeCompare(String(b.createdAt ?? b.file)) || a.file.localeCompare(b.file));
  const output = [], events = [], seen = new Set(), calls = new Map(), responseSignatures = new Set(), referenced = new Set();
  const children = entry.children ?? [];
  let currentTime = entry.createdAt, processed = 0;
  function add(fields) {
    const message = makeMessage({ createdAt: currentTime, role: "assistant", ...fields });
    output.push(message);
    return message;
  }
  function signature(role, text) { return createHash("sha256").update(role + "\0" + text).digest("hex"); }
  function childRefs(payload) {
    const refs = children.filter((child) => !referenced.has(child.sessionId) && child.agentPath && [payload.author, payload.recipient].includes(child.agentPath));
    for (const ref of refs) referenced.add(ref.sessionId);
    return refs;
  }
  for (const segment of segments) {
    for await (const row of readRows(segment.file)) {
      if (++processed % 1000 === 0) await (ctx.yieldNow ?? yieldNow)();
      const timestamp = parseTime(row.timestamp);
      if (timestamp) {
        currentTime = timestamp;
        if (!entry.updatedAt || timestamp > entry.updatedAt) entry.updatedAt = timestamp;
      }
      if (inherited(row)) continue;
      const payload = row.payload ?? row;
      if (row.type === "turn_context") {
        entry.modelId = payload.model ?? entry.modelId;
        entry.reasoningEffort = payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort ?? entry.reasoningEffort;
        continue;
      }
      if (row.type === "event_msg") {
        if (["user_message", "agent_message", "agent_reasoning"].includes(payload.type)) {
          const role = payload.type === "user_message" ? "user" : "assistant";
          const text = contentText(payload.message ?? payload.text);
          if (text.trim() && (payload.type !== "agent_reasoning" || ctx.withThinking !== false)) {
            events.push(makeMessage({ role, text: payload.type === "agent_reasoning" ? "" : text,
              thinking: payload.type === "agent_reasoning" ? [text] : undefined, createdAt: currentTime,
              kind: role === "user" && injected(text) ? "injected" : "normal" }));
          }
        }
        // item_completed is only a UI projection of response_item.
        continue;
      }
      if (row.type !== "response_item") continue;
      if (payload.id) {
        if (seen.has(payload.id)) continue;
        seen.add(payload.id);
      }
      if (payload.type === "message") {
        if (!["user", "assistant"].includes(payload.role)) continue;
        const text = contentText(payload.content);
        if (!text.trim()) continue;
        responseSignatures.add(signature(payload.role, text));
        add({ role: payload.role, text, kind: payload.role === "user" && injected(userRequest(text)) ? "injected" : "normal" });
      } else if (payload.type === "reasoning") {
        const text = contentText(payload.summary) || contentText(payload.content);
        if (text.trim() && ctx.withThinking !== false) {
          responseSignatures.add(signature("assistant", text));
          add({ thinking: [text] });
        }
      } else if (payload.type === "agent_message") {
        const text = contentText(payload.content);
        if (!text.trim()) continue;
        const encrypted = Array.isArray(payload.content) && payload.content.some((block) => block.type === "encrypted_content");
        const route = [payload.author, payload.recipient].filter(Boolean).join(" → ");
        add({ kind: "subagent", text: `[子代理${route ? ` ${route}` : ""}]\n${text}${encrypted ? "\n[加密内容保留在来源会话中]" : ""}`,
          children: childRefs(payload) });
      } else if (["function_call", "custom_tool_call", "tool_search_call", "web_search_call"].includes(payload.type)) {
        const callId = payload.call_id ?? payload.id ?? `codex_call_${processed}`;
        const name = payload.name ? (payload.namespace && !payload.name.startsWith(payload.namespace + ".") ? `${payload.namespace}.${payload.name}` : payload.name) : payload.type.replace(/_call$/, "");
        const args = payload.type === "custom_tool_call" ? { input: payload.input } : parseArgs(payload.arguments ?? payload.action ?? (payload.query != null ? { query: payload.query } : undefined));
        let tool = calls.get(callId);
        if (tool) { tool.name = name; tool.args = args; }
        else {
          tool = { id: callId, name, args, status: "pending" };
          calls.set(callId, tool);
          add({ tools: [tool] });
        }
        if (payload.type === "web_search_call") {
          tool.result = payload.status ?? "web search recorded";
          tool.status = failed(payload, tool.result) ? "error" : payload.status === "completed" ? "success" : "pending";
        }
      } else if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(payload.type)) {
        const callId = payload.call_id ?? payload.id ?? `codex_output_${processed}`;
        const value = payload.output ?? payload.tools ?? payload.result;
        const result = payload.type === "tool_search_output" ? toolNames(value) : resultText(value);
        let tool = calls.get(callId);
        if (!tool) {
          tool = { id: callId, name: payload.type === "tool_search_output" ? "tool_search" : payload.name ?? "unknown_tool" };
          calls.set(callId, tool);
          add({ tools: [tool] });
        }
        tool.result = result;
        tool.status = failed(payload, result) ? "error" : "success";
      }
    }
  }
  for (const event of events) {
    if (!responseSignatures.has(signature(event.role, event.text || event.thinking?.join("\n")))) output.push(event);
  }
  const hasContent = output.some((message) => !["injected", "noise"].includes(message.kind) &&
    (message.text.trim() || message.thinking?.some((text) => text.trim()) || message.tools?.length));
  if (ctx.withThinking !== false) {
    entry.hasContent = hasContent;
    entry.importable = hasContent;
    entry.importBlockedReason = hasContent ? null : "empty";
  }
  if (!hasContent) return [];
  const missingRefs = children.filter((child) => !referenced.has(child.sessionId));
  if (missingRefs.length) add({ kind: "subagent", children: missingRefs });
  output.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  return output;
}

module.exports = { messages };
