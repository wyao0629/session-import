import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { project, stableExternalId } = require('../lib/import/project');
const { validate, validateBatch, serializedBytes, BATCH_MAX_BYTES } = require('../lib/import/contract');
const { commit, makeUniqueExternalId, buildBatchMessage } = require('../lib/import/commit');
const time = '2026-11-06T00:00:00.000Z';
const entry = { harness: 'test', sessionId: 'one', name: '测试', createdAt: time, updatedAt: time };
const message = (role, text) => ({ role, text, createdAt: time });
const item = (id = 'one', source = 'codex', messages = [message('user', '问题'), message('assistant', '回答')]) => ({ source, entry: { ...entry, sessionId: id }, messages });
function host() {
  const calls = [];
  return { calls, session: { importBatch: async (payload) => {
    assert.deepEqual(validateBatch(payload), []);
    calls.push(payload);
    return { imported: payload.sessions.length, skipped: 0, failed: 0, results: payload.sessions.map((s) => ({ externalId: s.externalId, sessionId: `host-${s.externalId}`, status: 'imported' })) };
  } } };
}

test('projection: every capped parity remains within 2000 and alternates', () => {
  for (const length of [2000, 2001, 2002, 2200]) {
    const original = Array.from({ length }, (_, index) => message(index % 2 ? 'assistant' : 'user', String(index)));
    const result = project(entry, original);
    assert.ok(result.messages.length <= 2000);
    assert.ok(result.messages.at(-1).text.endsWith(String(length - 1)));
    for (let i = 1; i < result.messages.length; i++) assert.notEqual(result.messages[i].role, result.messages[i - 1].role);
    assert.deepEqual(validate({ session: result.session, messages: result.messages.map(buildBatchMessage) }), []);
  }
});

test('projection: multibyte content is clipped with note after role merge', () => {
  const result = project(entry, [message('assistant', '鲸🐳'.repeat(100000)), message('assistant', '尾部')]);
  const text = result.messages[0].text;
  assert.ok(Buffer.byteLength(text) <= 512 * 1024);
  assert.match(text, /正文超过 512 KiB/);
  assert.equal(result.report.contentTruncated, 1);
  assert.equal(text.includes('�'), false);
});

test('projection: empty injected-only session never becomes a synthetic session', () => {
  const result = project(entry, [{ ...message('user', 'context'), kind: 'injected' }]);
  assert.equal(result.messages.length, 0);
  assert.ok(validate({ session: result.session, messages: [] }).includes('no readable messages'));
});

test('projection: invalid source time, blank title, child summary and image', () => {
  const result = project({ ...entry, name: ' ', title: '名称', createdAt: 'bad' }, [
    { ...message('assistant', 'text'), createdAt: 'bad', children: [{ harness: 'codex', sessionId: 'child' }], images: ['data:image/png;base64,AA=='] },
    message('user', 'next')
  ], { subagentSummary: true, childSummaries: new Map([['child', 'summary']]) });
  assert.equal(result.session.title, '名称');
  assert.match(result.messages[0].text, /summary/);
  assert.match(result.messages[0].text, /图片保留/);
  assert.deepEqual(validate({ session: result.session, messages: result.messages.map(buildBatchMessage) }), []);
});

test('contract rejects missing content, loose dates and non-tool tool fields', () => {
  const result = project(entry, [message('user', 'x')]);
  assert.match(validate(result).join(' '), /content must be a string/);
  const messages = result.messages.map(buildBatchMessage);
  messages[0].createdAt = '2026-11-06';
  messages[0].toolName = 'bad';
  const errors = validate({ session: result.session, messages }).join(' ');
  assert.match(errors, /RFC3339/);
  assert.match(errors, /only valid for tool/);
});

test('contract measures raw UTF-8 content and serialized batch separately', () => {
  const result = project(entry, [message('user', 'x')]);
  const messages = [{ role: 'user', content: '"'.repeat(512 * 1024), createdAt: time }];
  assert.deepEqual(validate({ session: result.session, messages }), []);
  messages[0].content += 'x';
  assert.match(validate({ session: result.session, messages }).join(' '), /512 KiB/);
});

test('stable IDs do not strip native suffixes or collide on long prefixes', () => {
  assert.equal(makeUniqueExternalId('id~rabc'), 'id~rabc');
  const first = stableExternalId('x'.repeat(300) + 'a');
  const second = stableExternalId('x'.repeat(300) + 'b');
  assert.ok(first.length <= 256);
  assert.notEqual(first, second);
  assert.notEqual(makeUniqueExternalId('id', 'new'), makeUniqueExternalId('id', 'new'));
});

test('commit separates sources, deduplicates selection and retains per-item options', async () => {
  const pi = host();
  const result = await commit([item('one'), item('one'), item('one', 'kimi-code'), { ...item('thinking', 'codex', [{ ...message('assistant', 'answer'), thinking: ['hidden'] }]), projectOpts: { withThinking: false } }], {}, pi);
  assert.equal(result.imported, 3);
  assert.equal(result.skipped, 1);
  assert.deepEqual(pi.calls.map((c) => c.source), ['codex', 'kimi-code']);
  assert.ok(!pi.calls[0].sessions[1].messages[0].content.includes('hidden'));
});

test('commit chunks at 100 and includes exact JSON envelope in byte budget', async () => {
  const pi = host();
  const items = Array.from({ length: 101 }, (_, i) => item(`s${i}`));
  const result = await commit(items, {}, pi);
  assert.equal(result.imported, 101);
  assert.deepEqual(pi.calls.map((c) => c.sessions.length), [100, 1]);
  const bigHost = host();
  const bigItems = Array.from({ length: 33 }, (_, i) => item(`b${i}`, 'codex', [message('user', '"'.repeat(512 * 1024))]));
  await commit(bigItems, {}, bigHost);
  assert.equal(bigHost.calls.length, 2);
  for (const payload of bigHost.calls) assert.ok(serializedBytes(payload) <= BATCH_MAX_BYTES);
});

test('commit reports unreadable, host failure, and isolated project without false success', async () => {
  const pi = host();
  const result = await commit([item('empty', 'codex', [])], {}, pi);
  assert.equal(result.ok, false);
  assert.equal(result.unreadable, 1);
  assert.equal(pi.calls.length, 0);
  const failed = await commit([item()], {}, { session: { importBatch: async () => ({ imported: 0, skipped: 0, failed: 1 }) } });
  assert.equal(failed.ok, false);
  assert.ok(failed.failed.length);
  const bound = item();
  bound.entry.workspacePath = 'D:\workspace';
  await commit([bound], { bindProjects: false }, pi);
  assert.equal(pi.calls[0].sessions[0].projectPath, null);
});
