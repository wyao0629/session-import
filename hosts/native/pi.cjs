"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, randomBytes } = require("node:crypto");

function defaultRoot({ home = os.homedir(), env = process.env } = {}) {
  const agent = (env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent")).replace(/^~(?=[/\\]|$)/, home);
  return path.join(path.resolve(home, agent), "sessions");
}

function timestamp(value, fallback) {
  if (value == null || value === "") return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Pi import: invalid message timestamp");
  return date.toISOString();
}

async function importSession({ entry = {}, messages, rawMessages, destination, title, mode, options = {} }) {
  const root = path.resolve(destination.root || defaultRoot());
  const workspace = path.resolve(destination.workspace);
  // SessionManager.getDefaultSessionDir: resolve cwd, remove one leading separator,
  // then replace separators and colons. Do not hash or lowercase the workspace.
  const directory = path.join(root, `--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const createdAt = timestamp(entry.createdAt ?? messages[0]?.createdAt, now);
  const name = String(title ?? entry.name ?? entry.title ?? "Imported session").replace(/[\r\n]+/g, " ").trim();
  const sessionPath = path.join(directory, `${createdAt.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const pendingPath = `${sessionPath}.pending`;
  const normalized = messages.map(message => {
    if (!["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new Error("Pi import: each message must have a user/assistant role and string content");
    }
    return { ...message, createdAt: timestamp(message.createdAt, createdAt) };
  });
  const ids = new Set();
  let parentId = null;
  const nextEntry = (type, time, fields) => {
    let id;
    do { id = randomBytes(4).toString("hex"); } while (ids.has(id));
    ids.add(id);
    const result = { type, id, parentId, timestamp: time, ...fields };
    parentId = id;
    return result;
  };
  // Imported text did not make a model request. Preserve known source model
  // identifiers and mark unknown ones as imported rather than inventing a model.
  const model = options.modelId ?? entry.modelId ?? "imported";
  const provider = options.modelProvider ?? entry.providerId ?? "session-import";
  const api = options.api ?? "openai-completions";
  await fs.mkdir(directory, { recursive: true });
  const file = await fs.open(pendingPath, "wx", 0o600);
  try {
    const append = record => file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await append({ type: "session", version: 3, id: sessionId, timestamp: createdAt, cwd: workspace });
    for (const source of normalized) {
      const message = {
        role: source.role, content: [{ type: "text", text: source.content }],
        timestamp: Date.parse(source.createdAt),
      };
      if (source.role === "assistant") {
        Object.assign(message, {
          api, provider, model,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
        });
      }
      await append(nextEntry("message", source.createdAt, { message }));
    }
    await append(nextEntry("session_info", now, { name }));
    await file.sync();
  } finally { await file.close(); }
  // New UUID only, for every mode. The caller owns duplicate-import receipts.
  // Pi discovers these files directly; it has no separate native session index.
  await fs.rename(pendingPath, sessionPath);
  return {
    sessionId, sessionPath, target: "pi", title: name, messageCount: normalized.length,
    nativeHistory: true, sidebar: { registered: true, workspace },
  };
}

module.exports = { targets: [{ id: "pi", label: "Pi", defaultRoot, importSession }] };
