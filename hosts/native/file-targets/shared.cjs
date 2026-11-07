"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const pending = new Map();

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function parseJson(text, file) {
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (cause) { throw new Error(`无法读取原生 JSON：${file}：${cause.message}`, { cause }); }
}
async function readJson(file, fallback = null) {
  const text = await readOptional(file);
  return text === null ? fallback : parseJson(text, file);
}
function object(value, file) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`原生索引应为 JSON 对象：${file}`);
  return value;
}
function serialize(file, action) {
  const previous = pending.get(file) || Promise.resolve();
  const next = previous.then(action, action);
  pending.set(file, next);
  return next.finally(() => { if (pending.get(file) === next) pending.delete(file); });
}
async function mergeJson(file, initial, merge) {
  return serialize(file, async () => {
    const before = await readOptional(file);
    const current = before === null ? initial : parseJson(before, file);
    const updated = await merge(current);
    if (updated === undefined) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (before !== null) await fs.writeFile(`${file}.bak-${randomUUID()}`, before, { encoding: "utf8", flag: "wx" });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(updated, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, file);
    return updated;
  });
}
async function writeNew(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}
async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, "wx");
  try { for (const row of rows) await handle.writeFile(JSON.stringify(row) + "\n", "utf8"); }
  finally { await handle.close(); }
}
function segment(value, label) {
  if (typeof value !== "string" || !value || value === "." || value === ".." || /[\/\\\0]/.test(value)) throw new Error(`${label} 不是有效的原生目录名。`);
  return value;
}
function timestamp(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`无法转换会话时间：${String(value)}`);
  return date.toISOString();
}
function prepare(target, { entry = {}, messages, destination = {}, title, options = {} }) {
  const root = path.resolve(destination.root || target.defaultRoot({ home: os.homedir(), env: process.env }));
  const workspace = path.resolve(destination.workspace || entry.workspacePath || process.cwd());
  const now = new Date().toISOString();
  const fallback = timestamp(entry.createdAt, now);
  if (!Array.isArray(messages)) throw new Error("原生导入缺少逐条 messages。");
  const history = messages.map((message, index) => {
    if (!["user", "assistant"].includes(message.role) || typeof message.content !== "string") throw new Error(`第 ${index + 1} 条消息缺少 user/assistant 角色或完整 content。`);
    return { role: message.role, content: message.content, timestamp: timestamp(message.createdAt, fallback) };
  });
  const sessionId = randomUUID();
  return { root, workspace, sessionId, messages: history, options, destination,
    title: title || entry.name || entry.title || sessionId,
    createdAt: history[0]?.timestamp || fallback, updatedAt: history.at(-1)?.timestamp || timestamp(entry.updatedAt, fallback),
    importedAt: now };
}
function result(target, data, sessionPath) {
  return { sessionId: data.sessionId, sessionPath, target: target.id, title: data.title,
    messageCount: data.messages.length, nativeHistory: true, sidebar: { registered: true, workspace: data.workspace } };
}
function sameWorkspace(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
module.exports = { fs, path, randomUUID, createHash, readOptional, readJson, object, serialize, mergeJson, writeNew, writeJsonl, segment, prepare, result, sameWorkspace };
