"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");

function targets() {
  return ["kimi", "kimi-variants", "codex", "pi", "pi-desktop", "file-targets", "database-targets"].flatMap(name => require(`./${name}.cjs`).targets);
}
function targetOf(id) {
  const normalized = ({ kimi: "kimi-code", "kimi-cli": "kimi-code", "claude-code": "claude" })[id] ?? id;
  const target = targets().find(item => item.id === normalized);
  if (!target) throw new Error(`未知目标宿主：${id}`);
  return target;
}
function listTargets() {
  return targets().map(target => ({ id: target.id, label: target.label, root: target.defaultRoot({ home: os.homedir(), env: process.env }), nativeHistory: true }));
}
function serialize(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function fullMessages(messages, options = {}) {
  return messages.filter(message => !["injected", "noise"].includes(message.kind)).map(message => {
    const sections = [];
    if (options.withThinking !== false) for (const thought of message.thinking ?? []) sections.push(`【思考】\n${thought}`);
    if (message.text) sections.push(message.text);
    for (const image of message.images ?? []) sections.push(`[图片：${image}]`);
    for (const tool of message.tools ?? []) {
      const parts = [`【工具 ${tool.name ?? "tool"} · ${tool.status ?? "recorded"}】`];
      if (tool.args != null) parts.push(`参数：\n${serialize(tool.args)}`);
      if (tool.result != null) parts.push(`结果：\n${serialize(tool.result)}`);
      sections.push(parts.join("\n"));
    }
    for (const child of message.children ?? []) {
      const summary = options.subagentSummary && options.childSummaries?.get(child.sessionId);
      sections.push(`【子会话】${child.label ?? child.sessionId} (${child.harness}/${child.sessionId})${summary ? `\n${summary}` : ""}`);
    }
    return { role: message.role === "user" ? "user" : "assistant", content: sections.join("\n\n"), createdAt: message.createdAt };
  }).filter(message => message.content.trim());
}

async function importNative({ target: targetId, entry, messages, destination = {}, title, mode = "skip", dataDir, options = {} }) {
  const target = targetOf(targetId);
  const root = path.resolve(destination.root || target.defaultRoot({ home: os.homedir(), env: process.env }));
  const workspace = path.resolve(destination.workspace || entry.workspacePath || process.cwd());
  const converted = fullMessages(messages, options);
  if (!converted.length) throw new Error("没有可导入的历史消息。");
  const key = createHash("sha256").update(JSON.stringify([target.id, root, workspace, destination.projectId ?? null, destination.placement ?? options.placement ?? "project", entry.key ?? entry.sessionId])).digest("hex");
  const receiptDir = path.join(dataDir, "native-import-receipts");
  await fs.mkdir(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `${key}.json`);
  if (mode === "skip") {
    try {
      const old = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      await fs.stat(old.sessionPath.replace(/#session_id=.*$/, ""));
      return { ...old, alreadyImported: true, status: "skipped" };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const result = await require("./worker.cjs").writeTarget(target, { entry, messages: converted, rawMessages: messages, destination: { ...destination, root, workspace }, title: title || entry.name || entry.title, mode, options });
  if (!result?.sessionId || !result.sessionPath || result.nativeHistory !== true || result.sidebar?.registered !== true) throw new Error("目标宿主未确认原生会话及侧边栏登记，不能报告导入成功。");
  const receipt = { ...result, sourceKey: entry.key, target: target.id, kind: "native", nativeHistory: true, status: "imported", imported: true, importedAt: new Date().toISOString() };
  const temp = `${receiptPath}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(receipt, null, 2), { encoding: "utf8", flag: "wx" });
  await fs.rename(temp, receiptPath);
  return receipt;
}
module.exports = { listTargets, targetOf, fullMessages, importNative };
