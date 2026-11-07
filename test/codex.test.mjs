import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const codex = require('../lib/harnesses/codex');
const { cleanPath } = require('../lib/harnesses/_shared/codex-rollout');
const { readStateDb } = require('../lib/harnesses/_shared/codex-sqlite');
const { project } = require('../lib/import/project');
const scratch = process.env.PI_SCRATCH_DIR ?? path.resolve('../../fixtures');
await fs.mkdir(scratch, { recursive: true });
const fixture = await fs.mkdtemp(path.join(scratch, 'codex-test-'));
const home = path.join(fixture, 'home');
const root = path.join(home, '.codex');
await fs.mkdir(root, { recursive: true });
const ids = Array.from({ length: 12 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const [parent, child, grandchild, archived, guardian, empty, automation, missing, orphan, inheritedEmpty, metaChild, fork] = ids;
const start = Date.parse('2026-11-01T00:00:00Z');
const time = (n) => new Date(start + n * 1000).toISOString();
const record = (ordinal, type, payload, extra = {}) => ({ ordinal, timestamp: time(ordinal), type, payload, ...extra });
const meta = (sessionId, ordinal, extra = {}) => record(ordinal, 'session_meta', { id: sessionId, cwd: 'D:/project', timestamp: time(ordinal), source: 'vscode', ...extra });
const msg = (ordinal, role, text, id = `message-${ordinal}`) => record(ordinal, 'response_item', { type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
async function rollout(sessionId, rows, { segment = '', compressed = false, archive = false, stamp = '2026-11-01T00-00-00' } = {}) {
  const dir = path.join(root, archive ? 'archived_sessions' : 'sessions/2026/11/01');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${stamp}-${sessionId}${segment ? '_' + segment : ''}.jsonl${compressed ? '.zst' : ''}`);
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(file, compressed ? zstdCompressSync(Buffer.from(text)) : text);
  return file;
}
const firstPath = await rollout(parent, [
  meta(parent, 1),
  meta('foreign-parent', 2, { cwd: 'D:/wrong' }),
  msg(3, 'user', '# AGENTS.md for fixture'),
  msg(4, 'user', '<environment_context>injected</environment_context>'),
  msg(5, 'user', 'parent request'),
  msg(6, 'assistant', 'first segment answer'),
  record(7, 'response_item', { type: 'custom_tool_call', id: 'custom-1', call_id: 'exec-1', name: 'exec', input: 'console.log(1)' }),
  record(8, 'response_item', { type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text: 'reasoning summary' }], encrypted_content: 'SECRET_ENCRYPTED' }),
], { stamp: '2026-11-02T00-00-00' });
const lastPath = await rollout(parent, [
  meta(parent, 9),
  msg(10, 'assistant', 'first segment answer', 'message-6'),
  record(11, 'response_item', { type: 'custom_tool_call_output', id: 'custom-output', call_id: 'exec-1', output: [{ type: 'input_text', text: 'Exit code: 0\n1' }, { type: 'input_image', image_url: 'SECRET_IMAGE' }] }),
  record(12, 'response_item', { type: 'function_call', id: 'fc-1', call_id: 'fn-1', namespace: 'collaboration', name: 'spawn_agent', arguments: '{"task_name":"worker"}' }),
  record(13, 'response_item', { type: 'function_call_output', id: 'fo-1', call_id: 'fn-1', output: '{"task_name":"/root/worker"}' }),
  record(14, 'response_item', { type: 'tool_search_call', id: 'search-1', call_id: 'search', query: 'file tools' }),
  record(15, 'response_item', { type: 'tool_search_output', id: 'search-output', call_id: 'search', tools: [{ name: 'Read', description: 'do not import tool manifest' }, { function: { name: 'Glob' } }] }),
  record(16, 'response_item', { type: 'web_search_call', id: 'web-1', status: 'completed' }),
  record(17, 'response_item', { type: 'agent_message', id: 'agent-1', author: '/root/worker', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nPayload:\nchild conclusion' }] }),
  record(18, 'response_item', { type: 'agent_message', id: 'agent-2', author: '/root', recipient: '/root/worker', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK' }, { type: 'encrypted_content', encrypted_content: 'SECRET_TASK' }] }),
  record(19, 'response_item', { type: 'custom_tool_call', id: 'patch-1', call_id: 'patch', name: 'apply_patch', input: 'patch body' }),
  record(20, 'response_item', { type: 'custom_tool_call_output', id: 'patch-2', call_id: 'patch', output: 'Script failed: exit code: 2' }),
  record(21, 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', text: 'UI projection must not duplicate' } }),
  record(22, 'event_msg', { type: 'agent_message', message: 'final answer' }),
  msg(23, 'assistant', 'final answer'),
  record(24, 'turn_context', { model: 'gpt-test', effort: 'ultra' }),
  record(25, 'response_item', { type: 'function_call_output', id: 'orphan-output', call_id: 'orphan-call', output: 'unpaired result' }),
  record(26, 'response_item', { type: 'function_call', id: 'pending-call', call_id: 'pending', name: 'wait', arguments: '{}' }),
  record(27, 'response_item', { type: 'reasoning', id: 'encrypted-only', encrypted_content: 'SECRET_REASONING' }),
], { compressed: true, segment: ids[11] });
const childPath = await rollout(child, [
  meta(child, 30, { agent_path: '/root/worker', agent_nickname: 'Ada' }),
  meta(parent, 31, { cwd: 'D:/wrong-parent' }),
  { ...msg(32, 'user', 'INHERITED_PARENT'), metadata: { inherited_user_message: true } },
  { ...msg(33, 'assistant', 'INHERITED_ASSISTANT'), payload: { ...msg(33, 'assistant', 'INHERITED_ASSISTANT').payload, metadata: { inherited_user_message: true } } },
  msg(34, 'assistant', 'child own answer'),
]);
const grandPath = await rollout(grandchild, [meta(grandchild, 40, { parent_thread_id: child, agent_path: '/root/worker/nested' }), msg(41, 'assistant', 'nested own answer')], { compressed: true });
const archivedPath = await rollout(archived, [meta(archived, 50), msg(51, 'user', 'archive prompt')], { archive: true, compressed: true });
const guardianPath = await rollout(guardian, [meta(guardian, 60, { source: { subagent: { other: 'guardian' } } })], { compressed: true });
const emptyPath = await rollout(empty, [meta(empty, 70)]);
const automationPath = await rollout(automation, [meta(automation, 80), msg(81, 'user', 'scheduled request')]);
await rollout(orphan, [meta(orphan, 90), msg(91, 'user', 'orphan request'), msg(92, 'assistant', 'orphan last')], { compressed: true });
await rollout(inheritedEmpty, [meta(inheritedEmpty, 100), { ...msg(101, 'user', 'inherited only'), metadata: { inherited_user_message: true } }]);
const metaChildPath = await rollout(metaChild, [meta(metaChild, 110, { parent_thread_id: parent, agent_nickname: 'Emmy', agent_role: 'worker' }), msg(111, 'assistant', 'meta-linked answer')]);
const forkPath = await rollout(fork, [meta(fork, 120, { forked_from_id: parent }), msg(121, 'user', 'fork request')]);
await fs.writeFile(firstPath + '.backup-ignored', 'not a rollout');
await fs.mkdir(path.join(root, 'sqlite'), { recursive: true });
await fs.writeFile(path.join(root, 'sqlite/state_99.sqlite'), 'obsolete database must not be opened');
await fs.writeFile(path.join(root, 'state_4.sqlite'), 'older state must not be opened');
await fs.writeFile(path.join(root, 'auth.json'), 'credential fixture must not be opened');
await fs.writeFile(path.join(root, 'session_index.jsonl'), [
  { id: parent, thread_name: 'old name', updated_at: time(1) },
  { id: parent, thread_name: 'GUI renamed title', updated_at: time(2) },
].map(JSON.stringify).join('\n') + '\n');
const dbPath = path.join(root, 'state_5.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER, has_user_event INTEGER, source TEXT, thread_source TEXT, model TEXT, reasoning_effort TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)`);
const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
for (const [sid, file, source, kind, hasUser, isArchived] of [
  [parent, lastPath.slice(0, -4), 'vscode', 'user', 1, 0],
  [child, childPath, 'vscode', 'subagent', 0, 0],
  [grandchild, grandPath, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: child } } }), 'subagent', 0, 0],
  [archived, archivedPath.slice(0, -4), 'vscode', 'user', 1, 1],
  [guardian, guardianPath, JSON.stringify({ subagent: { other: 'guardian' } }), 'guardian_review', 0, 0],
  [empty, emptyPath, 'vscode', 'user', 0, 0],
  [automation, automationPath, 'exec', 'automation', 1, 0],
  [missing, path.join(root, 'absent.jsonl'), 'vscode', 'user', 1, 0],
  [metaChild, metaChildPath, 'vscode', 'subagent', 0, 0],
  [fork, forkPath, 'vscode', 'agent_forked_thread', 1, 0],
]) {
  const storedPath = process.platform === 'win32' ? String.fromCharCode(92, 92, 63, 92) + file : file;
  insert.run(sid, storedPath, sid === parent ? 'DB old name' : null, 'DB prompt title', hasUser ? 'DB first prompt' : '', 'D:/project', start, start + 1000, isArchived, hasUser, source, kind, 'state-model', 'ultra');
}
db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)').run(parent, child, 'closed');
db.close();
const entries = await codex.scan(root, { home });
const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));

test('discover combines default, environment and extra roots, deduplicating paths', async () => {
  const result = await codex.discover({ home, env: { CODEX_HOME: root }, extraRoots: [root, home, path.join(root, 'sessions')] });
  assert.equal(result.length, 1);
  assert.equal(result[0].root, await fs.realpath(root));
  assert.deepEqual(codex.capabilities, { import: true, nativeInHost: false, children: true });
});

test('state-first scan keeps hidden, missing, archive and orphan entries with GUI names', () => {
  assert.equal(entries.length, 12);
  assert.equal(byId.get(parent).title, 'GUI renamed title');
  assert.equal(byId.get(parent).key, `codex:${parent}`);
  assert.equal(byId.get(parent).segmentCount, 2);
  assert.deepEqual(byId.get(parent).segmentPaths, [firstPath, lastPath]);
  assert.equal(byId.get(parent).workspacePath, 'D:/project');
  assert.equal(byId.get(parent).reasoningEffort, 'ultra');
  assert.equal(byId.get(archived).hiddenReason, 'archived');
  assert.equal(byId.get(guardian).hiddenReason, 'internal');
  assert.equal(byId.get(empty).hiddenReason, 'empty');
  assert.equal(byId.get(child).hiddenReason, 'subagent');
  assert.equal(byId.get(inheritedEmpty).hiddenReason, 'empty');
  assert.equal(byId.get(automation).visible, true);
  assert.equal(byId.get(missing).missingRollout, true);
  assert.equal(byId.get(orphan).title, 'orphan request');
  assert.equal(byId.get(orphan).updatedAt, time(92));
  assert.equal(byId.get(fork).visible, true);
  assert.equal(byId.get(fork).parentSessionId, undefined);
  assert.ok(entries.every((entry) => entry.importSource === 'codex'));
  for (const sid of [missing, empty, guardian, inheritedEmpty]) assert.equal(byId.get(sid).importable, false);
  for (const sid of [parent, child, grandchild, archived, automation, orphan, metaChild, fork]) assert.equal(byId.get(sid).importable, true);
  assert.equal(byId.get(parent).childCount, 2);
  assert.equal(byId.get(child).parentSessionId, parent);
  assert.equal(byId.get(child).name, 'worker');
  assert.equal(byId.get(child).childCount, 1);
  assert.equal(byId.get(grandchild).parentSessionId, child);
  assert.equal(byId.get(metaChild).parentSessionId, parent);
});

test('extended Windows paths clean drive and UNC prefixes', () => {
  const slash = String.fromCharCode(92), prefix = slash + slash + '?' + slash;
  const drive = ['C:', 'Users', 'test', 'session.jsonl'].join(slash);
  const unc = ['server', 'share', 'session.jsonl'].join(slash);
  assert.equal(cleanPath(prefix + drive), drive);
  assert.equal(cleanPath(prefix + 'UNC' + slash + unc), slash + slash + unc);
});

test('merge segments and dedupe payload IDs; retain tools, reasoning and FINAL_ANSWER', async () => {
  const entry = { ...byId.get(parent), segmentPaths: [lastPath, firstPath] };
  const messages = await codex.messages(entry);
  assert.equal(messages.filter((m) => m.text === 'first segment answer').length, 1);
  assert.equal(messages.filter((m) => m.text === 'final answer').length, 1);
  const tools = new Map(messages.flatMap((m) => m.tools ?? []).map((tool) => [tool.id, tool]));
  assert.equal(tools.get('exec-1').args.input, 'console.log(1)');
  assert.equal(tools.get('exec-1').result, 'Exit code: 0\n1\n[image]');
  assert.equal(tools.get('exec-1').status, 'success');
  assert.equal(tools.get('fn-1').name, 'collaboration.spawn_agent');
  assert.equal(tools.get('search').result, 'Read\nGlob');
  assert.equal(tools.get('web-1').status, 'success');
  assert.equal(tools.get('patch').status, 'error');
  assert.equal(tools.get('pending').status, 'pending');
  assert.equal(tools.get('orphan-call').result, 'unpaired result');
  assert.ok(messages.some((m) => m.thinking?.includes('reasoning summary')));
  assert.ok(messages.some((m) => m.text.includes('FINAL_ANSWER') && m.text.includes('child conclusion')));
  assert.ok(messages.some((m) => m.children?.some((ref) => ref.sessionId === child)));
  assert.ok(messages.some((m) => m.children?.some((ref) => ref.sessionId === metaChild)));
  assert.ok(!JSON.stringify(messages).includes('SECRET_'));
  assert.ok(!JSON.stringify(messages).includes('UI projection'));
  assert.equal(entry.updatedAt, time(27));
  assert.equal(entry.modelId, 'gpt-test');
  assert.equal(entry.sessionId, parent);
  const noThinking = await codex.messages(entry, { withThinking: false });
  assert.ok(noThinking.every((m) => !m.thinking?.length));
  const projected = project(entry, messages, { subagentSummary: true, childSummaries: new Map([[child, 'optional summary text']]) });
  const body = JSON.stringify(projected.messages);
  assert.ok(body.includes('optional summary text'));
  assert.ok(body.includes('工具'));
  assert.ok(body.includes('reasoning summary'));
  assert.ok(projected.messages.every((m) => ['user', 'assistant'].includes(m.role) && !('toolCallId' in m)));
  assert.ok(!body.includes('# AGENTS.md'));
  assert.ok(!body.includes('<environment_context>'));
});

test('child reads its first meta only and skips inherited history', async () => {
  const messages = await codex.messages(byId.get(child));
  assert.ok(messages.some((m) => m.text === 'child own answer'));
  assert.ok(!JSON.stringify(messages).includes('INHERITED_'));
  assert.ok(messages.some((m) => m.children?.some((ref) => ref.sessionId === grandchild)));
  await assert.rejects(codex.messages(byId.get(missing)), { code: 'CODEX_ROLLOUT_MISSING' });
});

test('read-only SQLite queries and external helper preserve database bytes', async () => {
  const hash = async () => createHash('sha256').update(await fs.readFile(dbPath)).digest('hex');
  const before = await hash();
  const native = await readStateDb(dbPath);
  const external = await readStateDb(dbPath, { external: true });
  assert.deepEqual(JSON.parse(JSON.stringify(native)), external);
  assert.equal(await hash(), before);
  assert.equal(native.threads.length, 10);
  assert.equal(native.edges.length, 1);
  await assert.rejects(readStateDb(path.join(root, 'state_4.sqlite')));
});

test('older DB schema falls back to first-meta and complete file timestamps', async () => {
  const oldRoot = path.join(fixture, 'old-codex');
  await fs.mkdir(oldRoot);
  const oldDb = new DatabaseSync(path.join(oldRoot, 'state_2.sqlite'));
  oldDb.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT)');
  const oldPath = path.join(oldRoot, path.basename(firstPath));
  await fs.copyFile(firstPath, oldPath);
  oldDb.prepare('INSERT INTO threads VALUES(?,?,?)').run(parent, oldPath, 'legacy title');
  oldDb.close();
  const oldEntries = await codex.scan(oldRoot, { home });
  assert.equal(oldEntries.length, 1);
  assert.equal(oldEntries[0].visible, true);
  assert.equal(oldEntries[0].updatedAt, time(8));
  assert.equal(oldEntries[0].firstPrompt, 'parent request');
  assert.notEqual(oldEntries[0].key, byId.get(parent).key);
  assert.notEqual(oldEntries[0].externalId, byId.get(parent).externalId);
});

test('discover recognizes an old custom home without state DB or index', async () => {
  const custom = path.join(fixture, 'account');
  await fs.mkdir(path.join(custom, 'archived_sessions'), { recursive: true });
  await fs.copyFile(archivedPath, path.join(custom, 'archived_sessions', path.basename(archivedPath)));
  const result = await codex.discover({ home, env: {}, extraRoots: [custom] });
  assert.equal(result.length, 2);
  assert.ok(result.some((hit) => hit.root === custom));
});

test('bad compressed rollout remains indexed with error metadata and fails reading', async () => {
  const corruptRoot = path.join(fixture, 'corrupt-codex');
  await fs.mkdir(path.join(corruptRoot, 'sessions'), { recursive: true });
  const file = path.join(corruptRoot, 'sessions', `rollout-2026-11-01T00-00-00-${parent}.jsonl.zst`);
  await fs.writeFile(file, 'bad frame');
  const reports = [];
  const scanned = await codex.scan(corruptRoot, { report: (sid, error) => reports.push([sid, error.code]) });
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].sessionId, parent);
  assert.equal(scanned[0].readErrors.length, 1);
  assert.equal(reports.length, 1);
  await assert.rejects(codex.messages(scanned[0]), { code: 'ZSTD_INVALID_FRAME' });
});

test('child references appear once when several agent reports mention the same child', async () => {
  const messages = await codex.messages(byId.get(parent));
  const refs = messages.flatMap((message) => message.children ?? []);
  assert.equal(refs.filter((ref) => ref.sessionId === child).length, 1);
});
