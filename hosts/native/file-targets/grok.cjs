"use strict";

const { path, randomUUID, writeNew, writeJsonl, prepare, result } = require("./shared.cjs");

function* chatHistory(data) {
  for (const item of data.messages) yield { type: item.role,
    content: item.role === "user" ? [{ type: "text", text: item.content }] : item.content,
    timestamp: item.timestamp };
}
function* updates(data) {
  let promptIndex = -1, promptId = randomUUID();
  for (const item of data.messages) {
    if (item.role === "user") { promptIndex++; promptId = randomUUID(); }
    const timestamp = new Date(item.timestamp).getTime();
    yield { timestamp, method: "session/update", params: { sessionId: data.sessionId,
      update: { sessionUpdate: item.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: { type: "text", text: item.content },
        ...(item.role === "user" ? { _meta: { promptIndex } } : {}) },
      _meta: { eventId: item.role === "user" ? promptId : randomUUID(), agentTimestampMs: timestamp } } };
    if (item.role === "assistant") yield { timestamp, method: "_x.ai/session/update", params: { sessionId: data.sessionId,
      update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" },
      _meta: { eventId: randomUUID(), agentTimestampMs: timestamp } } };
  }
}
const target = {
  id: "grok", label: "Grok",
  defaultRoot: ({ home, env }) => env.GROK_HOME || path.join(home, ".grok"),
  async importSession(input) {
    const data = prepare(target, input);
    const workspaceKey = encodeURIComponent(data.workspace).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const dir = path.join(data.root, "sessions", workspaceKey, data.sessionId);
    const sessionPath = path.join(dir, "chat_history.jsonl");
    await writeJsonl(sessionPath, chatHistory(data));
    await writeJsonl(path.join(dir, "updates.jsonl"), updates(data));
    await writeNew(path.join(dir, "summary.json"), {
      info: { id: data.sessionId, cwd: data.workspace },
      session_summary: data.title, generated_title: data.title, title_is_manual: true,
      created_at: data.createdAt, updated_at: data.updatedAt, last_active_at: data.importedAt,
      num_messages: data.messages.length + data.messages.filter(message => message.role === "assistant").length, num_chat_messages: data.messages.length,
      next_trace_turn: data.messages.filter(message => message.role === "user").length,
      chat_format_version: 1, request_id: randomUUID(), grok_home: data.root,
      ...(data.options.model ? { current_model_id: data.options.model } : {}),
    });
    return result(target, data, sessionPath);
  },
};
module.exports = target;
