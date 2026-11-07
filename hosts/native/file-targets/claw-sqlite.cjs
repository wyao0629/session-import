"use strict";

const { fs, path, randomUUID, serialize } = require("./shared.cjs");

async function sqliteStore(agentDir) {
  const file = path.join(agentDir, "agent", "openclaw-agent.sqlite");
  try { await fs.access(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_nodes', 'session_windows', 'transcript_events')").get() ? file : null;
  } finally { db.close(); }
}

async function writeSqliteSession(file, data, sessionKey, projectId, events) {
  return serialize(file, async () => {
    const { DatabaseSync, backup } = require("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      await backup(db, `${file}.bak-${randomUUID()}`);
      db.exec("PRAGMA foreign_keys = ON");
      const createdAt = new Date(data.createdAt).getTime();
      const updatedAt = new Date(data.updatedAt).getTime();
      const entry = {
        sessionId: data.sessionId, updatedAt, createdAt, sessionStartedAt: createdAt, startedAt: createdAt,
        createdVia: "plugin", displayName: data.title, label: data.title, chatType: "direct",
        cwd: data.workspace, spawnedCwd: data.workspace, spawnedWorkspaceDir: data.workspace, sessionRoot: data.workspace,
        ...(projectId ? { projectId } : {}), delivery: { kind: "none" },
        lastInteractionAt: updatedAt, lastActivityAt: updatedAt, systemSent: false, abortedLastRun: false,
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO session_nodes
          (session_key, current_session_id, entry_json, updated_at, created_at, created_via,
           project_id, label, display_name, last_interaction_at, last_activity_at)
          VALUES (?, ?, ?, ?, ?, 'plugin', ?, ?, ?, ?, ?)`).run(
          sessionKey, data.sessionId, JSON.stringify(entry), updatedAt, createdAt,
          projectId || null, data.title, data.title, updatedAt, updatedAt);
        db.prepare(`INSERT INTO session_windows
          (session_id, session_key, reason, session_scope, created_at, updated_at,
           transcript_updated_at, transcript_observed_at, session_entry_provenance, started_at, chat_type, display_name)
          VALUES (?, ?, 'initial', 'conversation', ?, ?, ?, ?, 1, ?, 'direct', ?)`).run(
          data.sessionId, sessionKey, createdAt, updatedAt, updatedAt, updatedAt, createdAt, data.title);
        db.prepare(`INSERT INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
          VALUES (?, ?, ?)`).run(data.sessionId, randomUUID().replaceAll("-", ""), new Date(data.importedAt).getTime());

        // Plain event_json is a native storage form and preserves arbitrarily long content.
        const insertEvent = db.prepare(`INSERT INTO transcript_events
          (session_id, seq, event_json, created_at, event_utf8_bytes) VALUES (?, ?, ?, ?, ?)`);
        const insertIdentity = db.prepare(`INSERT INTO transcript_event_identities
          (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?)`);
        const insertActive = db.prepare(`INSERT INTO session_transcript_active_events
          (session_id, active_position, event_seq, message_position, context_eligible) VALUES (?, ?, ?, ?, 1)`);
        const insertFtsIdentity = db.prepare("INSERT INTO session_transcript_fts_rows (session_id, message_id) VALUES (?, ?)");
        const insertFts = db.prepare(`INSERT INTO session_transcript_fts
          (rowid, text, session_id, message_id, role, timestamp) VALUES (last_insert_rowid(), ?, ?, ?, ?, ?)`);
        let seq = 0, activeCount = 0, messageCount = 0, leafId = null;
        for (const event of events) {
          const json = JSON.stringify(event);
          const timestamp = new Date(event.timestamp).getTime();
          insertEvent.run(data.sessionId, seq, json, timestamp, Buffer.byteLength(json, "utf8"));
          insertIdentity.run(data.sessionId, event.id, seq, event.type, event.parentId ?? null, timestamp);
          if (event.type !== "session") {
            insertActive.run(data.sessionId, activeCount++, seq, event.type === "message" ? messageCount++ : null);
            leafId = event.id;
          }
          if (event.type === "message") {
            const text = event.message.content[0].text;
            if (text.trim()) {
              insertFtsIdentity.run(data.sessionId, event.id);
              insertFts.run(text, data.sessionId, event.id, event.message.role, timestamp);
            }
          }
          seq++;
        }
        db.prepare(`INSERT INTO session_transcript_index_state
          (session_id, indexed_seq, leaf_event_id, needs_rebuild, active_event_count, active_message_count, updated_at)
          VALUES (?, ?, ?, 0, ?, ?, ?)`).run(data.sessionId, seq - 1, leafId, activeCount, messageCount, updatedAt);
        // Native insert triggers reset this flag; certify only this new, fully populated node.
        db.prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ? AND current_session_id = ?").run(sessionKey, data.sessionId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally { db.close(); }
  });
}

module.exports = { sqliteStore, writeSqliteSession };
