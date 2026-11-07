#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const { createRuntime, tools } = require("./runtime.cjs");

async function main(argv = process.argv.slice(2)) {
  const action = argv.shift() ?? "help";
  if (["help", "--help", "-h"].includes(action)) {
    console.log(`session-import 2.0
用法：node hosts/cli.cjs <open|sync|search|resolve|read|import|forge> [引用] [--json '{...}']
选项：--host <宿主> --workspace <工作区> --data-dir <数据目录> --harness <来源>
      --input <参数JSON文件> --text --with-thinking --include-subagents
安装入口：node hosts/install.cjs <宿主> [--workspace <工作区>] [--output <目录>]
MCP 服务：node hosts/mcp.cjs
示例：node hosts/cli.cjs search --json '{"query":"会话关键词"}'
      node hosts/cli.cjs import codex:<会话ID> --host kimi-code
import 逐条写入原生历史并返回会话 ID；open 打开原会话导入面板。`);
    return;
  }
  if (action === "tools") { console.log(JSON.stringify(tools, null, 2)); return; }
  let args = {}, textOutput = false;
  const options = { autoSync: action === "open" || action === "session_hub_open" };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${key} 缺少值`); return argv[++i]; };
    switch (key) {
      case "--json": args = { ...args, ...JSON.parse(value()) }; break;
      case "--input": args = { ...args, ...JSON.parse(await fs.readFile(value(), "utf8")) }; break;
      case "--host": options.host = value(); break;
      case "--workspace": options.workspace = value(); break;
      case "--data-dir": options.dataDir = value(); break;
      case "--harness": args.harness = value(); break;
      case "--target": args.target = value(); break;
      case "--target-root": args.targetRoot = value(); break;
      case "--project-id": args.projectId = value(); break;
      case "--placement": args.placement = value(); break;
      case "--query": args.query = value(); break;
      case "--ref": args.ref = value(); break;
      case "--limit": args.limit = Number(value()); break;
      case "--offset": args.offset = Number(value()); break;
      case "--max-chars": args.maxChars = Number(value()); break;
      case "--include-hidden": args.includeHidden = true; break;
      case "--include-subagents": args.includeSubagents = true; break;
      case "--with-thinking": args.withThinking = true; break;
      case "--no-thinking": args.withThinking = false; break;
      case "--from-end": args.fromEnd = true; break;
      case "--text": textOutput = true; break;
      default: if (key.startsWith("--")) throw new Error(`未知参数：${key}`); positionals.push(key);
    }
  }
  if (action === "search" && positionals.length) args.query ??= positionals.join(" ");
  else if (action === "forge" && positionals.length) args.refs ??= positionals;
  else if (positionals.length) args.ref ??= positionals[0];
  const name = action.startsWith("session_hub_") ? action : `session_hub_${action}`;
  if (!tools.some(tool => tool.name === name)) throw new Error(`未知命令：${action}`);
  const runtime = await createRuntime(options);
  if (name === "session_hub_import") args.workspace ??= options.workspace;
  try {
    const output = await runtime.call(name, args);
    console.log(textOutput ? output.text ?? output.content ?? JSON.stringify(output, null, 2) : JSON.stringify(output, null, 2));
    if (output.ok === false) process.exitCode = 1;
  } finally { if (name !== "session_hub_open") runtime.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
