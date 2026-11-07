#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { hosts, getHost } = require("./catalog.cjs");
const { build, tomlConfig, serverName } = require("./configs/build.cjs");
const root = path.resolve(__dirname, "..");

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function save(file, content, previous) {
  const before = previous === undefined ? await readOptional(file) : previous;
  if (before === content) return { file, changed: false };
  await fs.mkdir(path.dirname(file), { recursive: true });
  let backup;
  if (before !== null) {
    backup = `${file}.session-import-${Date.now()}-${randomUUID().slice(0, 8)}.bak`;
    await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
    await fs.chmod(backup, 0o600);
  }
  await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  return { file, changed: true, ...(backup ? { backup } : {}) };
}

function parseJsonConfig(text) {
  if (text === null) return {};
  const clean = text.replace(/^\uFEFF/, "").replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    token => token.startsWith("/") ? token.replace(/[^\r\n]/g, " ") : token
  ).replace(/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g, (token, string) => string ?? "");
  const value = JSON.parse(clean);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("配置根必须是对象");
  return value;
}

function objectAt(config, keys) {
  let current = config;
  for (const key of keys) {
    if (current[key] === undefined) current[key] = {};
    if (!current[key] || Array.isArray(current[key]) || typeof current[key] !== "object") throw new Error(`配置 ${keys.join(".")} 不是对象`);
    current = current[key];
  }
  return current;
}

function sameServer(existing, incoming) {
  return existing && Object.entries(incoming).every(([key, value]) => {
    if (key === "env" || key === "environment") return Object.entries(value).every(([name, val]) => existing[key]?.[name] === val);
    return JSON.stringify(existing[key]) === JSON.stringify(value);
  });
}

function addServer(servers, server, host) {
  const match = Object.entries(servers).find(([name, value]) => name.startsWith(serverName) && sameServer(value, server));
  if (match) return match[0];
  let name = serverName, index = 1;
  while (Object.prototype.hasOwnProperty.call(servers, name)) name = `${serverName}_${host.id.replace(/-/g, "_")}_${index++}`;
  servers[name] = server;
  return name;
}

function configPath(host, workspace) {
  if (host.scope === "workspace") return path.join(workspace, ...host.configFile.split("/"));
  if (host.configHome) {
    const override = host.configEnv && process.env[host.configEnv];
    return override ? path.resolve(override, host.configHome.at(-1)) : path.join(os.homedir(), ...host.configHome);
  }
  return null;
}

async function install(host, bundle, options) {
  if (host.skillHome) {
    const destination = path.join(os.homedir(), ...host.skillHome, "session-import");
    const writes = [];
    for (const name of ["SKILL.md", "run.cjs"]) writes.push(await save(path.join(destination, name), bundle.files[`skills/session-import/${name}`]));
    return { status: "installed-skill", destination, writes };
  }
  let target = configPath(host, options.workspace);
  if (!target) return { status: "manual-import", instruction: host.installHint };
  if (host.id === "opencode" && await readOptional(target) === null) {
    const jsonc = path.join(options.workspace, "opencode.jsonc");
    if (await readOptional(jsonc) !== null) target = jsonc;
  }
  const before = await readOptional(target);
  if (host.kind === "mcp-toml") {
    const source = before ?? "";
    if (/^\s*mcp_servers\s*=/m.test(source)) return { status: "manual-import", target, instruction: "现有 TOML 使用内联 mcp_servers；请合并生成的 config.toml，原文件保持原样。" };
    let name = serverName, index = 1;
    while (new RegExp(`\\b${name}\\b`).test(source)) {
      if (source.includes(tomlConfig(bundle.server, name).trim())) return { status: "already-installed", target, server: name };
      name = `${serverName}_${host.id.replace(/-/g, "_")}_${index++}`;
    }
    const content = source + (source.endsWith("\n") || !source ? "" : "\n") + "\n" + tomlConfig(bundle.server, name);
    return { status: "installed", server: name, ...await save(target, content, before) };
  }
  let config;
  try { config = parseJsonConfig(before); }
  catch { return { status: "manual-import", target, instruction: "现有文件不是可无依赖解析的 JSON/JSONC；保留原文件，在宿主界面导入生成配置或使用随附技能。" }; }
  let name;
  if (host.kind === "openclaw-plugin") {
    const plugins = objectAt(config, ["plugins"]);
    const load = objectAt(plugins, ["load"]);
    const pluginPath = path.join(options.output, "openclaw-plugin");
    if (load.paths !== undefined && !Array.isArray(load.paths)) throw new Error("plugins.load.paths 必须是数组");
    load.paths = [...new Set([...(load.paths ?? []), pluginPath])];
    const entries = objectAt(plugins, ["entries"]);
    entries[bundle.pluginId] = { ...entries[bundle.pluginId], enabled: true };
    if (Array.isArray(plugins.allow)) plugins.allow = [...new Set([...plugins.allow, bundle.pluginId])];
  } else if (host.kind === "opencode-local") {
    const mcp = objectAt(config, ["mcp"]);
    const legacy = !mcp.servers && Object.values(mcp).some(value => value && ["local", "remote"].includes(value.type));
    const incoming = bundle.config.mcp.servers[serverName];
    name = addServer(legacy ? mcp : objectAt(mcp, ["servers"]), legacy ? { ...incoming, enabled: true } : incoming, host);
  } else {
    const incoming = host.kind === "zcode-json" ? bundle.config.mcp.servers[serverName] : bundle.server;
    name = addServer(objectAt(config, host.schemaPath), incoming, host);
    if (host.kind === "zcode-json") objectAt(config, ["features"]).mcp = true;
  }
  return { status: "installed", ...(name ? { server: name } : {}), ...await save(target, JSON.stringify(config, null, 2) + "\n", before) };
}

async function main(argv = process.argv.slice(2)) {
  const id = argv.shift();
  if (!id || ["help", "--help", "-h"].includes(id)) {
    console.log(`node hosts/install.cjs <host> [--workspace PATH] [--output DIR] [--install]\n默认只生成配置与 CLI 技能；--install 才合并已知宿主配置或安装技能，并备份被修改文件。\n宿主：${hosts.map(host => host.id).join(", ")}`);
    return;
  }
  const host = getHost(id);
  if (!host) throw new Error(`未知宿主：${id}；支持：${hosts.map(item => item.id).join(", ")}`);
  const options = { workspace: process.cwd(), output: path.join(root, "generated", id), install: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--install") options.install = true;
    else if (["--workspace", "--output"].includes(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${flag} 缺少路径`);
      options[flag.slice(2)] = path.resolve(argv[++i]);
    } else throw new Error(`未知参数：${flag}`);
  }
  options.workspace = path.resolve(options.workspace);
  options.output = path.resolve(options.output);
  const bundle = build(host, { root, ...options });
  const generated = [];
  for (const [relative, content] of Object.entries(bundle.files)) generated.push(await save(path.join(options.output, ...relative.split("/")), content));
  const result = { host: host.id, output: options.output, config: path.join(options.output, ...bundle.configName.split("/")),
    skill: path.join(options.output, "skills", "session-import", "SKILL.md"), generated: generated.length };
  result.install = options.install ? await install(host, bundle, options) : { status: "generated-only", instruction: host.installHint };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, install, configPath };
