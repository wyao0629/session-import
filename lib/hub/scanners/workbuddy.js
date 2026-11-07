/**
 * WorkBuddy: <root>/projects/<project>/<sessionId>.jsonl. The session's own
 * name is the last `ai-title` row; injected context blocks are stripped from
 * the first-prompt fallback exactly as the importer does.
 */
"use strict";

const path = require("node:path");
const { mkEntry } = require("../entry");
const { listDir, statSig, eachJsonLine, text, iso, cleanPath } = require("../fsx");
const wb = require("../../sources/workbuddy");

async function readOne(file) {
  const info = { count: 0 };
  await eachJsonLine(file, (o) => {
    if (!o) return false;
    if (o.type === "ai-title" && text(o.aiTitle)) info.name = o.aiTitle.trim();
    if (!wb.isConversationLine(o)) return false;
    info.count += 1;
    info.cwd = info.cwd ?? text(o.cwd);
    info.createdAt = info.createdAt ?? o.timestamp;
    if (!info.prompt && o.role === "user") info.prompt = wb.stripInjected(wb.blockText(o.content)) || undefined;
    return false;
  });
  return info;
}

async function scan(root, ctx) {
  const base = path.join(root, "projects");
  const out = [];
  for (const dir of listDir(base)) {
    if (!dir.isDirectory()) continue;
    for (const f of listDir(path.join(base, dir.name))) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const file = path.join(base, dir.name, f.name);
      const id = f.name.slice(0, -6);
      try {
        const st = await statSig(file);
        const prev = ctx.previous.get(`workbuddy:${id}`);
        if (prev && prev.sig === st?.sig && prev.sessionPath === file) {
          out.push(prev);
          continue;
        }
        const info = await readOne(file);
        if (info.count === 0) continue;
        out.push(
          mkEntry("workbuddy", id, file, {
            name: info.name,
            firstPrompt: info.prompt,
            workspacePath: cleanPath(info.cwd),
            sourceFormat: "workbuddy-jsonl",
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
