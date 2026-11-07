import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const code = require('../lib/harnesses/kimi-code');
const desktop = require('../lib/harnesses/kimi-desktop');
const legacy = require('../lib/harnesses/kimi-legacy');
const { project } = require('../lib/import/project');
const { modernMessages, legacyMessages } = require('../lib/harnesses/_shared/kimi-wire');
const fixtures = process.env.PI_SCRATCH_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
fs.mkdirSync(fixtures, { recursive: true });
const base = fs.mkdtempSync(path.join(fixtures, 'kimi-fixtures-'));
const NL = String.fromCharCode(10);
const T = 1794000000000;
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
function json(file, value) { return write(file, JSON.stringify(value)); }
function wire(file, values) { return write(file, values.map(value => JSON.stringify(value)).join(NL) + NL); }
const user = (text, extra = {}) => ({ type: 'context.append_message', time: T, message: { role: 'user', content: text, origin: { kind: 'user' }, ...extra } });
const prompt = (id, text) => ({ type: 'turn.prompt', time: T, turnId: id, input: text, origin: { kind: 'user' } });
const loop = event => ({ type: 'context.append_loop_event', time: T + 10, event });
const ama = (message, origin = { kind: 'user' }) => ({ type: 'agent.message.appended', time: T + 20, message: { message, meta: { source: 'input', origin } } });
const answer = text => loop({ type: 'content.part', stepUuid: 'step', part: { type: 'text', text } });
function session(root, id, state = {}, events = [prompt(0, 'question'), user('question'), answer('answer')], group = 'wd_live') {
  const dir = path.join(root, 'sessions', group, id);
  json(path.join(dir, 'state.json'), { createdAt: T, ...state });
  wire(path.join(dir, 'agents/main/wire.jsonl'), events);
  return dir;
}

test('cam plus loop is authoritative; UUID pairing, errors, thinking and user origins survive', async () => {
  const file = wire(path.join(base, 'modern.jsonl'), [
    prompt(0, 'raw question'),
    user('expanded attachment', { origin: { kind: 'user', clientMetadata: [{ display_text: 'display question' }] } }),
    user('internal notification', { origin: { kind: 'injection' } }),
    user('unknown origin', { origin: undefined }),
    ama({ role: 'user', content: 'mirrored question' }),
    loop({ type: 'content.part', stepUuid: 's1', part: { type: 'think', think: 'reasoning' } }),
    loop({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'answer' } }),
    loop({ type: 'tool.call', stepUuid: 's1', uuid: 'uuid1', toolCallId: 'reused', name: 'Read', args: { path: 'a' } }),
    loop({ type: 'tool.call', stepUuid: 's1', uuid: 'uuid2', toolCallId: 'reused', name: 'Read', args: { path: 'b' } }),
    loop({ type: 'tool.result', parentUuid: 'uuid1', toolCallId: 'reused', result: { output: 'first error', isError: true } }),
    loop({ type: 'tool.result', parentUuid: 'uuid2', toolCallId: 'reused', result: { output: 'second result' } }),
    loop({ type: 'tool.result', parentUuid: 'uuid2', result: { output: 'duplicate result' } }),
    loop({ type: 'tool.call', stepUuid: 's1', uuid: 'pending', name: 'Shell', args: {} }),
    ama({ role: 'assistant', content: 'duplicate answer' }),
  ]);
  const messages = await modernMessages(file);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, 'display question');
  assert.deepEqual(messages[1].thinking, ['reasoning']);
  assert.equal(messages[1].text, 'answer');
  assert.deepEqual(messages[1].tools.map(tool => [tool.result, tool.status]), [['first error', 'error'], ['second result', 'success'], [undefined, 'pending']]);
  assert.equal(messages[1].tools[0].isError, true);
  assert.ok(messages.every(message => message.kind === 'normal' && message.createdAt));
  assert.ok((await modernMessages(file, { withThinking: false })).every(message => !message.thinking));
  const projected = project({ sessionId: 'test', title: 'title', createdAt: new Date(T).toISOString() }, messages);
  const output = projected.messages.map(message => message.text).join(NL);
  for (const text of ['reasoning', 'first error', 'second result', 'display question']) assert.ok(output.includes(text));
  assert.ok(!output.includes('internal notification') && !output.includes('duplicate answer'));
  assert.ok(projected.messages.every(message => ['user', 'assistant'].includes(message.role) && !message.toolCalls));
});

test('ama-only and mixed-version turns fall back without losing tool results', async () => {
  const file = wire(path.join(base, 'ama.jsonl'), [
    prompt(0, 'question'), user('question'), answer('modern answer'),
    prompt(1, 'older question'),
    ama({ role: 'user', content: 'older question' }),
    ama({ role: 'user', content: 'notification' }, { kind: 'system_trigger' }),
    ama({ role: 'assistant', content: [{ type: 'think', think: 'older thought' }], toolCalls: [{ id: 'old', name: 'Shell', arguments: '{"command":"echo test"}' }] }),
    ama({ role: 'tool', toolCallId: 'old', content: 'old result' }),
  ]);
  const messages = await modernMessages(file);
  assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.text), ['question', 'older question']);
  assert.equal(messages.at(-1).tools[0].result, 'old result');
  assert.deepEqual(messages.at(-1).tools[0].args, { command: 'echo test' });
  assert.deepEqual(messages.at(-1).thinking, ['older thought']);
});

test('undo removes the base line and applies the three-record undo sequence once', async () => {
  const events = [prompt(0, 'keep'), user('keep'), answer('keep answer'), prompt(1, 'discard'), user('discard'), answer('discard answer')];
  events.push({ type: 'agent.switched', reason: 'undo', base: { branch: 'main', line: 4 }, turns: 1 }, { type: 'context.undo', count: 1 }, { type: 'context.undone', turns: 1, fromTurnId: 1 }, prompt(1, 'replacement'), user('replacement'), answer('replacement answer'));
  const messages = await modernMessages(wire(path.join(base, 'undo.jsonl'), events));
  assert.deepEqual(messages.map(message => message.text), ['keep', 'keep answer', 'replacement', 'replacement answer']);
  const standalone = await modernMessages(wire(path.join(base, 'undo-count.jsonl'), [...events.slice(0, 6), { type: 'context.undo', count: 1 }, { type: 'context.undone', turns: 1, fromTurnId: 1 }]));
  assert.deepEqual(standalone.map(message => message.text), ['keep', 'keep answer']);
});

test('discovery, sidebar naming, visibility and root-qualified identities', async () => {
  const home = path.join(base, 'home'), root = path.join(home, '.kimi-code');
  const a = session(root, 'same-id-long-123', { title: 'GUI title', titleKind: 'custom', archived: true, agents: { main: { type: 'main' }, 'agent-1': { type: 'sub', parentAgentId: 'main' } } });
  wire(path.join(a, 'agents/agent-1/wire.jsonl'), [loop({ type: 'content.part', part: { type: 'text', text: 'child answer' } })]);
  session(root, 'fallback-long-123', { lastPrompt: 'last prompt' });
  session(root, 'empty-title', { title: '', lastPrompt: 'do not use' });
  session(root, 'id-fallback-long-123');
  session(root, 'empty', {}, []);
  session(root, 'ctitle-helper');
  session(root, 'fork', { forkedFrom: 'same-id-long-123' });
  session(root, 'deleted-session');
  session(root, 'deleted-project', {}, undefined, 'wd_deleted');
  json(path.join(root, 'projects.json'), { projects: { wd_live: { name: 'Live', root: '/project' } }, deleted_project_ids: ['wd_deleted'] });
  wire(path.join(root, 'session_index.jsonl'), [{ sessionId: 'deleted-session', deleted: false }, { sessionId: 'deleted-session', deleted: true }, { sessionId: 'missing', sessionDir: 'sessions/wd_live/missing' }]);
  const other = path.join(base, 'other-root'); session(other, 'same-id-long-123');
  const fake = path.join(home, '.codex'); fs.mkdirSync(path.join(fake, 'sessions'), { recursive: true }); wire(path.join(fake, 'session_index.jsonl'), []);
  const found = await code.discover({ home, env: { KIMI_CODE_HOME: root }, extraRoots: [other, fake, root] });
  assert.equal(found.length, 2);
  const entries = await code.scan(root), byId = new Map(entries.map(entry => [entry.nativeSessionId, entry]));
  assert.equal(byId.get('same-id-long-123').title, 'GUI title');
  assert.equal(byId.get('same-id-long-123').visible, true);
  assert.equal(byId.get('same-id-long-123').childCount, 2);
  assert.equal(byId.get('fallback-long-123').title, 'last prompt');
  assert.equal(byId.get('empty-title').title, '');
  assert.equal(byId.get('id-fallback-long-123').title, 'id-fallback-');
  for (const [id, reason] of [['empty', 'empty'], ['ctitle-helper', 'internal'], ['fork', 'subagent'], ['deleted-session', 'deleted'], ['deleted-project', 'deleted']]) {
    assert.equal(byId.get(id).hiddenReason, reason); assert.equal(byId.get(id).visible, false);
  }
  assert.equal(byId.get('fork').parentSessionId, byId.get('same-id-long-123').sessionId);
  assert.equal(byId.get('same-id-long-123/agent-1').hiddenReason, 'subagent');
  assert.equal((await code.messages(byId.get('same-id-long-123/agent-1')))[0].text, 'child answer');
  assert.equal(byId.get('deleted-session').importable, false);
  assert.equal(byId.get('same-id-long-123').importable, true);
  assert.equal(byId.has('missing'), false);
  for (const entry of entries) assert.equal(entry.key, `${entry.harness}:${entry.sessionId}`);
  assert.notEqual((await code.scan(other))[0].key, byId.get('same-id-long-123').key);
});

test('desktop discovers multiple nested runtimes and reads SQLite titles without writes', async () => {
  const appdata = path.join(base, 'appdata');
  const share = path.join(appdata, 'kimi-desktop/daimon-share');
  const root = path.join(share, 'daimon/runtime/kimi-code/home');
  const second = path.join(share, 'another/profile/runtime/kimi-code/home');
  const dir = session(root, 'conv-visible', { title: '<meta>expanded internal prompt</meta>' });
  session(root, 'ctitle-generated'); session(second, 'conv-second');
  const dbFile = path.join(share, 'daimon/agents/main/sessions/hosted-logical/conversations.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations (kernel_session_id TEXT, kernel_session_dir TEXT, kernel_records_path TEXT, title TEXT, title_status TEXT, first_user_text TEXT, workspace_path TEXT, created_at TEXT)');
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('conv-visible', dir, path.join(dir, 'agents/main/wire.jsonl'), 'Sidebar title', 'generated', 'first question', '/desktop/project', '2026-11-06T10:00:00Z');
  db.close();
  const before = createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
  const found = await desktop.discover({ home: path.join(base, 'no-home'), env: { APPDATA: appdata } });
  assert.equal(found.length, 2);
  const entries = await desktop.scan(root);
  const entry = entries.find(item => item.nativeSessionId === 'conv-visible');
  assert.equal(entry.title, 'Sidebar title'); assert.equal(entry.nameKind, 'generated');
  assert.equal(entry.workspacePath, '/desktop/project');
  assert.equal(entry.createdAt, '2026-11-06T10:00:00.000Z');
  assert.equal(entry.visible, true); assert.equal(entry.importSource, 'kimi-desktop');
  assert.equal(entries.find(item => item.nativeSessionId.startsWith('ctitle-')).visible, false);
  assert.equal(createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex'), before);
  assert.equal((await desktop.scan(second)).find(item => item.nativeSessionId === 'conv-second').title, 'conv-second');
});

test('legacy wire timestamps, streamed tool args and errors take priority over context', async () => {
  const root = path.join(base, 'legacy-home/.kimi'), dir = path.join(root, 'sessions/hash/old');
  const events = [
    { type: 'TurnBegin', payload: { user_input: '<git-context>context</git-context>actual prompt' } },
    { type: 'StepBegin', payload: { n: 1 } },
    { type: 'ContentPart', payload: { type: 'think', think: 'legacy thought' } },
    { type: 'ToolCall', payload: { id: 't', function: { name: 'Shell', arguments: '' } } },
    { type: 'ToolCallPart', payload: { arguments_part: '{"command":"test"}' } },
    { type: 'ToolResult', payload: { tool_call_id: 't', return_value: { output: 'legacy error', is_error: true } } },
    { type: 'ContentPart', payload: { type: 'text', text: 'legacy answer' } },
  ].map(message => ({ timestamp: T / 1000, message }));
  wire(path.join(dir, 'wire.jsonl'), events);
  wire(path.join(dir, 'context.jsonl'), [{ role: 'user', content: 'duplicate context' }]);
  json(path.join(dir, 'state.json'), { custom_title: 'Legacy GUI' });
  wire(path.join(dir, 'subagents/child/context.jsonl'), [{ role: 'assistant', content: 'legacy child answer' }]);
  const fallback = path.join(root, 'sessions/hash/context-only');
  wire(path.join(fallback, 'context.jsonl'), [{ role: '_system_prompt', content: 'ignore' }, { role: 'user', content: 'context prompt' }, { role: 'assistant', content: [{ type: 'think', think: 'context thought' }, { type: 'text', text: 'context answer' }], tool_calls: [{ id: 'f', function: { name: 'Read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'f', content: 'fallback result' }]);
  wire(path.join(root, 'sessions/hash/empty/context.jsonl'), [{ role: '_checkpoint', id: 0 }]);
  assert.equal((await legacy.discover({ home: path.dirname(root), env: {} })).length, 1);
  const entries = await legacy.scan(root);
  const entry = entries.find(item => item.nativeSessionId === 'old');
  assert.equal(entry.title, 'Legacy GUI');
  const messages = await legacy.messages(entry);
  assert.equal(messages[0].text, 'actual prompt');
  assert.equal(messages[0].createdAt, new Date(T).toISOString());
  assert.deepEqual(messages[1].thinking, ['legacy thought']);
  assert.equal(messages[1].tools[0].isError, true);
  assert.deepEqual(messages[1].tools[0].args, { command: 'test' });
  const contextEntry = entries.find(item => item.nativeSessionId === 'context-only');
  const contextMessages = await legacy.messages(contextEntry);
  assert.equal(contextMessages[1].tools[0].result, 'fallback result');
  assert.ok(contextMessages.every(message => message.createdAt));
  assert.equal(contextEntry.timestampSource, 'filesystem');
  assert.equal(entries.find(item => item.nativeSessionId === 'empty').visible, false);
  const child = entries.find(item => item.agentId === 'child');
  assert.equal(child.parentSessionId, entry.sessionId);
  assert.equal(child.visible, false);
  assert.equal(entry.childCount, 1);
  assert.equal((await legacy.messages(child))[0].text, 'legacy child answer');
});

test('incomplete last JSON record is deferred; malformed completed records fail without body disclosure', async () => {
  const valid = JSON.stringify(user('complete'));
  const partial = write(path.join(base, 'partial.jsonl'), valid + NL + '{"partial":');
  assert.equal((await modernMessages(partial)).length, 1);
  const bad = write(path.join(base, 'bad.jsonl'), valid + NL + 'private-invalid-record' + NL);
  await assert.rejects(modernMessages(bad), error => error.message.includes(':2') && !error.message.includes('private-invalid-record'));
});

test('metadata nullish title fallback ignores first_user_text and respects records paths', async () => {
  const share = path.join(base, 'title-cases/kimi-desktop/daimon-share');
  const root = path.join(share, 'daimon/runtime/kimi-code/home');
  const dbFile = path.join(share, 'daimon/agents/main/sessions/hosted-logical/conversations.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations (kernel_session_id TEXT, kernel_session_dir TEXT, kernel_records_path TEXT, title TEXT, lastPrompt TEXT, first_user_text TEXT)');
  const insert = db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, title, lastPrompt, state] of [['conv-null-long-id', null, null, {}], ['conv-prompt', null, 'last display', {}], ['conv-empty', '', 'ignored', {}], ['conv-state', null, null, { lastPrompt: 'state display' }]]) {
    const dir = session(root, id, state);
    const records = wire(path.join(dir, 'agents/main/alternate.jsonl'), [user('alternate records')]);
    insert.run(id, path.relative(path.dirname(dbFile), dir), path.relative(path.dirname(dbFile), records), title, lastPrompt, 'do not use first text');
  }
  db.close();
  const entries = await desktop.scan(root);
  const byId = new Map(entries.map(entry => [entry.nativeSessionId, entry]));
  assert.equal(byId.get('conv-null-long-id').title, 'conv-null-lo');
  assert.equal(byId.get('conv-prompt').title, 'last display');
  assert.equal(byId.get('conv-empty').title, '');
  assert.equal(byId.get('conv-state').title, 'state display');
  assert.equal((await desktop.messages(byId.get('conv-null-long-id')))[0].text, 'alternate records');
});

test('ama tool fallback supplements cam assistants; origin and ama undo remain strict', async () => {
  const file = wire(path.join(base, 'cam-ama.jsonl'), [
    prompt(0, 'question'), user('question'),
    { type: 'context.append_message', time: T, message: { role: 'assistant', toolCalls: [{ id: 'mix', name: 'Read', arguments: '{}' }] } },
    ama({ role: 'tool', toolCallId: 'mix', content: 'ama result' }),
  ]);
  assert.equal((await modernMessages(file))[1].tools[0].result, 'ama result');
  const undo = wire(path.join(base, 'ama-undo.jsonl'), [ama({ role: 'user', content: 'retained' }), ama({ role: 'assistant', content: 'answer' }), ama({ role: 'user', content: 'removed' }), { type: 'context.undo', count: 1 }, { type: 'context.undone', turns: 1 }]);
  assert.deepEqual((await modernMessages(undo)).map(message => message.text), ['retained', 'answer']);
  const legacyFile = wire(path.join(base, 'legacy-origin.jsonl'), [{ timestamp: T / 1000, message: { type: 'TurnBegin', payload: { user_input: 'injected', origin: { kind: 'injection' } } } }]);
  assert.deepEqual(await legacyMessages(legacyFile, path.join(base, 'absent-context')), []);
});

test('empty modern and legacy children remain indexed but cannot be imported', async () => {
  const modernRoot = path.join(base, 'empty-child-modern');
  const modernDir = session(modernRoot, 'parent', { agents: { main: { type: 'main' }, empty: { type: 'sub', parentAgentId: 'main' } } });
  wire(path.join(modernDir, 'agents/empty/wire.jsonl'), []);
  const modernEntries = await code.scan(modernRoot);
  const modernChild = modernEntries.find(entry => entry.nativeSessionId === 'parent/empty');
  assert.ok(modernChild);
  assert.equal(modernChild.importable, false);
  assert.equal(modernChild.messageCount, 0);
  assert.equal(modernEntries.find(entry => entry.nativeSessionId === 'parent').childCount, 1);

  const legacyRoot = path.join(base, 'empty-child-legacy');
  const legacyDir = path.join(legacyRoot, 'sessions/hash/parent');
  wire(path.join(legacyDir, 'context.jsonl'), [{ role: 'user', content: 'parent question' }]);
  wire(path.join(legacyDir, 'subagents/empty/context.jsonl'), [{ role: '_checkpoint', id: 0 }]);
  const legacyEntries = await legacy.scan(legacyRoot);
  const legacyChild = legacyEntries.find(entry => entry.agentId === 'empty');
  assert.ok(legacyChild);
  assert.equal(legacyChild.importable, false);
  assert.equal(legacyChild.messageCount, 0);
  assert.equal(legacyEntries.find(entry => entry.nativeSessionId === 'parent').childCount, 1);
});
