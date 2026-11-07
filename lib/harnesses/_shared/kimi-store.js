"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { makeEntry } = require("../../model");
const { rows, iso, cleanUser, modernMessages, legacyMessages } = require("./kimi-wire");

async function stat(file) {
  try { return await fs.promises.stat(file); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
}

async function json(file, fallback = {}) {
  let text;
  try { text = await fs.promises.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Invalid Kimi JSON: ${file}`); }
}

async function dirs(dir) {
  try { return (await fs.promises.readdir(dir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => path.join(dir, item.name)); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }
}

function normalized(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function qualify(nativeId, root) {
  const suffix = createHash("sha256").update(normalized(root)).digest("hex").slice(0, 12);
  return `${nativeId}@${suffix}`;
}

async function sessionDirs(root) {
  const result = [];
  for (const group of await dirs(path.join(root, "sessions"))) {
    if (path.basename(group).startsWith(".")) continue;
    if (await stat(path.join(group, "state.json")) || await stat(path.join(group, "context.jsonl"))) result.push(group);
    else result.push(...await dirs(group));
  }
  return result;
}

async function modernRoot(root) {
  if (!(await stat(path.join(root, "sessions")))?.isDirectory()) return false;
  if (await stat(path.join(root, "projects.json"))) return true;
  for (const dir of await sessionDirs(root)) {
    if (await stat(path.join(dir, "state.json")) && await stat(path.join(dir, "agents/main/wire.jsonl"))) return true;
  }
  return false;
}

async function legacyRoot(root) {
  for (const dir of await sessionDirs(root)) if (await stat(path.join(dir, "context.jsonl")) || await stat(path.join(dir, "wire.jsonl"))) return true;
  return false;
}

async function discoverLocal(kind, ctx = {}) {
  const home = ctx.home ?? os.homedir(), env = ctx.env ?? process.env;
  const modern = kind === "kimi-code";
  const name = modern ? ".kimi-code" : ".kimi";
  const candidates = [{ root: path.join(home, name), via: "home" }];
  const override = modern ? env.KIMI_CODE_HOME : env.KIMI_HOME;
  if (override) candidates.push({ root: override, via: "env" });
  for (const extra of ctx.extraRoots ?? []) {
    candidates.push({ root: extra, via: "extra" }, { root: path.join(extra, name), via: "extra" });
    for (const child of await dirs(extra)) {
      if ((modern ? /^\.?kimi[-_ ]?code$/i : /^\.?kimi$/i).test(path.basename(child))) candidates.push({ root: child, via: "extra" });
    }
  }
  const found = [], seen = new Set();
  for (const candidate of candidates) {
    if (!(await stat(candidate.root))?.isDirectory()) continue;
    const root = await fs.promises.realpath(candidate.root);
    if (seen.has(normalized(root))) continue;
    seen.add(normalized(root));
    if (modern ? await modernRoot(root) : await legacyRoot(root)) found.push({ root, via: candidate.via });
  }
  return found;
}

async function desktopFiles(base, target) {
  const out = [];
  async function visit(dir) {
    if (target === "home" && path.basename(dir) === "home" && path.basename(path.dirname(dir)) === "kimi-code") {
      if (await modernRoot(dir)) out.push(dir);
      return;
    }
    if (target === "database" && await stat(path.join(dir, "conversations.sqlite"))) out.push(path.join(dir, "conversations.sqlite"));
    for (const child of await dirs(dir)) {
      const name = path.basename(child);
      if (["node_modules", "logs", "cache", ".git", "attachments", "tasks"].includes(name)) continue;
      if (target === "database" && name === "home") continue;
      if (target === "home" && name === "sessions") continue;
      await visit(child);
    }
  }
  await visit(base);
  return out;
}

async function discoverDesktop(ctx = {}) {
  const home = ctx.home ?? os.homedir(), env = ctx.env ?? process.env;
  const appdata = env.APPDATA ?? path.join(home, "AppData/Roaming");
  const bases = [path.join(appdata, "kimi-desktop/daimon-share")];
  const direct = [];
  for (const extra of ctx.extraRoots ?? []) {
    if (path.basename(extra) === "home" && path.basename(path.dirname(extra)) === "kimi-code") direct.push(extra);
    else {
      if (["kimi-desktop", "daimon-share", "daimon"].includes(path.basename(extra))) bases.push(extra);
      bases.push(path.join(extra, "kimi-desktop/daimon-share"));
    }
  }
  const result = [], seen = new Set();
  for (const base of bases) direct.push(...await desktopFiles(base, "home"));
  for (const candidate of direct) {
    if (!await modernRoot(candidate)) continue;
    const root = await fs.promises.realpath(candidate);
    if (seen.has(normalized(root))) continue;
    seen.add(normalized(root));
    result.push({ root, via: "kimi-desktop" });
  }
  return result;
}

async function desktopMetadata(root) {
  let base = root;
  while (path.dirname(base) !== base && path.basename(base) !== "daimon-share") base = path.dirname(base);
  if (path.basename(base) !== "daimon-share") return new Map();
  const result = new Map();
  for (const file of await desktopFiles(base, "database")) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const columns = new Set(db.prepare("PRAGMA table_info(conversations)").all().map(row => row.name));
      const fields = ["kernel_session_id", "kernel_session_dir", "kernel_records_path", "conversation_id", "title", "title_status", "lastPrompt", "last_prompt", "first_user_text", "workspace_path", "created_at", "updated_at", "created_at_ms", "updated_at_ms", "parent_session_id", "deleted", "deleted_at"].filter(name => columns.has(name));
      if (!columns.has("kernel_session_id")) continue;
      for (const row of db.prepare(`SELECT ${fields.map(name => `"${name}"`).join(",")} FROM conversations`).all()) {
        const records = row.kernel_records_path ? path.resolve(path.dirname(file), row.kernel_records_path) : undefined;
        const dir = row.kernel_session_dir ? path.resolve(path.dirname(file), row.kernel_session_dir) : undefined;
        const location = records ?? dir;
        if (location) {
          const relative = path.relative(root, location);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        }
        result.set(row.kernel_session_id, { ...row, kernel_session_dir: dir, kernel_records_path: records });
      }
    } finally { db.close(); }
  }
  return result;
}

function visibility(nativeId, parent, deleted, empty, deletedWorkspace) {
  if (deleted) return "deleted";
  if (parent) return "subagent";
  if (nativeId.startsWith("ctitle-")) return "internal";
  if (deletedWorkspace) return "deleted";
  if (empty) return "empty";
  return null;
}

async function scanModern(harness, inputRoot, ctx = {}) {
  const root = await fs.promises.realpath(inputRoot);
  const index = new Map();
  for await (const { data } of rows(path.join(root, "session_index.jsonl"))) {
    if (typeof data.sessionId === "string") index.set(data.sessionId, { ...index.get(data.sessionId), ...data });
  }
  const candidates = new Map();
  for (const dir of await sessionDirs(root)) candidates.set(path.basename(dir), { dir, hint: index.get(path.basename(dir)) ?? {} });
  for (const [nativeId, hint] of index) {
    if (hint.sessionDir) candidates.set(nativeId, { dir: path.resolve(root, hint.sessionDir), hint });
  }
  const desktop = harness === "kimi-desktop" ? await desktopMetadata(root) : new Map();
  for (const [nativeId, meta] of desktop) {
    if (meta.kernel_session_dir || meta.kernel_records_path) {
      const dir = meta.kernel_session_dir ?? path.dirname(path.dirname(path.dirname(meta.kernel_records_path)));
      candidates.set(nativeId, { dir: path.resolve(root, dir), hint: index.get(nativeId) ?? {} });
    }
  }
  const projects = await json(path.join(root, "projects.json"), null) ?? await json(path.join(root, "workspaces.json"));
  const deletedProjects = new Set(projects.deleted_project_ids ?? projects.deleted_workspace_ids ?? []);
  const entries = [];
  for (const [nativeId, { dir, hint }] of candidates) {
    if (!(await stat(dir))?.isDirectory()) continue;
    const state = await json(path.join(dir, "state.json"));
    const meta = desktop.get(nativeId);
    const file = meta?.kernel_records_path ?? path.join(dir, "agents/main/wire.jsonl");
    const fileStat = await stat(file);
    const stateStat = await stat(path.join(dir, "state.json"));
    if (!fileStat && !stateStat) continue;
    const parsed = await modernMessages(file);
    const users = parsed.filter(message => message.role === "user");
    const parent = state.parentSessionId ?? state.forkedFrom ?? state.custom?.parentSessionId ?? meta?.parent_session_id;
    const workspaceId = state.workspaceId ?? state.projectId ?? hint.workspaceId ?? path.basename(path.dirname(dir));
    const workspace = projects.projects?.[workspaceId] ?? projects.workspaces?.[workspaceId];
    const deleted = hint.deleted === true || state.deleted === true || meta?.deleted === 1 || Boolean(meta?.deleted_at);
    const hiddenReason = visibility(nativeId, parent, deleted, !users.length, deletedProjects.has(workspaceId));
    const lastPrompt = meta?.lastPrompt ?? meta?.last_prompt ?? state.lastPrompt;
    const title = meta ? meta.title ?? lastPrompt ?? nativeId.slice(0, 12)
      : harness === "kimi-desktop" ? lastPrompt ?? nativeId.slice(0, 12) : state.title ?? lastPrompt ?? nativeId.slice(0, 12);
    const sessionId = qualify(nativeId, root);
    const entry = makeEntry({
      key: `${harness}:${sessionId}`, harness, sessionId, nativeSessionId: nativeId, root, sessionPath: file, sessionDir: dir,
      title, name: title, nameKind: meta?.title != null ? (meta.title_status === "generated" ? "generated" : "native") : state.title != null && harness !== "kimi-desktop" ? (state.titleKind === "generated" ? "generated" : state.titleKind === "replaceable" ? "prompt" : "native") : (lastPrompt != null ? "prompt" : "none"),
      firstPrompt: users[0]?.text.slice(0, 200), workspaceId, workspaceName: workspace?.name,
      workspacePath: meta?.workspace_path ?? state.cwd ?? state.workDir ?? hint.workDir ?? workspace?.root,
      createdAt: iso(meta?.created_at ?? meta?.created_at_ms ?? state.createdAt) ?? parsed[0]?.createdAt ?? iso(stateStat?.birthtimeMs),
      updatedAt: iso(meta?.updated_at ?? meta?.updated_at_ms ?? state.updatedAt) ?? iso(fileStat?.mtimeMs ?? stateStat?.mtimeMs),
      archived: state.archived === true, internal: hiddenReason === "internal", visible: hiddenReason === null, hiddenReason,
      importable: Boolean(users.length && !deleted), importSource: harness, messageCount: parsed.length,
      parentSessionId: parent ? qualify(parent, root) : undefined, nativeParentSessionId: parent, childCount: 0,
    });
    entries.push(entry);
    for (const [agentId, agent] of Object.entries(state.agents ?? {})) {
      if (agentId === "main" || agent.type !== "sub") continue;
      const childFile = path.join(dir, "agents", agentId, "wire.jsonl");
      const childStat = await stat(childFile);
      if (!childStat) continue;
      const childId = qualify(`${nativeId}/${agentId}`, root);
      const childMessages = await modernMessages(childFile, { agentId });
      entries.push(makeEntry({
        key: `${harness}:${childId}`, harness, sessionId: childId, nativeSessionId: `${nativeId}/${agentId}`, root, sessionDir: dir, sessionPath: childFile, agentId,
        title: agent.name ?? agentId, name: agent.name ?? agentId, nameKind: agent.name ? "native" : "none",
        workspacePath: entry.workspacePath, createdAt: entry.createdAt, updatedAt: iso(childStat.mtimeMs),
        parentSessionId: agent.parentAgentId && agent.parentAgentId !== "main" ? qualify(`${nativeId}/${agent.parentAgentId}`, root) : sessionId,
        nativeParentSessionId: nativeId, visible: false, hiddenReason: "subagent", internal: true, importable: !deleted && childMessages.length > 0, importSource: harness, messageCount: childMessages.length,
      }));
    }
    await ctx.yieldNow?.();
  }
  const byId = new Map(entries.map(entry => [entry.sessionId, entry]));
  for (const entry of entries) if (byId.has(entry.parentSessionId)) byId.get(entry.parentSessionId).childCount = (byId.get(entry.parentSessionId).childCount ?? 0) + 1;
  return entries;
}

async function scanLegacy(inputRoot, ctx = {}) {
  const root = await fs.promises.realpath(inputRoot);
  const entries = [];
  for (const dir of await sessionDirs(root)) {
    const file = path.join(dir, "wire.jsonl"), contextFile = path.join(dir, "context.jsonl");
    const fileStat = await stat(file), contextStat = await stat(contextFile);
    if (!fileStat && !contextStat) continue;
    const state = await json(path.join(dir, "state.json"));
    const createdAt = iso(state.createdAt ?? (fileStat ?? contextStat).birthtimeMs);
    const parsed = await legacyMessages(file, contextFile, { createdAt });
    const users = parsed.filter(message => message.role === "user");
    const nativeId = path.basename(dir), sessionId = qualify(nativeId, root);
    const parent = state.parentSessionId ?? state.forkedFrom;
    const hiddenReason = visibility(nativeId, parent, state.deleted === true, !users.length, false);
    const nativeTitle = state.custom_title == null ? null : cleanUser(state.custom_title);
    const title = nativeTitle || users[0]?.text.slice(0, 200) || nativeId.slice(0, 12);
    entries.push(makeEntry({
      key: `kimi-legacy:${sessionId}`, harness: "kimi-legacy", sessionId, nativeSessionId: nativeId, root, sessionDir: dir,
      sessionPath: fileStat ? file : contextFile, contextFile, sourceFormat: fileStat ? "kimi-legacy-wire" : "kimi-legacy-context",
      title, name: title, nameKind: nativeTitle ? "native" : users.length ? "prompt" : "none", firstPrompt: users[0]?.text.slice(0, 200),
      workspacePath: state.cwd ?? state.workDir, createdAt: parsed[0]?.createdAt ?? createdAt,
      updatedAt: iso(state.updatedAt ?? (fileStat ?? contextStat).mtimeMs), timestampSource: fileStat ? "wire" : "filesystem",
      messageCount: parsed.length, visible: hiddenReason === null, hiddenReason, archived: state.archived === true,
      importSource: "kimi-legacy", importable: users.length > 0 && state.deleted !== true,
      parentSessionId: parent ? qualify(parent, root) : undefined, nativeParentSessionId: parent,
    }));
    const parentEntry = entries[entries.length - 1];
    parentEntry.childCount = 0;
    for (const childDir of await dirs(path.join(dir, "subagents"))) {
      const childContext = path.join(childDir, "context.jsonl");
      const childWire = path.join(childDir, "wire.jsonl");
      const childStat = await stat(childWire) ?? await stat(childContext);
      if (!childStat) continue;
      const agentId = path.basename(childDir);
      const childId = qualify(`${nativeId}/${agentId}`, root);
      const childMessages = await legacyMessages(childWire, childContext, { createdAt: parentEntry.createdAt });
      entries.push(makeEntry({
        key: `kimi-legacy:${childId}`, harness: "kimi-legacy", sessionId: childId, nativeSessionId: `${nativeId}/${agentId}`, root,
        sessionDir: childDir, sessionPath: await stat(childWire) ? childWire : childContext, agentId,
        title: agentId, name: agentId, nameKind: "none", createdAt: parentEntry.createdAt, updatedAt: iso(childStat.mtimeMs),
        parentSessionId: sessionId, nativeParentSessionId: nativeId, workspacePath: parentEntry.workspacePath,
        visible: false, hiddenReason: "subagent", internal: true, importSource: "kimi-legacy", importable: state.deleted !== true && childMessages.length > 0, messageCount: childMessages.length,
      }));
      parentEntry.childCount++;
    }
    await ctx.yieldNow?.();
  }
  return entries;
}

async function messages(entry, ctx = {}) {
  if (entry.harness === "kimi-legacy") {
    const dir = entry.sessionDir ?? path.dirname(entry.sessionPath);
    return legacyMessages(path.join(dir, "wire.jsonl"), path.join(dir, "context.jsonl"), { ...ctx, createdAt: entry.createdAt });
  }
  return modernMessages(entry.sessionPath, { ...ctx, agentId: entry.agentId ?? "main" });
}

module.exports = { discoverLocal, discoverDesktop, scanModern, scanLegacy, messages };
