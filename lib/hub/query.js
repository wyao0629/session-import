"use strict";

const { registry } = require("../registry");
const norm = (s) => String(s ?? "").toLowerCase();
const normPath = (s) => norm(s).replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
const stripPrefix = (id) => norm(id).replace(/^session[-_]/, "");
function schemes() {
  const out = { pi: "pi", "native-pi": "pi" };
  for (const h of registry.list()) for (const name of [h.id, ...(h.aliases ?? []), ...(h.schemes ?? [])]) out[name.replace(/:\/\/$/, "")] = h.id;
  return out;
}
function brief(e) {
  return { key: e.key, harness: e.harness, sessionId: e.sessionId, externalId: e.externalId ?? e.sessionId, title: e.title, name: e.name ?? null, nameKind: e.nameKind,
    firstPrompt: e.firstPrompt ?? null, workspacePath: e.workspacePath ?? null, sessionPath: e.sessionPath,
    createdAt: e.createdAt ?? null, updatedAt: e.updatedAt ?? null, messageCount: e.messageCount ?? null,
    parentSessionId: e.parentSessionId ?? null, parentKey: e.parentKey ?? null, childCount: e.childCount ?? 0, visible: e.visible !== false, hiddenReason: e.hiddenReason ?? null,
    archived: e.archived === true, internal: e.internal === true, importedFrom: e.importedFrom ?? null,
    importable: e.importable === true, nativeInHost: e.nativeInHost === true };
}
function fieldScore(e, token) {
  const id = norm(e.sessionId);
  if (id === token || (e.aliases ?? []).some((a) => norm(a) === token)) return 100;
  if (id.startsWith(token) || stripPrefix(id).startsWith(token)) return 60;
  if (norm(e.name).includes(token)) return 50;
  if (norm(e.title).includes(token)) return 40;
  if (norm(e.workspacePath).includes(token) || norm(e.workspaceName).includes(token)) return 25;
  if (norm(e.firstPrompt).includes(token)) return 20;
  if (id.includes(token)) return 15;
  if (normPath(e.sessionPath).includes(token)) return 10;
  return 0;
}
function search(entries, q = {}) {
  const tokens = norm(q.query).split(/\s+/).filter(Boolean);
  const since = Date.parse(q.since ?? ""), until = Date.parse(q.until ?? "");
  const harness = registry.get(q.harness)?.id ?? q.harness;
  const limit = Math.max(1, Math.min(Number(q.limit) || 20, q.maxLimit || 200));
  const offset = Math.max(0, Math.floor(Number(q.offset) || 0));
  const hits = [];
  for (const e of entries) {
    if (harness && e.harness !== harness) continue;
    if (q.parentSessionId && e.parentSessionId !== q.parentSessionId) continue;
    if (!q.includeHidden && !q.parentSessionId && e.visible === false) continue;
    if (q.workspace && !norm(e.workspacePath).includes(norm(q.workspace)) && !norm(e.workspaceName).includes(norm(q.workspace))) continue;
    if (!Number.isNaN(since) && !(Date.parse(e.updatedAt ?? "") >= since)) continue;
    if (!Number.isNaN(until) && !(Date.parse(e.updatedAt ?? "") <= until)) continue;
    if (q.includeArchived === false && e.archived) continue;
    const scores = tokens.map((t) => fieldScore(e, t));
    if (scores.every(Boolean)) hits.push({ e, score: scores.reduce((a, b) => a + b, 0) });
  }
  hits.sort((a, b) => b.score - a.score || String(b.e.updatedAt ?? "").localeCompare(String(a.e.updatedAt ?? "")));
  return { total: hits.length, offset, sessions: hits.slice(offset, offset + limit).map(({ e }) => brief(e)) };
}
function parseRef(ref) {
  const raw = String(ref ?? "").trim().replace(/^["'<`]+|["'>`]+$/g, "");
  const out = { raw, hint: undefined, tokens: [], path: undefined };
  const url = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  let body = url ? url[2] : raw;
  try { body = decodeURIComponent(body); } catch { /* literal malformed URI */ }
  if (url) {
    out.hint = schemes()[url[1].toLowerCase()];
    if (/^file$/i.test(url[1])) out.path = body.replace(/^\/([a-z]:)/i, "$1");
  }
  if (!out.path && (/^[a-z]:[\\/]/i.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\") || /\.(jsonl|json|sqlite|zst|zstd)(#.*)?$/i.test(raw))) out.path = raw;
  out.tokens = [...new Set([norm(body), ...body.split(/[^A-Za-z0-9_-]+/).filter((t) => t.length >= 6).map(norm)])];
  return out;
}
function resolve(entries, ref, opts = {}) {
  const p = parseRef(ref);
  const hint = opts.harness ?? p.hint;
  const harness = registry.get(hint)?.id ?? hint;
  const pool = harness ? entries.filter((e) => e.harness === harness) : entries;
  const done = (how, list) => ({ how, ambiguous: list.length > 1, matches: list.map(brief) });
  const exactKey = pool.filter((e) => e.key === p.raw || e.nativeSessionId === p.raw || (e.externalId !== e.sessionId && e.externalId === p.raw));
  if (exactKey.length) return done("id", exactKey);
  if (p.path) {
    const want = normPath(p.path);
    const exact = pool.filter((e) => normPath(e.sessionPath) === want);
    if (exact.length) return done("path", exact);
    const file = want.split("#")[0];
    if (file.length >= 6 && file.includes("/")) {
      const match = pool.filter((e) => normPath(e.sessionPath).split("#")[0] === file);
      if (match.length) return done("path", match);
    }
  }
  for (const token of p.tokens) {
    const hits = pool.filter((e) => norm(e.sessionId) === token || stripPrefix(e.sessionId) === stripPrefix(token) || (e.aliases ?? []).some((a) => norm(a) === token));
    if (hits.length) return done(harness ? "link" : "id", hits);
  }
  for (const token of p.tokens.filter((t) => t.length >= 8)) {
    const hits = pool.filter((e) => stripPrefix(e.sessionId).startsWith(stripPrefix(token)) || (e.aliases ?? []).some((a) => norm(a).startsWith(token)));
    if (hits.length) return done("prefix", hits);
  }
  return done("none", []);
}
module.exports = { search, resolve, parseRef, brief, get SCHEME_HARNESS() { return schemes(); } };
