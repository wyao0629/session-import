import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fixture, put, jsonl, database, ms } from './fixtures/other/helpers.mjs';
const require = createRequire(import.meta.url);
const { loadCustomSources } = require('../lib/custom-sources');
const { registry } = require('../lib/registry');
const main = require('../main');
const mainPath = fileURLToPath(new URL('../main.js', import.meta.url));

test('review: missing workspace isolates relative file and database sources', async () => {
  const root = await fixture('review-paths');
  const sources = [
    { id: 'relative-file', label: 'Relative', driver: 'jsonl-transcript', root: 'sessions' },
    { id: 'relative-db', label: 'DB', driver: 'sqlite-session', db: 'sessions.db' },
    { id: 'absolute-file', label: 'Absolute', driver: 'jsonl-transcript', root },
  ];
  const loaded = await loadCustomSources({ readText: async () => JSON.stringify(sources) });
  assert.deepEqual(loaded.specs.map(s => s.id), ['absolute-file']);
  assert.equal(loaded.errors.length, 2);
  assert.ok(loaded.errors.every(error => /relative path requires an active workspace/.test(error)));
});

test('review: host startup and reload resolve paths and preserve archived page summaries', async (t) => {
  const root = await fixture('review-lifecycle');
  for (const archived of [false, true]) {
    await put(root, `sessions/${archived ? 'archived' : 'active'}.jsonl`, jsonl([
      { role: 'user', content: 'fixture question', archived },
      { role: 'assistant', content: 'fixture answer' },
    ]));
  }
  await database(root, 'sessions.db', 'CREATE TABLE session(id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,role TEXT,content TEXT,time_created INTEGER,sequence INTEGER)', db => {
    for (const archived of [false, true]) {
      const id = archived ? 'archived' : 'active';
      db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(id, id, ms, ms, archived ? ms : null);
      db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?)').run(id, id, 'user', 'fixture question', ms, 0);
    }
  });
  const specs = [
    { id: 'review-files', label: 'Files', driver: 'jsonl-transcript', root: 'sessions', session: { archivedFrom: 'archived' }, entry: { rolePath: 'role', content: 'content' } },
    { id: 'review-db', label: 'DB', driver: 'sqlite-session', db: 'sessions.db', message: { roleCol: 'role', contentCol: 'content' } },
  ];
  let workspace = { path: root }, workspaceReads = 0;
  const previousPi = global.pi;
  global.pi = {
    commands: { register: async () => {}, unregister: async () => {} },
    plugin: { getDataPath: async () => path.join(root, 'plugin-data'), getSettings: async () => ({ 'session-import.enabledHarnesses': 'review-files,review-db', 'session-import.autoSyncEnabled': false }) },
    workspace: { get: async () => { workspaceReads++; return workspace; } },
    fs: { readText: async () => JSON.stringify(specs) },
    agent: { registerTool: async () => {}, unregisterTool: async () => {} },
  };
  t.after(async () => { await main.onUnload(); global.pi = previousPi; });
  await main.onLoad();
  assert.equal((await main.onPanelInvoke('import.customSources')).count, 2);
  assert.equal(registry.get('review-files').dataPath, path.join(root, 'sessions'));
  assert.equal(registry.get('review-db').dataPath, path.join(root, 'sessions.db'));
  for (const source of ['review-files', 'review-db']) {
    const count = await main.onPanelInvoke('import.scanSource', { source });
    assert.equal(count.count, 1, source);
    assert.equal(count.archived, 1, source);
    const active = await main.onPanelInvoke('import.sessions', { source });
    const all = await main.onPanelInvoke('import.sessions', { source, includeArchived: true });
    assert.equal(active.sessions.length, 1, source);
    assert.equal(all.sessions.length, 2, source);
    assert.equal(all.sessions.find(s => s.sessionId === 'archived').archived, true, source);
    assert.equal(all.sessions.find(s => s.sessionId === 'active').archived, false, source);
  }
  assert.deepEqual((await main.onPanelInvoke('import.reloadCustomSources')).errors, []);
  assert.equal(workspaceReads, 2);
  workspace = null;
  specs[0].root = path.join(root, 'sessions');
  const reloaded = await main.onPanelInvoke('import.reloadCustomSources');
  assert.equal(reloaded.count, 1);
  assert.equal(reloaded.errors.length, 1);
  assert.match(reloaded.errors[0], /relative path requires an active workspace/);
  assert.ok(registry.get('review-files'));
  assert.equal(registry.get('review-db'), undefined);
});

test('review: host provenance matches exact native IDs and only confirmed copy markers', async () => {
  const source = await fs.readFile(mainPath, 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source + '\nmodule.exports.check = (entry, rows, markers = []) => { hub = { entries: () => rows }; imported.clear(); markers.forEach(key => imported.add(key)); return isImported(entry); };', { require: createRequire(mainPath), module, console });
  const check = module.exports.check;
  const entry = id => ({ importSource: 'codex', externalId: id, sessionId: id });
  const provenance = (id, pluginId = 'pi.session-import') => ({ harness: 'pi-desktop', importedFrom: { pluginId, source: 'session-import.codex', externalId: id } });
  const suffix = '~r' + 'a'.repeat(32);
  assert.equal(check(entry('native'), [provenance('native' + suffix)]), false);
  assert.equal(check(entry('native' + suffix), [provenance('native' + suffix)]), true);
  assert.equal(check(entry('native~rabc'), [provenance('native~rabc')]), true);
  assert.equal(check(entry('native'), [provenance('native', 'io.github.muzimu217.session-import')]), false);
  assert.equal(check(entry('native'), [provenance('native' + suffix)], ['session-import.codex:native']), true);
});

test('review: hub validates every segment before parsing, including compressed fallback', async (t) => {
  const { assertInsideRoots, loadMessages } = require('../lib/hub/reader');
  const root = await fixture('review-segments');
  const inside = path.join(root, 'allowed'), outside = path.join(root, 'allowed-other');
  const primary = await put(inside, 'new.jsonl', 'fixture');
  const older = await put(outside, 'old.jsonl', 'fixture');
  const compressed = await put(inside, 'packed.jsonl.zst', 'fixture');
  const compressedOutside = await put(outside, 'packed.jsonl.zst', 'fixture');
  let calls = 0;
  t.mock.method(registry.get('codex'), 'messages', async (_entry, options) => { calls++; assert.deepEqual(options.roots, [inside]); return []; });
  const entry = { harness: 'codex', sessionPath: primary, segmentPaths: [older, primary] };
  await assert.rejects(() => loadMessages(entry, { roots: [inside] }), /已拒绝读取/);
  await assert.rejects(() => assertInsideRoots({ ...entry, segmentPaths: [compressedOutside.slice(0, -4), primary] }, [inside]), /已拒绝读取/);
  assert.equal(calls, 0);
  const valid = { ...entry, sessionPath: compressed.slice(0, -4), segmentPaths: [primary, compressed.slice(0, -4)] };
  assert.equal(await assertInsideRoots(valid, [inside]), await fs.realpath(compressed));
  await loadMessages(valid, { roots: [inside] });
  assert.equal(calls, 1);
});
