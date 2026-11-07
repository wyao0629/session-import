"use strict";
const { path, json, files, rows, fileOf, withDb, columns, normalize, harness } = require("./other");
function create(config) {
  return harness({ ...config, markers: ["agents"],
    async enumerate(root) {
      const base = path.join(root, "agents"), out = [];
      for (const file of await files(base, n => n === "openclaw-agent.sqlite", 3)) {
        const list = withDb(file, db => {
          if (!columns(db, "session_windows").size) return [];
          const wc = columns(db, "session_windows"), nc = columns(db, "session_nodes");
          const col = (alias, set, name, as) => `${set.has(name) ? `${alias}.${name}` : "NULL"} AS ${as}`;
          return db.prepare(`SELECT w.session_id,w.session_key,w.created_at,w.updated_at,w.transcript_updated_at,w.display_name AS window_name,
            n.display_name,n.label,${col("n", nc, "entry_json", "entry_json")},${col("n", nc, "archived_at", "archived")},
            ${col("w", wc, "parent_session_key", "wp")},${col("w", wc, "spawned_by", "ws")},
            ${col("n", nc, "parent_session_key", "np")},${col("n", nc, "spawned_by", "ns")},
            ${col("n", nc, "fork_source_session_id", "fork_id")}
            FROM session_windows w LEFT JOIN session_nodes n ON n.session_key=w.session_key`).all();
        });
        for (const r of list) {
          const parentKey = r.wp || r.ws || r.np || r.ns;
          const parent = parentKey && list.filter(p => p.session_key === parentKey && p.session_id !== r.session_id).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
          const meta = r.entry_json ? JSON.parse(r.entry_json) : {};
          out.push({ sessionId: r.session_id, sessionPath: `${file}#session_id=${encodeURIComponent(r.session_id)}`, filePath: file,
            sourceFormat: "openclaw-sqlite", name: r.display_name || r.label || r.window_name, createdAt: r.created_at, updatedAt: r.transcript_updated_at ?? r.updated_at,
            workspacePath: meta.cwd || meta.spawnedWorkspaceDir, archived: !!r.archived, subagent: !!parentKey,
            parentSessionId: parent?.session_id || r.fork_id || null, parentSessionKey: parentKey, dependencies: [file + "-wal"], noCache: true });
        }
      }
      const indexes = new Map();
      for (const indexFile of await files(base, (n, f) => n === "sessions.json" && path.basename(path.dirname(f)) === "sessions", 3)) {
        indexes.set(path.dirname(indexFile), await json(indexFile, {}));
      }
      for (const file of await files(base, (n, f) => n.endsWith(".jsonl") && path.basename(path.dirname(f)) === "sessions", 3)) {
        const id = path.basename(file, ".jsonl"), index = indexes.get(path.dirname(file)) ?? {};
        const [key, meta] = Object.entries(index).find(([, v]) => v.sessionId === id) ?? ["", {}];
        const parentKey = meta.spawnedBy || meta.parentSessionKey;
        out.push({ sessionId: id, sessionPath: file, sourceFormat: "openclaw-jsonl", name: meta.displayName || meta.label,
          createdAt: meta.sessionStartedAt ?? meta.startedAt, updatedAt: meta.updatedAt, workspacePath: meta.spawnedWorkspaceDir,
          parentSessionId: index[parentKey]?.sessionId ?? meta.parentSessionId, parentSessionKey: parentKey,
          subagent: !!parentKey || key.includes(":subagent:"), dependencies: [path.join(path.dirname(file), "sessions.json")] });
      }
      return out;
    },
    async load(entry) {
      let events;
      if (entry.sourceFormat === "openclaw-sqlite" || /\.sqlite#/.test(entry.sessionPath)) {
        const data = withDb(fileOf(entry), db => db.prepare("SELECT event_json,event_zstd FROM transcript_events WHERE session_id=? ORDER BY seq").all(entry.sessionId));
        const zlib = require("node:zlib");
        events = data.map(r => JSON.parse(r.event_json ?? zlib.zstdDecompressSync(r.event_zstd).toString("utf8")));
      } else events = await rows(fileOf(entry));
      const header = events.find(e => e.type === "session");
      return { meta: { workspacePath: entry.workspacePath || header?.cwd }, messages: normalize(events.filter(e => e.type === "message")) };
    }
  });
}
module.exports = { create };
