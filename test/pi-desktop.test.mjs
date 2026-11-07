import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
const desktop = require('../lib/harnesses/pi-desktop');
const registry = require('../lib/harnesses');
const { safeStat } = require('../lib/harnesses/_shared/pi-common');
const fixture = fileURLToPath(new URL('./fixtures/pi-desktop/desktop.jsonl', import.meta.url));
async function temporary() {
  const scratch = process.env.PI_SCRATCH_DIR;
  assert.ok(scratch && (await safeStat(scratch))?.isDirectory(), 'A non-linked PI_SCRATCH_DIR is required');
  return fs.mkdtemp(path.join(scratch, 'pi-desktop-fixtures-'));
}
async function fixtureDb(root) {
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
  await fs.copyFile(fixture, path.join(root, 'sessions', 'desktop.jsonl'));
  const file = path.join(root, 'pi.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, title_source TEXT, created_at INTEGER, updated_at INTEGER, model_id TEXT, project_id TEXT, source TEXT, deleted_at INTEGER);
    CREATE TABLE session_import_origins (session_id TEXT, source_id TEXT, external_id TEXT, plugin_id TEXT);
    INSERT INTO projects VALUES ('p', 'D:/fixture-project');`);
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, 1793494800000, 1793494800009, ?, ?, ?, ?)');
  insert.run('desktop', 'GUI renamed title', 'manual', 'gui-model', 'p', null, null);
  insert.run('imported', 'Plugin output', 'legacy', null, null, 'codex', null);
  insert.run('other-plugin', 'Other plugin output', 'legacy', null, null, null, null);
  insert.run('source-only', 'Legacy imported output', 'legacy', null, null, 'pi', null);
  insert.run('empty', 'Empty GUI session', 'default', null, null, null, null);
  insert.run('deleted', 'Deleted', 'manual', null, null, null, 1793494800005);
  insert.run('generated', 'Generated GUI title', 'generated', null, null, null, null);
  const origin = db.prepare('INSERT INTO session_import_origins VALUES (?, ?, ?, ?)');
  origin.run('imported', 'codex', 'external~rabc', 'pi.session-import');
  origin.run('other-plugin', 'pi', 'external-pi', 'another-plugin');
  db.close();
  const rows = (await fs.readFile(fixture, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const id of ['imported', 'other-plugin', 'source-only', 'deleted', 'generated']) {
    const copy = rows.map((row) => row.type === 'session' ? { ...row, sessionId: id } : row);
    await fs.writeFile(path.join(root, 'sessions', `${id}.jsonl`), copy.map(JSON.stringify).join('\n') + '\n');
  }
  return file;
}
const digest = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

test('PI-Desktop preview reads JSONL thinking, paired tools, images and summaries', async () => {
  const [entry] = await desktop.scan(path.dirname(fixture));
  assert.equal(entry.key, 'pi-desktop:desktop');
  assert.equal(entry.title, 'Desktop request');
  assert.equal(entry.importable, false);
  assert.equal(entry.importSource, null);
  assert.equal(entry.messageCount, 4);
  assert.equal(entry.parentSessionId, null);
  const messages = await desktop.messages(entry);
  const assistant = messages.find((message) => message.text === 'Desktop answer');
  assert.deepEqual(assistant.thinking, ['Desktop reasoning']);
  assert.equal(assistant.tools[0].status, 'success');
  assert.deepEqual(assistant.tools[0].args, { path: 'fixture.txt' });
  assert.match(assistant.tools[0].result, /Desktop tool body/);
  assert.ok(assistant.tools[0].result.includes('image/jpeg'));
  assert.equal(messages.flatMap((message) => message.tools ?? []).length, 2);
  assert.ok(messages.some((message) => message.kind === 'summary' && message.text.includes('Desktop summary')));
  assert.ok(messages.some((message) => message.kind === 'subagent'));
  assert.ok(messages.some((message) => message.kind === 'error'));
  assert.ok(messages[0].images.includes('image/png'));
  assert.doesNotMatch(JSON.stringify(messages), /SYNTHETIC-IMAGE/);
  assert.ok((await desktop.messages(entry, { withThinking: false })).every((message) => !message.thinking));
});

test('PI-Desktop previews imported origins with read-only metadata and no re-import', async () => {
  const root = await temporary();
  const file = await fixtureDb(root);
  const before = await digest(file);
  const sourceFile = path.join(root, 'sessions', 'desktop.jsonl');
  const sourceBefore = await digest(sourceFile);
  const entries = await desktop.scan(root);
  assert.equal(entries.length, 7);
  const entry = entries.find((entry) => entry.sessionId === 'desktop');
  assert.equal(entry.title, 'GUI renamed title');
  assert.equal(entry.nameKind, 'native');
  assert.equal(entry.workspacePath, 'D:/fixture-project');
  assert.equal(entry.modelId, 'gui-model');
  assert.equal(entry.visible, true);
  assert.equal(entries.find((entry) => entry.sessionId === 'generated').nameKind, 'generated');
  assert.equal(entries.find((entry) => entry.sessionId === 'empty').hiddenReason, 'empty');
  assert.equal(entries.find((entry) => entry.sessionId === 'deleted').hiddenReason, 'deleted');
  for (const id of ['imported', 'other-plugin', 'source-only']) {
    const imported = entries.find((entry) => entry.sessionId === id);
    assert.equal(imported.hiddenReason, null);
    assert.equal(imported.visible, true);
    assert.equal(imported.internal, false);
    assert.equal(imported.messageCount, 4);
    assert.equal(imported.firstPrompt, 'Desktop request');
    assert.equal(imported.importSource, null);
    assert.equal(imported.importable, false);
    const preview = await desktop.messages(imported);
    assert.ok(preview.some((message) => message.text === 'Desktop answer'));
    assert.deepEqual(await desktop.messages({ sessionId: id, sessionPath: imported.sessionPath }), preview);
    assert.deepEqual(await desktop.messages({ ...imported, internal: true }), preview);
  }
  const importedOrigin = entries.find((entry) => entry.sessionId === 'imported').importedFrom;
  const otherOrigin = entries.find((entry) => entry.sessionId === 'other-plugin').importedFrom;
  assert.deepEqual(importedOrigin, { pluginId: 'pi.session-import', plugin: 'pi.session-import', source: 'codex', externalId: 'external~rabc' });
  assert.equal(otherOrigin.pluginId, 'another-plugin');
  assert.equal(otherOrigin.plugin, 'another-plugin');
  assert.notEqual(otherOrigin.pluginId, importedOrigin.pluginId);
  const deleted = entries.find((entry) => entry.sessionId === 'deleted');
  assert.deepEqual(await desktop.messages(deleted), []);
  assert.deepEqual(await desktop.messages({ sessionId: deleted.sessionId, sessionPath: deleted.sessionPath }), []);
  assert.ok((await desktop.messages(entry)).length > 1);
  assert.equal(await digest(file), before);
  assert.equal(await digest(sourceFile), sourceBefore);
  assert.ok(!registry.importSources().has('pi-desktop'));
  assert.equal(registry.importSources().get('pi').id, 'pi');
});

test('PI-Desktop discovery and bounded scanning remain read-only', async () => {
  const home = await temporary();
  const root = path.join(home, '.pi-desktop');
  await fixtureDb(root);
  const found = await desktop.discover({ home, extraRoots: [root] });
  assert.deepEqual(found.map((item) => item.root), [root]);
  const entries = await desktop.scan(root, { maxFiles: 2, maxFileBytes: 4096 });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.importSource === null && !entry.importable));
});

test('PI-Desktop ignores revision sidecars and supports latest stored message', async () => {
  const root = await temporary();
  const source = await fs.readFile(fixture, 'utf8');
  const file = path.join(root, 'desktop.jsonl');
  await fs.writeFile(file, source);
  await fs.writeFile(path.join(root, 'desktop.revisions.jsonl'), source);
  await fs.appendFile(file, JSON.stringify({ type: 'message', id: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'Updated stored answer' }], createdAt: 1793494800010 }) + '\n{unfinished');
  const entries = await desktop.scan(root);
  assert.equal(entries.length, 1);
  const messages = await desktop.messages(entries[0]);
  assert.ok(messages.some((message) => message.text === 'Updated stored answer'));
  assert.ok(!messages.some((message) => message.text === 'Desktop answer'));
});

test('PI-Desktop normalizes header origin plugin names without hiding preview', async () => {
  const root = await temporary();
  const records = (await fs.readFile(fixture, 'utf8')).trim().split('\n').map(JSON.parse);
  const origins = [
    ['legacy', { plugin: 'legacy-importer', source: 'codex', externalId: 'shared-id' }, 'legacy-importer'],
    ['current', { pluginId: 'current-importer', source: 'codex', externalId: 'shared-id' }, 'current-importer'],
    ['both', { pluginId: 'current-importer', plugin: 'stale-importer', source: 'pi', externalId: 'shared-id' }, 'current-importer'],
  ];
  for (const [id, origin] of origins) {
    const copy = records.map((record) => record.type === 'session' ? { ...record, sessionId: id, importedFrom: origin } : record);
    await fs.writeFile(path.join(root, `${id}.jsonl`), copy.map(JSON.stringify).join('\n') + '\n');
  }
  const entries = await desktop.scan(root);
  for (const [id, , pluginId] of origins) {
    const entry = entries.find((entry) => entry.sessionId === id);
    assert.equal(entry.importedFrom.pluginId, pluginId);
    assert.equal(entry.importedFrom.plugin, pluginId);
    assert.equal(entry.importedFrom.externalId, 'shared-id');
    assert.equal(entry.visible, true);
    assert.equal(entry.hiddenReason, null);
    assert.equal(entry.importable, false);
    assert.equal(entry.importSource, null);
    assert.ok((await desktop.messages(entry)).some((message) => message.text === 'Desktop answer'));
  }
});
