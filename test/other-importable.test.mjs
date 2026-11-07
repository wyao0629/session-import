import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture, put, instant } from './fixtures/other/helpers.mjs';

const require = createRequire(import.meta.url);
const { entryFor, harness, normalize } = require('../lib/harnesses/_shared/other');
const { makeMessage } = require('../lib/model');
const { project } = require('../lib/import/project');
const { buildBatchMessage } = require('../lib/import/commit');
const { validateBatch } = require('../lib/import/contract');

const adapter = { id: 'grok', importSource: 'grok', capabilities: { import: true } };
const descriptor = { sessionId: 'fixture', sessionPath: 'fixture.jsonl' };

test('shared importability follows readable projection without discarding hidden content', () => {
  const cases = [
    ['empty', [], false],
    ['injected', normalize([{ role: 'system', content: 'fixture setup' }]), false],
    ['noise', [makeMessage({ kind: 'noise', text: 'fixture noise' })], false],
    ['whitespace', [makeMessage({ text: ' \n ', thinking: [' \t '] })], false],
    ['text', normalize([{ role: 'user', content: 'fixture question' }]), true],
    ['thinking', [makeMessage({ role: 'assistant', thinking: ['fixture thought'] })], true],
    ['tool', normalize([{ type: 'function_call', callId: 'call', name: 'Read', arguments: '{}' }]), true],
    ['image', [makeMessage({ images: ['fixture.png'] })], true],
    ['child', [makeMessage({ children: [{ harness: 'grok', sessionId: 'child' }] })], true],
  ];
  for (const [label, messages, expected] of cases) {
    const entry = entryFor(adapter, descriptor, { subagent: true, parentSessionId: 'parent', createdAt: instant }, messages);
    assert.equal(entry.importable, expected, label);
    assert.equal(entry.visible, false, label);
    assert.equal(entry.hiddenReason, 'subagent', label);
    assert.equal(entry.parentSessionId, 'parent', label);
    const converted = project(entry, messages);
    assert.equal(converted.messages.length > 0, expected, label);
    const session = { ...converted.session, messages: converted.messages.map(buildBatchMessage) };
    const errors = validateBatch({ source: entry.importSource, mode: 'skip', sessions: [session] });
    if (expected) assert.deepEqual(errors, [], label);
    else assert.deepEqual(errors, ['fixture: no readable messages'], label);
  }
  assert.equal(entryFor({ ...adapter, capabilities: { import: false } }, descriptor, {}, normalize([{ role: 'user', content: 'fixture question' }])).importable, false);
});

test('shared scanner refreshes legacy cached empty importability and reuses corrected entries', async () => {
  const root = await fixture('importability-cache');
  const sessionPath = await put(root, 'empty.jsonl', '');
  let loads = 0;
  const source = harness({
    id: 'fixture', roots: [root],
    enumerate: async () => [{ sessionId: 'empty', sessionPath }],
    load: async () => { loads++; return { meta: {}, messages: [] }; },
  });
  const [entry] = await source.scan(root);
  assert.equal(entry.importable, false);
  assert.equal(entry.hiddenReason, 'empty');
  const [corrected] = await source.scan(root, { previous: new Map([[entry.key, { ...entry, importable: true }]]) });
  assert.equal(corrected.importable, false);
  assert.equal(loads, 2);
  const [cached] = await source.scan(root, { previous: new Map([[corrected.key, corrected]]) });
  assert.deepEqual(cached, corrected);
  assert.equal(loads, 2);
});

test('missing source files remain scan and messages errors rather than empty successes', async () => {
  const root = await fixture('importability-missing');
  const missing = { sessionId: 'missing', sessionPath: `${root}/missing.jsonl` };
  const source = harness({
    id: 'fixture', roots: [root],
    enumerate: async () => [missing],
    load: async entry => ({ meta: {}, messages: normalize(JSON.parse(await fs.readFile(entry.sessionPath, 'utf8'))) }),
  });
  const errors = [];
  assert.deepEqual(await source.scan(root, { report: (id, error) => errors.push({ id, code: error.code }) }), []);
  assert.deepEqual(errors, [{ id: 'missing', code: 'ENOENT' }]);
  await assert.rejects(source.messages(missing), { code: 'ENOENT' });
});
