import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { zstdCompressSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { inspectRollout, readRows } = require('../lib/harnesses/_shared/codex-rollout');
const scratch = process.env.PI_SCRATCH_DIR ?? path.resolve('../../fixtures');
await fs.mkdir(scratch, { recursive: true });
const root = await fs.mkdtemp(path.join(scratch, 'codex-probe-'));
const stamp = n => new Date(Date.parse('2026-11-07T00:00:00Z') + n * 1000).toISOString();
const record = (n, type, payload) => ({ timestamp: stamp(n), type, payload });
const meta = record(0, 'session_meta', { id: 'synthetic-probe' });
const message = (n, role, content) => record(n, 'response_item', { type: 'message', role, content });
async function fixture(name, rows, compressed) {
  const file = path.join(root, name + (compressed ? '.jsonl.zst' : '.jsonl'));
  const text = rows.map(JSON.stringify).join('\n') + '\n';
  await fs.writeFile(file, compressed ? zstdCompressSync(Buffer.from(text)) : text);
  return file;
}

for (const compressed of [false, true]) {
  test(`probe, needUser and full preserve evidence and timestamps (${compressed ? 'zstd' : 'plain'})`, async () => {
    const file = await fixture('modes', [meta, message(1, 'assistant', 'answer'),
      ...Array.from({ length: 100 }, (_, i) => message(i + 2, 'user', '# AGENTS.md injected')),
      message(102, 'user', 'late real user request'), message(103, 'assistant', 'last answer')], compressed);
    const probe = await inspectRollout(file, { probe: true, needUser: false, full: false });
    assert.equal(probe.meaningful, true);
    assert.equal(probe.hasUserEvent, false);
    assert.equal(probe.complete, false);
    assert.equal(probe.updatedAt, stamp(1));
    const user = await inspectRollout(file, { probe: true, needUser: true, full: false });
    assert.equal(user.hasUserEvent, true);
    assert.equal(user.firstPrompt, 'late real user request');
    assert.equal(user.updatedAt, stamp(102));
    assert.equal(user.complete, false);
    const full = await inspectRollout(file, { probe: true, needUser: true, full: true });
    assert.equal(full.complete, true);
    assert.equal(full.updatedAt, stamp(103));
  });

  test(`injected and encrypted-only evidence requires EOF and remains empty (${compressed ? 'zstd' : 'plain'})`, async () => {
    const file = await fixture('empty', [meta, ...Array.from({ length: 100 }, (_, i) => message(i + 1, 'user', '# AGENTS.md injected')),
      record(101, 'response_item', { type: 'reasoning', encrypted_content: 'synthetic opaque value' })], compressed);
    const info = await inspectRollout(file, { probe: true, needUser: true, full: false });
    assert.equal(info.complete, true);
    assert.equal(info.meaningful, false);
    assert.equal(info.hasUserEvent, false);
    assert.equal(info.firstPrompt, '');
    assert.equal(info.updatedAt, stamp(101));
  });
}

test('plain JSONL shares linear UTF-8 parsing, malformed-line policy and early close', async () => {
  const file = path.join(root, 'plain-long.jsonl');
  const text = '汉字😀'.repeat(300000);
  await fs.writeFile(file, JSON.stringify({ text }) + '\ninvalid\n{"final":true}');
  const rows = [];
  for await (const row of readRows(file)) rows.push(row);
  assert.equal(rows[0].text, text);
  assert.deepEqual(rows[1], { final: true });
  await assert.rejects(async () => { for await (const row of readRows(file, { strict: true })) void row; }, { code: 'INVALID_JSONL' });
  let count = 0;
  for await (const row of readRows(file, { maxLines: 1 })) { count++; assert.equal(row.text.length, text.length); }
  assert.equal(count, 1);
});
