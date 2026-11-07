"use strict";

/**
 * Async file system utilities for session-import 2.0.
 *
 * All I/O is async (fs.promises) so the plugin never blocks the Node event loop.
 * SQLite helpers open a shared-read copy in the PI_SCRATCH_DIR so we never write
 * to harness databases.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createInterface } = require("node:readline");

// ---------------------------------------------------------------------------
// Basic helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the path exists (file or directory).
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stat a path, returning null instead of throwing when it does not exist.
 * @param {string} p
 * @returns {Promise<import("node:fs").Stats|null>}
 */
async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/**
 * Read a file as UTF-8, returning null when the file is absent.
 * @param {string} p
 * @returns {Promise<string|null>}
 */
async function readTextOrNull(p) {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Parse a JSON file, returning null when absent or malformed.
 * @param {string} p
 * @returns {Promise<*>}
 */
async function readJsonOrNull(p) {
  const text = await readTextOrNull(p);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSONL streaming reader (yield N records at a time to avoid blocking)
// ---------------------------------------------------------------------------

/**
 * Async-iterable JSONL reader. Yields one parsed record per line.
 * Skips blank lines and malformed records.
 * @param {string} filePath
 * @returns {AsyncIterable<*>}
 */
async function* readJsonl(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // skip malformed
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Read all records from a JSONL file into an array.
 * @param {string} filePath
 * @returns {Promise<*[]>}
 */
async function readJsonlAll(filePath) {
  const rows = [];
  for await (const row of readJsonl(filePath)) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

/**
 * List immediate children of a directory, returning [] when absent/inaccessible.
 * @param {string} dir
 * @returns {Promise<import("node:fs").Dirent[]>}
 */
async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Recursively yield all files under dir matching an optional test function.
 * @param {string} dir
 * @param {(name: string, dirent: import("node:fs").Dirent) => boolean} [filter]
 * @returns {AsyncIterable<string>}
 */
async function* walkFiles(dir, filter) {
  const entries = await listDir(dir);
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkFiles(full, filter);
    } else if (!filter || filter(ent.name, ent)) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite copy helper (read-only, shared-read via copy to scratch)
// ---------------------------------------------------------------------------

/**
 * Copy a SQLite database file (and its WAL/SHM if present) to a temp
 * directory and return the path to the copy. The copy is opened read-only,
 * so we never accidentally write to harness databases.
 *
 * @param {string} src  Absolute path to the source .sqlite / .db file
 * @param {string} [tag] Short label for the temp file name (default: basename)
 * @returns {Promise<string>} Path to the copy
 */
async function copyDbToScratch(src, tag) {
  const scratchDir =
    process.env.PI_SCRATCH_DIR || path.join(os.tmpdir(), "pi-session-import");
  await fsp.mkdir(scratchDir, { recursive: true });
  const name = tag || path.basename(src);
  const dest = path.join(scratchDir, `${name}.${Date.now()}.db`);
  await fsp.copyFile(src, dest);
  // Copy WAL and SHM if present (needed for consistent reads)
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await fsp.copyFile(src + suffix, dest + suffix);
    } catch {
      // not present — fine
    }
  }
  return dest;
}

// ---------------------------------------------------------------------------
// Cooperative yield (let the event loop breathe between batches)
// ---------------------------------------------------------------------------

/**
 * Yield control to the event loop. Call every ~50 files in tight loops.
 * @returns {Promise<void>}
 */
function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = {
  exists,
  statOrNull,
  readTextOrNull,
  readJsonOrNull,
  readJsonl,
  readJsonlAll,
  listDir,
  walkFiles,
  copyDbToScratch,
  yieldNow,
};
