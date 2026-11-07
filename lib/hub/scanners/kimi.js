/**
 * Kimi Code: session_index.jsonl lists sessions (later lines override earlier
 * ones); each session's state.json holds its title (`isCustomTitle` marks a
 * user rename) and wire.jsonl holds the transcript. Legacy Kimi keeps
 * <root>/sessions/**\/wire.jsonl next to a state.json.
 */
"use strict";

const path = require("node:path");
const { mkEntry } = require("../entry");
const fs = require("node:fs");
const { readJsonLines, readJson, eachJsonLine, walk, exists, statSig, text, iso, cleanPath } = require("../fsx");
const { isInjected } = require("../inject");

const bare = (id) => id.replace(/^session_/, "");

async function describe(harness, id, dir, hint, ctx) {
  const state = (await readJson(path.join(dir, "state.json"))) ?? {};
  const wire = path.join(dir, "agents", "main", "wire.jsonl");
  const file = exists(wire) ? wire : path.join(dir, "state.json");
  const st = await statSig(file);
  if (!st) return null;
  const title = text(state.title);
  const aliases = id !== bare(id) ? [bare(id)] : [];
  return mkEntry(harness, id, file, {
    aliases,
    name: title,
    workspacePath: cleanPath(state.cwd) ?? cleanPath(hint),
    sourceFormat: harness === "kimi-code" ? "kimi-code-wire" : "kimi-wire",
    createdAt: iso(state.createdAt),
    updatedAt: iso(state.updatedAt) ?? new Date(st.mtimeMs).toISOString(),
    archived: state.archived === true,
    importSource: null,
    sig: st.sig,
  });
}

async function scanKimiCode(root, ctx) {
  const latest = new Map();
  for (const row of await readJsonLines(path.join(root, "session_index.jsonl"))) {
    const id = text(row.sessionId);
    if (id) latest.set(id, { ...latest.get(id), ...row });
  }
  const out = [];
  for (const [id, row] of latest) {
    if (row.deleted === true) continue;
    try {
      const dir = text(row.sessionDir) ?? path.join(root, "sessions");
      const entry = await describe("kimi-code", id, dir, row.workDir, ctx);
      if (entry) out.push(entry);
    } catch (error) {
      ctx.report(id, error);
    }
  }
  return out;
}

/**
 * Legacy Kimi: <root>/sessions/<hash>/<session>/context.jsonl is the transcript
 * (OpenAI-style roles). context_N.jsonl are rotated parts and subagents/ are
 * child runs, so neither is a session of its own. state.json, when present,
 * carries `custom_title` and `archived`.
 */
async function scanKimi(root, ctx) {
  const out = [];
  const files = await walk(path.join(root, "sessions"), (p, n) => n === "context.jsonl");
  for (const file of files) {
    const dir = path.dirname(file);
    if (dir.split(path.sep).includes("subagents")) continue;
    const id = path.basename(dir);
    try {
      const st = await statSig(file);
      if (!st) continue;
      const prev = ctx.previous.get(`kimi:${id}`);
      if (prev && prev.sig === st.sig && prev.sessionPath === file) {
        out.push(prev);
        continue;
      }
      let count = 0;
      let prompt;
      await eachJsonLine(file, (o) => {
        if (!o) return false;
        if (o.role === "user" || o.role === "assistant") count += 1;
        if (!prompt && o.role === "user") {
          const t = typeof o.content === "string" ? o.content : (o.content ?? []).map((b) => b?.text ?? "").join("\n");
          if (t.trim() && !isInjected(t)) prompt = t.trim();
        }
        return false;
      });
      if (count === 0) continue;
      const state = (await readJson(path.join(dir, "state.json"))) ?? {};
      out.push(
        mkEntry("kimi", id, file, {
          name: text(state.custom_title),
          firstPrompt: prompt,
          sourceFormat: "kimi-context",
          createdAt: iso(fs.statSync(file).birthtimeMs),
          updatedAt: iso(st.mtimeMs),
          messageCount: count,
          archived: state.archived === true,
          importSource: null,
          sig: st.sig,
        }),
      );
    } catch (error) {
      ctx.report(id, error);
    }
  }
  return out;
}

module.exports = { scanKimiCode, scanKimi };
