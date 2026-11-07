/**
 * Claude Code: <root>/projects/<slug>/<sessionId>.jsonl. A session's own name
 * is recorded by marker rows (custom-title > agent-name > ai-title > summary,
 * last one of each kind wins). Only marker rows and the first prompt are
 * JSON-parsed; message counting is a substring test so tens-of-MB transcripts
 * stay cheap, and unchanged files are skipped via the mtime/size signature.
 */
"use strict";

const path = require("node:path");
const { mkEntry } = require("../entry");
const { isInjected, userRequest } = require("../inject");
const { listDir, statSig, eachJsonLine, text, iso, cleanPath } = require("../fsx");

const NAME_ROWS = {
  "custom-title": ["customTitle", "title"],
  "agent-name": ["agentName", "name"],
  "ai-title": ["aiTitle", "title"],
  summary: ["summary", "title"],
};
const NAME_ORDER = ["custom-title", "agent-name", "ai-title", "summary"];
const MARKER = /"type":"(custom-title|agent-name|ai-title|summary)"/;
const CONVO = /^\{[^\n]{0,240}?"type":"(user|assistant)"/;

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function readOne(file) {
  const names = {};
  const info = { count: 0 };
  await eachJsonLine(file, (o, raw) => {
    if (raw.length < 4000 && MARKER.test(raw) && o) {
      const keys = NAME_ROWS[o.type];
      const v = keys && keys.map((k) => text(o[k])).find(Boolean);
      if (v) names[o.type] = v;
      return false;
    }
    if (!CONVO.test(raw) || raw.includes('"isSidechain":true')) return false;
    info.count += 1;
    if (!info.cwd || !info.prompt || !info.createdAt) {
      const row = o ?? safeParse(raw);
      info.cwd = info.cwd ?? text(row?.cwd);
      info.createdAt = info.createdAt ?? row?.timestamp;
      info.sessionId = info.sessionId ?? text(row?.sessionId);
      if (!info.prompt && row?.type === "user") {
        const t = blockText(row.message?.content);
        if (t && !isInjected(t)) info.prompt = userRequest(t);
      }
    }
    return false;
  });
  info.name = NAME_ORDER.map((k) => names[k]).find(Boolean);
  return info;
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function scan(root, ctx) {
  const projects = path.join(root, "projects");
  const out = [];
  for (const dir of listDir(projects)) {
    if (!dir.isDirectory()) continue;
    for (const f of listDir(path.join(projects, dir.name))) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const file = path.join(projects, dir.name, f.name);
      const id = f.name.slice(0, -6);
      try {
        const st = await statSig(file);
        const prev = ctx.previous.get(`claude:${id}`);
        if (prev && prev.sig === st?.sig && prev.sessionPath === file) {
          out.push(prev);
          continue;
        }
        const info = await readOne(file);
        if (info.count === 0) continue;
        out.push(
          mkEntry("claude", id, file, {
            name: info.name,
            firstPrompt: info.prompt,
            workspacePath: cleanPath(info.cwd),
            sourceFormat: "claude-jsonl",
            createdAt: iso(info.createdAt),
            updatedAt: new Date(st.mtimeMs).toISOString(),
            messageCount: info.count,
            sig: st.sig,
          }),
        );
      } catch (error) {
        ctx.report(id, error);
      }
    }
  }
  return out;
}

module.exports = { scan };
