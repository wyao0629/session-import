#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { createRuntime, tools } = require("./runtime.cjs");
let runtimePromise;
const runtime = () => runtimePromise ??= createRuntime();
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const prompts = [{ name: "session-import", description: "转换历史并登记为目标客户端的原生会话", arguments: [{ name: "ref", description: "会话 key、ID 或链接", required: true }, { name: "harness", description: "来源 Harness", required: false }] }, { name: "session-forge", description: "提炼历史会话为项目规则或技能", arguments: [{ name: "ref", description: "会话 key、ID 或链接", required: true }, { name: "goal", description: "提炼目标", required: false }] }];

async function dispatch(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    error(message?.id ?? null, -32600, "Invalid JSON-RPC request");
    return;
  }
  const { id, method, params = {} } = message;
  if (id === undefined) {
    if (method === "notifications/initialized") await runtime();
    return;
  }
  switch (method) {
    case "initialize": {
      const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
      result(id, { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : "2025-06-18", capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: { name: "session-import", version: "2.0.0" }, instructions: "沿用原会话导入面板，自动同步、预览并转换为原生会话。session_hub_open 打开面板；import 按目标工作区登记侧边栏并返回原生会话 ID，不把历史作为当前对话上下文。" });
      return;
    }
    case "ping": result(id, {}); return;
    case "tools/list": result(id, { tools }); return;
    case "tools/call": {
      if (!tools.some(tool => tool.name === params.name)) { error(id, -32602, `Unknown tool: ${params.name}`); return; }
      try {
        const output = await (await runtime()).call(params.name, params.arguments ?? {});
        result(id, { content: [{ type: "text", text: JSON.stringify(output) }], isError: output.ok === false });
      } catch (failure) {
        result(id, { content: [{ type: "text", text: failure.message }], isError: true });
      }
      return;
    }
    case "prompts/list": result(id, { prompts }); return;
    case "prompts/get": {
      const args = params.arguments ?? {};
      if (!args.ref) { error(id, -32602, "ref is required"); return; }
      let output;
      if (params.name === "session-import") output = await (await runtime()).call("session_hub_import", args);
      else if (params.name === "session-forge") output = await (await runtime()).call("session_hub_forge", { refs: [args.ref], goal: args.goal });
      else { error(id, -32602, `Unknown prompt: ${params.name}`); return; }
      result(id, { description: output.title ?? "Session Forge", messages: [{ role: "user", content: { type: "text", text: output.text ?? JSON.stringify(output) } }] });
      return;
    }
    default: error(id, -32601, `Method not found: ${method}`);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve();
input.on("line", line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { error(null, -32700, "Parse error"); return; }
  pending = pending.then(() => dispatch(message)).catch(failure => {
    if (message?.id !== undefined) error(message.id, -32603, failure.message);
    else console.error(`[session-import] ${failure.message}`);
  });
});
input.on("close", () => { pending.finally(async () => { if (runtimePromise) (await runtimePromise).close(); }).catch(failure => console.error(failure.message)); });
process.on("SIGINT", async () => { if (runtimePromise) (await runtimePromise).close(); input.close(); process.exit(0); });
process.on("SIGTERM", async () => { if (runtimePromise) (await runtimePromise).close(); input.close(); process.exit(0); });
