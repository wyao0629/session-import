'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { findRuntimeBinding, runtimeBindingRecords, runtimeBindingStatus } = require('./kimi-runtime-binding.cjs');

const TARGET = 'kimi-code';

function defaultRoot({ home = os.homedir(), env = process.env } = {}) {
  return env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function normalizedPath(value) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function rootKey(value) {
  const normalized = normalizedPath(value);
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(value)
    ? normalized.toLowerCase() : normalized;
}

function workspaceId(workspace) {
  const normalized = normalizedPath(workspace);
  let slug = normalized.split('/').pop().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..') slug = 'workspace';
  return `wd_${slug}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

function messageTime(value, fallback, index) {
  if (value === undefined || value === null) return fallback;
  const time = typeof value === 'number' ? value
    : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) {
    throw new TypeError(`messages[${index}].createdAt is invalid`);
  }
  return time;
}

function messageContent(value, index) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) {
    throw new TypeError(`messages[${index}].content must be text or native content parts`);
  }
  for (const part of value) {
    object(part, `messages[${index}] content part`);
    if (part.type === 'text' || part.type === 'think') {
      if (typeof part[part.type] !== 'string') {
        throw new TypeError(`messages[${index}] has an invalid ${part.type} part`);
      }
    } else {
      const field = { image_url: 'imageUrl', audio_url: 'audioUrl', video_url: 'videoUrl' }[part.type];
      if (!field || typeof part[field]?.url !== 'string') {
        throw new TypeError(`messages[${index}] has an unsupported content part; no content was discarded`);
      }
    }
  }
  return structuredClone(value);
}

function prepareMessages(messages, now) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('messages must be a non-empty array');
  }
  return messages.map((message, index) => {
    object(message, `messages[${index}]`);
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new TypeError(`messages[${index}].role must be user or assistant`);
    }
    const content = messageContent(message.content, index);
    // Reject non-serializable input before creating any native files.
    JSON.stringify(content);
    return { id: `msg_${randomUUID()}`, role: message.role, content,
      time: messageTime(message.createdAt, now, index) };
  });
}

// Display restoration uses context.*; engine restoration uses agent.*.
// Engine message.appended contains an entry { message, meta? }, not a bare message.
function* wireRecords(messages, createdAt, binding, bindingTime = createdAt, workspace) {
  yield { type: 'metadata', protocol_version: '1.5', created_at: createdAt };
  yield* runtimeBindingRecords(binding, bindingTime, workspace);
  let turnId = -1;
  let last;
  function* endTurn() {
    if (turnId < 0) return;
    const completed = last.role === 'assistant';
    yield { type: 'agent.turn.ended', kind: 'event', agentId: 'main',
      turnId, outcome: completed ? 'done' : 'aborted', time: last.time };
    yield { type: 'turn.ended', agentId: 'main', turnId,
      reason: completed ? 'completed' : 'cancelled', time: last.time };
  }
  for (const message of messages) {
    const { id, role, content, time } = message;
    if (role === 'user') {
      yield* endTurn();
      turnId += 1;
      yield { type: 'agent.turn.started', kind: 'event', agentId: 'main',
        turnId, queueItemId: id, time };
      yield { type: 'turn.prompt', agentId: 'main', turnId, promptId: id,
        input: content, origin: { kind: 'user' }, time };
    }
    const display = { id, role, content, toolCalls: [] };
    const replay = { message: role === 'assistant'
      ? { role, content, toolCalls: [] } : { role, content } };
    if (role === 'user') {
      display.origin = { kind: 'user' };
      replay.meta = { source: 'input', promptId: id, userMessageId: id,
        origin: { kind: 'user' }, createdAt: new Date(time).toISOString() };
    }
    yield { type: 'context.append_message', agentId: 'main', message: display, time };
    yield { type: 'agent.message.appended', kind: 'event', agentId: 'main',
      message: replay, time };
    last = message;
  }
  yield* endTurn();
}

async function readOptional(file) {
  try { return await fsp.readFile(file); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeExclusive(file, contents) {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally { await handle.close(); }
}

function validateCatalog(file) {
  object(file, 'projects.json');
  if (!Number.isInteger(file.schema_version) || file.schema_version < 1 || file.schema_version > 2) {
    throw new Error('Unsupported projects.json schema_version');
  }
  object(file.projects, 'projects.json projects');
  if (file.deleted_project_ids !== undefined && !Array.isArray(file.deleted_project_ids)) {
    throw new Error('Invalid deleted_project_ids');
  }
  if (file.idempotency_keys !== undefined) object(file.idempotency_keys, 'idempotency_keys');
  for (const project of Object.values(file.projects)) {
    object(project, 'project');
    for (const key of ['root', 'name', 'created_at', 'last_opened_at']) {
      if (typeof project[key] !== 'string') throw new Error(`Invalid project ${key}`);
    }
    if (file.schema_version === 2 && project.kind !== 'managed' && project.kind !== 'implicit') {
      throw new Error('Invalid project kind');
    }
    if (project.additional_dirs !== undefined && (!Array.isArray(project.additional_dirs)
      || project.additional_dirs.some(dir => typeof dir !== 'string'))) {
      throw new Error('Invalid project additional_dirs');
    }
  }
}

async function readCatalog(root) {
  const bytes = await readOptional(path.join(root, 'projects.json'));
  if (bytes !== undefined) {
    const file = JSON.parse(bytes.toString('utf8'));
    validateCatalog(file);
    return { file, bytes };
  }
  const legacyPath = path.join(root, 'workspaces.json');
  const legacyBytes = await readOptional(legacyPath);
  if (legacyBytes === undefined) {
    return { file: { schema_version: 2, projects: {}, deleted_project_ids: [], idempotency_keys: {} } };
  }
  const legacy = object(JSON.parse(legacyBytes.toString('utf8')), 'workspaces.json');
  const { version, workspaces = {}, deleted_workspace_ids = [], ...extra } = legacy;
  object(workspaces, 'workspaces.json workspaces');
  const file = { ...extra, schema_version: 1, projects: workspaces,
    deleted_project_ids: deleted_workspace_ids, idempotency_keys: extra.idempotency_keys ?? {},
    migration: { source_file: 'workspaces.json', source_version: version,
      source_sha256: createHash('sha256').update(legacyBytes).digest('hex'),
      migrated_at: new Date().toISOString() } };
  validateCatalog(file);
  const again = await readOptional(legacyPath);
  if (!again || !again.equals(legacyBytes)) throw new Error('workspaces.json changed during migration');
  return { file, legacyBytes };
}

function selectProject(file, workspace, requestedId) {
  const derivedId = workspaceId(workspace);
  const id = requestedId ?? (Object.hasOwn(file.projects, derivedId) ? derivedId
    : Object.keys(file.projects).find(key => key.startsWith('wd_')
      && rootKey(file.projects[key].root) === rootKey(workspace)) ?? derivedId);
  if (!/^(?:wd_[A-Za-z0-9._-]+|wm_[A-Za-z0-9-]+)$/.test(id)) {
    throw new Error('Invalid native projectId');
  }
  const existing = Object.hasOwn(file.projects, id) ? file.projects[id] : undefined;
  if (requestedId !== undefined && !existing && id !== derivedId) {
    throw new Error('The selected projectId is not registered for this workspace');
  }
  if (existing && rootKey(existing.root) !== rootKey(workspace)) {
    throw new Error('The selected projectId belongs to a different workspace');
  }
  return id;
}

// proper-lockfile uses mkdir(target + '.lock'), a 5-second stale window and
// mtime heartbeats. Never steal a stale lock. Archive our lock on release.
async function withProjectsLock(root, backupDir, action) {
  const lockPath = path.join(root, '.projects-write-lock.lock');
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  try { await fsp.mkdir(lockPath, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') {
      const locked = new Error('Kimi projects catalog is locked; retry after the native writer finishes');
      locked.code = 'KIMI_PROJECTS_LOCKED';
      throw locked;
    }
    throw error;
  }
  let identity = fs.lstatSync(lockPath);
  let lost;
  function assertOwned() {
    if (lost) throw lost;
    const current = fs.lstatSync(lockPath);
    if (!current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev
      || current.mtimeMs !== identity.mtimeMs || Date.now() - identity.mtimeMs >= 4000) {
      throw new Error('Kimi projects lock ownership was lost or its heartbeat expired');
    }
  }
  const heartbeat = setInterval(() => {
    try {
      assertOwned();
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
      identity = fs.lstatSync(lockPath);
    } catch (error) { lost = error; }
  }, 1000);
  heartbeat.unref();
  let result;
  let failure;
  try { result = await action(assertOwned); } catch (error) { failure = error; }
  clearInterval(heartbeat);
  try {
    assertOwned();
    fs.renameSync(lockPath, path.join(backupDir, 'projects-write-lock'));
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Import failed and the projects lock could not be released') : error;
  }
  if (failure) throw failure;
  return result;
}

async function saveCatalog(root, snapshot, file, backupDir, sessionId, assertOwned) {
  const catalogPath = path.join(root, 'projects.json');
  if (snapshot.bytes !== undefined) {
    await writeExclusive(path.join(backupDir, 'projects.json'), snapshot.bytes);
  }
  if (snapshot.legacyBytes !== undefined) {
    const stamp = new Date().toISOString().replace(/:/g, '-');
    await writeExclusive(path.join(root, `workspaces.json.pre-projects-migration-${stamp}-${sessionId}.bak`), snapshot.legacyBytes);
  }
  const pending = path.join(backupDir, 'projects.pending.json');
  await writeExclusive(pending, `${JSON.stringify(file, null, 2)}\n`);
  const current = await readOptional(catalogPath);
  if (snapshot.bytes === undefined ? current !== undefined : !current?.equals(snapshot.bytes)) {
    throw new Error('projects.json changed outside the native write lock');
  }
  if (snapshot.legacyBytes !== undefined) {
    const legacy = await readOptional(path.join(root, 'workspaces.json'));
    if (!legacy?.equals(snapshot.legacyBytes)) throw new Error('workspaces.json changed during migration');
  }
  assertOwned();
  await fsp.rename(pending, catalogPath);
}

async function appendIndex(root, record) {
  const file = path.join(root, 'session_index.jsonl');
  let handle;
  try { handle = await fsp.open(file, 'ax+', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    handle = await fsp.open(file, 'a+');
  }
  try {
    const stat = await handle.stat();
    if (stat.size > 0) {
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, stat.size - 1);
      if (tail[0] !== 10) throw new Error('session_index.jsonl has an incomplete final record');
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    const result = await handle.write(line);
    if (result.bytesWritten !== line.length) throw new Error('Incomplete session_index.jsonl append');
    await handle.sync();
  } finally { await handle.close(); }
}

/**
 * Always creates a new native UUID session. mode/options never select an
 * overwrite, active journal or context-only import. No host credentials or
 * provider secrets are copied. Existing local startup records provide the model,
 * profile, environment and tools; the latest thinking effort overrides them.
 */
async function importSession({ entry, messages, destination, title, mode, options } = {}) {
  object(destination, 'destination');
  const root = absolutePath(destination.root, 'destination.root');
  const workspace = absolutePath(destination.workspace, 'destination.workspace');
  if (destination.projectId !== undefined && typeof destination.projectId !== 'string') {
    throw new TypeError('destination.projectId must be a native project ID');
  }
  const now = Date.now();
  const prepared = prepareMessages(messages, now);
  const sessionTitle = title ?? entry?.title ?? 'Imported session';
  if (typeof sessionTitle !== 'string' || !sessionTitle.trim()) {
    throw new TypeError('title must be a non-empty string');
  }
  if (!(await fsp.stat(workspace)).isDirectory()) throw new Error('workspace is not a directory');
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const runtimeBinding = await findRuntimeBinding(root, workspace);
  const sessionId = randomUUID();
  const backupDir = path.join(root, '.session-import-backups', sessionId);
  let sessionPath;
  let phase = 'lock projects catalog';
  try {
    return await withProjectsLock(root, backupDir, async assertOwned => {
      phase = 'read projects catalog';
      const snapshot = await readCatalog(root);
      const projectId = selectProject(snapshot.file, workspace, destination.projectId);
      const scope = path.join(root, 'sessions', projectId);
      sessionPath = path.join(scope, sessionId);
      phase = 'create new session';
      assertOwned();
      await fsp.mkdir(scope, { recursive: true, mode: 0o700 });
      await fsp.mkdir(sessionPath, { mode: 0o700 });
      const agentHome = path.join(sessionPath, 'agents', 'main');
      await fsp.mkdir(agentHome, { recursive: true, mode: 0o700 });
      let createdAt = prepared[0].time;
      let updatedAt = now;
      let lastPrompt;
      for (const message of prepared) {
        createdAt = Math.min(createdAt, message.time);
        updatedAt = Math.max(updatedAt, message.time);
        if (message.role === 'user') {
          lastPrompt = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
        }
      }
      phase = 'write native history';
      const wire = await fsp.open(path.join(agentHome, 'wire.jsonl'), 'wx', 0o600);
      try {
        for (const record of wireRecords(prepared, createdAt, runtimeBinding, now, workspace)) {
          assertOwned();
          await wire.writeFile(`${JSON.stringify(record)}\n`);
        }
        await wire.sync();
      } finally { await wire.close(); }
      // Register a real main agent; binding belongs to native profile/model selection.
      const state = { id: sessionId, version: 2, cwd: workspace, createdAt, updatedAt,
        archived: false, title: sessionTitle, titleKind: 'custom', isCustomTitle: true,
        agents: { main: { type: 'main', homedir: agentHome } }, custom: {}, lastPrompt };
      if (lastPrompt !== undefined) {
        state.lastTurnReason = prepared[prepared.length - 1].role === 'assistant' ? 'completed' : 'cancelled';
      }
      phase = 'publish session state';
      assertOwned();
      await writeExclusive(path.join(sessionPath, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
      phase = 'append session index';
      assertOwned();
      await appendIndex(root, { sessionId, sessionDir: sessionPath, workDir: workspace });
      const dirtyDir = path.join(root, 'sessions', '.index-dirty');
      await fsp.mkdir(dirtyDir, { recursive: true, mode: 0o700 });
      await writeExclusive(path.join(dirtyDir, `${sessionId}.${Date.now()}`), '');
      phase = 'register sidebar project';
      const file = { ...snapshot.file, schema_version: 2, projects: {} };
      for (const [id, project] of Object.entries(snapshot.file.projects)) {
        Object.defineProperty(file.projects, id, { enumerable: true, configurable: true, writable: true,
          value: { ...project, kind: project.kind === 'managed' ? 'managed' : 'implicit' } });
      }
      const stamp = new Date(now).toISOString();
      const existing = file.projects[projectId];
      file.projects[projectId] = existing ? { ...existing, last_opened_at: stamp } : {
        root: workspace, name: path.basename(workspace) || workspace, kind: 'implicit',
        created_at: stamp, last_opened_at: stamp, additional_dirs: [] };
      file.deleted_project_ids = (file.deleted_project_ids ?? []).filter(id => id !== projectId);
      file.idempotency_keys ??= {};
      await saveCatalog(root, snapshot, file, backupDir, sessionId, assertOwned);
      assertOwned();
      phase = 'release projects lock';
      return { sessionId, sessionPath, target: TARGET, title: sessionTitle,
        messageCount: prepared.length, nativeHistory: true,
        runtimeBinding: { status: runtimeBindingStatus(runtimeBinding), ...(runtimeBinding ? {
          modelAlias: runtimeBinding.modelAlias, profileName: runtimeBinding.profileName,
          thinkingEffort: runtimeBinding.thinkingEffort } : {}) },
        sidebar: { registered: true, workspace, projectId } };
    });
  } catch (cause) {
    const error = new Error(`Kimi native import failed during ${phase}; any partial files are retained`, { cause });
    error.code = cause.code ?? 'KIMI_NATIVE_IMPORT_FAILED';
    error.sessionId = sessionId;
    error.sessionPath = sessionPath;
    error.backupPath = backupDir;
    error.phase = phase;
    throw error;
  }
}

module.exports = { targets: [{ id: TARGET, label: 'Kimi Code', defaultRoot, importSession }] };
