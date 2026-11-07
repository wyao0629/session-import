import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registry, hostSource } = require('../lib/registry');
const manifest = require('../manifest.json');

test('assembly: all 17 built-in harnesses load without disappearing', () => {
  const expected = ['autoclaw','claude','codex','dsh','gemini','grok','kimi-code','kimi-desktop','kimi-legacy','opencode','openclaw','pi','pi-desktop','qoder','reasonix','workbuddy','zcode'];
  assert.deepEqual(registry.list().map((h) => h.id).sort(), expected.sort());
  for (const harness of registry.list()) for (const method of ['discover','scan','messages']) assert.equal(typeof harness[method], 'function', `${harness.id}.${method}`);
});

test('assembly: every importable source is declared, desktop is preview only', () => {
  const declared = new Set(manifest.contributes.sessionSources.map((s) => s.id));
  for (const [id] of registry.importSources()) assert.ok(declared.has(hostSource(id)), `Missing source declaration: ${hostSource(id)}`);
  assert.equal(registry.get('pi-desktop').capabilities.import, false);
  assert.equal(registry.get('pi-desktop').importSource, null);
  assert.equal(registry.get('pi').capabilities.nativeInHost, true);
});

test('assembly: namespaced commands and tools coexist with old plugin', () => {
  assert.notEqual(manifest.id, 'io.github.muzimu217.session-import');
  for (const command of manifest.contributes.commands) assert.ok(command.id.startsWith('session-import.'));
  const names = manifest.contributes.agentTools.map((t) => t.name ?? t.id).sort();
  assert.deepEqual(names, ['session_hub_read','session_hub_resolve','session_hub_search','session_hub_sync']);
});

test('assembly: view identifiers satisfy the host manifest contract', () => {
  for (const view of manifest.contributes.views) {
    assert.match(view.id, /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
    assert.ok(view.id.startsWith('session-import-'));
  }
});
