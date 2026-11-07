import runtimeModule from "../runtime.cjs";

const { createRuntime, tools } = runtimeModule;
function argsOf(input) {
  const value = input.trim();
  return value.startsWith("{") ? JSON.parse(value) : { ref: value };
}
export default function sessionImport(pi) {
  const runtimes = new Map();
  const runtime = ctx => {
    if (!runtimes.has(ctx.cwd)) runtimes.set(ctx.cwd, createRuntime({ host: "pi", workspace: ctx.cwd }));
    return runtimes.get(ctx.cwd);
  };
  for (const definition of tools) pi.registerTool({
    name: definition.name, label: definition.name, description: definition.description, parameters: definition.inputSchema,
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const result = await (await runtime(ctx)).call(definition.name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.on("session_start", async (_event, ctx) => { await runtime(ctx); });
  pi.on("session_shutdown", async () => {
    const pending = [...runtimes.values()]; runtimes.clear();
    await Promise.all(pending.map(async item => (await item).close()));
  });
  pi.registerCommand("session-import-open", {
    description: "打开原会话导入面板",
    handler: async (_input, ctx) => { await (await runtime(ctx)).call("session_hub_open", {}); },
  });
  const importAndOpen = async (input, ctx) => {
    if (!input.trim()) { await (await runtime(ctx)).call("session_hub_open", {}); return; }
    await ctx.waitForIdle();
    const result = await (await runtime(ctx)).call("session_hub_import", { ...argsOf(input), target: "pi" });
    if (!result.sessionPath) throw new Error(result.failed.map(item => item.error).join("；"));
    if (result.failed.length) pi.sendMessage({ customType: "session-import-result", content: JSON.stringify(result, null, 2), display: true, details: result }, { triggerTurn: false });
    await ctx.switchSession(result.sessionPath);
  };
  pi.registerCommand("session-import", { description: "逐条导入历史为 Pi 原生会话并打开；不带参数打开原面板", handler: importAndOpen });
  pi.registerCommand("session-import-current", { description: "兼容旧命令：导入并打开原生会话，不注入当前对话", handler: importAndOpen });
  pi.registerCommand("session-hub", {
    description: "同步、搜索、预览或原生导入",
    handler: async (input, ctx) => {
      const match = input.trim().match(/^(open|sync|search|resolve|read|import|forge)(?:\s+([\s\S]+))?$/);
      if (!match) { await (await runtime(ctx)).call("session_hub_open", {}); return; }
      const args = match[2] ? JSON.parse(match[2]) : {};
      const result = await (await runtime(ctx)).call(`session_hub_${match[1]}`, args);
      pi.sendMessage({ customType: "session-import-result", content: JSON.stringify(result, null, 2), display: true, details: result }, { triggerTurn: false });
    },
  });
}
