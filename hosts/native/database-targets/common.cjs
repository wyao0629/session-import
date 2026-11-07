"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const NL = String.fromCharCode(10);

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function json(file, missing) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return missing; throw error; }
}
function timestamp(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  const time = Number.isFinite(number) ? (number > 0 && number < 100000000000 ? number * 1000 : number) : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("Native import: invalid message createdAt");
  return Math.trunc(time);
}
function context(target, input) {
  const { destination, messages, entry = {}, options = {} } = input;
  if (!destination?.root || !destination.workspace) throw new Error(`${target}: destination.root and destination.workspace are required`);
  const now = Date.now();
  const records = messages.map((message, index) => {
    if (!["user", "assistant"].includes(message.role) || typeof message.content !== "string") throw new Error(`${target}: messages[${index}] requires user/assistant role and string content`);
    return { role: message.role, content: message.content, time: timestamp(message.createdAt, now + index), id: randomUUID(), sequence: index };
  });
  let created = records[0]?.time ?? now, updated = created;
  for (const record of records) { created = Math.min(created, record.time); updated = Math.max(updated, record.time); }
  return { target, root: path.resolve(destination.root), workspace: path.resolve(destination.workspace), projectId: destination.projectId, id: randomUUID(), title: input.title || entry.name || entry.title || "Imported session", records, created, updated, now, entry, options };
}
function result(c, sessionPath, sessionId = c.id) {
  return { sessionId, sessionPath, target: c.target, title: c.title, messageCount: c.records.length, nativeHistory: true, sidebar: { registered: true, workspace: c.workspace } };
}
async function writeNew(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" });
}
async function writeRows(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, "wx");
  try { for (const row of rows) await handle.writeFile(JSON.stringify(row) + NL, "utf8"); } finally { await handle.close(); }
}
const indexWrites = new Map();
async function mergeJson(file, initial, merge) {
  const previous = indexWrites.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const old = await json(file, undefined);
    const next = merge(old === undefined ? initial : old);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (old !== undefined) await fs.copyFile(file, `${file}.session-import-${randomUUID()}.bak`);
    const temporary = `${file}.session-import-${randomUUID()}.tmp`;
    await writeNew(temporary, JSON.stringify(next, null, 2) + NL);
    await fs.rename(temporary, file);
  });
  indexWrites.set(file, operation);
  try { await operation; } finally { if (indexWrites.get(file) === operation) indexWrites.delete(file); }
}
function ident(name) { return '"' + name.replaceAll('"', '""') + '"'; }
function columns(db, table, schema = "main") {
  const rows = db.prepare(`PRAGMA ${ident(schema)}.table_info(${ident(table)})`).all();
  if (!rows.length) throw new Error(`Native import: missing ${schema}.${table} table`);
  return rows;
}
function inserter(db, table, required, schema = "main") {
  const info = columns(db, table, schema), known = new Set(info.map(c => c.name));
  for (const name of required) if (!known.has(name)) throw new Error(`Native import: missing ${schema}.${table}.${name}`);
  const statements = new Map();
  return values => {
    for (const column of info) if (column.notnull && column.dflt_value === null && values[column.name] == null && !(column.pk && column.type.toUpperCase() === "INTEGER")) throw new Error(`Native import: ${schema}.${table}.${column.name} requires a value for this installed schema`);
    const names = Object.keys(values).filter(name => known.has(name) && values[name] !== undefined), key = names.join(",");
    let statement = statements.get(key);
    if (!statement) { statement = db.prepare(`INSERT INTO ${ident(schema)}.${ident(table)} (${names.map(ident).join(",")}) VALUES (${names.map(() => "?").join(",")})`); statements.set(key, statement); }
    statement.run(...names.map(name => values[name]));
  };
}
async function database(file) {
  if (!await exists(file)) throw new Error(`Native import: target database is missing: ${file}`);
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(file);
}
async function backupDatabase(db, file, source = "main") {
  const { backup } = require("node:sqlite");
  await backup(db, `${file}.session-import-${randomUUID()}.bak`, { source });
}
async function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try { const value = await callback(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function samePath(a, b) {
  if (!a || !b) return false;
  const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}
module.exports = { fs, path, randomUUID, createHash, NL, exists, json, timestamp, context, result, writeNew, writeRows, mergeJson, columns, inserter, database, backupDatabase, transaction, samePath };
