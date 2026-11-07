import { tool } from "@opencode-ai/plugin";
import runtimeModule from "../runtime.cjs";

const { createRuntime, tools } = runtimeModule;

function schemaField(schema) {
  const z = tool.schema;
  let value;
  if (schema.enum) {
    value = z.enum(schema.enum);
  } else {
    switch (schema.type) {
      case "string": value = z.string(); break;
      case "boolean": value = z.boolean(); break;
      case "integer": value = z.number().int(); break;
      case "number": value = z.number(); break;
      case "array": value = z.array(schemaField(schema.items)); break;
      case "object": {
        value = z.object(schemaArgs(schema));
        if (schema.additionalProperties === false) value = value.strict();
        break;
      }
      default: throw new Error(`Unsupported session tool schema: ${schema.type}`);
    }
    for (const [keyword, method] of [
      ["minLength", "min"], ["maxLength", "max"],
      ["minimum", "min"], ["maximum", "max"],
      ["minItems", "min"], ["maxItems", "max"],
    ]) {
      if (schema[keyword] !== undefined) value = value[method](schema[keyword]);
    }
  }
  return schema.description ? value.describe(schema.description) : value;
}

function schemaArgs(schema) {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, field]) => {
    const value = schemaField(field);
    return [name, required.has(name) ? value : value.optional()];
  }));
}

export default async function sessionImport({ directory }) {
  const runtimes = new Map();
  function runtime(workspace) {
    if (!runtimes.has(workspace)) {
      runtimes.set(workspace, createRuntime({ host: "opencode", workspace }));
    }
    return runtimes.get(workspace);
  }
  await runtime(directory);

  return {
    tool: Object.fromEntries(tools.map(definition => [definition.name, tool({
      description: definition.description,
      args: schemaArgs(definition.inputSchema),
      async execute(args, context) {
        const result = await (await runtime(context.directory ?? directory)).call(definition.name, args);
        return JSON.stringify(result);
      },
    })])),
    async config(config) {
      config.command ??= {};
      config.command["session-import"] ??= {
        description: "打开原导入面板或转换为目标客户端的原生会话",
        template: "用户要求：$ARGUMENTS\n没有明确来源和目标时调用 session_hub_open 打开原面板。有来源和目标时调用 session_hub_import，传用户指定的 target、workspace、targetRoot，返回原生 sessionId、sessionPath 与侧边栏位置。不要将转录注入当前对话，不把全文塞成单条用户消息。",
      };
      config.command["session-forge"] ??= {
        description: "Distill selected sessions with the current model",
        template: "Use session_hub_resolve/search and session_hub_forge for this request: $ARGUMENTS\nProduce the requested rules or skill from the returned material. Save with session_hub_forge content/outputPath only if the user requested a saved artifact.",
      };
    },
    async event({ event }) {
      if (event.type !== "server.instance.disposed") return;
      const pending = [...runtimes.values()];
      runtimes.clear();
      await Promise.all(pending.map(async value => (await value).close()));
    },
  };
}
