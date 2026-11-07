"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

function defaultRoot({ home = os.homedir(), env = process.env } = {}) {
  return path.resolve(home, (env.CODEX_HOME || path.join(home, ".codex")).replace(/^~(?=[/\\]|$)/, home));
}

function timestamp(value, fallback) {
  if (value == null || value === "") return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Codex import: invalid message timestamp");
  return date.toISOString();
}

const quote = name => `"${name.replaceAll('"', '""')}"`;
function insertStatement(db, schema, table, values, required) {
  const columns = db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all();
  const names = new Set(columns.map(column => column.name));
  for (const field of required) {
    if (!names.has(field)) throw new Error(`Codex schema missing ${table}.${field}`);
  }
  for (const column of columns) {
    if ((column.notnull || column.pk) && column.dflt_value == null && values[column.name] == null) {
      throw new Error(`Codex schema requires an unavailable value: ${table}.${column.name}`);
    }
  }
  const selected = columns.filter(column => values[column.name] !== undefined).map(column => column.name);
  const statement = db.prepare(`INSERT INTO ${schema}.${quote(table)} (${selected.map(quote).join(",")}) VALUES (${selected.map(() => "?").join(",")})`);
  return () => statement.run(...selected.map(name => values[name]));
}

async function writeRollout(filePath, meta, messages) {
  const file = await fs.open(filePath, "wx", 0o600);
  try {
    const append = (type, time, payload) => file.writeFile(`${JSON.stringify({ timestamp: time, type, payload })}\n`, "utf8");
    await append("session_meta", meta.timestamp, meta);
    let turnId = null;
    let lastAssistant = null;
    let lastTime = meta.timestamp;
    const finish = async () => {
      if (turnId) await append("event_msg", lastTime, { type: "task_complete", turn_id: turnId, last_agent_message: lastAssistant });
      turnId = null;
      lastAssistant = null;
    };
    for (const [index, message] of messages.entries()) {
      const phase = messages[index + 1]?.role === "assistant" ? "commentary" : "final_answer";
      if (message.role === "user") await finish();
      if (!turnId) {
        turnId = randomUUID();
        await append("event_msg", message.createdAt, { type: "task_started", turn_id: turnId, model_context_window: null, collaboration_mode_kind: "default" });
      }
      lastTime = message.createdAt;
      if (message.role === "user") {
        await append("event_msg", lastTime, { type: "user_message", message: message.content, images: [], local_images: [], text_elements: [] });
      }
      await append("response_item", lastTime, {
        type: "message", id: `msg_${randomUUID()}`, role: message.role,
        content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.content }],
        ...(message.role === "assistant" ? { phase, end_turn: phase === "final_answer" } : {}),
      });
      if (message.role === "assistant") {
        lastAssistant = message.content;
        await append("event_msg", lastTime, { type: "agent_message", message: message.content, phase });
      }
    }
    await finish();
    await file.sync();
  } finally { await file.close(); }
}

async function appendIndex(indexPath, record) {
  const file = await fs.open(indexPath, "a+", 0o600);
  try {
    const { size } = await file.stat();
    let separator = "";
    if (size) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      if (last[0] !== 10) separator = "\n";
    }
    await file.writeFile(`${separator}${JSON.stringify(record)}\n`, "utf8");
    await file.sync();
  } finally { await file.close(); }
}

async function importWithSqlite({ entry = {}, messages, rawMessages, destination, title, mode, options = {} }, sqlite) {
  const root = path.resolve(destination.root || defaultRoot());
  const workspace = path.resolve(destination.workspace);
  const statePath = path.join(root, "state_5.sqlite");
  const catalogPath = path.join(root, "sqlite", "codex.db");
  // Missing native databases are a schema failure, not permission to create an
  // empty replacement. Only the installed host owns schema migrations.
  for (const file of [statePath, catalogPath]) {
    try {
      if (!(await fs.stat(file)).isFile()) throw new Error("not a file");
    } catch { throw new Error(`Codex native schema database is unavailable: ${file}`); }
  }
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const createdAt = timestamp(entry.createdAt ?? messages[0]?.createdAt, now);
  const normalized = messages.map(message => {
    if (!["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new Error("Codex import: each message must have a user/assistant role and string content");
    }
    return { ...message, createdAt: timestamp(message.createdAt, createdAt) };
  });
  const createdMs = Date.parse(createdAt);
  let updatedMs = Date.parse(timestamp(entry.updatedAt, createdAt));
  for (const message of normalized) updatedMs = Math.max(updatedMs, Date.parse(message.createdAt));
  updatedMs = Math.max(updatedMs, createdMs);
  const nowMs = Date.parse(now);
  const name = String(title ?? entry.name ?? entry.title ?? "Imported session");
  const firstUser = normalized.find(message => message.role === "user");
  const directory = path.join(root, "sessions", createdAt.slice(0, 4), createdAt.slice(5, 7), createdAt.slice(8, 10));
  const sessionPath = path.join(directory, `rollout-${createdAt.slice(0, 19).replaceAll(":", "-")}-${sessionId}.jsonl`);
  const backupDir = path.join(root, ".session-import-backups", sessionId);
  const indexPath = path.join(root, "session_index.jsonl");
  let provider = options.modelProvider ?? "openai";
  const model = options.modelId ?? (entry.harness === "codex" ? entry.modelId : undefined);
  const sandbox = options.sandboxPolicy;
  const state = {
    id: sessionId, rollout_path: sessionPath, cwd: workspace, title: name, name,
    created_at: Math.floor(createdMs / 1000), updated_at: Math.floor(updatedMs / 1000),
    created_at_ms: createdMs, updated_at_ms: updatedMs,
    recency_at: Math.floor(nowMs / 1000), recency_at_ms: nowMs,
    source: "cli", model_provider: provider, model, originator: "session-import",
    sandbox_policy: typeof sandbox === "string" ? sandbox : JSON.stringify(sandbox),
    approval_mode: options.approvalMode,
    tokens_used: 0, has_user_event: firstUser ? 1 : 0, archived: 0,
    first_user_message: firstUser?.content ?? "", preview: firstUser?.content ?? "",
    cli_version: "session-import", history_mode: "legacy", project_id: destination.projectId,
  };
  const catalog = {
    host_id: "local", thread_id: sessionId, display_title: name, cwd: workspace,
    source_created_at: createdMs / 1000, source_updated_at: updatedMs / 1000,
    source_recency_at: nowMs / 1000, source_kind: "cli", source_detail: null,
    model_provider: provider, observation_sequence: 0, missing_candidate: 0,
    pending_observed_title: 0, project_id: destination.projectId,
  };
  const db = new sqlite.DatabaseSync(statePath);
  let inTransaction = false;
  let published = false;
  let committed = false;
  try {
    db.prepare("ATTACH DATABASE ? AS catalog").run(catalogPath);
    const available = new Set(db.prepare("PRAGMA table_info(threads)").all().map(column => column.name));
    const inheritedFields = ["model_provider", "sandbox_policy", "approval_mode"].filter(field => available.has(field));
    const inherited = inheritedFields.length ? db.prepare(`SELECT ${inheritedFields.map(quote).join(",")} FROM threads ORDER BY CASE WHEN cwd=? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`).get(workspace) : {};
    if (options.modelProvider == null && inherited?.model_provider) { provider = inherited.model_provider; state.model_provider = provider; catalog.model_provider = provider; }
    if (options.sandboxPolicy == null) state.sandbox_policy = inherited?.sandbox_policy ?? undefined;
    if (options.approvalMode == null) state.approval_mode = inherited?.approval_mode ?? undefined;
    const projectFields = destination.projectId == null ? [] : ["project_id"];
    const insertState = insertStatement(db, "main", "threads", state, ["id", "rollout_path", "cwd", "title", "created_at", "updated_at", ...projectFields]);
    const insertCatalog = insertStatement(db, "catalog", "local_thread_catalog", catalog, ["host_id", "thread_id", "display_title", "cwd", "source_created_at", "source_updated_at", ...projectFields]);
    await fs.mkdir(backupDir, { recursive: true });
    // SQLite's online backup includes WAL data; copying a live .sqlite file does not.
    await sqlite.backup(db, path.join(backupDir, "state_5.sqlite"));
    await sqlite.backup(db, path.join(backupDir, "codex.db"), { source: "catalog" });
    try { await fs.copyFile(indexPath, path.join(backupDir, "session_index.jsonl"), constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const pendingPath = path.join(backupDir, "rollout.pending");
    await writeRollout(pendingPath, {
      id: sessionId, timestamp: createdAt, cwd: workspace, originator: "session-import",
      cli_version: "session-import", source: "cli", model_provider: provider,
    }, normalized);
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(pendingPath, sessionPath, constants.COPYFILE_EXCL);
    published = true;
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    insertState();
    insertCatalog();
    db.exec("COMMIT");
    inTransaction = false;
    committed = true;
    await appendIndex(indexPath, { id: sessionId, thread_name: name, updated_at: new Date(updatedMs).toISOString() });
    return {
      sessionId, sessionPath, target: "codex", title: name, messageCount: normalized.length,
      nativeHistory: true, sidebar: { registered: true, workspace },
    };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    // Keep failures recoverable without deleting history or reverting another
    // process's index updates. A committed native registration is never retried here.
    if (published && !committed) await fs.rename(sessionPath, path.join(backupDir, "unregistered-rollout.jsonl"));
    if (committed) {
      throw Object.assign(new Error(`Codex registered ${sessionId}, but the session index append failed; retained ${sessionPath}`), { code: "CODEX_IMPORT_PARTIAL", sessionId, sessionPath });
    }
    throw error;
  } finally { db.close(); }
}

async function importSession(args) {
  let sqlite;
  try { sqlite = require("node:sqlite"); }
  catch (error) {
    if (!["ERR_UNKNOWN_BUILTIN_MODULE", "MODULE_NOT_FOUND", "ERR_NO_SUCH_BUILTIN_MODULE"].includes(error.code)) throw error;
  }
  if (sqlite?.DatabaseSync && sqlite.backup) return importWithSqlite(args, sqlite);
  // Electron can lack node:sqlite. Use the installed Node without a shell,
  // command-line transcript, timeout, or message/byte cap.
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
      catch { reject(new Error("Codex import needs an installed Node with node:sqlite and backup support")); return; }
      if (code !== 0 || !response.ok) {
        reject(Object.assign(new Error(response.error || "Codex native import failed"), { code: response.code, sessionId: response.sessionId, sessionPath: response.sessionPath }));
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

module.exports = { targets: [{ id: "codex", label: "Codex", defaultRoot, importSession }] };
