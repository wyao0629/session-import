"use strict";

const { makeMessage } = require("../../model");
const { records, contentParts, resultText, prompt, injected, iso } = require("./pi-common");

function metadata(record) {
  const message = record.message;
  const parts = contentParts(message?.content ?? record.content, false);
  const text = parts.text.join("\n");
  const importable = projectBranch([record]).some((message) => message.kind !== "injected" && (
    message.text.trim() || message.thinking?.some((text) => text.trim()) || message.images?.length || message.tools?.length
  ));
  return {
    id: record.id, parentId: record.parentId, type: record.type,
    timestamp: record.timestamp, modelId: record.modelId ?? message?.model,
    role: message?.role, stopReason: message?.stopReason, importable,
    firstPrompt: message?.role === "user" ? prompt(text) : undefined,
    count: record.type === "message" || record.type === "compaction" || record.type === "branch_summary" || (record.type === "custom_message" && record.display === true) ? 1 : 0,
  };
}

async function readTree(file, { metadataOnly = false } = {}) {
  let header;
  let leaf;
  let name;
  let updatedAt;
  const nodes = new Map();
  for await (const record of records(file)) {
    if (!header) {
      if (record.type !== "session" || typeof record.id !== "string" || ![1, 2, 3].includes(record.version)) return null;
      header = record;
      updatedAt = iso(header.timestamp);
      continue;
    }
    if (record.type === "session") throw new Error("Duplicate Pi session header");
    if (record.type === "session_info") name = typeof record.name === "string" ? record.name.trim() || undefined : undefined;
    const timestamp = iso(record.timestamp);
    if (timestamp && (!updatedAt || timestamp > updatedAt)) updatedAt = timestamp;
    const id = header.version === 1 ? `legacy-${nodes.size}` : record.id;
    if (typeof id !== "string" || !id || nodes.has(id)) throw new Error("Invalid or duplicate Pi entry id");
    const node = { ...record, id, parentId: header.version === 1 ? leaf ?? null : record.parentId };
    const stored = metadataOnly ? metadata(node) : node;
    if (metadataOnly && record.type === "context_edit") {
      stored.targetId = record.targetId;
      stored.replacement = record.replacement;
    }
    nodes.set(id, stored);
    leaf = id;
  }
  if (!header) return null;
  const branch = [];
  const seen = new Set();
  while (leaf != null) {
    const node = nodes.get(leaf);
    if (!node || seen.has(leaf)) throw new Error("Broken Pi active branch");
    seen.add(leaf);
    branch.push(node);
    leaf = node.parentId;
  }
  branch.reverse();
  const active = new Map(branch.map((node, index) => [node.id, index]));
  for (const node of branch) {
    if (node.type !== "context_edit" || !active.has(node.targetId)) continue;
    const index = active.get(node.targetId);
    const target = branch[index];
    if (target.type !== "message") continue;
    const replacement = node.replacement;
    const content = typeof replacement === "string" || Array.isArray(replacement) ? replacement : replacement?.content;
    if (content == null) continue;
    if (metadataOnly) {
      const replacementMetadata = metadata({ ...target, message: { role: target.role, stopReason: target.stopReason, content } });
      target.firstPrompt = replacementMetadata.firstPrompt;
      target.importable = replacementMetadata.importable;
    } else {
      branch[index] = { ...target, message: { ...target.message, content } };
    }
  }
  return { header, branch, name, updatedAt };
}

function projectBranch(branch, { withThinking = true } = {}) {
  const out = [];
  const pending = new Map();
  for (const record of branch) {
    const createdAt = iso(record.timestamp ?? record.message?.timestamp);
    if (record.type === "compaction" || record.type === "branch_summary") {
      if (record.summary) out.push(makeMessage({ role: "system", kind: "summary", text: `[${record.type === "compaction" ? "上下文压缩摘要" : "分支摘要"}]\n${record.summary}`, createdAt }));
      continue;
    }
    const custom = record.type === "custom_message";
    if (custom && record.display !== true) continue;
    if (!custom && record.type !== "message") continue;
    const source = custom ? { role: "custom", content: record.content } : record.message;
    if (!source) continue;
    if (source.role === "toolResult") {
      let tool = pending.get(source.toolCallId);
      if (!tool) {
        tool = { id: source.toolCallId ?? record.id, name: source.toolName || "tool", status: "pending" };
        out.push(makeMessage({ role: "assistant", tools: [tool], createdAt }));
      }
      tool.result = resultText(source);
      tool.status = source.isError ? "error" : "success";
      pending.delete(source.toolCallId);
      continue;
    }
    const parts = contentParts(source.content, withThinking);
    const role = ["user", "assistant", "system"].includes(source.role) ? source.role : "system";
    const text = parts.text.join("\n");
    const message = makeMessage({
      role, text, createdAt,
      kind: role === "user" && injected(text, source.role) ? "injected" : "normal",
      ...(parts.thinking.length ? { thinking: parts.thinking } : {}),
      ...(parts.images.length ? { images: parts.images } : {}),
    });
    if (parts.calls.length) {
      message.tools = parts.calls.map((call) => {
        const tool = { id: call.id ?? record.id, name: call.name || "tool", args: call.arguments, status: "pending" };
        pending.set(tool.id, tool);
        return tool;
      });
    }
    if (source.stopReason === "error" || source.stopReason === "aborted") {
      message.kind = "error";
      message.text += `${message.text ? "\n" : ""}[${source.stopReason === "aborted" ? "已中止" : "生成错误"}]${source.errorMessage ? ` ${source.errorMessage}` : ""}`;
    }
    if (message.text || message.thinking?.length || message.images?.length || message.tools?.length) out.push(message);
  }
  return out;
}

module.exports = { readTree, projectBranch };
