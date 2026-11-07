/** Small, dependency-free filesystem + value helpers shared by hub scanners. */
"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const readline = require("node:readline");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statSig(p) {
  try {
    const st = await fsp.stat(p);
    return { sig: `${Math.round(st.mtimeMs)}:${st.size}`, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Recursive file walk with a depth cap; unreadable directories are skipped. */
async function walk(root, accept, maxDepth = 6) {
  const out = [];
  async function visit(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await visit(p, depth + 1);
      } else if (e.isFile() && accept(p, e.name)) out.push(p);
    }
  }
  await visit(root, 0);
  return out.sort();
}

/** Stream a JSONL file; `onRow(obj, rawLine)` may return true to stop early. */
async function eachJsonLine(file, onRow) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        obj = undefined;
      }
      if (onRow(obj, t) === true) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function readJsonLines(file, max = 100000) {
  const rows = [];
  try {
    await eachJsonLine(file, (obj) => {
      if (obj && typeof obj === "object") rows.push(obj);
      return rows.length >= max;
    });
  } catch {
    return rows;
  }
  return rows;
}

async function readJson(file) {
  try {
    const v = JSON.parse(await fsp.readFile(file, "utf8"));
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

function text(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function iso(v) {
  if (typeof v === "string" && v.trim() !== "" && !/^\d+(\.\d+)?$/.test(v.trim())) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) {
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  return undefined;
}

/** Strip the Windows extended-length prefix that some tools persist in cwd. */
function cleanPath(p) {
  const t = text(p);
  if (!t) return undefined;
  return t.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
}

function baseName(p) {
  const t = cleanPath(p);
  if (!t) return undefined;
  return t.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || undefined;
}

function clip(s, max = 160) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function uuidIn(s) {
  const m = UUID_RE.exec(String(s ?? ""));
  return m ? m[0].toLowerCase() : undefined;
}

module.exports = {
  UUID_RE,
  exists,
  isDir,
  listDir,
  statSig,
  walk,
  eachJsonLine,
  readJsonLines,
  readJson,
  text,
  iso,
  cleanPath,
  baseName,
  clip,
  uuidIn,
};
