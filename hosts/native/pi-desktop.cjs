"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

function defaultRoot({ home = os.homedir(), env = process.env } = {}) {
  return path.resolve(home, env.PI_DESKTOP_DATA_DIR || ".pi-desktop");
}

function workspacePath(value) {
  let resolved = path.resolve(value).split(String.fromCharCode(92)).join("/");
  if (resolved.startsWith("//?/UNC/")) resolved = `//${resolved.slice(8)}`;
  else if (resolved.startsWith("//?/")) resolved = resolved.slice(4);
  return resolved;
}

function timestamp(value, fallback) {
  if (value == null || value === "") return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("PI-Desktop import: invalid timestamp");
  return date.toISOString();
}

// Installed Desktop writer: out/main/chunks/index-CrUJHd1c.js forwards imports
// to host-core plugin_sessions.rs; sessions.rs indexes MessageRecord rows and
// transcripts.rs persists schema-1 JSONL. This is not Pi CLI's message tree.
// The native session catalog is sessions JOIN projects (last_seq is the count),
// not a separate catalog table. The existing messages_ai trigger indexes FTS.
async function importWithSqlite({ entry = {}, messages, rawMessages, destination = {}, title, mode, options = {} }, { DatabaseSync }) {
  if (typeof destination.workspace !== "string" || !destination.workspace.trim()) {
    throw new Error("PI-Desktop import: destination.workspace is required");
  }
  if (!Array.isArray(messages) || !messages.length) throw new Error("PI-Desktop import: messages are required");
  const root = path.resolve(destination.root || defaultRoot());
  const workspace = workspacePath(destination.workspace);
  const standalone = (destination.placement ?? options.placement) === "standalone";
  const requestedProjectId = destination.projectId == null ? null : Number(destination.projectId);
  if (requestedProjectId != null && (!Number.isSafeInteger(requestedProjectId) || requestedProjectId <= 0)) {
    throw new Error("PI-Desktop import: projectId must be a positive integer");
  }
  const name = title ?? entry.name ?? entry.title ?? "Imported session";
  if (typeof name !== "string") throw new Error("PI-Desktop import: title must be a string");
  const initialTime = timestamp(entry.createdAt ?? messages[0]?.createdAt, new Date().toISOString());
  let createdMs = Date.parse(initialTime);
  let updatedMs = Date.parse(timestamp(entry.updatedAt, initialTime));
  let previousTime = initialTime;
  // Keep every supplied message, including empty content, in its original order.
  // rawMessages is not re-rendered: messages already contains the complete text.
  const records = messages.map(message => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new Error("PI-Desktop import: each message needs a user/assistant role and string content");
    }
    const createdAt = timestamp(message.createdAt, previousTime);
    previousTime = createdAt;
    createdMs = Math.min(createdMs, Date.parse(createdAt));
    updatedMs = Math.max(updatedMs, Date.parse(createdAt));
    return {
      type: "message", id: randomUUID(), role: message.role,
      blocks: [{ type: "text", text: message.content }],
      meta: { status: "complete" }, createdAt,
    };
  });
  updatedMs = Math.max(updatedMs, createdMs);
  const databasePath = path.join(root, "pi.sqlite");
  // Only the installed host creates/migrates its database. Never manufacture an
  // empty pi.sqlite when the selected data root has not been initialized.
  if (!(await fs.stat(databasePath)).isFile()) throw new Error(`PI-Desktop database is not a file: ${databasePath}`);
  const sessionId = randomUUID();
  const directory = path.join(root, "sessions");
  const sessionPath = path.join(directory, `${sessionId}.jsonl`);
  const db = new DatabaseSync(databasePath);
  let inTransaction = false;
  let fileCreated = false;
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // Preparing the installed writer's columns before creating a file also
    // rejects incompatible schemas without changing them. All data is bound.
    const findProject = requestedProjectId == null
      ? db.prepare(`SELECT id, path FROM projects WHERE replace(path, char(92), '/') = ?${process.platform === "win32" ? " COLLATE NOCASE" : ""}`)
      : db.prepare("SELECT id, path FROM projects WHERE id = ?");
    const insertProject = db.prepare("INSERT INTO projects (path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?)");
    const insertSession = db.prepare(`INSERT INTO sessions (
      id, title, title_source, project_id, provider_id, model_id, mode,
      thinking_level, permission_mode, source, last_seq, created_at, updated_at
    ) VALUES (?, ?, 'manual', ?, NULL, NULL, 'agent', 'off', 'inherit', NULL, ?, ?, ?)`);
    const insertMessage = db.prepare(`INSERT INTO messages (
      id, session_id, turn_id, seq, role, tool_name, is_error, text, created_at, streaming
    ) VALUES (?, ?, NULL, ?, ?, NULL, 0, ?, ?, 0)`);
    const resolveProject = () => {
      const project = findProject.get(requestedProjectId ?? workspace);
      if (requestedProjectId != null) {
        const registeredPath = project && workspacePath(project.path);
        const matches = process.platform === "win32"
          ? registeredPath?.toLowerCase() === workspace.toLowerCase()
          : registeredPath === workspace;
        if (!matches) throw new Error("PI-Desktop import: projectId does not belong to destination.workspace");
      }
      return project;
    };
    if (!standalone) resolveProject();
    await fs.mkdir(directory, { recursive: true });
    const file = await fs.open(sessionPath, "wx", 0o600);
    fileCreated = true;
    try {
      const append = record => file.writeFile(JSON.stringify(record) + String.fromCharCode(10), "utf8");
      await append({ type: "session", schema: 1, sessionId, cwd: workspace, title: name, createdAt: new Date(createdMs).toISOString() });
      for (const record of records) await append(record);
      await file.sync();
    } finally { await file.close(); }

    // Do not hold a synchronous SQLite writer lock across asynchronous file IO.
    // Receipt deduplication/mode belongs to the caller; this target only adds a
    // fresh UUID and never replaces an existing session or project.
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    let project = standalone ? null : resolveProject();
    if (!standalone && !project) {
      const now = Date.now();
      const inserted = insertProject.run(workspace, path.basename(workspace) || workspace, now, now);
      project = { id: Number(inserted.lastInsertRowid) };
    }
    insertSession.run(sessionId, name, project?.id ?? null, records.length, createdMs, updatedMs);
    for (const [index, record] of records.entries()) {
      insertMessage.run(record.id, sessionId, index + 1, record.role, record.blocks[0].text, Date.parse(record.createdAt));
    }
    db.exec("COMMIT");
    inTransaction = false;
    return {
      sessionId, sessionPath, target: "pi-desktop", title: name, messageCount: records.length,
      nativeHistory: true, sidebar: { registered: true, workspace, projectId: project?.id ?? null, placement: standalone ? "standalone" : "project" },
    };
  } catch (error) {
    const errors = [error];
    if (inTransaction) {
      try { db.exec("ROLLBACK"); } catch (rollbackError) { errors.push(rollbackError); }
    }
    let retainedPath = sessionPath;
    if (fileCreated) {
      // Retain failed writes outside the .jsonl namespace so host recovery
      // cannot silently register an orphan under the wrong workspace.
      const incompletePath = path.join(directory, `${sessionId}.${randomUUID()}.unregistered`);
      try { await fs.rename(sessionPath, incompletePath); retainedPath = incompletePath; }
      catch (archiveError) { errors.push(archiveError); }
    }
    throw Object.assign(new Error(`PI-Desktop native import failed: ${error.message}${fileCreated ? `; retained ${retainedPath}` : ""}`, { cause: errors.length === 1 ? error : new AggregateError(errors) }), {
      code: "PI_DESKTOP_IMPORT_FAILED", sessionId, ...(fileCreated ? { sessionPath: retainedPath } : {}),
    });
  } finally { db.close(); }
}

async function importSession(args) {
  let sqlite;
  try { sqlite = require("node:sqlite"); }
  catch (error) {
    if (!["ERR_UNKNOWN_BUILTIN_MODULE", "MODULE_NOT_FOUND", "ERR_NO_SUCH_BUILTIN_MODULE"].includes(error.code)) throw error;
  }
  if (sqlite?.DatabaseSync) return importWithSqlite(args, sqlite);
  // Other hosts (including Electron) may omit node:sqlite. Invoke an installed
  // Node only on an explicit import, with the full input on stdin, no shell,
  // transcript arguments, artificial byte/message limits, or host process.
  return new Promise((resolve, reject) => {
    const child = spawn("node", [__filename, "--native-import"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", code => {
      let response;
      try { response = JSON.parse(output); }
      catch { reject(new Error("PI-Desktop import needs an installed Node with node:sqlite support")); return; }
      if (code !== 0 || !response.ok) {
        reject(Object.assign(new Error(response.error || "PI-Desktop native import failed"), { code: response.code, sessionId: response.sessionId, sessionPath: response.sessionPath }));
      } else resolve(response.result);
    });
    const { entry, messages, destination, title, mode, options } = args;
    child.stdin.end(JSON.stringify({ entry, messages, destination, title, mode, options }));
  });
}

if (require.main === module && process.argv[2] === "--native-import") {
  (async () => {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    const result = await importWithSqlite(JSON.parse(input), require("node:sqlite"));
    process.stdout.write(JSON.stringify({ ok: true, result }));
  })().catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message, code: error.code, sessionId: error.sessionId, sessionPath: error.sessionPath }));
    process.exitCode = 1;
  });
}

// Registration is durable; a running host may keep an in-memory catalog. The
// user can refresh/reopen or normally restart Desktop; never restart it here.
module.exports = { targets: [{ id: "pi-desktop", label: "PI-Desktop", defaultRoot, importSession }] };
