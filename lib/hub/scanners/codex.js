/**
 * Codex: names live in session_index.jsonl (`thread_name`, updated on rename)
 * and the newest state_*.sqlite `threads` table (`name`). The table's `title`
 * is only the first user message, so it is a display fallback, never the name.
 */
"use strict";

const path = require("node:path");
const { mkEntry, withDb, columnsOf } = require("../entry");
const { walk, readJsonLines, eachJsonLine, listDir, exists, statSig, text, iso, cleanPath, uuidIn } = require("../fsx");

const { isInjected, userRequest } = require("../inject");

function messageText(item) {
  const c = item?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b) => typeof b?.text === "string" && (b.type === "input_text" || b.type === "text"))
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Peek at the head of a rollout for id / cwd / first prompt. */
async function peek(file) {
  const out = {};
  let rows = 0;
  await eachJsonLine(file, (o) => {
    rows += 1;
    if (!o) return rows > 60;
    const payload = o.type === "session_meta" ? o.payload : !o.type && o.id ? o : null;
    if (payload) {
      out.id = text(payload.id) ?? out.id;
      out.cwd = text(payload.cwd) ?? out.cwd;
      out.startedAt = payload.timestamp ?? o.timestamp ?? out.startedAt;
    }
    const item = o.type === "response_item" ? o.payload : o;
    if (!out.prompt && item?.type === "message" && item.role === "user") {
      const t = messageText(item);
      if (t && !isInjected(t)) out.prompt = userRequest(t);
    }
    return Boolean(out.id && out.prompt) || rows > 60;
  });
  return out;
}

/** `source` holds JSON like {"subagent":{"thread_spawn":{"parent_thread_id":...}}} for spawned agents. */
function subagentParent(source) {
  if (typeof source !== "string" || !source.startsWith("{")) return undefined;
  try {
    return text(JSON.parse(source)?.subagent?.thread_spawn?.parent_thread_id);
  } catch {
    return undefined;
  }
}

/**
 * Threads Codex does not list as sessions of their own: agents spawned by
 * another thread, and automation runs. They stay in the index (an agent can
 * still look them up) but are not offered for import.
 */
function isInternal(row) {
  if (!row) return false;
  const ts = text(row.thread_source);
  return ts === "subagent" || ts === "automation" || Boolean(subagentParent(row.source));
}

function readState(root) {
  const files = listDir(root)
    .filter((e) => e.isFile() && /^state(_\d+)?\.sqlite$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0)));
  for (const f of files) {
    try {
      return withDb(path.join(root, f), (db) => {
        const cols = columnsOf(db, "threads");
        const pick = (c, as = c) => (cols.has(c) ? `${c} AS ${as}` : `NULL AS ${as}`);
        const sql = `SELECT id, ${pick("rollout_path")}, ${pick("cwd")}, ${pick("title")}, ${pick("name")},
          ${pick("first_user_message")}, ${pick("updated_at")}, ${pick("updated_at_ms")}, ${pick("created_at")},
          ${pick("archived")}, ${pick("model")}, ${pick("attached_thread_parent_id", "parent")},
          ${pick("thread_source")}, ${pick("source")} FROM threads`;
        return db.prepare(sql).all();
      });
    } catch {
      continue;
    }
  }
  return [];
}

async function scan(root, ctx) {
  const names = new Map();
  for (const row of await readJsonLines(path.join(root, "session_index.jsonl"))) {
    const id = text(row.id);
    if (id && text(row.thread_name)) names.set(id, { name: row.thread_name.trim(), at: row.updated_at });
  }
  const threads = new Map(readState(root).map((r) => [String(r.id), r]));
  const files = new Map();
  for (const sub of ["sessions", "archived_sessions"]) {
    for (const f of await walk(path.join(root, sub), (p) => p.endsWith(".jsonl"))) {
      const id = uuidIn(path.basename(f));
      if (id) files.set(id, { file: f, archived: sub !== "sessions" });
    }
  }
  const out = [];
  for (const id of new Set([...threads.keys(), ...files.keys()])) {
    try {
      const row = threads.get(id);
      const found = files.get(id);
      const rollout = [cleanPath(row?.rollout_path), found?.file].find((p) => p && exists(p));
      if (!rollout) continue;
      const st = await statSig(rollout);
      const indexed = names.get(id);
      const name = indexed?.name ?? text(row?.name);
      const rawPrompt = text(row?.first_user_message) ?? text(row?.title);
      let prompt = rawPrompt ? userRequest(rawPrompt) : undefined;
      let cwd = cleanPath(row?.cwd);
      let startedAt;
      if (!prompt || !cwd) {
        const prev = ctx.previous.get(`codex:${id}`);
        if (prev?.sig === st?.sig && (prev.firstPrompt || prev.workspacePath)) {
          prompt = prompt ?? prev.firstPrompt;
          cwd = cwd ?? prev.workspacePath;
        } else {
          const p = await peek(rollout).catch(() => ({}));
          prompt = prompt ?? p.prompt;
          cwd = cwd ?? cleanPath(p.cwd);
          startedAt = p.startedAt;
        }
      }
      out.push(
        mkEntry("codex", id, rollout, {
          name,
          firstPrompt: prompt,
          workspacePath: cwd,
          sourceFormat: "codex-jsonl",
          createdAt: iso(row?.created_at) ?? iso(startedAt),
          updatedAt: iso(row?.updated_at_ms) ?? iso(row?.updated_at) ?? iso(indexed?.at) ?? (st ? new Date(st.mtimeMs).toISOString() : undefined),
          parentSessionId: text(row?.parent) ?? subagentParent(row?.source),
          internal: isInternal(row),
          archived: Boolean(row?.archived) || found?.archived,
          modelId: text(row?.model),
          sig: st?.sig,
        }),
      );
    } catch (error) {
      ctx.report(id, error);
    }
  }
  return out;
}

module.exports = { scan };
