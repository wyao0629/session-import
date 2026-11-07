/**
 * DeepSeek Harness: <root>/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd.
 * The file is hundreds or thousands of concatenated zstd frames, and
 * zlib.zstdDecompressSync only reads the first one, so frames are decoded one
 * by one. The name is the last `session/title` event.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { mkEntry } = require("../entry");
const { listDir, statSig, text, iso, cleanPath } = require("../fsx");

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeFrames(buf) {
  const starts = [];
  for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 4)) starts.push(i);
  const parts = [];
  let from = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[from], end)));
      from = k + 1;
    } catch {
      /* a frame boundary that was only a coincidental magic: extend the span */
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

function readEvents(file) {
  const raw = fs.readFileSync(file);
  const body = file.endsWith(".zstd") ? decodeFrames(raw) : raw.toString("utf8");
  const rows = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* ignore a torn tail line */
    }
  }
  return rows;
}

async function scan(root, ctx) {
  const base = path.join(root, "sessions");
  const out = [];
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("当前运行环境的 Node 不支持 zstd 解压（需要 zlib.zstdDecompressSync），无法读取 DSH 会话");
  }
  for (const slug of listDir(base)) {
    if (!slug.isDirectory()) continue;
    for (const ses of listDir(path.join(base, slug.name))) {
      if (!ses.isDirectory()) continue;
      const dir = path.join(base, slug.name, ses.name);
      const file = listDir(dir).map((e) => e.name).find((n) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n));
      if (!file) continue;
      const full = path.join(dir, file);
      try {
        const st = await statSig(full);
        const prev = ctx.byPath.get(full);
        if (prev && prev.sig === st?.sig) {
          out.push(prev);
          continue;
        }
        const rows = readEvents(full);
        const header = rows.find((r) => r.type === "session");
        if (!header) continue;
        const title = rows.filter((r) => r.type === "session/title").map((r) => text(r.data?.title)).filter(Boolean).pop();
        out.push(
          mkEntry("dsh", String(header.id ?? ses.name), full, {
            name: title,
            workspacePath: cleanPath(header.cwd),
            sourceFormat: "dsh-events",
            createdAt: iso(header.createdAt),
            updatedAt: new Date(st.mtimeMs).toISOString(),
            messageCount: rows.filter((r) => r.type === "user/message" || r.type === "assistant/message").length,
            parentSessionId: text(header.parentSession),
            importSource: null,
            sig: st.sig,
          }),
        );
      } catch (error) {
        ctx.report(ses.name, error);
      }
    }
  }
  return out;
}

module.exports = { scan, readEvents, decodeFrames };
