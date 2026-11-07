/**
 * Index entry shape shared by every scanner.
 *
 *   key            "<harness>:<sessionId>"
 *   harness        harness id (see discover.js)
 *   sessionId      the id the harness itself uses
 *   aliases        extra ids that resolve to this session (prefix-less forms)
 *   name           the name the harness shows for the session, when it has one
 *   nameKind       "native" (harness-assigned/renamed) | "prompt" (derived)
 *   title          what to display: name, else first prompt, else sessionId
 *   firstPrompt    first real user message (clipped), when known
 *   workspacePath  working directory recorded by the harness
 *   workspaceName  last path segment of workspacePath
 *   sessionPath    file (or db#fragment) holding the transcript
 *   sourceFormat   how sessionPath is stored
 *   createdAt / updatedAt   ISO strings
 *   messageCount   number, or null when the scanner did not count
 *   parentSessionId, archived, importedFrom, modelId
 *   importSource   adapter id that can import this session, or null
 *   sig            change signature used to reuse a previous scan
 */
"use strict";

const { baseName, clip, text } = require("./fsx");

/** harness id -> import adapter id (lib/sources). */
const IMPORT_SOURCE = {
  codex: "codex",
  claude: "claude-code",
  pi: "pi",
  zcode: "zcode",
  workbuddy: "workbuddy",
  opencode: "opencode",
};

function mkEntry(harness, sessionId, sessionPath, f = {}) {
  const name = text(f.name);
  const firstPrompt = text(f.firstPrompt) ? clip(f.firstPrompt, 200) : undefined;
  const entry = {
    key: `${harness}:${sessionId}`,
    harness,
    sessionId,
    aliases: f.aliases ?? [],
    name,
    nameKind: name ? "native" : firstPrompt ? "prompt" : "none",
    title: name ?? (firstPrompt ? clip(firstPrompt, 80) : sessionId),
    firstPrompt,
    workspacePath: f.workspacePath,
    workspaceName: baseName(f.workspacePath),
    sessionPath,
    sourceFormat: f.sourceFormat ?? "jsonl",
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    messageCount: typeof f.messageCount === "number" ? f.messageCount : null,
    parentSessionId: f.parentSessionId,
    archived: f.archived === true ? true : undefined,
    internal: f.internal === true ? true : undefined,
    importedFrom: f.importedFrom,
    modelId: f.modelId,
    importSource: f.importSource === undefined ? IMPORT_SOURCE[harness] ?? null : f.importSource,
    sig: f.sig,
  };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  return entry;
}

/** Open a SQLite file read-only; callers must close it. */
function openReadOnly(file) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

function withDb(file, fn) {
  const db = openReadOnly(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

/** Never let one over-long scan run unbounded. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(ms / 1000)} 秒未完成`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { mkEntry, IMPORT_SOURCE, openReadOnly, withDb, columnsOf, withTimeout };
