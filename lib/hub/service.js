"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { registry, labelOf } = require("../registry");
const { discover } = require("./discover");
const { yieldNow } = require("../core/fsx");
const { withTimeout } = require("./entry");
const INDEX_VERSION = 5;

function normalizeEntry(entry, h) {
  const importSource = h.id === "pi-desktop" ? null : (entry.importSource ?? h.importSource ?? null);
  return { ...entry, harness: h.id, key: entry.key ?? `${h.id}:${entry.sessionId}`,
    title: entry.title ?? entry.name ?? entry.firstPrompt ?? entry.sessionId,
    importSource, importable: Boolean(importSource && h.capabilities?.import && entry.importable !== false),
    visible: entry.visible ?? !(entry.internal || entry.parentSessionId),
    nativeInHost: h.capabilities?.nativeInHost === true, childCount: 0 };
}

function mergeDuplicate(previous, incoming) {
  if (!previous) return incoming;
  const [latest, older] = String(incoming.updatedAt ?? "") > String(previous.updatedAt ?? "")
    ? [incoming, previous] : [previous, incoming];
  if (latest.nameKind !== "native" && older.nameKind === "native") {
    return { ...latest, title: older.title, name: older.name, nameKind: older.nameKind };
  }
  return latest;
}

function isChildOf(child, parent) {
  if (child.harness !== parent.harness || child.key === parent.key) return false;
  if (child.parentKey) return child.parentKey === parent.key;
  return child.parentSessionId === parent.sessionId && (!child.sourceRoot || !parent.sourceRoot || child.sourceRoot === parent.sourceRoot);
}

function relate(entries) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const byId = new Map();
  for (const e of entries) {
    e.childCount = 0;
    const id = `${e.harness}:${e.sessionId}`;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(e);
  }
  for (const e of entries) {
    if (!e.parentSessionId) continue;
    const parent = e.parentKey ? byKey.get(e.parentKey) : (byId.get(`${e.harness}:${e.parentSessionId}`) ?? []).find((p) => isChildOf(e, p));
    if (parent && isChildOf(e, parent)) parent.childCount++;
  }
  return entries;
}

function renderMarkdown(entries, sources, errors) {
  const lines = ["# 本地 Harness 会话索引", "", `共 ${entries.length} 个会话（含隐藏子会话）。`, ""];
  for (const s of sources) lines.push(`- ${s.label ?? s.harness}（${s.via}）：${s.count} · ${s.root}`);
  for (const e of entries) lines.push(`- ${e.title} — ${e.harness}/${e.sessionId}${e.parentSessionId ? ` ↳ ${e.parentSessionId}` : ""}${e.visible === false ? ` [隐藏：${e.hiddenReason ?? "internal"}]` : ""}`);
  if (errors.length) lines.push("", "## 同步错误", ...errors.map((e) => `- ${e.harness}: ${e.message}`));
  return lines.join("\n") + "\n";
}

// Chunked serialization and asynchronous writes avoid monopolizing the plugin
// event loop. Temporary files are renamed, never physically removed.
async function persist(file, metadata, entries) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx");
  try {
    await handle.writeFile(JSON.stringify(metadata).slice(0, -1) + ',"entries":[');
    for (let i = 0; i < entries.length; i += 100) {
      await handle.writeFile((i ? "," : "") + entries.slice(i, i + 100).map((e) => JSON.stringify(e)).join(","));
      await yieldNow();
    }
    await handle.writeFile("]}\n");
  } finally { await handle.close(); }
  await fs.rename(temp, file);
}

function createHubService({ dataDir, getConfig, home, env, log = () => {} }) {
  const jsonPath = path.join(dataDir, "index.json");
  const mdPath = path.join(dataDir, "index.md");
  let entries = [], sources = [], errors = [];
  let lastSyncAt = null, lastDurationMs = null, lastError = null;
  let pending = null, syncing = false;
  const listeners = new Set();
  const status = () => ({ syncing, lastSyncAt, lastDurationMs, total: entries.length,
    visibleTotal: entries.filter((e) => e.visible !== false).length, sources, errors, lastError,
    indexJsonPath: jsonPath, indexMarkdownPath: mdPath });
  const initialized = (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(jsonPath, "utf8"));
      if (saved.version !== INDEX_VERSION || !Array.isArray(saved.entries)) return;
      entries = relate(saved.entries.filter((e) => registry.get(e.harness)).map((e) => normalizeEntry(e, registry.get(e.harness))));
      sources = saved.sources ?? [];
      lastSyncAt = saved.lastSyncAt ?? null;
      lastDurationMs = saved.lastDurationMs ?? null;
    } catch (error) {
      if (error.code !== "ENOENT") { lastError = "索引缓存不可读，将在同步时重建"; log("index cache unavailable", error); }
    }
  })();

  async function run() {
    await initialized;
    const started = Date.now();
    const config = getConfig();
    const nextErrors = [];
    const found = await discover({ home, env, extraRoots: config.extraRoots, harnesses: config.harnesses,
      report: (harness, error) => nextErrors.push({ harness, message: String(error.message ?? error) }) });
    const next = new Map();
    const used = [];
    for (const hit of found) {
      const h = registry.get(hit.harness);
      const old = entries.filter((e) => e.harness === h.id);
      const ctx = { home, env, previous: new Map(old.map((e) => [e.sessionId, e])),
        byPath: new Map(old.map((e) => [e.sessionPath, e])), yieldNow,
        report: (sessionId, error) => nextErrors.push({ harness: h.id, sessionId, message: String(error?.message ?? error) }) };
      try {
        const got = await withTimeout(Promise.resolve().then(() => h.scan(hit.root, ctx)), 180000, h.id);
        let n = 0;
        for (const raw of got) {
          const e = normalizeEntry(raw, h);
          const previous = next.get(e.key);
          next.set(e.key, mergeDuplicate(previous, e));
          if (++n % 100 === 0) await yieldNow();
        }
        used.push({ ...hit, label: labelOf(h), count: got.length });
      } catch (error) {
        nextErrors.push({ harness: h.id, message: String(error.message ?? error) });
        used.push({ ...hit, count: 0, failed: true });
      }
      await yieldNow();
    }
    const nextEntries = relate([...next.values()].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.key.localeCompare(b.key)));
    const at = new Date().toISOString();
    const duration = Date.now() - started;
    await fs.mkdir(dataDir, { recursive: true });
    const mdTemp = `${mdPath}.${randomUUID()}.tmp`;
    await fs.writeFile(mdTemp, renderMarkdown(nextEntries, used, nextErrors), "utf8");
    await fs.rename(mdTemp, mdPath);
    await persist(jsonPath, { version: INDEX_VERSION, lastSyncAt: at, lastDurationMs: duration, sources: used }, nextEntries);
    entries = nextEntries; sources = used; errors = nextErrors; lastSyncAt = at; lastDurationMs = duration; lastError = null;
  }

  function sync() {
    if (pending) return pending;
    syncing = true;
    pending = run().catch((error) => { lastError = String(error.message ?? error); log("sync failed", error); throw error; })
      .then(() => { syncing = false; return status(); })
      .finally(() => {
        syncing = false; pending = null;
        for (const fn of listeners) { try { fn(status()); } catch (error) { log("index listener failed", error); } }
      });
    return pending;
  }
  return { sync, status, entries: () => entries,
    roots: (harness) => sources.filter((s) => s.harness === harness && !s.failed).map((s) => s.root),
    children: (e) => entries.filter((child) => isChildOf(child, e)),
    onChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    ready: () => pending ?? initialized.then(status) };
}

module.exports = { createHubService, normalizeEntry, mergeDuplicate, relate, isChildOf, renderMarkdown };
