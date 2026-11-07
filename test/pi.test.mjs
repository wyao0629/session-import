import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pi = require('../lib/harnesses/pi');
const { project } = require('../lib/import/project');
const { safeStat } = require('../lib/harnesses/_shared/pi-common');
const fixture = fileURLToPath(new URL('./fixtures/pi-v3/branch.jsonl', import.meta.url));
const fixtureRoot = path.dirname(fixture);
const header = (id, version = 3) => ({ type: 'session', version, id, cwd: 'D:/demo', timestamp: '2026-11-01T01:00:00Z' });
const user = (id, parentId, text) => ({ type: 'message', id, parentId, message: { role: 'user', content: text } });
async function temporary() {
  const scratch = process.env.PI_SCRATCH_DIR;
  assert.ok(scratch && (await safeStat(scratch))?.isDirectory(), 'A non-linked PI_SCRATCH_DIR is required');
  return fs.mkdtemp(path.join(scratch, 'pi-fixtures-'));
}
async function jsonl(root, name, rows) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('Pi active leaf, cleared title, model, fork and native-open metadata', async () => {
  const [entry] = await pi.scan(fixtureRoot);
  assert.equal(entry.key, 'pi:pi-branch');
  assert.equal(entry.title, 'Revised request');
  assert.equal(entry.name, undefined);
  assert.equal(entry.nameKind, 'prompt');
  assert.equal(entry.modelId, 'active-model');
  assert.equal(entry.workspaceName, 'demo');
  assert.equal(entry.parentSessionId, '11111111-1111-1111-1111-111111111111');
  assert.equal(entry.importable, true);
  assert.equal(entry.importSource, 'pi');
  assert.equal(entry.visible, true);
  assert.equal(entry.hiddenReason, null);
  assert.equal(pi.capabilities.nativeInHost, true);
  assert.match(entry.nativeSessionId, /^native-pi:[A-Za-z0-9_-]{24}$/);
  const messages = await pi.messages(entry);
  const all = JSON.stringify(messages);
  assert.doesNotMatch(all, /OLD BRANCH|wrong-branch-tool|Hidden extension|Not a message|SYNTHETIC-IMAGE/);
  assert.ok(messages.some((message) => message.text === 'Revised request'));
  assert.ok(messages.some((message) => message.text === 'Visible extension'));
  assert.equal(messages.filter((message) => message.kind === 'summary').length, 2);
  const assistant = messages.find((message) => message.text === 'Reading');
  assert.deepEqual(assistant.thinking, ['Synthetic reasoning']);
  assert.equal(assistant.tools[0].name, 'Read');
  assert.deepEqual(assistant.tools[0].args, { path: 'demo.txt' });
  assert.equal(assistant.tools[0].status, 'success');
  assert.match(assistant.tools[0].result, /Synthetic file body.*|image\/jpeg/s);
  const tools = messages.flatMap((message) => message.tools ?? []);
  assert.equal(tools.length, 3);
  assert.equal(tools.find((tool) => tool.id === 'orphan-call').name, 'tool');
  assert.equal(tools.find((tool) => tool.id === 'orphan-call').status, 'error');
  assert.equal(tools.find((tool) => tool.id === 'pending-call').status, 'pending');
  assert.ok(messages.some((message) => message.kind === 'error' && message.text.includes('已中止')));
  assert.ok(messages.some((message) => message.images?.includes('image/png')));
  const quiet = await pi.messages(entry, { withThinking: false });
  assert.ok(quiet.every((message) => !message.thinking));
});

test('Pi projects tools and reasoning into continuation-safe plain text', async () => {
  const [entry] = await pi.scan(fixtureRoot);
  const output = project(entry, await pi.messages(entry));
  assert.ok(output.messages.length > 1);
  assert.ok(output.messages.every((message) => ['user', 'assistant'].includes(message.role)));
  assert.ok(output.messages.every((message) => !message.tools && !message.thinking));
  const text = output.messages.map((message) => message.text).join('\n');
  for (const expected of ['Synthetic reasoning', '工具：Read', 'Synthetic file body', '分支摘要', '上下文压缩摘要', 'image/png']) assert.ok(text.includes(expected));
  assert.doesNotMatch(text, /OLD BRANCH|synthetic context/);
  assert.equal(output.report.injectedDropped, 1);
});

test('Pi latest session_info overrides branch names; empty files remain hidden', async () => {
  const root = await temporary();
  await jsonl(root, 'named.jsonl', [header('named'), user('u', null, 'Prompt'), { type: 'session_info', id: 'n1', parentId: 'u', name: 'First' }, { type: 'session_info', id: 'n2', parentId: 'u', name: 'GUI name' }, { type: 'label', id: 'leaf', parentId: 'u', label: 'main' }]);
  await jsonl(root, 'empty.jsonl', [header('empty')]);
  const entries = await pi.scan(root);
  assert.equal(entries.find((entry) => entry.sessionId === 'named').title, 'GUI name');
  const empty = entries.find((entry) => entry.sessionId === 'empty');
  assert.equal(empty.visible, false);
  assert.equal(empty.hiddenReason, 'empty');
  assert.equal(empty.importable, false);
  assert.equal(project(empty, await pi.messages(empty)).messages.length, 0);
});

test('Pi recursive scan deduplicates ids and refreshes from disk', async () => {
  const root = await temporary();
  await jsonl(root, 'old/session.jsonl', [header('duplicate'), user('u', null, 'Old')]);
  const recent = await jsonl(root, 'nested/deep/session.jsonl', [header('duplicate'), user('u', null, 'New'), { type: 'session_info', id: 'n', parentId: 'u', name: 'New name', timestamp: '2026-11-02T01:00:00Z' }]);
  const [entry] = await pi.scan(root);
  assert.equal(entry.title, 'New name');
  await fs.appendFile(recent, JSON.stringify({ type: 'session_info', id: 'n2', parentId: 'n', name: 'Renamed', timestamp: '2026-11-03T01:00:00Z' }) + '\n');
  const refreshed = await pi.scan(root, { previous: new Map([[entry.sessionId, entry]]) });
  assert.equal(refreshed[0].title, 'Renamed');
});

test('Pi discovers default, override, configured and extra roots without scanning settings content', async () => {
  const home = await temporary();
  const agent = path.join(home, '.pi', 'agent');
  const override = path.join(home, 'override');
  const configured = path.join(home, 'configured');
  const project = path.join(home, 'project');
  await Promise.all([path.join(agent, 'sessions'), path.join(override, 'sessions'), configured, path.join(project, '.pi'), path.join(project, 'local-sessions')].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ sessionDir: configured }));
  await fs.writeFile(path.join(project, '.pi', 'settings.json'), JSON.stringify({ sessionDir: './local-sessions' }));
  const roots = await pi.discover({ home, env: {}, extraRoots: [configured], projectPaths: [project] });
  assert.equal(roots.length, 3);
  assert.ok(roots.some((root) => root.root === path.join(agent, 'sessions')));
  assert.ok(roots.some((root) => root.root === configured));
  assert.ok(roots.some((root) => root.root === path.join(project, 'local-sessions')));
  const overridden = await pi.discover({ home, env: { PI_CODING_AGENT_DIR: override } });
  assert.deepEqual(overridden.map((root) => root.root), [path.join(override, 'sessions')]);
});

test('Pi handles malformed tails and legacy messages; broken trees are reported', async () => {
  const root = await temporary();
  const valid = await jsonl(root, 'legacy.jsonl', [header('legacy', 1), { type: 'message', message: { role: 'user', content: 'Legacy' } }]);
  await fs.appendFile(valid, '{unfinished');
  await jsonl(root, 'broken.jsonl', [header('broken'), user('leaf', 'absent', 'Do not linearize')]);
  await jsonl(root, 'cycle.jsonl', [header('cycle'), user('a', 'b', 'A'), user('b', 'a', 'B')]);
  const failures = [];
  const entries = await pi.scan(root, { report: (_file, error) => failures.push(error.message) });
  assert.equal(failures.length, 2);
  assert.equal(entries.length, 1);
  assert.equal((await pi.messages(entries[0]))[0].text, 'Legacy');
});

test('Pi root safety rejects a junction before inspecting descendants', async (t) => {
  const root = path.resolve('simulated-link');
  const inspected = [];
  t.mock.method(fs, 'lstat', async (file) => {
    inspected.push(file);
    return { isSymbolicLink: () => file === root, isDirectory: () => true };
  });
  assert.equal(await safeStat(path.join(root, 'private', 'session.jsonl')), null);
  assert.equal(inspected.at(-1), root);
});

test('Pi importable matches non-empty projection including edits and active branches', async () => {
  const root = await temporary();
  const injected = '<app-context>Fixture context</app-context>';
  const assistant = (content) => ({ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content } });
  const edit = (replacement) => ({ type: 'context_edit', id: 'edit', parentId: 'u', targetId: 'u', replacement });
  const cases = [
    ['empty', [], false],
    ['injected', [user('u', null, injected)], false],
    ['whitespace', [user('u', null, '   ')], false],
    ['empty-thinking', [assistant([{ type: 'thinking', thinking: '   ' }])], false],
    ['hidden-custom', [{ type: 'custom_message', id: 'c', parentId: null, display: false, content: 'Hidden' }], false],
    ['empty-summary', [{ type: 'compaction', id: 'c', parentId: null, summary: '' }], false],
    ['old-branch', [user('u', null, injected), { ...assistant('Old answer'), parentId: 'u' }, { type: 'label', id: 'leaf', parentId: 'u' }], false],
    ['edit-to-injected', [user('u', null, 'Request'), edit(injected)], false],
    ['edit-to-empty', [user('u', null, 'Request'), edit([])], false],
    ['edit-to-request', [user('u', null, injected), edit('Revised request')], true],
    ['thinking', [assistant([{ type: 'thinking', thinking: 'Reasoning only' }])], true],
    ['image', [user('u', null, [{ type: 'image', mimeType: 'image/png', data: 'FIXTURE' }])], true],
    ['pending-tool', [assistant([{ type: 'toolCall', id: 'call', name: 'Read', arguments: {} }])], true],
    ['tool-result', [{ type: 'message', id: 'r', parentId: null, message: { role: 'toolResult', toolCallId: 'orphan', content: 'Result' } }], true],
    ['summary', [{ type: 'compaction', id: 'c', parentId: null, summary: 'Summary' }], true],
    ['visible-custom', [{ type: 'custom_message', id: 'c', parentId: null, display: true, content: 'Extension' }], true],
  ];
  for (const [id, records] of cases) await jsonl(root, `${id}.jsonl`, [header(id), ...records]);
  const entries = new Map((await pi.scan(root)).map((entry) => [entry.sessionId, entry]));
  assert.equal(entries.size, cases.length);
  for (const [id, , expected] of cases) {
    const entry = entries.get(id);
    assert.equal(entry.importable, expected, id);
    assert.equal(project(entry, await pi.messages(entry)).messages.length > 0, expected, `${id} projection`);
  }
  assert.equal(entries.get('edit-to-request').firstPrompt, 'Revised request');
});

test('Pi native id matches fixed vectors from installed host ve(realpath, header.id)', async (t) => {
  // native-pi-session-KT5Z7BTS.js:7 ve(), :10 realpathSync caller; chunk-OHR6YJRZ.js:2 prefix.
  const separator = String.fromCharCode(92);
  const vectors = [
    [['C:', 'fixture', 'sessions', 'pi-branch.jsonl'].join(separator), 'native-pi:FVAy5o-cl_G7egHh09zKwaDc'],
    ['C:/fixture/sessions/pi-branch.jsonl', 'native-pi:s2lAOYOwWoJIqFA0GOpvGEG0'],
    [['D:', '夹具', 'sessions', 'pi-branch.jsonl'].join(separator), 'native-pi:OVx9DIr6Uv8flKDeDxhnTA_5'],
  ];
  let canonical;
  t.mock.method(fs, 'realpath', async () => canonical);
  for (const [real, expected] of vectors) {
    canonical = real;
    const [entry] = await pi.scan(fixtureRoot);
    assert.equal(entry.nativeSessionId, expected);
    assert.equal(entry.sessionPath, real);
  }
});
