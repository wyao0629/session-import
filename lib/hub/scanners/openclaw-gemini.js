/**
 * OpenClaw keeps sessions in <root>/agents/<agent>/agent/openclaw-agent.sqlite
 * (session_windows joined to session_nodes for the display name / label).
 * Gemini CLI keeps <root>/tmp/<project>/chats/session-*.jsonl.
 */
"use strict";

const path = require("node:path");
const { mkEntry, withDb, columnsOf } = require("../entry");
const { listDir, exists, walk, statSig, eachJsonLine, text, iso, cleanPath } = require("../fsx");

async function scanOpenClaw(root, ctx) {
  const out = [];
  const agents = path.join(root, "agents");
  for (const a of listDir(agents)) {
    const db = path.join(agents, a.name, "agent", "openclaw-agent.sqlite");
    if (!a.isDirectory() || !exists(db)) continue;
    try {
      const rows = withDb(db, (conn) => {
        const arch = columnsOf(conn, "session_nodes").has("archived_at") ? "n.archived_at" : "NULL";
        const hasCounts = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_transcript_index_state'").get();
        const counts = hasCounts ? "x.active_message_count" : "NULL";
        const join = hasCounts ? "LEFT JOIN session_transcript_index_state x ON x.session_id = w.session_id" : "";
        return conn
          .prepare(
            `SELECT w.session_id, w.display_name AS window_name, w.created_at, w.updated_at, w.transcript_updated_at,
               n.display_name, n.label, n.fork_source_session_id, ${arch} AS archived, ${counts} AS n
             FROM session_windows w LEFT JOIN session_nodes n ON n.session_key = w.session_key ${join}`,
          )
          .all();
      });
      for (const r of rows) {
        const id = String(r.session_id);
        out.push(
          mkEntry("openclaw", id, `${db}#session_id=${encodeURIComponent(id)}`, {
            name: text(r.display_name) ?? text(r.label) ?? text(r.window_name),
            sourceFormat: "openclaw-sqlite",
            createdAt: iso(r.created_at),
            updatedAt: iso(r.transcript_updated_at) ?? iso(r.updated_at),
            parentSessionId: text(r.fork_source_session_id),
            archived: Boolean(r.archived),
            messageCount: typeof r.n === "number" ? r.n : undefined,
            importSource: null,
          }),
        );
      }
    } catch (error) {
      ctx.report(a.name, error);
    }
  }
  return out;
}

function messageRows(o) {
  if (Array.isArray(o?.$set?.messages)) return o.$set.messages;
  return o?.type ? [o] : [];
}

async function scanGemini(root, ctx) {
  const out = [];
  const files = await walk(path.join(root, "tmp"), (p, n) => n.startsWith("session-") && n.endsWith(".jsonl"), 4);
  for (const file of files) {
    try {
      const st = await statSig(file);
      const prev = ctx.byPath.get(file);
      if (prev && prev.sig === st?.sig) {
        out.push(prev);
        continue;
      }
      const info = { count: 0 };
      await eachJsonLine(file, (o) => {
        if (!o) return false;
        if (o.sessionId && !info.header) info.header = o;
        for (const m of messageRows(o)) {
          if (m.type !== "user" && m.type !== "gemini") continue;
          info.count += 1;
          const t = Array.isArray(m.content) ? m.content.map((b) => b?.text).filter(Boolean).join("\n") : text(m.content);
          if (!info.prompt && m.type === "user" && t && !t.startsWith("<session_context>")) info.prompt = t;
        }
        return false;
      });
      const h = info.header;
      if (!h?.sessionId) continue;
      out.push(
        mkEntry("gemini", String(h.sessionId), file, {
          firstPrompt: info.prompt,
          workspacePath: cleanPath(h.cwd),
          sourceFormat: "gemini-jsonl",
          createdAt: iso(h.startTime),
          updatedAt: iso(h.lastUpdated) ?? new Date(st.mtimeMs).toISOString(),
          messageCount: info.count,
          importSource: null,
          sig: st.sig,
        }),
      );
    } catch (error) {
      ctx.report(path.basename(file), error);
    }
  }
  return out;
}

module.exports = { scanOpenClaw, scanGemini };
