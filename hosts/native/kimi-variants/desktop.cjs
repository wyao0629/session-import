'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { serialize, optionalBytes, parseJson, prepare } = require('./common.cjs');

function defaultRoot({ home = os.homedir(), env = process.env } = {}) {
  return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    'kimi-desktop', 'daimon-share', 'daimon', 'runtime', 'kimi-code', 'home');
}

function locations(input) {
  const root = path.resolve(input);
  const leaf = path.basename(root).toLowerCase();
  let daimon, kernelRoot;
  if (leaf === 'home' && path.basename(path.dirname(root)).toLowerCase() === 'kimi-code') {
    kernelRoot = root;
    daimon = path.resolve(root, '../../..');
  } else {
    daimon = leaf === 'kimi-desktop' ? path.join(root, 'daimon-share', 'daimon')
      : leaf === 'daimon-share' ? path.join(root, 'daimon') : root;
    kernelRoot = path.join(daimon, 'runtime', 'kimi-code', 'home');
  }
  return { kernelRoot, catalog: path.join(daimon, 'agents', 'main', 'sessions', 'hosted-logical', 'conversations.sqlite') };
}

// Daimon conversation-sessions v2, SQLite schema version 1.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  agent_id TEXT NOT NULL, session_key TEXT NOT NULL, active_conversation_key TEXT,
  channel TEXT, account_id TEXT, peer_json TEXT, parent_peer_json TEXT, guild_id TEXT, team_id TEXT, thread_id TEXT,
  created_at TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (agent_id, session_key)
) STRICT;
CREATE TABLE IF NOT EXISTS conversations (
  agent_id TEXT NOT NULL, conversation_key TEXT NOT NULL, session_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
  kernel_type TEXT, kernel_session_id TEXT, kernel_session_dir TEXT, kernel_records_path TEXT,
  trace_id TEXT, work_tag TEXT, origin TEXT NOT NULL, workspace_path TEXT, prompt_layout_json TEXT,
  client_instructions TEXT, extra_json TEXT, title TEXT NOT NULL, title_status TEXT NOT NULL,
  title_generated_at TEXT, title_error TEXT, first_user_text TEXT, first_assistant_text TEXT, first_assistant_completed_at TEXT,
  created_at TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_key),
  FOREIGN KEY (agent_id, session_key) REFERENCES sessions(agent_id, session_key) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_v2_global_recency ON conversations(agent_id, updated_at_ms DESC, conversation_key DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_v2_workspace_recency ON conversations(agent_id, workspace_path, updated_at_ms DESC, conversation_key DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_v2_origin_recency ON conversations(agent_id, origin, updated_at_ms DESC, conversation_key DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_v2_session ON conversations(agent_id, session_key);
`;

function insertEntries(db, sessions, conversations) {
  const sessionInsert = db.prepare(`INSERT INTO sessions (
    agent_id, session_key, active_conversation_key, channel, account_id, peer_json, parent_peer_json, guild_id, team_id, thread_id,
    created_at, created_at_ms, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const conversationInsert = db.prepare(`INSERT INTO conversations (
    agent_id, conversation_key, session_key, conversation_id, kernel_type, kernel_session_id, kernel_session_dir, kernel_records_path,
    trace_id, work_tag, origin, workspace_path, prompt_layout_json, client_instructions, extra_json, title, title_status,
    title_generated_at, title_error, first_user_text, first_assistant_text, first_assistant_completed_at,
    created_at, created_at_ms, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const json = value => value == null ? null : JSON.stringify(value);
  for (const row of sessions) sessionInsert.run(
    row.agentId ?? 'main', row.sessionKey, row.activeConversationKey ?? null, row.channel ?? null, row.accountId ?? null,
    json(row.peer), json(row.parentPeer), row.guildId ?? null, row.teamId ?? null, row.threadId ?? null,
    row.createdAt, Date.parse(row.createdAt), row.updatedAt, Date.parse(row.updatedAt));
  for (const row of conversations) conversationInsert.run(
    row.agentId ?? 'main', row.conversationKey, row.sessionKey, row.conversationId,
    row.kernelType ?? 'kimi-code', row.kernelSessionId ?? row.kimiSessionId ?? null, row.kernelSessionDir ?? null, row.kernelRecordsPath ?? null,
    row.traceId ?? null, row.workTag ?? 'normal', row.origin ?? 'im', row.workspacePath ?? null,
    json(row.promptLayout), row.clientInstructions ?? null, json(row.extra), row.title, row.titleStatus,
    row.titleGeneratedAt ?? null, row.titleError ?? null, row.firstUserText ?? null, row.firstAssistantText ?? null, row.firstAssistantCompletedAt ?? null,
    row.createdAt, Date.parse(row.createdAt), row.updatedAt, Date.parse(row.updatedAt));
}

async function importSession({ entry, messages, rawMessages, destination, title, mode, options } = {}) {
  const prepared = prepare({ entry, messages, title });
  const { kernelRoot, catalog } = locations(destination.root || defaultRoot());
  const workspace = path.resolve(destination.workspace);
  const { DatabaseSync, backup } = require('node:sqlite');
  const target = require('../kimi.cjs').targets.find(item => item.id === 'kimi-code');
  const conversationId = randomUUID();
  const sessionKey = `agent:main:client:${randomUUID()}`;
  const conversationKey = `${sessionKey}:conversation:${conversationId}`;
  const backupPath = path.join(path.dirname(catalog), '.session-import-backups', conversationId);
  return serialize(catalog, async () => {
    await fs.mkdir(path.dirname(catalog), { recursive: true, mode: 0o700 });
    let exists = true;
    try { await fs.stat(catalog); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    const legacyIndexPath = path.join(path.dirname(catalog), 'sessions.v2.json');
    const db = new DatabaseSync(catalog);
    let kernel, inTransaction = false;
    try {
      const hasCatalog = () => Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'conversations'));
      const legacyBytes = hasCatalog() ? null : await optionalBytes(legacyIndexPath);
      const legacy = legacyBytes === null ? { sessions: [], conversations: [] } : parseJson(legacyBytes);
      if (exists || legacyBytes !== null) {
        await fs.mkdir(backupPath, { recursive: true, mode: 0o700 });
        if (exists) await backup(db, path.join(backupPath, 'conversations.sqlite'));
        if (legacyBytes !== null) await fs.writeFile(path.join(backupPath, 'sessions.v2.json'), legacyBytes, { flag: 'wx', mode: 0o600 });
      }
      // Forward every history item to the modern kernel writer, then publish its GUI pointer.
      kernel = await target.importSession({ entry, messages, rawMessages,
        destination: { ...destination, root: kernelRoot, workspace }, title: prepared.title, mode, options });
      const recordsPath = path.join(kernel.sessionPath, 'agents', 'main', 'wire.jsonl');
      await fs.stat(recordsPath);
      const firstAssistant = prepared.messages.find(message => message.role === 'assistant');
      const session = { agentId: 'main', sessionKey, createdAt: prepared.createdAt, updatedAt: prepared.updatedAt };
      const conversation = {
        agentId: 'main', conversationKey, sessionKey, conversationId, kernelType: 'kimi-code',
        kernelSessionId: kernel.sessionId, kernelSessionDir: kernel.sessionPath, kernelRecordsPath: recordsPath,
        traceId: randomBytes(16).toString('hex'), workTag: 'normal', origin: 'client', workspacePath: workspace,
        title: prepared.title, titleStatus: 'generated', titleGeneratedAt: prepared.updatedAt,
        firstUserText: prepared.messages.find(message => message.role === 'user')?.content,
        firstAssistantText: firstAssistant?.content, firstAssistantCompletedAt: firstAssistant?.createdAt,
        createdAt: prepared.createdAt, updatedAt: prepared.updatedAt,
      };
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      if (!hasCatalog()) {
        db.exec(SCHEMA);
        const metadata = db.prepare('INSERT INTO schema_metadata (key, value) VALUES (?, ?)');
        metadata.run('schema_version', '1');
        metadata.run('source_migration_kind', legacyBytes === null ? 'empty' : 'legacy-json');
        metadata.run('source_migration_legacy_json_path', legacyIndexPath);
        metadata.run('source_migration_recorded_at', new Date().toISOString());
        insertEntries(db, legacy.sessions, legacy.conversations);
      }
      insertEntries(db, [session], [conversation]);
      db.exec('COMMIT');
      inTransaction = false;
      const registered = db.prepare(`SELECT c.kernel_session_id, c.workspace_path
        FROM conversations c JOIN sessions s ON s.agent_id = c.agent_id AND s.session_key = c.session_key
        WHERE c.agent_id = ? AND c.conversation_key = ?`).get('main', conversationKey);
      if (registered?.kernel_session_id !== kernel.sessionId || registered.workspace_path !== workspace) {
        throw new Error('Desktop GUI catalog did not retain the native session registration');
      }
      return { ...kernel, target: 'kimi-desktop', title: prepared.title, messageCount: prepared.messages.length, nativeHistory: true,
        sidebar: { ...kernel.sidebar, registered: true, workspace, catalogPath: catalog, sessionKey, conversationId, conversationKey } };
    } catch (cause) {
      if (inTransaction) db.exec('ROLLBACK');
      const error = new Error('Kimi Desktop native import failed; partial kernel files and catalog backups are retained', { cause });
      Object.assign(error, { code: cause.code ?? 'KIMI_DESKTOP_IMPORT_FAILED', sessionId: kernel?.sessionId ?? cause.sessionId,
        sessionPath: kernel?.sessionPath ?? cause.sessionPath, catalogPath: catalog, backupPath });
      throw error;
    } finally { db.close(); }
  });
}

module.exports = { id: 'kimi-desktop', label: 'Kimi Desktop', defaultRoot, importSession };
