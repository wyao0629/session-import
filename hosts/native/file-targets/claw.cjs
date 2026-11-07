"use strict";

const { path, randomUUID, readJson, object, mergeJson, writeJsonl, segment, prepare, result, sameWorkspace } = require("./shared.cjs");
const { sqliteStore, writeSqliteSession } = require("./claw-sqlite.cjs");

async function agentFor(data) {
  const config = await readJson(path.join(data.root, "openclaw.json"), {});
  const agents = config.agents?.list || Object.entries(config.agents?.entries || {}).map(([id, entry]) => ({ ...entry, id }));
  const requestedProject = data.destination.projectId;
  const projectAgent = requestedProject?.startsWith("workspace:") ? requestedProject.slice(10) : agents.find(agent => agent.id === requestedProject)?.id;
  const match = agents.find(agent => sameWorkspace(agent.workspace || config.agents?.defaults?.workspace, data.workspace));
  const agentId = segment(data.options.agentId || projectAgent || match?.id || agents.find(agent => agent.default)?.id || "main", "Claw agentId");
  const projectId = requestedProject === agentId ? `workspace:${agentId}` : requestedProject || (match?.id === agentId ? `workspace:${agentId}` : undefined);
  return { agentId, projectId };
}
function* transcript(data) {
  yield { type: "session", version: 3, id: data.sessionId, timestamp: data.createdAt, cwd: data.workspace };
  let parentId = null;
  for (const item of data.messages) {
    const id = randomUUID();
    const message = { role: item.role, content: [{ type: "text", text: item.content }], timestamp: new Date(item.timestamp).getTime() };
    if (item.role === "assistant") Object.assign(message, { api: "openai-completions", provider: "session-import",
      model: data.options.model || "imported", stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    yield { type: "message", id, parentId, timestamp: item.timestamp, message };
    parentId = id;
  }
  yield { type: "session_info", id: randomUUID(), parentId, timestamp: data.updatedAt, name: data.title };
}
function create(id, label, stateVariable, directory) {
  const target = {
    id, label,
    defaultRoot: ({ home, env }) => env[stateVariable] || path.join(home, directory),
    async importSession(input) {
      const data = prepare(target, input);
      const { agentId, projectId } = await agentFor(data);
      const agentDir = path.join(data.root, "agents", agentId);
      const database = await sqliteStore(agentDir);
      if (database) {
        const sessionKey = `agent:${agentId.toLowerCase()}:dashboard:${data.sessionId}`;
        await writeSqliteSession(database, data, sessionKey, projectId, transcript(data));
        return { ...result(target, data, database), sessionKey, storage: "sqlite" };
      }
      const fileAgentId = segment(data.destination.projectId && !data.destination.projectId.startsWith("workspace:") ? data.destination.projectId : agentId, "Claw agentId");
      const sessions = path.join(data.root, "agents", fileAgentId, "sessions");
      const indexPath = path.join(sessions, "sessions.json");
      object(await readJson(indexPath, {}), indexPath);
      const sessionPath = path.join(sessions, `${data.sessionId}.jsonl`);
      const sessionKey = `agent:${fileAgentId}:${data.sessionId}`;
      await writeJsonl(sessionPath, transcript(data));
      await mergeJson(indexPath, {}, index => {
        object(index, indexPath);
        if (Object.hasOwn(index, sessionKey)) throw new Error(`原生会话索引已存在新生成的 UUID：${sessionKey}`);
        index[sessionKey] = { sessionId: data.sessionId, sessionFile: sessionPath,
          displayName: data.title, label: data.title, chatType: "direct",
          sessionStartedAt: new Date(data.createdAt).getTime(), startedAt: new Date(data.createdAt).getTime(),
          updatedAt: new Date(data.updatedAt).getTime(), lastInteractionAt: new Date(data.updatedAt).getTime(),
          cwd: data.workspace, spawnedWorkspaceDir: data.workspace,
          systemSent: false, abortedLastRun: false };
        return index;
      });
      return result(target, data, sessionPath);
    },
  };
  return target;
}
module.exports = { targets: [create("openclaw", "OpenClaw", "OPENCLAW_STATE_DIR", ".openclaw"), create("autoclaw", "AutoClaw", "AUTOCLAW_STATE_DIR", ".openclaw-autoclaw")] };
