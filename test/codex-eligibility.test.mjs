import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const codex = require('../lib/harnesses/codex');
const { readCatalogDb } = require('../lib/harnesses/_shared/codex-sqlite');
const scratch = process.env.PI_SCRATCH_DIR ?? path.resolve('../../fixtures');
await fs.mkdir(scratch, { recursive: true });
const root = await fs.mkdtemp(path.join(scratch, 'codex-eligibility-'));
await fs.mkdir(path.join(root, 'sessions'));
await fs.mkdir(path.join(root, 'sqlite'));
const ids = Array.from({ length: 11 }, (_, i) => `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const [normal, automation, archived, child, guardian, injected, whitespace, inheritedOnly, toolOnly, encryptedOnly, missing] = ids;
const stamp = '2026-11-07T00:00:00.000Z';
const row = (type, payload, extra = {}) => ({ type, payload, timestamp: stamp, ...extra });
const message = (role, text) => row('response_item', { type: 'message', role, content: [{ type: 'input_text', text }] });
const payloads = new Map([
  [normal, [message('user', 'real request')]],
  [automation, [row('event_msg', { type: 'user_message', message: 'scheduled user request' })]],
  [archived, [message('user', 'archived request')]],
  [child, [message('assistant', 'meaningful child conclusion')]],
  [guardian, [message('assistant', 'review conclusion')]],
  [injected, [message('user', '# AGENTS.md instructions'), message('developer', 'developer instructions')]],
  [whitespace, [message('assistant', '  '), message('user', '  ')]],
  [inheritedOnly, [{ ...message('user', 'parent request'), metadata: { inherited_user_message: true } }]],
  [toolOnly, [row('response_item', { type: 'custom_tool_call', id: 'tool', name: 'exec', input: 'work' })]],
  [encryptedOnly, [row('response_item', { type: 'agent_message', author: '/root', recipient: '/root/worker', content: [{ type: 'encrypted_content', encrypted_content: 'unreadable' }] }), row('response_item', { type: 'reasoning', encrypted_content: 'unreadable' })]],
]);
const statePath = path.join(root, 'state_5.sqlite');
const db = new DatabaseSync(statePath);
db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,rollout_path TEXT,archived INTEGER,has_user_event INTEGER,source TEXT,thread_source TEXT,updated_at_ms INTEGER,name TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT)');
const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)');
for (const sid of ids) {
  const file = path.join(root, 'sessions', `rollout-2026-11-07T00-00-00-${sid}.jsonl`);
  if (sid !== missing) {
    const meta = row('session_meta', { id: sid, timestamp: stamp, ...(sid === child || sid === toolOnly ? { parent_thread_id: normal } : {}) });
    await fs.writeFile(file, [meta, ...payloads.get(sid)].map(JSON.stringify).join(String.fromCharCode(10)) + String.fromCharCode(10));
  }
  insert.run(sid, file, sid === archived ? 1 : 0, 0, sid === guardian ? '{"subagent":{"other":"guardian"}}' : 'vscode', sid === automation ? 'automation' : sid === child || sid === toolOnly ? 'subagent' : 'user', Date.parse(stamp), 'state title');
}
db.close();
await fs.writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ id: normal, thread_name: 'older index title' }) + String.fromCharCode(10));

test('without GUI catalog, real user events override drifted zero flags; empty stays indexed but cannot import', async () => {
  const entries = await codex.scan(root);
  const byId = new Map(entries.map((e) => [e.sessionId, e]));
  assert.equal(entries.length, ids.length);
  assert.deepEqual(entries.filter((e) => e.visible).map((e) => e.sessionId).sort(), [normal, automation].sort());
  for (const sid of [injected, whitespace, inheritedOnly, encryptedOnly, missing]) {
    assert.equal(byId.get(sid).importable, false, sid);
    if (sid !== missing) assert.deepEqual(await codex.messages(byId.get(sid)), []);
  }
  for (const sid of [normal, automation, child, toolOnly, guardian, archived]) assert.equal(byId.get(sid).importable, true, sid);
  assert.equal(byId.get(child).parentSessionId, normal);
  assert.equal(byId.get(child).visible, false);
  assert.equal(byId.get(archived).hiddenReason, 'archived');
  assert.equal(byId.get(guardian).hiddenReason, 'internal');
  assert.equal(byId.get(normal).visibilitySource, 'rollout-user-event');
  assert.equal(byId.get(normal).stateHasUserEvent, 0);
});

test('local catalog is authoritative for GUI visibility and title, with archived/internal exclusions', async () => {
  const catalogPath = path.join(root, 'sqlite/codex.db');
  const catalog = new DatabaseSync(catalogPath);
  catalog.exec('CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,display_title TEXT,missing_candidate INTEGER)');
  const put = catalog.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?,?)');
  for (const sid of [normal, automation, archived, child, guardian, whitespace]) put.run('local', sid, 'GUI title ' + sid, 0);
  put.run('remote', toolOnly, 'remote title', 0);
  put.run('local', inheritedOnly, 'missing candidate', 1);
  catalog.close();
  const metadata = await readCatalogDb(catalogPath);
  assert.equal(metadata.threads.length, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), await readCatalogDb(catalogPath, { external: true }));
  const entries = await codex.scan(root);
  const byId = new Map(entries.map((e) => [e.sessionId, e]));
  assert.deepEqual(entries.filter((e) => e.visible).map((e) => e.sessionId).sort(), [normal, automation, whitespace].sort());
  assert.equal(byId.get(normal).name, 'GUI title ' + normal);
  assert.equal(byId.get(normal).visibilitySource, 'gui-catalog');
  assert.equal(byId.get(whitespace).visible, true);
  assert.equal(byId.get(whitespace).importable, false);
  assert.equal(byId.get(archived).hiddenReason, 'archived');
  assert.equal(byId.get(child).hiddenReason, 'subagent');
  assert.equal(byId.get(guardian).hiddenReason, 'internal');
  assert.equal(byId.get(toolOnly).importable, true);

  const original = nativeFs.createReadStream;
  let rolloutReads = 0;
  nativeFs.createReadStream = (file, ...args) => {
    if (path.basename(String(file)).startsWith('rollout-')) rolloutReads++;
    return original(file, ...args);
  };
  try {
    const previous = new Map(JSON.parse(JSON.stringify(entries)).map((e) => [e.sessionId, e]));
    const cached = await codex.scan(root, { previous });
    assert.equal(rolloutReads, 0, 'unchanged fingerprints reuse serializable eligibility evidence');
    assert.equal(cached.find((e) => e.sessionId === injected).importable, false);
    const injectedFile = byId.get(injected).segmentPaths[0];
    await fs.appendFile(injectedFile, JSON.stringify(message('assistant', 'new real answer')) + String.fromCharCode(10));
    const changed = await codex.scan(root, { previous });
    assert.equal(rolloutReads, 1, 'only changed rollout is parsed again');
    assert.equal(changed.find((e) => e.sessionId === injected).importable, true);
    assert.equal(changed.find((e) => e.sessionId === injected).visible, false);
    const messageReadsBefore = rolloutReads;
    await codex.messages(changed.find((e) => e.sessionId === injected));
    assert.equal(rolloutReads - messageReadsBefore, 1, 'messages reuse scanned header and read body once');
  } finally { nativeFs.createReadStream = original; }
});
