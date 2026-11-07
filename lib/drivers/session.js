"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { makeEntry, makeMessage } = require("../model");
const { parseTime } = require("../core/time");
const { renderMessage } = require("../hub/render");
const { getPath, extractText, toIso } = require("./extract");
const { resolveSafe, isInside, readText, parseLines } = require("./fsutil");
const { mapEntries } = require("./entry-map");
const { normalize, rows } = require("../harnesses/_shared/other");

function unified(message) {
  const tool = message.role === "tool";
  const m = makeMessage({ ...message, role: tool ? "assistant" : message.role, text: tool ? "" : (message.text ?? message.content ?? ""),
    ...(tool ? { tools: [{ id: message.toolCallId, name: message.toolName ?? "tool", args: message.toolArgs, result: message.toolResult ?? message.content,
      status: message.toolStatus === "error" ? "error" : message.toolStatus === "running" ? "pending" : "success" }] } : {}) });
  if (typeof m.thinking === "string") m.thinking = [m.thinking];
  // Retain the old content field for existing adapter/Forge consumers.
  m.content = renderMessage(m, { toolDetail: "full" });
  return m;
}
async function mapMessages(rule, records, root) {
  return (rule && Object.keys(rule).length ? await mapEntries(rule, records, { root }) : normalize(records)).map(unified);
}
function pick(rule, records) {
  if (!rule) return "";
  if (Array.isArray(rule.first)) {
    for (const r of rule.first) { const v = pick(r, records); if (v) return v; }
    return "";
  }
  const last = rule.lastEntry;
  const list = last ? [...records].reverse() : records;
  for (const r of list) {
    const match = last?.match;
    if (match && !(match.in ? match.in.includes(getPath(r, match.path)) : getPath(r, match.path) === match.equals)) continue;
    const v = extractText(last?.path ?? rule, r);
    if (v) return v;
  }
  return "";
}
async function sidecar(spec, file, root) {
  const s = spec.sidecar ?? spec.session?.sidecar;
  if (!s?.path) return { rule: {}, data: {} };
  const stem = path.basename(file).replace(/\.jsonl?(?:\.zstd?|\.zst)?$/, "");
  const name = s.path.replace(/\{(dir|file|stem|basename|root)\}/g, (_, k) => ({ dir: path.dirname(file), file, stem, basename: path.basename(file), root })[k]);
  const full = path.resolve(path.dirname(file), name);
  if (!isInside(full, root)) throw new Error("Sidecar is outside the source root");
  let raw;
  try {
    if (!isInside(await fs.realpath(full), await fs.realpath(root))) throw new Error("Sidecar resolves outside the source root");
    raw = await readText(full, spec.maxBytes);
  } catch (e) { if (e.code === "ENOENT") return { rule: s, data: {} }; throw e; }
  return { rule: s, data: raw == null ? {} : JSON.parse(raw) };
}
async function loadFile(spec, file, format) {
  const root = resolveSafe(spec.root);
  if (!isInside(file, root) || !isInside(await fs.realpath(file), await fs.realpath(root))) throw new Error("Session is outside the source root");
  let records, doc;
  if (format === "jsonl" && /\.(zstd|zst)$/.test(file)) { records = await rows(file); doc = records[0] ?? {}; }
  else {
    const raw = await readText(file, spec.maxBytes);
    if (raw == null) return null;
    if (format === "jsonl") { records = parseLines(raw, spec.maxLines); doc = records[0] ?? {}; }
    else { doc = JSON.parse(raw); records = Array.isArray(doc) ? doc : getPath(doc, spec.session?.messagesPath ?? "messages") ?? []; }
  }
  const messages = await mapMessages(format === "jsonl" ? spec.entry : spec.message, records, root);
  return { records, doc, messages, side: await sidecar(spec, file, root), stat: await fs.stat(file) };
}
function summary(spec, sourceId, file, loaded, format) {
  const s = spec.session ?? {}, { records, doc, messages, side, stat } = loaded;
  const base = path.basename(file).replace(/\.jsonl?(?:\.zstd?|\.zst)?$/, "");
  const documents = format === "jsonl" ? records : [doc];
  const sideValue = key => getPath(side.data, side.rule[key]);
  let id = s.idFrom === "parentDir" || spec.sessionDir ? path.basename(path.dirname(file)) : base;
  if (s.idPath) id = getPath(doc, s.idPath) ?? id;
  else if (format === "json") id = doc.id ?? id;
  if (s.idFrom && !["parentDir", "filename"].includes(s.idFrom)) {
    const match = s.idFromEntry;
    const preferred = match?.in ? records.filter(r => match.in.includes(getPath(r, match.path))) : records;
    id = pick(s.idFrom, preferred) || pick(s.idFrom, records) || id;
  }
  id = String(sideValue("idPath") ?? id);
  const native = sideValue("titlePath") || (format === "json" ? getPath(doc, s.titlePath ?? "title") : s.titleFrom && !["firstUser", "filename"].includes(s.titleFrom) ? pick(s.titleFrom, records) : "");
  const prompt = messages.find(m => m.role === "user" && !["injected", "noise"].includes(m.kind) && m.text)?.text;
  const title = String(native || (s.titleFrom === "filename" ? base : prompt) || base);
  const projectPath = sideValue("cwdPath") ?? sideValue("pathPath") ?? (s.pathPath ? getPath(doc, s.pathPath) : format === "json" ? doc.directory : null) ??
    (s.projectFrom && s.projectFrom !== "parentDir" ? pick(s.projectFrom, documents) : null) ?? path.dirname(file);
  const parentSessionId = sideValue("parentPath") || pick(s.parentFrom ?? s.parentPath, documents) || null;
  const branchKind = sideValue("branchPath") || pick(s.branchFrom, documents) || undefined;
  const excluded = (Array.isArray(s.excludeWhen) ? s.excludeWhen : s.excludeWhen ? [s.excludeWhen] : []).find(rule => documents.some(r => rule.in ? rule.in.includes(getPath(r, rule.path)) : getPath(r, rule.path) === rule.equals));
  const visibleMessages = messages.filter(m => !["injected", "noise"].includes(m.kind));
  const flagged = value => value != null && ![false, 0, "", "false", "0"].includes(value);
  const archived = flagged(sideValue("archivedPath")) || flagged(pick(s.archivedFrom, documents));
  const hiddenReason = flagged(sideValue("deletedPath")) || flagged(pick(s.deletedFrom, documents)) ? "deleted" : archived ? "archived" :
    excluded ? excluded.reason || "internal" : flagged(sideValue("subagentPath")) || flagged(pick(s.subagentFrom, documents)) || (parentSessionId && !branchKind) ? "subagent" : !visibleMessages.length ? "empty" : null;
  const date = v => toIso(v, spec.tsUnit) ?? parseTime(v);
  const createdAt = date(sideValue("createdPath") ?? getPath(doc, s.tsPath ?? "createdAt")) ?? messages.find(m => m.createdAt)?.createdAt ?? stat.mtime.toISOString();
  const updatedAt = date(sideValue("updatedPath") ?? getPath(doc, s.updatedPath ?? "updatedAt")) ?? messages.findLast(m => m.createdAt)?.createdAt ?? stat.mtime.toISOString();
  return makeEntry({ source: sourceId, harness: sourceId, key: `${sourceId}:${id}`, externalId: id, sessionId: id, filePath: file, sessionPath: file,
    title: [...title].slice(0, 200).join(""), fullTitle: title, name: native ? String(native) : undefined, nameKind: native ? "native" : prompt ? "prompt" : "none",
    projectPath, workspacePath: projectPath, projectName: typeof projectPath === "string" ? path.basename(projectPath) : s.fallbackProject ?? null,
    createdAt, updatedAt, messageCount: visibleMessages.length, visible: !hiddenReason, hiddenReason, archived, parentSessionId, branchKind, modelId: null, providerId: null });
}
function converted(s, messages) {
  return { session: { id: `import-${s.source}-${s.externalId}`, title: s.fullTitle || s.title, projectPath: s.projectPath ?? null, modelId: s.modelId ?? null,
    providerId: s.providerId ?? null, mode: "agent", createdAt: s.createdAt, updatedAt: s.updatedAt }, messages };
}
module.exports = { unified, mapMessages, pick, loadFile, summary, converted };
