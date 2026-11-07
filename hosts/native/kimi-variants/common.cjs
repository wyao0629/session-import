'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const mutations = new Map();
function serialize(file, action) {
  const key = path.resolve(file);
  const previous = mutations.get(key) ?? Promise.resolve();
  const result = previous.then(action);
  const settled = result.then(() => {}, () => {});
  mutations.set(key, settled);
  void settled.then(() => { if (mutations.get(key) === settled) mutations.delete(key); });
  return result;
}

async function optionalBytes(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function parseJson(bytes) { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }

async function mergeJson(file, backupDir, update) {
  const before = await optionalBytes(file);
  const data = await update(before === null ? {} : parseJson(before));
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (before === null) {
    await fs.writeFile(file, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return;
  }
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(backupDir, `${path.basename(file)}.${randomUUID()}.bak`), before, { flag: 'wx', mode: 0o600 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const current = await optionalBytes(file);
  if (current === null || !before.equals(current)) {
    throw new Error(`Native index changed during import: ${file}; backup and staged index are retained`);
  }
  await fs.rename(temporary, file);
}

async function writeJsonl(file, records) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    for (const record of records) await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

function prepare({ entry, messages, title }) {
  if (!Array.isArray(messages) || !messages.length) throw new TypeError('messages must contain native history entries');
  const now = Date.now();
  const prepared = messages.map((message, index) => {
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new TypeError(`messages[${index}] must have a user/assistant role and string content`);
    }
    const time = message.createdAt == null ? now : new Date(message.createdAt).getTime();
    if (!Number.isFinite(time)) throw new TypeError(`messages[${index}].createdAt is invalid`);
    return { role: message.role, content: message.content, createdAt: new Date(time).toISOString(), time };
  });
  const sessionTitle = title ?? entry?.name ?? entry?.title ?? 'Imported session';
  if (typeof sessionTitle !== 'string' || !sessionTitle.trim()) throw new TypeError('title must be a non-empty string');
  let created = prepared[0].time, updated = now;
  for (const message of prepared) { created = Math.min(created, message.time); updated = Math.max(updated, message.time); }
  return { messages: prepared, title: sessionTitle, createdAt: new Date(created).toISOString(), updatedAt: new Date(updated).toISOString() };
}

module.exports = { serialize, optionalBytes, parseJson, mergeJson, writeJsonl, prepare };
