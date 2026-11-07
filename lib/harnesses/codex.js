"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { makeEntry } = require("../model");
const { parseTime } = require("../core/time");
const { yieldNow } = require("../core/fsx");
const { readStateDb, readCatalogDb } = require("./_shared/codex-sqlite");
const { cleanPath, sourceInfo, readRows, inspectRollout, userRequest, injected } = require("./_shared/codex-rollout");
const { messages } = require("./_shared/codex-messages");
const { resolveRollout } = require("./_shared/codex-paths");

const id = "codex";
const label = { en: "Codex", "zh-CN": "Codex" };
const capabilities = { import: true, nativeInHost: false, children: true };
const ROLLOUT = /^rollout-.*\.jsonl(?:\.zst)?$/i;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const THREAD_ID = new RegExp(`-(${UUID})(?:_${UUID})?\\.jsonl(?:\\.zst)?$`, "i");

async function list(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }
}

async function stat(file) {
  try { return await fs.stat(file); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
}

function pathKey(file) {
  const resolved = path.resolve(cleanPath(file));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function discover(ctx = {}) {
  const home = ctx.home ?? os.homedir(), env = ctx.env ?? process.env;
  const candidates = [{ root: path.join(home, ".codex"), via: "home" }];
  if (env.CODEX_HOME) candidates.push({ root: cleanPath(env.CODEX_HOME), via: "CODEX_HOME" });
  for (const extra of ctx.extraRoots ?? []) {
    candidates.push({ root: extra, via: "extra" }, { root: path.join(extra, ".codex"), via: "extra" });
  }
  const found = [], seen = new Set();
  for (const candidate of candidates) {
    let root = path.resolve(cleanPath(candidate.root));
    if (["sessions", "archived_sessions"].includes(path.basename(root))) root = path.dirname(root);
    const names = await list(root);
    const hasIndex = names.some((entry) => /^state_\d+\.sqlite$/.test(entry.name) || entry.name === "session_index.jsonl");
    const hasSessions = names.some((entry) => entry.isDirectory() && ["sessions", "archived_sessions"].includes(entry.name));
    let identified = hasIndex || (hasSessions && (candidate.via === "CODEX_HOME" || path.basename(root).toLowerCase().includes("codex")));
    if (!identified && hasSessions) {
      for (const directory of ["sessions", "archived_sessions"]) {
        for await (const _file of rolloutFiles(path.join(root, directory))) { identified = true; break; }
        if (identified) break;
      }
    }
    if (!identified) continue;
    root = await fs.realpath(root);
    if (seen.has(pathKey(root))) continue;
    seen.add(pathKey(root));
    found.push({ root, via: candidate.via });
  }
  return found;
}

async function* rolloutFiles(dir) {
  for (const entry of await list(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* rolloutFiles(full);
    else if (entry.isFile() && ROLLOUT.test(entry.name)) yield full;
  }
}


function childLabel(entry) {
  return entry.agentPath?.replace(/^\/root\//, "") ||
    (entry.agentNickname ? `${entry.agentNickname}${entry.agentRole ? ` (${entry.agentRole})` : ""}` : entry.sessionId);
}

async function scan(inputRoot, ctx = {}) {
  const root = await fs.realpath(cleanPath(inputRoot));
  const files = await list(root);
  const dbName = files.filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
    .sort((a, b) => Number(b.name.match(/\d+/)[0]) - Number(a.name.match(/\d+/)[0]))[0]?.name;
  // A broken or unsupported state DB is an explicit scan failure, never an
  // apparently successful empty index or an undisclosed filesystem downgrade.
  const state = dbName ? await readStateDb(path.join(root, dbName)) : { threads: [], edges: [] };
  const catalogPath = path.join(root, "sqlite", "codex.db");
  const catalog = (await stat(catalogPath))?.isFile() ? await readCatalogDb(catalogPath) : { available: false, threads: [] };
  const gui = new Map(catalog.threads.map((row) => [row.thread_id, row]));
  const cached = new Map();
  for (const previous of ctx.previous?.values() ?? []) {
    if (previous.sourceRoot && pathKey(previous.sourceRoot) === pathKey(root)) {
      for (const segment of previous.rolloutScan ?? []) cached.set(pathKey(segment.path), segment);
    }
  }
  const rows = new Map(state.threads.map((row) => [row.id, row]));
  const parents = new Map(state.edges.map((edge) => [edge.child_thread_id, edge.parent_thread_id]));
  const names = new Map();
  if (files.some((entry) => entry.name === "session_index.jsonl")) {
    for await (const row of readRows(path.join(root, "session_index.jsonl"))) {
      if (typeof row?.id === "string") names.set(row.id, row);
    }
  }
  const paths = new Map();
  for (const directory of ["sessions", "archived_sessions"]) {
    for await (const candidate of rolloutFiles(path.join(root, directory))) {
      const file = await resolveRollout(candidate, [root]);
      paths.set(pathKey(file), { path: file });
    }
  }
  for (const row of state.threads) {
    const file = await resolveRollout(row.rollout_path, [root], { allowMissing: true });
    if (file) paths.set(pathKey(file), { ...paths.get(pathKey(file)), path: file, stateId: row.id });
  }
  // If an active JSONL and its compressed copy coexist, prefer the active file.
  for (const key of paths.keys()) if (key.endsWith(".zst") && paths.has(key.slice(0, -4))) paths.delete(key);
  const groups = new Map();
  let processed = 0;
  for (const descriptor of paths.values()) {
    const guessedId = descriptor.stateId ?? THREAD_ID.exec(path.basename(descriptor.path))?.[1];
    const row = rows.get(guessedId);
    let info, fingerprint;
    try {
      const stats = await stat(descriptor.path);
      if (!stats) throw Object.assign(new Error("Codex rollout disappeared during scan"), { code: "ENOENT" });
      fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
      const source = sourceInfo(row?.source);
      const needUser = !catalog.available && !row?.archived && !source?.subagent && !["subagent", "guardian_review"].includes(row?.thread_source);
      const full = !parseTime(row?.updated_at_ms ?? row?.updated_at);
      const previous = cached.get(pathKey(descriptor.path));
      if (previous?.version === 1 && previous.fingerprint === fingerprint && !previous.info.readError &&
          (!full || previous.info.complete) && (!needUser || previous.info.hasUserEvent || previous.info.complete)) info = previous.info;
      else info = await inspectRollout(descriptor.path, { probe: true, needUser, full });
    } catch (error) {
      if (!guessedId) throw error;
      ctx.report?.(guessedId, error);
      info = { meta: {}, readError: error.code ?? "CODEX_ROLLOUT_READ" };
    }
    const sessionId = info.meta.id ?? guessedId;
    if (!sessionId) throw Object.assign(new Error("Codex rollout has no session identity"), { code: "CODEX_ROLLOUT_ID" });
    const group = groups.get(sessionId) ?? [];
    group.push({ ...descriptor, ...info, fingerprint });
    groups.set(sessionId, group);
    if (++processed % 50 === 0) await (ctx.yieldNow ?? yieldNow)();
  }
  const defaultRoot = path.join(ctx.home ?? os.homedir(), ".codex");
  const suffix = pathKey(root) === pathKey(defaultRoot) ? "" : `@${createHash("sha256").update(pathKey(root)).digest("hex").slice(0, 12)}`;
  const entries = [];
  for (const sessionId of new Set([...rows.keys(), ...groups.keys()])) {
    const row = rows.get(sessionId) ?? {};
    const segments = groups.get(sessionId) ?? [];
    segments.sort((a, b) => (a.ordinal != null && b.ordinal != null ? a.ordinal - b.ordinal : 0) ||
      String(a.createdAt ?? path.basename(a.path)).localeCompare(String(b.createdAt ?? path.basename(b.path))) || a.path.localeCompare(b.path));
    const meta = segments[0]?.meta ?? {};
    const source = sourceInfo(row.source ?? meta.source);
    const spawn = source?.subagent?.thread_spawn ?? {};
    const parentSessionId = parents.get(sessionId) ?? row.parent_thread_id ?? meta.parent_thread_id ?? spawn.parent_thread_id;
    const threadSource = row.thread_source ?? meta.thread_source;
    const guardian = source?.subagent?.other === "guardian" || threadSource === "guardian_review";
    const internal = !!source?.subagent || threadSource === "subagent" || guardian || !!parentSessionId;
    const archived = row.archived != null ? !!row.archived : segments.every((segment) => segment.path.split(path.sep).includes("archived_sessions"));
    const first = row.first_user_message || segments.find((segment) => segment.firstPrompt)?.firstPrompt || "";
    const firstPrompt = injected(userRequest(first)) ? "" : userRequest(first);
    const hasUserEvent = segments.some((segment) => segment.hasUserEvent);
    const hasContent = segments.some((segment) => segment.meaningful);
    const readErrors = segments.filter((segment) => segment.readError).map((segment) => segment.readError);
    const importable = segments.length > 0 && hasContent && readErrors.length === 0;
    const nativeName = gui.get(sessionId)?.display_title || names.get(sessionId)?.thread_name || row.name;
    const agentPath = row.agent_path ?? meta.agent_path ?? spawn.agent_path;
    const agentNickname = row.agent_nickname ?? meta.agent_nickname ?? spawn.agent_nickname;
    const agentRole = row.agent_role ?? meta.agent_role ?? spawn.agent_role;
    const promptTitle = !internal && !injected(userRequest(row.title || "")) ? userRequest(row.title || "") : "";
    const name = nativeName || (internal ? childLabel({ sessionId, agentPath, agentNickname, agentRole }) : promptTitle || firstPrompt || sessionId);
    const createdAt = parseTime(row.created_at_ms ?? row.created_at) ?? parseTime(meta.timestamp) ?? segments[0]?.createdAt;
    const updatedAt = [parseTime(row.updated_at_ms ?? row.updated_at), parseTime(names.get(sessionId)?.updated_at), ...segments.map((segment) => segment.updatedAt), createdAt].filter(Boolean).sort().at(-1);
    const guiVisible = catalog.available ? gui.has(sessionId) : hasUserEvent;
    const hiddenReason = guardian ? "internal" : internal ? "subagent" : archived ? "archived" :
      !guiVisible ? (hasContent ? "not-in-gui" : "empty") : null;
    entries.push(makeEntry({
      harness: id, key: `${id}:${sessionId}${suffix}`, sessionId, externalId: `${sessionId}${suffix}`, sourceRoot: root,
      sessionPath: segments.at(-1)?.path ?? `${path.join(root, dbName ?? "state.sqlite")}#${sessionId}`,
      segmentPaths: segments.map((segment) => segment.path), segmentCount: segments.length,
      title: [...name].slice(0, 200).join(""), name, firstPrompt: [...firstPrompt].slice(0, 200).join(""),
      nameKind: nativeName ? "native" : internal ? "generated" : promptTitle || firstPrompt ? "prompt" : "none",
      workspacePath: cleanPath(row.cwd ?? meta.cwd), modelId: row.model ?? segments.at(-1)?.modelId,
      reasoningEffort: row.reasoning_effort ?? segments.at(-1)?.reasoningEffort, createdAt, updatedAt,
      archived, internal, visible: hiddenReason == null, hiddenReason, hasUserEvent,
      visibilitySource: catalog.available ? "gui-catalog" : "rollout-user-event", stateHasUserEvent: row.has_user_event, hasContent,
      parentSessionId: parentSessionId && parentSessionId !== sessionId ? parentSessionId : undefined,
      parentKey: parentSessionId ? `${id}:${parentSessionId}${suffix}` : undefined, agentPath, agentNickname, agentRole,
      importSource: "codex", importable, missingRollout: segments.length === 0,
      importBlockedReason: importable ? null : !segments.length ? "missing-rollout" : readErrors.length ? "read-error" : "empty",
      readErrors, children: [], childCount: 0,
      rolloutScan: segments.map(({ path: file, fingerprint, ...segment }) => ({
        path: file, fingerprint, version: 1, info: {
          meta: Object.fromEntries(["id", "cwd", "timestamp", "source", "thread_source", "parent_thread_id", "agent_path", "agent_nickname", "agent_role"].filter((key) => segment.meta[key] != null).map((key) => [key, segment.meta[key]])),
          ordinal: segment.ordinal, firstPrompt: segment.firstPrompt, createdAt: segment.createdAt, updatedAt: segment.updatedAt,
          modelId: segment.modelId, reasoningEffort: segment.reasoningEffort, meaningful: segment.meaningful,
          hasUserEvent: segment.hasUserEvent, complete: segment.complete, readError: segment.readError,
        },
      })),
    }));
  }
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]));
  for (const entry of entries) {
    const parent = byId.get(entry.parentSessionId);
    if (!parent) continue;
    parent.children.push({ harness: id, sessionId: entry.sessionId, key: entry.key, label: childLabel(entry), agentPath: entry.agentPath });
    parent.childCount++;
  }
  return entries.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.key.localeCompare(b.key));
}

module.exports = { id, label, order: 10, importSource: "codex", aliases: [], schemes: ["codex://"], capabilities, discover, scan, messages };
