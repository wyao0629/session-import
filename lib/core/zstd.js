"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");

function isAvailable() {
  return typeof zlib.createZstdDecompress === "function";
}

function decompress(buf) {
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw Object.assign(new Error("Synchronous zstd decompression is unavailable in this Node runtime"), { code: "ZSTD_UNAVAILABLE" });
  }
  return zlib.zstdDecompressSync(buf);
}

// Older Electron runtimes can use the installed Node without a native addon.
// Only compressed bytes are sent through stdin; no shell or source writes.
async function* externalChunks(filePath) {
  const child = spawn("node", [__filename, "--decode"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let failure;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => { failure = error; resolve(); });
    child.once("close", (code) => {
      if (code !== 0 && !failure) failure = Object.assign(new Error(`zstd helper failed (exit ${code})`), { code: "ZSTD_HELPER_FAILED" });
      resolve();
    });
  });
  // Drain diagnostics without exposing source content or unbounded buffering.
  child.stderr.resume();
  const source = fs.createReadStream(filePath);
  const pumping = pipeline(source, child.stdin).catch((error) => { failure ??= error; child.stdout.destroy(error); });
  try {
    for await (const chunk of child.stdout) yield chunk;
    await pumping;
    await exited;
    if (failure) throw failure;
  } finally {
    source.destroy();
    child.stdin.destroy();
    child.stdout.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await pumping;
    await exited;
  }
}

// Node's zstd stream stops at the first frame and can accept truncated input.
// Delimit frames and validate block boundaries before passing bounded chunks
// to the native decoder. Neither compressed frames nor files are buffered.
async function* nativeChunks(source) {
  const iterator = source[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0), frames = 0;
  const invalid = (message) => Object.assign(new Error(message), { code: "ZSTD_INVALID_FRAME" });
  async function take(size, allowEof = false) {
    const parts = [];
    let length = 0;
    while (length < size) {
      if (!pending.length) {
        const next = await iterator.next();
        if (next.done) {
          if (allowEof && length === 0) return null;
          throw invalid("Truncated zstd frame");
        }
        pending = next.value;
      }
      const count = Math.min(size - length, pending.length);
      parts.push(pending.subarray(0, count));
      pending = pending.subarray(count);
      length += count;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
  }
  async function* frame(magic) {
    yield magic;
    const descriptor = await take(1), flag = descriptor[0];
    if (flag & 8) throw invalid("Reserved zstd frame flag");
    yield descriptor;
    const single = (flag & 32) !== 0;
    const headerSize = (single ? 0 : 1) + [0, 1, 2, 4][flag & 3] + [single ? 1 : 0, 2, 4, 8][flag >>> 6];
    if (headerSize) yield await take(headerSize);
    let last = false;
    while (!last) {
      const header = await take(3), block = header.readUIntLE(0, 3);
      const kind = (block >>> 1) & 3, size = block >>> 3;
      if (kind === 3 || size > 131072) throw invalid("Invalid zstd block header");
      last = (block & 1) !== 0;
      yield header;
      const bytes = kind === 1 ? 1 : size;
      if (bytes) yield await take(bytes);
    }
    if (flag & 4) yield await take(4);
  }
  try {
    for (;;) {
      const magic = await take(4, true);
      if (!magic) { if (!frames) throw invalid("Empty zstd file"); return; }
      const value = magic.readUInt32LE();
      if (value >= 0x184d2a50 && value <= 0x184d2a5f) {
        let remaining = (await take(4)).readUInt32LE();
        while (remaining) { const size = Math.min(remaining, 65536); await take(size); remaining -= size; }
        frames++;
        continue;
      }
      if (value !== 0xfd2fb528) throw invalid("Invalid zstd frame magic");
      frames++;
      const input = Readable.from(frame(magic));
      const decoder = zlib.createZstdDecompress();
      let failure;
      const pumping = pipeline(input, decoder).catch((error) => { failure = error; });
      try {
        for await (const chunk of decoder) yield chunk;
        await pumping;
        if (failure) throw failure;
      } finally {
        input.destroy();
        decoder.destroy();
        await pumping;
      }
    }
  } finally { source.destroy(); }
}

async function* decompressedChunks(filePath) {
  if (!isAvailable()) yield* externalChunks(filePath);
  else yield* nativeChunks(fs.createReadStream(filePath));
}

/** Explicit buffer API for small callers; JSONL readers never use this path. */
async function decompressFile(filePath) {
  const chunks = [];
  for await (const chunk of decompressedChunks(filePath)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Split each decoded chunk once; join an incomplete line only when complete. */
async function* readJsonlChunks(chunks, opts = {}) {
  const decoder = new StringDecoder("utf8");
  let parts = [], count = 0, lineNumber = 0;
  function parse(line) {
    lineNumber++;
    if (!line.trim()) return { valid: false };
    try { return { valid: true, value: JSON.parse(line) }; }
    catch {
      if (opts.strict) throw Object.assign(new Error(`Invalid JSON at line ${lineNumber}`), { code: "INVALID_JSONL" });
      return { valid: false };
    }
  }
  for await (const chunk of chunks) {
    const text = decoder.write(chunk);
    let start = 0, end;
    while ((end = text.indexOf("\n", start)) !== -1) {
      const tail = text.slice(start, end);
      let line = tail;
      if (parts.length) { parts.push(tail); line = parts.join(""); parts = []; }
      const record = parse(line);
      start = end + 1;
      if (!record.valid) continue;
      yield record.value;
      if (opts.maxLines > 0 && ++count >= opts.maxLines) return;
    }
    if (start < text.length) parts.push(text.slice(start));
  }
  parts.push(decoder.end());
  const line = parts.join("");
  if (line) { const record = parse(line); if (record.valid) yield record.value; }
}

async function* readZstdJsonl(filePath, opts = {}) {
  yield* readJsonlChunks(decompressedChunks(filePath), opts);
}

if (require.main === module && process.argv[2] === "--decode") {
  if (!isAvailable()) {
    process.stderr.write("Streaming zstd requires a Node runtime with createZstdDecompress\n");
    process.exitCode = 1;
    process.stdin.destroy();
  } else {
    pipeline(Readable.from(nativeChunks(process.stdin)), process.stdout).catch(() => {
      process.stderr.write("zstd stream could not be decoded\n");
      process.exitCode = 1;
    });
  }
}

module.exports = { isAvailable, decompress, decompressFile, readZstdJsonl, readJsonlChunks };
