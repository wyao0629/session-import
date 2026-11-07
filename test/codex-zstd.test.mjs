import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const zstd = require('../lib/core/zstd');
const scratch = process.env.PI_SCRATCH_DIR ?? path.resolve('../../fixtures');
await fsp.mkdir(scratch, { recursive: true });
const fixture = await fsp.mkdtemp(path.join(scratch, 'codex-zstd-test-'));
const collect = async (iterator) => { const rows = []; for await (const row of iterator) rows.push(row); return rows; };

test('streaming zstd handles concatenated frames, long UTF-8 lines, malformed JSON and final line', async () => {
  const value = '汉字😀'.repeat(120000);
  const expected = [{ text: value }, { value: 2 }, { value: 3 }];
  const file = path.join(fixture, 'unicode.jsonl.zst');
  await fsp.writeFile(file, Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify(expected[0]) + '\n\r\ninvalid\n')),
    zstdCompressSync(Buffer.from(JSON.stringify(expected[1]) + '\n' + JSON.stringify(expected[2]))),
  ]));
  const actual = await collect(zstd.readZstdJsonl(file));
  assert.equal(actual.length, 3);
  assert.ok(actual[0].text === value, 'long UTF-8 line must survive chunk boundaries');
  assert.deepEqual(actual.slice(1), expected.slice(1));
  await assert.rejects(collect(zstd.readZstdJsonl(file, { strict: true })), { code: 'INVALID_JSONL' });
  const buffer = await zstd.decompressFile(file);
  assert.ok(buffer.length > 1000000);
  assert.equal(zstd.decompress(zstdCompressSync(Buffer.from('hello'))).toString(), 'hello');
});

test('maxLines and early consumer break close streams before reading the whole file', async () => {
  const file = path.join(fixture, 'bounded.jsonl.zst');
  const frames = [zstdCompressSync(Buffer.from('{"value":1}\n'))];
  for (let i = 0; i < 24; i++) frames.push(zstdCompressSync(Buffer.from(JSON.stringify({ data: randomBytes(65536).toString('hex') }) + '\n')));
  await fsp.writeFile(file, Buffer.concat(frames));
  const originalRead = fs.createReadStream;
  const streams = [];
  fs.createReadStream = (...args) => { const stream = originalRead(...args); streams.push(stream); return stream; };
  try {
    assert.deepEqual(await collect(zstd.readZstdJsonl(file, { maxLines: 1 })), [{ value: 1 }]);
    for await (const row of zstd.readZstdJsonl(file)) { assert.equal(row.value, 1); break; }
  } finally { fs.createReadStream = originalRead; }
  const size = (await fsp.stat(file)).size;
  assert.equal(streams.length, 2);
  assert.ok(streams.every((stream) => stream.destroyed && stream.bytesRead < size / 2));
});

test('missing, invalid and truncated files reject asynchronously without unhandled errors', async () => {
  const invalid = path.join(fixture, 'invalid.zst');
  const truncated = path.join(fixture, 'truncated.zst');
  await fsp.writeFile(invalid, 'not a compressed frame');
  const frame = zstdCompressSync(Buffer.from('{"text":"' + 'payload'.repeat(100000) + '"}\n'));
  await fsp.writeFile(truncated, frame.subarray(0, frame.length - 4));
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(collect(zstd.readZstdJsonl(path.join(fixture, 'missing.zst'))), { code: 'ENOENT' });
    await assert.rejects(collect(zstd.readZstdJsonl(invalid)));
    await assert.rejects(collect(zstd.readZstdJsonl(truncated)));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('older host fallback streams via installed Node and propagates helper errors', async () => {
  const zlib = require('node:zlib');
  const native = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress');
  const file = path.join(fixture, 'helper.jsonl.zst');
  await fsp.writeFile(file, zstdCompressSync(Buffer.from('{"text":"helper"}\n')));
  Object.defineProperty(zlib, 'createZstdDecompress', { ...native, value: undefined });
  try {
    assert.deepEqual(await collect(zstd.readZstdJsonl(file)), [{ text: 'helper' }]);
    assert.deepEqual(await collect(zstd.readZstdJsonl(file, { maxLines: 1 })), [{ text: 'helper' }]);
    await assert.rejects(collect(zstd.readZstdJsonl(path.join(fixture, 'invalid.zst'))));
    await assert.rejects(collect(zstd.readZstdJsonl(path.join(fixture, 'missing-helper.zst'))));
  } finally { Object.defineProperty(zlib, 'createZstdDecompress', native); }
});

test('helper without zstd exits promptly without waiting for a whole input file', async () => {
  const preload = path.join(fixture, 'no-zstd.cjs');
  await fsp.writeFile(preload, `Object.defineProperty(require('node:zlib'), 'createZstdDecompress', { value: undefined, configurable: true });`);
  const child = spawn(process.execPath, ['--require', preload, require.resolve('../lib/core/zstd'), '--decode'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdout.resume();
  let diagnostic = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => { diagnostic += text; });
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  child.stdin.destroy();
  assert.equal(code, 1);
  assert.match(diagnostic, /requires a Node runtime/);
});

test('long lines search each chunk once and parse each record once', async () => {
  const data = Buffer.from(JSON.stringify({ text: '汉字😀'.repeat(500000) }) + '\n{"last":true}');
  async function* chunks() { for (let i = 0; i < data.length; i += 4093) yield data.subarray(i, i + 4093); }
  const indexOf = String.prototype.indexOf, parse = JSON.parse;
  let searched = 0, parsed = 0;
  String.prototype.indexOf = function(value, start = 0) { if (value === '\n') searched += this.length - start; return indexOf.call(this, value, start); };
  JSON.parse = (...args) => { parsed++; return parse(...args); };
  let rows;
  try { rows = await collect(zstd.readJsonlChunks(chunks())); }
  finally { String.prototype.indexOf = indexOf; JSON.parse = parse; }
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text.length, 2000000);
  assert.equal(rows[1].last, true);
  assert.equal(parsed, 2);
  assert.ok(searched <= data.length * 2, 'no repeated search of the accumulated line');
});

test('older host early close releases a large single-frame helper promptly', { timeout: 10000 }, async () => {
  const zlib = require('node:zlib');
  const native = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress');
  const file = path.join(fixture, 'large-helper.jsonl.zst');
  await fsp.writeFile(file, zstdCompressSync(Buffer.from('{"first":true}\n' + JSON.stringify({ text: 'x'.repeat(16 * 1024 * 1024) }) + '\n')));
  Object.defineProperty(zlib, 'createZstdDecompress', { ...native, value: undefined });
  try {
    assert.deepEqual(await collect(zstd.readZstdJsonl(file, { maxLines: 1 })), [{ first: true }]);
    for await (const row of zstd.readZstdJsonl(file)) { assert.equal(row.first, true); break; }
  } finally { Object.defineProperty(zlib, 'createZstdDecompress', native); }
});
