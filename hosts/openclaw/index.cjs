"use strict";

const { createRuntime, tools } = require("../runtime.cjs");
const { configSchema } = require("../../openclaw.plugin.json");

module.exports = {
  id: "session-import",
  name: "Session Import",
  version: "2.0.0",
  description: "Import local harness transcripts into current agent context.",
  configSchema: { jsonSchema: configSchema },
  register(api) {
    const options = api.pluginConfig ?? {};
    const runtimes = new Map();
    function runtime(workspaceDir) {
      const workspace = options.workspace ?? workspaceDir ?? process.cwd();
      if (!runtimes.has(workspace)) {
        runtimes.set(workspace, createRuntime({
          host: options.host ?? "openclaw",
          workspace,
          dataDir: options.dataDir,
          autoSync: options.autoSync !== false,
        }));
      }
      return runtimes.get(workspace);
    }

    api.registerTool((ctx) => tools.map(definition => ({
      name: definition.name,
      label: definition.name.replace("session_hub_", "Session: "),
      description: definition.description,
      parameters: definition.inputSchema,
      async execute(_toolCallId, args, signal) {
        signal?.throwIfAborted();
        const result = await (await runtime(ctx.workspaceDir)).call(definition.name, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    })), { names: tools.map(definition => definition.name) });

    api.registerService({
      id: "session-import-runtime",
      async start(ctx) {
        await runtime(ctx.workspaceDir);
      },
      async stop() {
        const pending = [...runtimes.values()];
        runtimes.clear();
        await Promise.all(pending.map(async value => (await value).close()));
      },
    });
  },
};
