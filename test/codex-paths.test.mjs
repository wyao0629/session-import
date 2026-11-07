import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const codex = require('../lib/harnesses/codex');
const scratch = process.env.PI_SCRATCH_DIR ?? path.resolve('../../fixtures');
await fs.mkdir(scratch, { recursive: true });
const fixture = await fs.mkdtemp(path.join(scratch, 'codex-paths-'));
const root = path.join(fixture, 'codex');
const outside = path.join(fixture, 'codex-outside');
await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
await fs.mkdir(outside);
const sid = '30000000-0000-4000-8000-000000000001';
const basename = `rollout-2026-11-07T00-00-00-${sid}.jsonl`;
const body = [
  { type: 'session_meta', timestamp: '2026-11-07T00:00:00Z', payload: { id: sid } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: 'synthetic request' } },
].map(JSON.stringify).join('\n') + '\n';
const inside = path.join(root, 'sessions', basename);
const foreign = path.join(outside, basename);
const compressed = path.join(outside, 'fallback.jsonl.zst');
await fs.writeFile(inside, body);
await fs.writeFile(foreign, body);
await fs.writeFile(compressed, zstdCompressSync(Buffer.from(body)));
const entry = { harness: 'codex', sessionId: sid, sourceRoot: root, sessionPath: inside, segmentPaths: [inside] };

async function rejectsBeforeRead(action, code = 'CODEX_ROOT_ESCAPE') {
  const original = nativeFs.createReadStream;
  let reads = 0;
  nativeFs.createReadStream = (...args) => { reads++; return original(...args); };
  try { await assert.rejects(action(), { code }); assert.equal(reads, 0, 'reject before any rollout body or header is opened'); }
  finally { nativeFs.createReadStream = original; }
}

for (const [label, file] of [['absolute sibling', foreign], ['relative traversal', path.relative(root, foreign)], ['compressed fallback', compressed.slice(0, -4)]]) {
  test(`messages reject ${label} in a nonrepresentative segment`, async () => {
    await rejectsBeforeRead(() => codex.messages({ ...entry, segmentPaths: [inside, file] }));
  });
}

test('explicit roots override sourceRoot; no segment can authorize its own root', async () => {
  await rejectsBeforeRead(() => codex.messages({ ...entry, sourceRoot: outside, segmentPaths: [foreign] }, { roots: [root] }));
  await rejectsBeforeRead(() => codex.messages({ ...entry, sourceRoot: undefined }), 'CODEX_ROOT_REQUIRED');
  await rejectsBeforeRead(() => codex.messages(entry, { roots: [] }), 'CODEX_ROOT_REQUIRED');
});

test('authorized roots and in-root compressed fallback remain readable', async () => {
  const fallback = path.join(root, 'fallback.jsonl');
  await fs.writeFile(fallback + '.zst', zstdCompressSync(Buffer.from(body)));
  assert.ok((await codex.messages({ ...entry, segmentPaths: [fallback] })).some(m => m.text === 'synthetic request'));
  assert.ok((await codex.messages({ ...entry, sourceRoot: undefined, segmentPaths: [foreign] }, { roots: [outside] })).length);
});

for (const [label, target] of [['absolute sibling', foreign], ['relative traversal', path.relative(root, foreign)], ['compressed fallback', compressed.slice(0, -4)]]) {
  test(`scan rejects state ${label} before reading rollouts`, async () => {
    const scanRoot = await fs.mkdtemp(path.join(fixture, 'scan-'));
    const db = new DatabaseSync(path.join(scanRoot, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT)');
    db.prepare('INSERT INTO threads VALUES(?,?)').run(sid, label === 'relative traversal' ? path.relative(scanRoot, foreign) : target);
    db.close();
    await rejectsBeforeRead(() => codex.scan(scanRoot));
  });
}

test('junction escapes and fallback through junction are rejected by messages and scan', async () => {
  const linkedRoot = await fs.mkdtemp(path.join(fixture, 'linked-'));
  const link = path.join(linkedRoot, 'sessions');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await rejectsBeforeRead(() => codex.messages({ ...entry, sourceRoot: linkedRoot, segmentPaths: [path.join(link, basename)] }));
  await rejectsBeforeRead(() => codex.messages({ ...entry, sourceRoot: linkedRoot, segmentPaths: [path.join(link, 'fallback.jsonl')] }));
  await rejectsBeforeRead(() => codex.scan(linkedRoot));
});

test('file symlink escape is rejected when file symlinks are supported', async (t) => {
  const link = path.join(root, 'file-link.jsonl');
  try { await fs.symlink(foreign, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlink privilege is unavailable; junction escape is covered separately'); return; } throw error; }
  await rejectsBeforeRead(() => codex.messages({ ...entry, segmentPaths: [link] }));
  const scanRoot = await fs.mkdtemp(path.join(fixture, 'file-link-scan-'));
  const db = new DatabaseSync(path.join(scanRoot, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?)').run(sid, link);
  db.close();
  await rejectsBeforeRead(() => codex.scan(scanRoot));
});
