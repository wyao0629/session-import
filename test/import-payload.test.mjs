import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { project } = require('../lib/import/project');
const { commit, buildBatchMessage } = require('../lib/import/commit');
const { validateBatch, serializedBytes, BATCH_MAX_BYTES, summarizeReport } = require('../lib/import/contract');
const stamp = '2026-11-01T00:00:00.000Z';
const entry = { harness: 'codex', importSource: 'codex', sessionId: 'payload-fixture', title: 'Payload fixture', createdAt: stamp, updatedAt: stamp };
const messages = (count, text) => Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i}:${text}`, createdAt: stamp }));
function verify(projected, latest) {
  const payload = { source: 'session-import.codex', mode: 'skip', sessions: [{ ...projected.session, messages: projected.messages.map(buildBatchMessage) }] };
  assert.deepEqual(validateBatch(payload), []);
  assert.ok(serializedBytes(payload) < BATCH_MAX_BYTES);
  assert.equal(projected.messages.at(-1).text, latest);
  assert.ok(projected.report.byteCappedDropped > 0);
  assert.match(projected.messages[0].text, /32 MiB/);
  assert.match(summarizeReport(projected.report), /32 MiB/);
  for (let i = 1; i < projected.messages.length; i++) assert.notEqual(projected.messages[i].role, projected.messages[i - 1].role);
}
test('payload: escaped JSON bytes are bounded and explicit copy still fits', async () => {
  const rows = messages(100, '\u0000'.repeat(65536));
  const projected = project(entry, rows);
  verify(projected, rows.at(-1).text);
  let submitted = 0;
  const receipt = await commit([{ entry, source: 'session-import.codex', messages: rows }], { mode: 'new', bindProjects: false }, { session: { importBatch: async payload => {
    assert.deepEqual(validateBatch(payload), []);
    assert.match(payload.sessions[0].externalId, /~r[0-9a-f]{32}$/);
    submitted++; return { imported: 1, skipped: 0, failed: 0, results: [{ externalId: payload.sessions[0].externalId, status: 'imported', sessionId: 'fixture-host' }] };
  } } });
  assert.equal(submitted, 1);
  assert.equal(receipt.truncated, 1);
  assert.equal(receipt.failed.length, 0);
});
test('payload: message and byte caps share one accurate omission notice', () => {
  const rows = messages(2010, 'x'.repeat(20000));
  const projected = project(entry, rows);
  verify(projected, rows.at(-1).text);
  assert.ok(projected.report.cappedDropped > 0);
  assert.ok(projected.messages.length <= 2000);
  assert.match(projected.messages[0].text, /2000 条消息上限及32 MiB/);
  const omitted = projected.report.cappedDropped + projected.report.byteCappedDropped;
  assert.match(projected.messages[0].text, new RegExp(`已省略前 ${omitted} 条`));
});
