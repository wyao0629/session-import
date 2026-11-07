/**
 * Pi CLI: <root>/sessions/<slug>/<file>.jsonl. Line 1 is the session header;
 * a `session_info` entry carries the name set with /name (last one wins).
 */
"use strict";

const path = require("node:path");
const { mkEntry } = require("../entry");
const { isInjected, userRequest } = require("../inject");
const { listDir, statSig, eachJsonLine, text, iso, cleanPath, uuidIn } = require("../fsx");

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
  const info = { count: 0 };
  await eachJsonLine(file, (o) => {
    if (!o) return false;
    if (o.type === "session" && !info.header) info.header = o;
    else if (o.type === "session_info" && text(o.name)) info.name = o.name.trim();
    else if (o.type === "message" && o.message) {
      info.count += 1;
      if (!info.prompt && o.message.role === "user") {
        const t = blockText(o.message.content);
        if (t && !isInjected(t)) info.prompt = userRequest(t);
      }
    }
    return false;
  });
  return info;
}

async function scan(root, ctx) {
  const base = path.join(root, "sessions");
  const out = [];
  for (const dir of listDir(base)) {
    if (!dir.isDirectory()) continue;
    for (const f of listDir(path.join(base, dir.name))) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const file = path.join(base, dir.name, f.name);
      try {
        const st = await statSig(file);
        const prev = ctx.byPath.get(file);
        if (prev && prev.sig === st?.sig) {
          out.push(prev);
          continue;
        }
        const info = await readOne(file);
        const h = info.header;
        if (!h?.id || info.count === 0) continue;
        out.push(
          mkEntry("pi", String(h.id), file, {
            name: info.name,
            firstPrompt: info.prompt,
            workspacePath: cleanPath(h.cwd),
            sourceFormat: "pi-jsonl",
            createdAt: iso(h.timestamp),
            updatedAt: new Date(st.mtimeMs).toISOString(),
            messageCount: info.count,
            parentSessionId: uuidIn(h.parentSession),
            sig: st.sig,
          }),
        );
      } catch (error) {
        ctx.report(f.name, error);
      }
    }
  }
  return out;
}

module.exports = { scan };
