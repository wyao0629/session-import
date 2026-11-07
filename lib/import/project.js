"use strict";

const { createHash } = require("node:crypto");
const { parseTime, maxTime, monotonic } = require("../core/time");
const { BATCH_MAX_BYTES, serializedBytes } = require("./contract");

const MSG_CAP = 2000;
const CONTENT_MAX_BYTES = 512 * 1024;
const TRUNCATION_NOTE = "\n\n*[正文超过 512 KiB，后续内容已截断；完整记录保留在来源会话中]*";

// 只在外部导入边界裁剪；先保留完整段落，再处理单个超长段落。
function truncateContent(text, maxBytes = CONTENT_MAX_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const budget = maxBytes - Buffer.byteLength(TRUNCATION_NOTE, "utf8");
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) lo = mid;
    else hi = mid - 1;
  }
  if (lo && /[\uD800-\uDBFF]/.test(text[lo - 1])) lo--;
  const boundary = text.lastIndexOf("\n\n", lo);
  if (boundary > 0) lo = boundary;
  return { text: text.slice(0, lo) + TRUNCATION_NOTE, truncated: true };
}

function clip(value, cap) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= cap) return text;
  let cut = cap;
  if (cut && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
  return `${text.slice(0, cut)}\n…（共 ${text.length} 字符，已截断）`;
}

function fence(text) {
  const runs = text.match(/`{3,}/g) ?? [];
  const delimiter = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${delimiter}text\n${text}\n${delimiter}`;
}

function renderMessage(message, opts) {
  const parts = [];
  if (opts.withThinking !== false) {
    for (const text of message.thinking ?? []) {
      if (text.trim()) parts.push(`> **推理**\n>\n${text.split("\n").map((line) => `> ${line}`).join("\n")}`);
    }
  }
  if (message.text) parts.push(message.text);
  for (const image of message.images ?? []) {
    parts.push(/^data:/i.test(image) ? "[图片保留在来源会话中]" : `[图片：${image}]`);
  }
  for (const tool of message.tools ?? []) {
    const status = tool.status === "error" ? "（错误）" : tool.status === "pending" ? "（未记录结果）" : "";
    const lines = [`**工具：${tool.name ?? "tool"}${status}**`];
    if (tool.args != null) lines.push(fence(clip(tool.args, opts.toolArgsMax ?? 2000)));
    if (tool.result != null) lines.push(fence(clip(tool.result, opts.toolResultMax ?? 4000)));
    parts.push(lines.join("\n"));
  }
  for (const child of message.children ?? []) {
    const summary = opts.subagentSummary && opts.childSummaries?.get(child.sessionId);
    parts.push(`↳ 子代理：${child.label ?? child.sessionId}（${child.harness}/${child.sessionId}）${summary ? `\n${summary}` : ""}`);
  }
  return parts.join("\n\n").trim();
}

function stableExternalId(value) {
  const id = String(value ?? "");
  if (id.length <= 256) return id;
  let prefix = id.slice(0, 222);
  if (/[\uD800-\uDBFF]/.test(prefix.at(-1))) prefix = prefix.slice(0, -1);
  return `${prefix}~${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

function project(entry, messages, opts = {}) {
  const report = { inputCount: messages.length, injectedDropped: 0, noiseDropped: 0, emptyDropped: 0, cappedDropped: 0, byteCappedDropped: 0, contentTruncated: 0, outputCount: 0 };
  const merged = [];
  for (const message of messages) {
    if (message.kind === "injected") { report.injectedDropped++; continue; }
    if (message.kind === "noise") { report.noiseDropped++; continue; }
    const text = renderMessage(message, opts);
    if (!text) { report.emptyDropped++; continue; }
    const role = message.role === "user" ? "user" : "assistant";
    const previous = merged.at(-1);
    if (previous?.role === role) previous.text += `\n\n${text}`;
    else merged.push({ role, text, createdAt: message.createdAt });
  }

  // 提示同样计入宿主上限；合并相邻助手消息以保持角色交替。
  let capped = merged;
  if (merged.length > MSG_CAP) {
    capped = merged.slice(-(MSG_CAP - 1));
    report.cappedDropped = merged.length - capped.length;
    // 条数与字节预算确定后统一插入提示，避免提示被后续尾部裁剪丢弃。
  }

  const createdAt = parseTime(entry.createdAt) ?? parseTime(capped.find((m) => parseTime(m.createdAt))?.createdAt) ?? parseTime(entry.updatedAt) ?? new Date().toISOString();
  const times = monotonic(capped.map((m) => m.createdAt), createdAt);
  const finalMessages = capped.map((message, index) => {
    const clipped = truncateContent(message.text);
    if (clipped.truncated) report.contentTruncated++;
    return { role: message.role, text: clipped.text, createdAt: times[index] };
  });
  const name = [entry.name, entry.title, entry.firstPrompt, entry.sessionId, "未命名会话"].find((value) => typeof value === "string" && value.trim());
  const title = [...name.trim()].slice(0, 200).join("");
  const session = {
    externalId: stableExternalId(entry.externalId ?? entry.sessionId),
    title,
    projectPath: entry.workspacePath ?? null,
    modelId: entry.modelId ?? null,
    providerId: null,
    createdAt,
    updatedAt: maxTime(entry.updatedAt, times.at(-1) ?? createdAt),
  };
  // 按宿主 content 字段的 JSON 字节计算；预留提示、新副本 ID 与项目绑定的开销。
  const overhead = serializedBytes({ source: `session-import.${entry.importSource ?? entry.harness}`, mode: "skip", sessions: [{ ...session, messages: [] }] });
  const budget = BATCH_MAX_BYTES - overhead - 4096;
  const sizes = finalMessages.map((message) => serializedBytes({ role: message.role, content: message.text, createdAt: message.createdAt }) + 1);
  let bytes = sizes.reduce((sum, size) => sum + size, 0);
  while (bytes > budget && report.byteCappedDropped < finalMessages.length - 1) bytes -= sizes[report.byteCappedDropped++];
  if (report.byteCappedDropped) finalMessages.splice(0, report.byteCappedDropped);
  if (report.cappedDropped || report.byteCappedDropped) {
    const reason = [report.cappedDropped && "2000 条消息上限", report.byteCappedDropped && "32 MiB 载荷上限"].filter(Boolean).join("及");
    const notice = `*[已省略前 ${report.cappedDropped + report.byteCappedDropped} 条消息（超出${reason}）；完整记录保留在来源会话中]*`;
    if (finalMessages[0].role === "assistant") {
      const clipped = truncateContent(`${notice}\n\n${finalMessages[0].text}`);
      finalMessages[0].text = clipped.text;
      if (clipped.truncated) report.contentTruncated++;
    } else finalMessages.unshift({ role: "assistant", text: notice, createdAt: finalMessages[0].createdAt });
  }
  report.outputCount = finalMessages.length;
  return { session, messages: finalMessages, report };
}

module.exports = { project, truncateContent, stableExternalId };
