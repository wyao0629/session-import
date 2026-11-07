"use strict";

const { fs, path, randomUUID, readJson, object, mergeJson, writeJsonl, segment, prepare, result } = require("./shared.cjs");

// Claude Code's project-key algorithm, including its native long-path hash.
function projectKey(workspace) {
  const key = workspace.replace(/[^a-zA-Z0-9]/g, "-");
  if (key.length <= 200) return key;
  let hash = 0;
  for (let i = 0; i < workspace.length; i++) hash = ((hash << 5) - hash + workspace.charCodeAt(i)) | 0;
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
function* records(data) {
  let parentUuid = null;
  for (const item of data.messages) {
    const uuid = randomUUID();
    const message = item.role === "user"
      ? { role: "user", content: item.content }
      : { id: `msg_${randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant",
        model: data.options.model || "<synthetic>", content: [{ type: "text", text: item.content }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    yield { type: item.role, uuid, parentUuid, sessionId: data.sessionId, cwd: data.workspace,
      timestamp: item.timestamp, isSidechain: false, userType: "external", message };
    parentUuid = uuid;
  }
  yield { type: "custom-title", sessionId: data.sessionId, customTitle: data.title };
}
const target = {
  id: "claude", label: "Claude Code",
  defaultRoot: ({ home, env }) => env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
  async importSession(input) {
    const data = prepare(target, input);
    const base = path.basename(data.root) === "projects" ? data.root : path.join(data.root, "projects");
    const dir = path.join(base, segment(data.destination.projectId || projectKey(data.workspace), "Claude projectId"));
    const indexPath = path.join(dir, "sessions-index.json");
    const existing = await readJson(indexPath);
    if (existing !== null && (!object(existing, indexPath) || !Array.isArray(existing.entries))) throw new Error(`Claude sessions-index 缺少 entries 数组：${indexPath}`);
    const sessionPath = path.join(dir, `${data.sessionId}.jsonl`);
    await writeJsonl(sessionPath, records(data));
    const stat = await fs.stat(sessionPath);
    await mergeJson(indexPath, { version: 1, entries: [], originalPath: data.workspace }, index => {
      object(index, indexPath);
      if (!Array.isArray(index.entries)) throw new Error(`Claude sessions-index 缺少 entries 数组：${indexPath}`);
      index.entries.push({ sessionId: data.sessionId, fullPath: sessionPath, fileMtime: stat.mtimeMs,
        firstPrompt: data.messages.find(message => message.role === "user")?.content || "",
        summary: data.title, customTitle: data.title, messageCount: data.messages.length,
        created: data.createdAt, modified: data.updatedAt, gitBranch: "", projectPath: data.workspace, isSidechain: false });
      return index;
    });
    return result(target, data, sessionPath);
  },
};
module.exports = target;
