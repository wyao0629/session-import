"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const startupTypes = new Set([
  "environment.set_binding", "mcp.tools_discovered", "permission.set_mode", "profile.bind",
  "changeNotifier.snapshot", "config.update", "tool_select.initialized", "llm.tools_snapshot",
]);
const sensitiveKey = /^(?:api[_-]?key|.*token.*|.*secret.*|authorization|headers|env|credential.*|password.*)$/i;

function sameDirectory(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = value => {
    const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function withoutSensitiveFields(value) {
  if (Array.isArray(value)) return value.map(withoutSensitiveFields);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!sensitiveKey.test(key)) output[key] = withoutSensitiveFields(item);
  }
  return output;
}

function runtimeBindingRecords(binding, time, workspace) {
  if (!binding) return [];
  if (!binding.startupRecords?.length) return [
    { type: "profile.bind", agentId: "main", modelAlias: binding.modelAlias,
      profileName: binding.profileName, thinkingEffort: binding.thinkingEffort, time },
    { type: "config.update", agentId: "main", modelAlias: binding.modelAlias,
      thinkingEffort: binding.thinkingEffort, time },
  ];
  const crossWorkspace = binding.matchesWorkspace === false && workspace;
  const records = [];
  for (const source of binding.startupRecords) {
    if (crossWorkspace && source.type === "changeNotifier.snapshot") continue;
    const record = withoutSensitiveFields(structuredClone(source));
    record.time = time;
    if (record.type === "profile.bind") {
      record.modelAlias = binding.modelAlias;
      record.profileName = binding.profileName;
      record.thinkingEffort = binding.thinkingEffort;
      if (workspace && record.environmentDisclosure && typeof record.environmentDisclosure === "object") {
        record.environmentDisclosure.cwd = workspace;
      }
      if (crossWorkspace) {
        delete record.systemPrompt;
        delete record.agentsMdPaths;
      }
    }
    if (record.type === "config.update") {
      record.modelAlias = binding.modelAlias;
      record.thinkingEffort = binding.thinkingEffort;
    }
    records.push(record);
  }
  if (!records.some(record => record.type === "config.update")) {
    records.push({ type: "config.update", agentId: "main", modelAlias: binding.modelAlias,
      thinkingEffort: binding.thinkingEffort, time });
  }
  return records;
}

function runtimeBindingStatus(binding) {
  if (!binding) return "unavailable";
  const complete = binding.matchesWorkspace !== false && binding.startupRecords?.some(record =>
    record.type === "profile.bind" && typeof record.systemPrompt === "string");
  return complete ? "bound" : "minimal";
}

async function readRuntimeBinding(file) {
  let binding;
  let thinkingEffort;
  let modelAlias;
  let started = false;
  const startupRecords = [];
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type === "agent.turn.started") started = true;
      if (!started && startupTypes.has(row.type)) startupRecords.push(row);
      if (row.type === "profile.bind" && typeof row.modelAlias === "string" && typeof row.profileName === "string") {
        binding = { modelAlias: row.modelAlias, profileName: row.profileName,
          thinkingEffort: typeof row.thinkingEffort === "string" ? row.thinkingEffort : undefined };
      }
      if (row.type === "config.update") {
        if (typeof row.thinkingEffort === "string") thinkingEffort = row.thinkingEffort;
        if (typeof row.modelAlias === "string") modelAlias = row.modelAlias;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return binding ? { ...binding, modelAlias: modelAlias ?? binding.modelAlias,
    thinkingEffort: thinkingEffort ?? binding.thinkingEffort, startupRecords } : undefined;
}

async function directorySessionRecords(root) {
  const sessionsRoot = path.join(root, "sessions");
  let projects;
  try { projects = await fsp.readdir(sessionsRoot, { withFileTypes: true }); }
  catch { return []; }
  const records = [];
  for (const project of projects) {
    if (!project.isDirectory() || project.name === ".index-dirty") continue;
    const projectDir = path.join(sessionsRoot, project.name);
    let sessions;
    try { sessions = await fsp.readdir(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(projectDir, session.name);
      let state = {};
      try { state = JSON.parse(await fsp.readFile(path.join(sessionDir, "state.json"), "utf8")); } catch { /* Use directory only. */ }
      records.push({ sessionDir, workDir: state.cwd, updatedAt: Number(state.updatedAt) || 0 });
    }
  }
  return records.sort((left, right) => right.updatedAt - left.updatedAt);
}

async function findRuntimeBinding(root, workspace) {
  let index = "";
  try { index = await fsp.readFile(path.join(root, "session_index.jsonl"), "utf8"); } catch { /* Directory fallback remains available. */ }
  const indexed = index.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return undefined; }
  }).filter(record => typeof record?.sessionDir === "string").reverse();
  const records = [...indexed, ...await directorySessionRecords(root)];
  const byPath = new Map();
  for (const record of records) {
    const key = path.resolve(record.sessionDir);
    const existing = byPath.get(key);
    byPath.set(key, existing ? { ...record, workDir: record.workDir ?? existing.workDir,
      updatedAt: record.updatedAt ?? existing.updatedAt } : record);
  }
  const candidates = [...byPath.values()];
  if (workspace) candidates.sort((left, right) =>
    Number(sameDirectory(right.workDir, workspace)) - Number(sameDirectory(left.workDir, workspace)));
  let fallback;
  for (const record of candidates) {
    const sessionDir = path.resolve(record.sessionDir);
    const relative = path.relative(root, sessionDir);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    try {
      const binding = await readRuntimeBinding(path.join(sessionDir, "agents", "main", "wire.jsonl"));
      if (!binding) continue;
      binding.matchesWorkspace = workspace ? sameDirectory(record.workDir, workspace) : undefined;
      if (binding.startupRecords.some(row => row.type === "profile.bind" && typeof row.systemPrompt === "string")) return binding;
      fallback ??= binding;
    } catch { /* Try the next native session. */ }
  }
  return fallback;
}

module.exports = { findRuntimeBinding, runtimeBindingRecords, runtimeBindingStatus };
