import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findRuntimeBinding, runtimeBindingRecords } = require('../hosts/native/kimi-runtime-binding.cjs');
const { importSession } = require('../hosts/native/kimi.cjs').targets[0];
const scratch = process.env.PI_SCRATCH_DIR;
assert.ok(scratch && fs.statSync(scratch).isDirectory(), 'PI_SCRATCH_DIR is required');
const base = fs.mkdtempSync(path.join(scratch, 'kimi-runtime-binding-'));
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

test('minimal binding fallback contains only runtime selection fields', () => {
  assert.deepEqual(runtimeBindingRecords({ modelAlias: 'kimi-code/k3.1-pro', profileName: 'agent', thinkingEffort: 'high' }, 123), [
    { type: 'profile.bind', agentId: 'main', modelAlias: 'kimi-code/k3.1-pro', profileName: 'agent', thinkingEffort: 'high', time: 123 },
    { type: 'config.update', agentId: 'main', modelAlias: 'kimi-code/k3.1-pro', thinkingEffort: 'high', time: 123 },
  ]);
});

test('latest reasoning and native startup records survive while partial tails are ignored', async () => {
  const root = path.join(base, 'latest');
  const normal = path.join(root, 'sessions', 'wd_normal', 'normal');
  const unbound = path.join(root, 'sessions', 'wd_imported', 'imported');
  write(path.join(normal, 'agents/main/wire.jsonl'), [
    JSON.stringify({ type: 'metadata' }),
    JSON.stringify({ type: 'environment.set_binding', environmentId: 'local', agentId: 'main' }),
    JSON.stringify({ type: 'profile.bind', agentId: 'main', modelAlias: 'kimi-code/k3.1-pro', profileName: 'agent', thinkingEffort: 'max', systemPrompt: 'runtime prompt', activeToolNames: ['Read'] }),
    JSON.stringify({ type: 'config.update', agentId: 'main', thinkingEffort: 'high' }),
    JSON.stringify({ type: 'tool_select.initialized', agentId: 'main', tools: [{ name: 'Read' }] }),
    JSON.stringify({ type: 'agent.turn.started', agentId: 'main' }),
    JSON.stringify({ type: 'config.update', agentId: 'main', thinkingEffort: 'max', modelAlias: 'kimi-code/k3.2-latest' }),
    '{"type":',
  ].join('\n') + '\n');
  write(path.join(unbound, 'agents/main/wire.jsonl'), [
    JSON.stringify({ type: 'metadata' }),
    JSON.stringify({ type: 'profile.bind', agentId: 'main', modelAlias: 'minimal/should-not-win', profileName: 'agent', thinkingEffort: 'low' }),
  ].join('\n') + '\n');
  write(path.join(root, 'session_index.jsonl'), `${JSON.stringify({ sessionDir: normal })}\n${JSON.stringify({ sessionDir: unbound })}\n`);
  const binding = await findRuntimeBinding(root);
  assert.equal(binding.modelAlias, 'kimi-code/k3.2-latest');
  assert.equal(binding.thinkingEffort, 'max');
  assert.deepEqual(binding.startupRecords.map(row => row.type), ['environment.set_binding', 'profile.bind', 'config.update', 'tool_select.initialized']);
  const records = runtimeBindingRecords(binding, 123);
  assert.ok(records.every(row => row.time === 123));
  assert.equal(records.find(row => row.type === 'profile.bind').modelAlias, 'kimi-code/k3.2-latest');
  assert.equal(records.find(row => row.type === 'profile.bind').thinkingEffort, 'max');
  assert.equal(records.find(row => row.type === 'profile.bind').systemPrompt, 'runtime prompt');
  assert.equal(records.find(row => row.type === 'config.update').thinkingEffort, 'max');
});

test('missing normal sessions return no binding instead of inventing one', async () => {
  assert.equal(await findRuntimeBinding(path.join(base, 'empty')), undefined);
});

test('native import writes compatible startup records immediately after metadata', async () => {
  const root = path.join(base, 'import'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const normal = path.join(root, 'sessions', 'wd_normal', 'normal');
  write(path.join(normal, 'agents/main/wire.jsonl'), [
    JSON.stringify({ type: 'environment.set_binding', environmentId: 'local', agentId: 'main' }),
    JSON.stringify({ type: 'profile.bind', agentId: 'main', modelAlias: 'kimi-code/k3.1-pro', profileName: 'agent', thinkingEffort: 'high', systemPrompt: 'runtime prompt', environmentDisclosure: { cwd: 'D:/stale-source' } }),
    JSON.stringify({ type: 'config.update', agentId: 'main', thinkingEffort: 'high' }),
  ].join('\n') + '\n');
  write(path.join(root, 'session_index.jsonl'), `${JSON.stringify({ sessionDir: normal, workDir: workspace })}\n`);
  const result = await importSession({ entry: { title: 'Imported' }, messages: [
    { role: 'user', content: 'question', createdAt: 1000 },
    { role: 'assistant', content: 'answer', createdAt: 2000 },
  ], destination: { root, workspace }, mode: 'copy', options: {} });
  const rows = fs.readFileSync(path.join(result.sessionPath, 'agents/main/wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.slice(1, 4).map(row => row.type), ['environment.set_binding', 'profile.bind', 'config.update']);
  assert.equal(rows[2].modelAlias, 'kimi-code/k3.1-pro');
  assert.equal(rows[2].thinkingEffort, 'high');
  assert.equal(rows[2].systemPrompt, 'runtime prompt');
  assert.equal(rows[2].environmentDisclosure.cwd, workspace);
  assert.equal(result.runtimeBinding.status, 'bound');
  assert.equal(Object.hasOwn(result.runtimeBinding, 'startupRecords'), false);
});

function fullSession(root, id, { workDir, modelAlias = 'kimi-code/k3.1-pro', prompt = 'runtime prompt' } = {}) {
  const sessionDir = path.join(root, 'sessions', 'wd_demo', id);
  write(path.join(sessionDir, 'state.json'), JSON.stringify({ cwd: workDir, updatedAt: 1000 }));
  write(path.join(sessionDir, 'agents/main/wire.jsonl'), [
    JSON.stringify({ type: 'environment.set_binding', environmentId: 'local', agentId: 'main' }),
    JSON.stringify({ type: 'profile.bind', agentId: 'main', modelAlias, profileName: 'agent', thinkingEffort: 'max', systemPrompt: prompt }),
    JSON.stringify({ type: 'config.update', agentId: 'main', thinkingEffort: 'max' }),
  ].join('\n') + '\n');
  return { sessionDir, workDir };
}

test('complete sessions from the target workspace are preferred', async () => {
  const root = path.join(base, 'workspace-preference');
  const target = fullSession(root, 'target', { workDir: 'D:/workspace/target', modelAlias: 'target/model' });
  const other = fullSession(root, 'other', { workDir: 'D:/workspace/other', modelAlias: 'other/model' });
  write(path.join(root, 'session_index.jsonl'), `${JSON.stringify(target)}\n${JSON.stringify(other)}\n`);
  const binding = await findRuntimeBinding(root, 'D:/workspace/target');
  assert.equal(binding.modelAlias, 'target/model');
  assert.equal(binding.matchesWorkspace, true);
});

test('an unreadable index falls back to native session directories', async () => {
  const root = path.join(base, 'directory-fallback');
  fullSession(root, 'unindexed', { workDir: 'D:/workspace/target', modelAlias: 'directory/model' });
  fs.mkdirSync(path.join(root, 'session_index.jsonl'), { recursive: true });
  const binding = await findRuntimeBinding(root, 'D:/workspace/target');
  assert.equal(binding.modelAlias, 'directory/model');
});

test('sensitive fields are removed from copied startup records', () => {
  const records = runtimeBindingRecords({ modelAlias: 'kimi-code/k3.1-pro', profileName: 'agent', thinkingEffort: 'high', startupRecords: [
    { type: 'profile.bind', agentId: 'main', modelAlias: 'kimi-code/k3.1-pro', profileName: 'agent', systemPrompt: 'runtime', apiKey: 'sk-test' },
    { type: 'mcp.tools_discovered', agentId: 'main', tools: [], headers: { Authorization: 'secret-value' } },
  ] }, 123);
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes('sk-test'), false);
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(Object.hasOwn(records.find(row => row.type === 'profile.bind'), 'apiKey'), false);
});

test('cross-workspace startup data is sanitized for the destination', () => {
  const records = runtimeBindingRecords({ modelAlias: 'kimi-code/k3.1-pro', profileName: 'agent', thinkingEffort: 'high', matchesWorkspace: false, startupRecords: [
    { type: 'profile.bind', agentId: 'main', modelAlias: 'kimi-code/k3.1-pro', profileName: 'agent', systemPrompt: 'other workspace prompt', environmentDisclosure: { cwd: 'D:/source' }, agentsMdPaths: ['D:/source/AGENTS.md'] },
    { type: 'changeNotifier.snapshot', agentId: 'main', agentsMdHash: 'stale', workspacePrimaryByWorkspace: { wd_source: 'D:/source' } },
  ] }, 123, 'D:/target');
  const profile = records.find(row => row.type === 'profile.bind');
  assert.equal(profile.environmentDisclosure.cwd, 'D:/target');
  assert.equal(Object.hasOwn(profile, 'systemPrompt'), false);
  assert.equal(Object.hasOwn(profile, 'agentsMdPaths'), false);
  assert.equal(records.some(row => row.type === 'changeNotifier.snapshot'), false);
});

test('minimal fallback is reported as minimal and preserves imported history', async () => {
  const root = path.join(base, 'minimal-status'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const minimal = path.join(root, 'sessions', 'wd_demo', 'minimal');
  write(path.join(minimal, 'agents/main/wire.jsonl'), `${JSON.stringify({ type: 'profile.bind', agentId: 'main', modelAlias: 'minimal/model', profileName: 'agent', thinkingEffort: 'low' })}\n`);
  write(path.join(root, 'session_index.jsonl'), `${JSON.stringify({ sessionDir: minimal })}\n`);
  const result = await importSession({ entry: { title: 'Imported' }, messages: [
    { role: 'user', content: 'question', createdAt: 1000 },
    { role: 'assistant', content: 'answer', createdAt: 2000 },
  ], destination: { root, workspace }, mode: 'copy', options: {} });
  assert.equal(result.runtimeBinding.status, 'minimal');
  const rows = fs.readFileSync(path.join(result.sessionPath, 'agents/main/wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.type === 'turn.prompt' && row.input?.[0]?.text === 'question'));
});

test('unavailable binding still preserves imported history', async () => {
  const root = path.join(base, 'unavailable-status'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const result = await importSession({ entry: { title: 'Imported' }, messages: [
    { role: 'user', content: 'question', createdAt: 1000 },
    { role: 'assistant', content: 'answer', createdAt: 2000 },
  ], destination: { root, workspace }, mode: 'copy', options: {} });
  assert.equal(result.runtimeBinding.status, 'unavailable');
  const rows = fs.readFileSync(path.join(result.sessionPath, 'agents/main/wire.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.type === 'turn.prompt' && row.input?.[0]?.text === 'question'));
});
