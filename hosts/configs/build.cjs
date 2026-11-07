"use strict";

const path = require("node:path");
const json = value => JSON.stringify(value, null, 2) + "\n";
const quote = value => JSON.stringify(value);
const serverName = "session_import";

function serverFor(host, root, workspace) {
  return { command: "node", args: [path.join(root, "hosts", "mcp.cjs")],
    env: { SESSION_IMPORT_HOST: host.id, SESSION_IMPORT_WORKSPACE: workspace } };
}

function tomlConfig(server, name = serverName) {
  return `[mcp_servers.${name}]\ncommand = ${quote(server.command)}\nargs = ${JSON.stringify(server.args)}\n\n[mcp_servers.${name}.env]\n` +
    Object.entries(server.env).map(([key, value]) => `${key} = ${quote(value)}\n`).join("");
}

function build(host, { root, workspace, output }) {
  const server = serverFor(host, root, workspace);
  const mcp = { mcpServers: { [serverName]: server } };
  const cli = path.join(root, "hosts", "cli.cjs");
  const skillDir = path.join(output, "skills", "session-import");
  const files = { "mcp.json": json(mcp) };
  const runner = `#!/usr/bin/env node\n"use strict";\nconst { main } = require(${quote(cli)});\nmain([...process.argv.slice(2), "--host", ${quote(host.id)}, "--workspace", ${quote(workspace)}]).catch(error => { console.error(error.message); process.exitCode = 1; });\n`;
  files["skills/session-import/run.cjs"] = runner;
  const skill = [
    "---", "name: session-import", "description: Search, read, import and distill conversation history from seventeen local agent harnesses through the shared session-import CLI.", "---", "",
    "# Session import", "",
    `Host: ${host.label}. Shared entry: ${cli}.`,
    `Run the bundled launcher with Node. Resolve run.cjs relative to this SKILL.md (generated location: ${skillDir}).`,
    "", "```text", "node <skill-directory>/run.cjs open", "node <skill-directory>/run.cjs sync",
    "node <skill-directory>/run.cjs search --query <keywords>",
    "node <skill-directory>/run.cjs resolve <source:id>",
    "node <skill-directory>/run.cjs read <source:id> --text",
    "node <skill-directory>/run.cjs import <source:id> --include-subagents",
    "node <skill-directory>/run.cjs forge <source:id>",
    "node <skill-directory>/run.cjs forge --input <parameters.json>", "```", "",
    "Use the host shell tool to run these commands. Quote absolute paths containing spaces. Search and resolve before selecting a transcript; follow nextOffset when reading pages. All tools share the same seventeen source parsers.",
    "Import writes native per-message history and registers the target sidebar workspace. Report sessionId/sessionPath/sidebar from its receipt. Do not inject transcripts into the current conversation. Use open to launch the original importer panel.",
    "Forge first returns source material and instructions for the current model. To save its distilled result, supply content and outputPath via --input.",
    "Prefer the equivalent session_hub_sync/search/resolve/read/import/forge MCP tools when already connected.", "",
  ].join("\n");
  files["skills/session-import/SKILL.md"] = skill;
  let configName = "mcp.json";
  let config = mcp;
  let pluginId;
  if (host.kind === "mcp-toml") {
    configName = "config.toml";
    files[configName] = tomlConfig(server);
  } else if (host.kind === "opencode-local") {
    const local = { type: "local", command: [server.command, ...server.args], environment: server.env };
    configName = "opencode.json";
    config = { mcp: { servers: { [serverName]: local } } };
    files[configName] = json(config);
    files["opencode.v1.json"] = json({ mcp: { [serverName]: { ...local, enabled: true } } });
  } else if (host.kind === "zcode-json") {
    configName = "zcode.json";
    config = { features: { mcp: true }, mcp: { servers: { [serverName]: { type: "stdio", ...server } } } };
    files[configName] = json(config);
  } else if (host.kind === "cordis-bundle") {
    configName = "dsh-bundle/cordis.patch.yml";
    files[configName] = [
      "- insert:", "    - id: session-import-mcp", "      name: '@deepseek-ai/dsh-mcp-client'", "      config:",
      `        serverName: ${serverName}`, "        transport: stdio", "        command: node",
      `        args: ${JSON.stringify(server.args)}`, `        cwd: ${quote(workspace)}`,
      `        env: ${JSON.stringify(server.env)}`, "        failOnStartupError: true", "",
    ].join("\n");
    files["dsh-bundle/package.json"] = json({ name: "@local/session-import", version: "2.0.0", private: true, type: "module",
      files: ["cordis.patch.yml"], dsh: { bundle: { patch: "./cordis.patch.yml" } } });
  } else if (host.kind === "openclaw-plugin") {
    pluginId = `session-import-universal-${host.id}`;
    const pluginDir = path.join(output, "openclaw-plugin");
    configName = "openclaw.json";
    config = { plugins: { load: { paths: [pluginDir] }, entries: { [pluginId]: { enabled: true } } } };
    files[configName] = json(config);
    files["openclaw-plugin/package.json"] = json({ name: pluginId, version: "2.0.0", private: true, type: "module", openclaw: { extensions: ["./index.mjs"] } });
    files["openclaw-plugin/openclaw.plugin.json"] = json({ id: pluginId, name: "Session Import", description: "Shared seventeen-source session tools", configSchema: { type: "object", properties: {}, additionalProperties: false } });
    files["openclaw-plugin/index.mjs"] = [
      'import { createRequire } from "node:module";', 'const require = createRequire(import.meta.url);',
      `const { createRuntime, tools } = require(${quote(path.join(root, "hosts", "runtime.cjs"))});`,
      `export default { id: ${quote(pluginId)}, name: "Session Import", register(api) {`,
      '  let runtime;',
      `  const getRuntime = () => runtime ??= createRuntime({ host: ${quote(host.id)}, workspace: ${quote(workspace)} });`,
      '  for (const tool of tools) api.registerTool({ name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,',
      '    async execute(_id, args) { const details = await (await getRuntime()).call(tool.name, args); return { content: [{ type: "text", text: JSON.stringify(details) }], details }; }',
      '  });', '}};', '',
    ].join("\n");
  } else if (host.id === "claude" || host.id === "reasonix") {
    configName = ".mcp.json"; files[configName] = json(mcp);
  } else if (host.id === "gemini") {
    configName = "settings.json"; files[configName] = json(mcp);
  }
  files["README.md"] = [
    `# ${host.label} / session-import`, "", host.installHint, "",
    `生成配置：${configName}。所有路径已按生成时的插件位置解析；移动插件后重新生成。`,
    `目标工作区：${workspace}`,
    "", "无需安装即可运行：", "", "```text",
    `node ${quote(path.join(skillDir, "run.cjs"))} search --query 会话关键词`,
    `node ${quote(path.join(skillDir, "run.cjs"))} read <source:id> --text`, "```", "",
    "路径不确定的宿主：将 mcp.json 导入宿主 MCP 设置；或让当前 Agent 读取 skills/session-import/SKILL.md 并用终端执行其中命令。不会要求它解析不存在的统一 manifest。",
    "open 打开原会话导入面板；import 逐条转换为目标客户端原生会话并登记侧边栏，返回 sessionId/sessionPath。不会把历史注入当前 Agent 上下文。",
    `协议依据：${host.evidence}`, "",
  ].join("\n");
  return { files, configName, config, server, pluginId };
}

module.exports = { build, serverFor, tomlConfig, serverName };
