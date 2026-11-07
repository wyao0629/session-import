"use strict";

const { parseTime } = require("../core/time");
const ROLE = { user: "用户", assistant: "助手", tool: "工具", system: "系统" };
function cut(value, max) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  return text.length > max ? `${text.slice(0, max)}…（已截断，共 ${text.length} 字符）` : text;
}
const stamp = (value) => parseTime(value) ?? "";
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
function header(entry, notes = []) {
  return [`# ${oneLine(entry.name ?? entry.title) || entry.sessionId}`, "",
    `- Harness：${entry.harness}`, `- 会话 ID：${entry.sessionId}`,
    ...(entry.parentSessionId ? [`- 父会话：${entry.parentSessionId}`] : []),
    ...(entry.workspacePath ? [`- 工作区：${entry.workspacePath}`] : []),
    ...notes.map((n) => `- 说明：${n}`), ""];
}
function fence(value, max) {
  const text = cut(value, max);
  const delimiter = "`".repeat(Math.max(3, ...(text.match(/`{3,}/g) ?? []).map((s) => s.length + 1)));
  return `${delimiter}text\n${text}\n${delimiter}`;
}
function renderMessage(message, { toolDetail = "brief", withThinking = true } = {}) {
  const parts = [];
  if (message.text) parts.push(message.text);
  if (withThinking) for (const text of message.thinking ?? []) parts.push(`> **推理**\n${text.split("\n").map((s) => `> ${s}`).join("\n")}`);
  for (const image of message.images ?? []) parts.push(/^data:/i.test(image) ? "[图片保留在来源会话中]" : `[图片：${image}]`);
  if (toolDetail !== "none") for (const tool of message.tools ?? []) {
    const cap = toolDetail === "full" ? 200000 : 600;
    parts.push(`### 工具：${tool.name ?? "tool"}${tool.status === "error" ? "（失败）" : tool.status === "pending" ? "（未记录结果）" : ""}`);
    if (tool.args != null) parts.push("参数：", fence(tool.args, cap));
    if (tool.result != null) parts.push("结果：", fence(tool.result, cap));
  }
  for (const child of message.children ?? []) parts.push(`↳ 子代理：${child.label ?? child.sessionId}（${child.harness}/${child.sessionId}）`);
  return parts.join("\n\n");
}
function renderMessages(entry, messages, toolDetail = "brief", opts = {}) {
  const dropped = messages.filter((m) => m.kind === "injected" || m.kind === "noise").length;
  const out = header(entry, dropped ? [`已省略 ${dropped} 条注入或噪声消息`] : []);
  for (const m of messages) {
    if (m.kind === "injected" || m.kind === "noise") continue;
    const text = renderMessage(m, { ...opts, toolDetail });
    if (text) out.push(`## ${ROLE[m.role] ?? m.role}${m.createdAt ? ` · ${stamp(m.createdAt)}` : ""}`, "", text, "");
  }
  return out.join("\n");
}
module.exports = { renderMessages, renderMessage, cut, header, stamp, oneLine };
