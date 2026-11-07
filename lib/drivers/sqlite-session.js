"use strict";

const path = require("node:path");
const { makeEntry } = require("../model");
const { projectNameOf } = require("../util");
const { getPath, extractValue, asText, toIso, mapRole } = require("./extract");
const { resolveSafe, exists } = require("./fsutil");
const { unified, mapMessages, converted } = require("./session");
const { normalize } = require("../harnesses/_shared/other");

function openDb(file) { return new (require("node:sqlite").DatabaseSync)(file, { readOnly: true }); }
function ident(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) throw new Error(`invalid SQL identifier: ${value}`);
  return `"${value}"`;
}
function columns(db, table) { return new Set(db.prepare(`PRAGMA table_info(${ident(table)})`).all().map(r => r.name)); }
function order(db, table, candidates) {
  const have = columns(db, table), names = candidates.filter(c => c && have.has(c));
  return names.length ? ` ORDER BY ${[...new Set(names)].map(ident).join(",")}` : "";
}
function payload(row, field) {
  const value = row[field];
  return value == null ? {} : typeof value === "string" ? JSON.parse(value) : value;
}
function excluded(row, rules) {
  return (rules ?? []).find(r => r.in ? r.in.map(String).includes(String(row[r.col])) : r.equals != null && String(row[r.col]) === String(r.equals));
}
async function loadMessages(db, spec, sessionId) {
  const m = spec.message ?? {}, p = spec.part, table = m.table ?? "message";
  const messageRows = db.prepare(`SELECT * FROM ${ident(table)} WHERE ${ident(m.sessionIdCol ?? "session_id") }=?${order(db, table, [m.sequenceCol === null ? null : m.sequenceCol ?? "sequence", m.createdCol ?? "time_created", m.idCol ?? "id"])}`).all(sessionId);
  const parts = new Map();
  if (p) {
    const pt = p.table ?? "part";
    const partRows = db.prepare(`SELECT * FROM ${ident(pt)} WHERE ${ident(p.sessionIdCol ?? "session_id") }=?${order(db, pt, [p.sequenceCol === null ? null : p.sequenceCol ?? "sequence", p.createdCol ?? "time_created", p.idCol ?? "id"])}`).all(sessionId);
    for (const row of partRows) {
      const mid = row[p.messageIdCol ?? "message_id"], bucket = parts.get(mid) ?? [];
      bucket.push(payload(row, p.dataCol ?? "data")); parts.set(mid, bucket);
    }
  }
  const messages = [], records = []; let modelId, providerId;
  for (const row of messageRows) {
    const msg = { ...row, ...payload(row, m.dataCol ?? "data") };
    const role = mapRole(m.roleCol ? row[m.roleCol] : getPath(msg, m.rolePath ?? "role"), m.roleMap);
    const createdAt = toIso(getPath(msg, m.tsPath ?? "time.created") ?? row[m.createdCol ?? "time_created"], spec.tsUnit);
    if (role === "assistant") { modelId = getPath(msg, m.modelIdPath ?? "modelID") ?? modelId; providerId = getPath(msg, m.providerIdPath ?? "providerID") ?? providerId; }
    if (p) {
      for (const part of parts.get(row[m.idCol ?? "id"]) ?? []) {
        if (p.skipSynthetic !== false && part.synthetic) continue;
        const type = part.type;
        if (type === (p.toolType ?? "tool")) {
          const result = extractValue(p.resultPath ?? "state.output", part);
          const state = extractValue(p.statusPath ?? "state.status", part);
          messages.push(unified({ role: "assistant", text: "", createdAt, tools: [{ id: getPath(part, p.idPath ?? "callID") ?? part.id,
            name: String(getPath(part, p.toolNamePath ?? "tool") ?? "tool"), args: extractValue(p.argsPath ?? "state.input", part), result,
            status: ["error", "failed"].includes(state) ? "error" : result != null || ["success", "completed"].includes(state) ? "success" : "pending" }] }));
        } else if ((p.thinkingTypes ?? ["reasoning", "thinking"]).includes(type)) {
          const thought = asText(getPath(part, p.thinkingPath ?? "text"));
          if (thought) messages.push(unified({ role: "assistant", text: "", thinking: [thought], createdAt }));
        } else if (!(p.textTypes ?? ["text"]).length || (p.textTypes ?? ["text"]).includes(type)) {
          const text = asText(getPath(part, p.textPath ?? "text"));
          if (text) messages.push(unified({ role, text, createdAt }));
        }
      }
    } else {
      const content = m.contentCol ? row[m.contentCol] : getPath(msg, m.contentPath ?? "content") ?? msg.parts;
      records.push({ ...msg, role, content, createdAt, timestamp: createdAt, reasoning_content: getPath(msg, m.thinkingPath ?? "reasoning_content") });
    }
  }
  if (!p) messages.push(...await mapMessages(spec.entry, records, path.dirname(resolveSafe(spec.db))));
  return { messages, modelId, providerId };
}
async function scan(spec, sourceId) {
  const file = resolveSafe(spec.db);
  if (!await exists(file)) return [];
  const db = openDb(file), s = spec.session ?? {};
  try {
    const table = s.table ?? "session", have = columns(db, table);
    const limit = Math.max(1, Math.min(100000, Math.trunc(spec.maxSessions ?? 10000)));
    const rows = db.prepare(`SELECT * FROM ${ident(table)}${order(db, table, [s.updatedCol ?? "time_updated", s.idCol ?? "id"])} LIMIT ?`).all(limit);
    const out = [];
    for (const row of rows) {
      const sid = row[s.idCol ?? "id"];
      if (sid == null) continue;
      const loaded = await loadMessages(db, spec, sid);
      const title = String(row[s.titleCol ?? "title"] ?? sid);
      const parentSessionId = row[s.parentCol ?? "parent_id"] || null;
      const branchKind = row[s.branchCol ?? "task_type"] || undefined;
      const rule = excluded(row, (s.exclude ?? []).filter(r => have.has(r.col)));
      const archived = Boolean(row[s.archivedCol ?? "time_archived"]);
      const hiddenReason = row[s.deletedCol ?? "deleted_at"] != null ? "deleted" : archived ? "archived" :
        rule ? rule.reason || (row.task_type === "subagent_child" ? "subagent" : "internal") : branchKind === "subagent_child" ? "subagent" : !loaded.messages.length ? "empty" : null;
      const projectPath = row[s.pathCol ?? "directory"] ?? null;
      out.push(makeEntry({ source: sourceId, harness: sourceId, key: `${sourceId}:${sid}`, sessionId: String(sid), externalId: String(sid),
        filePath: file, sessionPath: `${file}#session_id=${encodeURIComponent(sid)}`, title: [...title].slice(0, 200).join(""), fullTitle: title, name: title, nameKind: "native",
        projectPath, workspacePath: projectPath, projectName: projectNameOf(projectPath) ?? spec.fallbackProject ?? null,
        createdAt: toIso(row[s.createdCol ?? "time_created"], spec.tsUnit), updatedAt: toIso(row[s.updatedCol ?? "time_updated"], spec.tsUnit),
        parentSessionId, branchKind, visible: !hiddenReason, hiddenReason, archived, messageCount: loaded.messages.length, modelId: loaded.modelId, providerId: loaded.providerId }));
    }
    return out;
  } finally { db.close(); }
}
async function convert(spec, summary) {
  const file = resolveSafe(spec.db);
  if (summary.filePath && path.resolve(summary.filePath) !== file) return { session: null, messages: [] };
  const db = openDb(file);
  try {
    const loaded = await loadMessages(db, spec, summary.externalId);
    return converted({ ...summary, modelId: loaded.modelId, providerId: loaded.providerId }, loaded.messages);
  } finally { db.close(); }
}
module.exports = { driver: "sqlite-session", scan, convert, openDb };
