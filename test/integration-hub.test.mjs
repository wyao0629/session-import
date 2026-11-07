import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { registry, refreshDynamicSources, sessionSources, hostSource, getDynamicLoadReport } = require('../lib/registry');
const { createHubService, normalizeEntry, relate } = require('../lib/hub/service');
const { readSession, prepareImport, descendants, assertInsideRoots, clearCache } = require('../lib/hub/reader');
const { search, resolve } = require('../lib/hub/query');
const { createTools } = require('../lib/hub/tools');
const config = require('../lib/hub/config');
const { project } = require('../lib/import/project');
const { validateBatch } = require('../lib/import/contract');
const manifest = require('../manifest.json');
const main = require('../main');

assert.ok(process.env.PI_SCRATCH_DIR, 'PI_SCRATCH_DIR is required; fixtures are retained');
const fixture = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'session-import-integration-'));
const home = path.join(fixture, 'home');
const codexRoot = path.join(home, '.codex');
const ids = Array.from({ length: 5 }, (_, i) => `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const [parentId, childId, archiveId, goodId, badId] = ids;
const stamp = '2026-11-01T00:00:00Z';
const enabled = ['codex', 'pi', 'pi-desktop', 'fixture-a', 'fixture-b'];
async function jsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
}
const message = (role, text) => ({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
for (const id of ids) {
  const rows = [
    { type: 'session_meta', timestamp: stamp, payload: { id, cwd: path.join(fixture, 'project'), timestamp: stamp, ...(id === childId ? { parent_thread_id: parentId, agent_path: '/root/worker' } : {}) } },
    message('user', id === childId ? 'Child task fixture' : 'Parent request fixture'),
    { type: 'response_item', timestamp: stamp, payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Fixture reasoning retained' }] } },
    { type: 'response_item', timestamp: stamp, payload: { type: 'custom_tool_call', call_id: 'tool-1', name: 'exec', input: 'fixture input' } },
    { type: 'response_item', timestamp: stamp, payload: { type: 'custom_tool_call_output', call_id: 'tool-1', output: 'Script failed: exit code: 2' } },
    message('assistant', id === childId ? 'CHILD FINAL ANSWER fixture' : 'Parent final answer fixture'),
  ];
  await jsonl(path.join(codexRoot, id === archiveId ? 'archived_sessions' : 'sessions', `rollout-2026-11-01T00-00-00-${id}.jsonl`), rows);
}
await jsonl(path.join(codexRoot, 'session_index.jsonl'), ids.map((id) => ({ id, thread_name: id === parentId ? 'Exact GUI title fixture' : id === childId ? 'Worker GUI title fixture' : `GUI ${id}`, updated_at: stamp })));
const piFile = path.join(home, '.pi/agent/sessions/project/pi.jsonl');
await fs.mkdir(path.dirname(piFile), { recursive: true });
await fs.copyFile(path.join(root, 'test/fixtures/pi-v3/branch.jsonl'), piFile);
const desktopFile = path.join(home, '.pi-desktop/sessions/desktop.jsonl');
await fs.mkdir(path.dirname(desktopFile), { recursive: true });
await fs.copyFile(path.join(root, 'test/fixtures/pi-desktop/desktop.jsonl'), desktopFile);
const specs = [];
for (const id of ['fixture-a', 'fixture-b']) {
  const customRoot = path.join(fixture, id);
  await jsonl(path.join(customRoot, 'same-id.jsonl'), [{ role: 'user', content: 'Custom task', at: stamp }, { role: 'assistant', content: 'Custom answer', thought: 'Custom reasoning', at: stamp }]);
  specs.push({ id, label: id, driver: 'jsonl-transcript', root: customRoot, session: { idFrom: 'filename', titleFrom: 'firstUser' }, entry: { rolePath: 'role', content: 'content', thinkingPath: 'thought', tsPath: 'at' } });
}
const customJson = JSON.stringify({ sources: specs });
const baseConfig = () => ({ ...config.normalize({ 'session-import.enabledHarnesses': enabled.join(',') }), extraRoots: [] });
let hub;

test('integration: manifest, runtime declarations and UI scripts agree', async () => {
  assert.deepEqual(manifest.contributes.sessionSources, sessionSources());
  assert.deepEqual(manifest.contributes.agentTools, createTools(null).map(({ execute, ...tool }) => tool));
  assert.equal(manifest.id, 'pi.session-import');
  for (const item of manifest.contributes.commands) assert.ok(item.id.startsWith('session-import.'));
  for (const item of manifest.contributes.views) assert.ok(item.id.startsWith('session-import-'));
  for (const setting of manifest.contributes.settings) assert.ok(setting.key.startsWith('session-import.'));
  assert.ok(manifest.permissions.includes('desktop.control'));
  assert.deepEqual(config.normalize({}).harnesses, registry.list().map((h) => h.id));
  assert.equal(config.normalize({ autoSyncEnabled: false, 'session-import.autoSyncEnabled': true }).autoSyncEnabled, true);
  for (const file of ['main.js', 'views/hub-all.js', 'views/hub-sync.js', 'views/import-view.js']) {
    new vm.Script(await fs.readFile(path.join(root, file), 'utf8'), { filename: file });
  }
  for (const file of ['views/importer.html', 'views/forge.html']) {
    const html = await fs.readFile(path.join(root, file), 'utf8');
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1], { filename: file });
  }
});

test('integration: declarative sources join the shared registry and full sync', async () => {
  await refreshDynamicSources({ readText: async () => customJson });
  assert.deepEqual(getDynamicLoadReport().errors, []);
  assert.equal(getDynamicLoadReport().count, 2);
  assert.equal(require('../lib/harnesses'), registry);
  assert.ok(registry.list().some((h) => h.id === 'fixture-a'));
  hub = createHubService({ dataDir: path.join(fixture, 'index'), home, env: {}, getConfig: baseConfig });
  const first = hub.sync();
  assert.equal(hub.sync(), first, 'concurrent syncs share one promise');
  const state = await first;
  assert.deepEqual(state.errors, []);
  assert.equal(state.total, 9);
  assert.ok(state.sources.every((s) => s.root.startsWith(fixture)));
  assert.ok(hub.entries().every((e) => e.key));
  const parent = hub.entries().find((e) => e.sessionId === parentId);
  assert.equal(parent.title, 'Exact GUI title fixture');
  assert.equal(parent.childCount, 1);
  assert.equal(hub.children(parent)[0].sessionId, childId);
  const custom = hub.entries().filter((e) => e.harness.startsWith('fixture-'));
  assert.equal(new Set(custom.map((e) => e.externalId)).size, 2);
  assert.ok(custom.every((e) => e.importSource === 'custom' && e.importable));
  const reopened = createHubService({ dataDir: path.join(fixture, 'index'), home, env: {}, getConfig: baseConfig });
  await reopened.ready();
  assert.equal(reopened.entries().length, state.total);
  assert.equal(reopened.entries().find((e) => e.sessionId === parentId).childCount, 1);
});

test('integration: GUI visibility and agent search preserve hidden child identity', async () => {
  const rows = hub.entries();
  const visible = search(rows, { harness: 'codex', limit: 100 });
  assert.equal(visible.total, 3);
  assert.ok(!visible.sessions.some((s) => [childId, archiveId].includes(s.sessionId)));
  const children = search(rows, { parentSessionId: parentId });
  assert.equal(children.total, 1);
  assert.equal(children.sessions[0].hiddenReason, 'subagent');
  assert.equal(children.sessions[0].visible, false);
  assert.equal(resolve(rows, `codex://${childId}`).matches[0].parentSessionId, parentId);
  assert.equal(resolve(rows, 'pi://pi-branch').matches[0].harness, 'pi');
  const tools = new Map(createTools(hub).map((t) => [t.name, t]));
  const found = await tools.get('session_hub_search').execute({ parentSessionId: parentId });
  assert.equal(found.sessions[0].sessionId, childId);
  const read = await tools.get('session_hub_read').execute({ ref: childId, withThinking: true, toolDetail: 'full' });
  assert.match(read.content, /CHILD FINAL ANSWER/);
  assert.match(read.content, /Fixture reasoning retained/);
  assert.match(read.content, /工具：exec/);
  assert.match(read.content, /失败/);
  assert.equal(read.session.parentSessionId, parentId);
});

test('integration: parent preview, pagination and optional subagent summaries share messages', async () => {
  const parent = hub.entries().find((e) => e.sessionId === parentId);
  const opts = { roots: hub.roots(parent.harness), entries: hub.entries(), rootsFor: hub.roots, toolDetail: 'full' };
  const full = await readSession(parent, { ...opts, includeSubagents: true, maxChars: 200000 });
  assert.match(full.content, /CHILD FINAL ANSWER/);
  const quiet = await readSession(parent, { ...opts, withThinking: false });
  assert.doesNotMatch(quiet.content, /Fixture reasoning retained/);
  assert.doesNotMatch(quiet.content, /CHILD FINAL ANSWER/);
  const page = await readSession(parent, { ...opts, maxChars: 90 });
  const next = await readSession(parent, { ...opts, offset: page.nextOffset, maxChars: 90 });
  assert.equal(page.nextOffset, 90);
  assert.equal(next.offset, 90);
  assert.equal(page.content + next.content, (await readSession(parent, { ...opts, maxChars: 180 })).content);
  const prepared = await prepareImport(parent, hub, { subagentSummary: true });
  const text = project(parent, prepared.messages, prepared.projectOpts).messages.map((m) => m.text).join('\n');
  assert.match(text, /任务：Child task fixture/);
  assert.match(text, /FINAL_ANSWER：CHILD FINAL ANSWER/);
  const plain = await prepareImport(parent, hub, { subagentSummary: false, withThinking: false });
  assert.doesNotMatch(project(parent, plain.messages, plain.projectOpts).messages.map((m) => m.text).join('\n'), /CHILD FINAL ANSWER|Fixture reasoning retained/);
  const outside = path.join(fixture, 'outside.jsonl');
  await fs.writeFile(outside, 'fixture only');
  await assert.rejects(assertInsideRoots({ ...parent, sessionPath: outside }, hub.roots('codex')), /不在已发现/);
});

test('integration: missing keys and same IDs in distinct roots keep separate child trees', () => {
  const h = registry.get('codex');
  assert.equal(normalizeEntry({ sessionId: 'missing-key', visible: false, hiddenReason: 'empty' }, h).key, 'codex:missing-key');
  const parentA = { harness: 'codex', key: 'codex:p@a', sessionId: 'p', externalId: 'p@a', sourceRoot: 'a' };
  const parentB = { harness: 'codex', key: 'codex:p@b', sessionId: 'p', externalId: 'p@b', sourceRoot: 'b' };
  const child = { harness: 'codex', key: 'codex:c@a', sessionId: 'c', parentSessionId: 'p', parentKey: parentA.key, sourceRoot: 'a' };
  const rows = relate([parentA, parentB, child]);
  assert.equal(parentA.childCount, 1);
  assert.equal(parentB.childCount, 0);
  assert.deepEqual(descendants(parentB, rows), []);
  assert.deepEqual(descendants(parentA, rows), [child]);
  assert.equal(resolve(rows, 'p').ambiguous, true);
  assert.equal(resolve(rows, 'p@b').matches[0].key, parentB.key);
  assert.equal(search(rows, { includeHidden: true }).sessions.find((s) => s.key === parentA.key).externalId, 'p@a');
});

test('integration: plugin lifecycle, import routing and Forge use real host shapes', async (t) => {
  const dataDir = path.join(fixture, 'plugin-data');
  const attempts = [], registered = new Map(), agentTools = new Map(), handlers = new Map(), requests = [], opened = [];
  const origins = new Map(), files = new Map(), failures = new Set([badId]);
  let settings = { 'session-import.enabledHarnesses': enabled.join(','), 'session-import.autoSyncEnabled': true };
  let settingsReads = 0, initial;
  const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
  t.mock.method(os, 'homedir', () => home);
  for (const id of ['codex', 'pi', 'pi-desktop']) {
    const h = registry.get(id), discover = h.discover;
    t.mock.method(h, 'discover', (ctx) => discover({ ...ctx, home, env: {}, extraRoots: [] }));
  }
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 5000) { initial = { fn, ms }; return initial; }
    return realSetTimeout(fn, ms, ...args);
  });
  t.mock.method(global, 'clearTimeout', (timer) => { if (timer !== initial) realClearTimeout(timer); });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const previousPi = global.pi;
  global.pi = {
    commands: { register: async (command) => { attempts.push(`command:${command.id}`); if (command.id === manifest.contributes.commands[0].id) throw new Error('fixture command rejection'); registered.set(command.id, command); }, unregister: async (id) => registered.delete(id) },
    plugin: { getDataPath: async () => { attempts.push('dataPath'); return dataDir; }, getSettings: async () => { settingsReads++; return settings; }, setSettings: async (patch) => { settings = { ...settings, ...patch }; } },
    events: { on: (name, handler) => handlers.set(name, handler), off: (name) => handlers.delete(name) },
    ui: { revealView: async (args) => opened.push(args), openPanel: async (args) => opened.push(args), showToast: async () => {} },
    desktop: { invoke: async (args) => opened.push(args) },
    fs: { readText: async (file) => { if (file === 'docs/session-import-sources.json') return customJson; if (files.has(file)) return files.get(file); throw Object.assign(new Error('fixture not found'), { code: 'NOT_FOUND' }); }, writeText: async (file, text) => files.set(file, text) },
    project: { create: async ({ path: projectPath }) => { assert.ok(projectPath); return { id: 1 }; } },
    models: { list: async () => [{ key: 'fixture-model', label: 'Fixture' }] },
    agent: { registerTool: async (tool) => { attempts.push(`tool:${tool.name}`); if (tool.name === 'session_hub_sync') throw new Error('fixture tool rejection'); agentTools.set(tool.name, tool); }, unregisterTool: async (name) => agentTools.delete(name), complete: async (args) => { assert.equal(args.modelKey, 'fixture-model'); assert.equal(args.messages[0].role, 'user'); return { text: 'Fixture distilled output' }; } },
    session: {
      importBatch: async (payload) => {
        assert.deepEqual(validateBatch(payload), []);
        assert.equal(payload.mode, 'skip');
        requests.push(payload);
        let imported = 0, skipped = 0, failed = 0;
        const results = payload.sessions.map((s) => {
          assert.ok(s.messages.every((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && !('text' in m)));
          const key = `${payload.source}:${s.externalId}`;
          if (failures.has(s.externalId)) { failed++; return { externalId: s.externalId, status: 'failed', errorMessage: 'fixture submit rejection' }; }
          if (origins.has(key)) { skipped++; return { externalId: s.externalId, status: 'skipped', sessionId: origins.get(key).sessionId }; }
          const sessionId = `host-${origins.size + 1}`; origins.set(key, { ...s, sessionId, source: payload.source }); imported++;
          return { externalId: s.externalId, sessionId, status: 'imported' };
        });
        return { imported, skipped, failed, results };
      },
      list: async (args) => ({ items: [...origins.values()].filter((s) => !args.source || s.source === args.source) }),
      listMessages: async ({ sessionId }) => ({ items: [...origins.values()].find((s) => s.sessionId === sessionId)?.messages ?? [] }),
    },
  };
  t.after(async () => { await main.onUnload(); global.pi = previousPi; clearCache(); });
  await main.onLoad();
  await t.test('commands register first, failures are isolated, initial sync waits five seconds', async () => {
    assert.deepEqual(attempts.slice(0, 3), manifest.contributes.commands.map((c) => `command:${c.id}`));
    assert.equal(attempts.filter((s) => s.startsWith('tool:')).length, 4);
    assert.equal(registered.size, 2);
    assert.equal(agentTools.size, 3);
    assert.ok(logs.some((s) => s.includes('fixture command rejection')));
    assert.ok(logs.some((s) => s.includes('fixture tool rejection')));
    assert.equal(initial.ms, 5000);
    assert.equal((await main.onPanelInvoke('hub.state')).status.lastSyncAt, null);
    await initial.fn();
    assert.equal((await main.onPanelInvoke('hub.state')).status.total, 9);
    const scan = await main.onPanelInvoke('import.scanSource', { source: 'codex' });
    assert.equal(scan.count, 3);
    assert.equal(scan.archived, 1);
    assert.equal((await main.onPanelInvoke('import.sessions', { source: 'codex' })).sessions.length, 3);
    assert.equal((await main.onPanelInvoke('import.sessions', { source: 'codex', includeArchived: true })).sessions.length, 4);
    assert.equal(main.ownSettingsEvent({ pluginId: 'io.github.muzimu217.session-import', 'session-import.autoSyncEnabled': false }), false);
    const reads = settingsReads;
    await handlers.get('plugin:settingsChanged')({ pluginId: 'unrelated' });
    assert.equal(settingsReads, reads);
    settings = { ...settings, 'session-import.autoSyncEnabled': false };
    await handlers.get('plugin:settingsChanged')(settings);
    assert.equal(settingsReads, reads + 1);
    assert.equal((await main.onPanelInvoke('hub.state')).schedule.enabled, false);
    await registered.get('session-import.forge.open').run();
    assert.deepEqual(opened.at(-1), { viewId: 'session-import-forge' });
    const state = await main.onPanelInvoke('hub.setConfig', { syncIntervalValue: 2, unrelated: 'ignored' });
    assert.equal(state.config.syncIntervalValue, 2);
    assert.equal(settings['session-import.syncIntervalValue'], 2);
    assert.equal(settings.unrelated, undefined);
  });
  await t.test('default skip, explicit copies, thinking and summaries use unified commit', async () => {
    const payload = { source: 'codex', items: [{ externalId: parentId }], subagentSummary: true };
    const imported = await main.onPanelInvoke('import.commit', payload);
    assert.equal(imported.imported, 1);
    assert.match(imported.notice, /先.*普通消息.*\/learn/);
    assert.match(imported.notice, /宿主限制/);
    const session = requests.at(-1).sessions[0];
    assert.equal(session.title, 'Exact GUI title fixture');
    assert.equal(session.externalId, parentId);
    assert.equal(requests.at(-1).source, hostSource('codex'));
    const text = session.messages.map((m) => m.content).join('\n');
    assert.match(text, /Fixture reasoning retained/);
    assert.match(text, /CHILD FINAL ANSWER/);
    assert.match(text, /工具：exec/);
    assert.equal((await main.onPanelInvoke('import.commit', payload)).skipped, 1);
    assert.equal((await main.onPanelInvoke('import.commit', { ...payload, mode: 'new', withThinking: false, subagentSummary: false })).imported, 1);
    assert.match(requests.at(-1).sessions[0].externalId, /~r[0-9a-f]{32}$/);
    assert.doesNotMatch(requests.at(-1).sessions[0].messages.map((m) => m.content).join('\n'), /Fixture reasoning retained|CHILD FINAL ANSWER/);
    assert.equal((await main.onPanelInvoke('import.sessions', { source: 'codex' })).sessions.find((s) => s.sessionId === parentId).imported, true);
  });
  await t.test('partial receipts mark only confirmed imports; child can import independently', async () => {
    const partial = await main.onPanelInvoke('import.commit', { source: 'codex', items: [{ externalId: goodId }, { externalId: badId }] });
    assert.equal(partial.imported, 1);
    assert.equal(partial.failed.length, 1);
    const rows = (await main.onPanelInvoke('import.sessions', { source: 'codex' })).sessions;
    assert.equal(rows.find((s) => s.sessionId === goodId).imported, true);
    assert.equal(rows.find((s) => s.sessionId === badId).imported, false);
    assert.equal((await main.onPanelInvoke('import.commit', { source: 'codex', items: [{ externalId: childId }] })).imported, 1);
    const list = await main.onPanelInvoke('hub.list', { harness: 'codex' });
    assert.equal(list.total, 3);
    assert.equal(list.sessions.find((s) => s.sessionId === parentId).childCount, 1);
  });
  await t.test('Pi native open uses host ID; explicit Pi import and desktop preview only', async () => {
    const count = requests.length;
    const blocked = await main.onPanelInvoke('import.commit', { source: 'pi', items: [{ externalId: 'pi-branch' }] });
    assert.equal(blocked.imported, 0);
    assert.match(blocked.failed[0].error, /显式选择导入/);
    assert.equal(requests.length, count);
    const openedPi = await main.onPanelInvoke('hub.openNative', { harness: 'pi', ref: 'pi-branch' });
    const expected = `native-pi:${createHash('sha256').update(`${await fs.realpath(piFile)}\0pi-branch`).digest('base64url').slice(0, 24)}`;
    assert.equal(openedPi.sessionId, expected);
    assert.deepEqual(opened.at(-1), { operation: 'session/open', args: [expected] });
    assert.equal((await main.onPanelInvoke('import.commit', { source: 'pi', items: [{ externalId: 'pi-branch' }], importNative: true })).imported, 1);
    const desktop = (await main.onPanelInvoke('import.sessions', { source: 'pi-desktop' })).sessions[0];
    assert.equal(desktop.importable, false);
    assert.match((await main.onPanelInvoke('hub.read', { ref: desktop.key })).content, /Desktop answer/);
    const rejected = await main.onPanelInvoke('import.commit', { source: 'pi-desktop', items: [desktop] });
    assert.match(rejected.failed[0].error, /仅支持预览/);
  });
  await t.test('custom source IDs share a declared source without dedupe collisions', async () => {
    for (const source of ['fixture-a', 'fixture-b']) {
      const rows = await main.onPanelInvoke('import.sessions', { source });
      const result = await main.onPanelInvoke('import.commit', { source, items: rows.sessions });
      assert.equal(result.imported, 1);
      assert.equal(requests.at(-1).source, 'session-import.custom');
      assert.equal(requests.at(-1).sessions[0].externalId, `${source}:same-id`);
      assert.match(requests.at(-1).sessions[0].messages.map((m) => m.content).join('\n'), /Custom reasoning/);
    }
    assert.deepEqual((await main.onPanelInvoke('import.reloadCustomSources')).errors, []);
    assert.equal((await main.onPanelInvoke('import.customSources')).count, 2);
  });
  await t.test('Forge list, read, distill, save and history remain wired', async () => {
    const rows = await main.onPanelInvoke('forge.sessions', { source: 'session-import.codex' });
    assert.ok(rows.sessions.length);
    assert.equal(rows.sessions[0].id, rows.sessions[0].sessionId);
    const id = rows.sessions[0].id;
    assert.ok((await main.onPanelInvoke('forge.messages', { sessionId: id })).messages.length);
    assert.equal((await main.onPanelInvoke('forge.models')).models[0].key, 'fixture-model');
    const distilled = await main.onPanelInvoke('forge.distill', { sessionIds: [id], sessions: rows.sessions, modelKey: 'fixture-model' });
    assert.equal(distilled.distilled, 'Fixture distilled output');
    const saved = await main.onPanelInvoke('forge.save', { path: 'docs/fixture.md', content: distilled.distilled, mode: 'overwrite' });
    assert.equal(saved.ok, true);
    assert.equal(files.get('docs/fixture.md'), distilled.distilled);
    assert.equal((await main.onPanelInvoke('forge.history.load')).entries.length, 1);
    assert.ok((await main.onPanelInvoke('import.recent')).lastImportCount > 0);
  });
  await t.test('unload removes registrations and reload restores import markers', async () => {
    await main.onUnload();
    assert.equal(registered.size, 0);
    assert.equal(agentTools.size, 0);
    assert.equal(handlers.size, 0);
    await main.onLoad();
    const rows = await main.onPanelInvoke('import.sessions', { source: 'codex' });
    assert.equal(rows.sessions.find((s) => s.sessionId === goodId).imported, true);
    assert.equal(rows.sessions.find((s) => s.sessionId === badId).imported, false);
  });
});

test('integration: normalization retains import restrictions and duplicate GUI titles', () => {
  const { mergeDuplicate } = require('../lib/hub/service');
  const harness = registry.get('codex');
  const empty = normalizeEntry({ sessionId: 'empty', importable: false }, harness);
  assert.equal(empty.importable, false);
  assert.equal(normalizeEntry({ sessionId: 'normal', importable: true }, harness).importable, true);
  const native = { key: 'qoder:same', updatedAt: '2026-01-01T00:00:00Z', title: 'GUI name', name: 'GUI name', nameKind: 'native', sessionPath: 'old' };
  const latest = { key: 'qoder:same', updatedAt: '2026-02-01T00:00:00Z', title: 'first prompt', nameKind: 'prompt', sessionPath: 'new' };
  for (const entry of [mergeDuplicate(native, latest), mergeDuplicate(latest, native)]) {
    assert.equal(entry.title, 'GUI name');
    assert.equal(entry.nameKind, 'native');
    assert.equal(entry.sessionPath, 'new');
    assert.equal(entry.updatedAt, latest.updatedAt);
  }
  assert.equal(mergeDuplicate(native, { ...latest, title: 'renamed GUI', nameKind: 'native' }).title, 'renamed GUI');
});
