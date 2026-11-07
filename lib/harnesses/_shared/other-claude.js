"use strict";
const { path, json, files, rows, fileOf, normalize } = require("./other");
const TITLES = { "custom-title": ["customTitle", "title"], "agent-name": ["agentName", "name"], "ai-title": ["aiTitle", "title"], summary: ["summary", "title"] };
async function enumerate(root) {
  const base = path.basename(root) === "projects" ? root : path.join(root, "projects");
  const paths = await files(base, (name, full) => name.endsWith(".jsonl") && !name.includes(".session.execution.") && !/[\\/]tool-results[\\/]/.test(full), 4);
  return paths.map(file => {
    const subagent = path.basename(path.dirname(file)) === "subagents";
    const parent = subagent ? path.basename(path.dirname(path.dirname(file))) : null;
    const stem = path.basename(file, ".jsonl");
    return { sessionId: subagent ? `${parent}:${stem}` : stem, sessionPath: file, filePath: file,
      sourceFormat: "claude-jsonl", subagent, parentSessionId: parent,
      dependencies: [file.replace(/\.jsonl$/, ".meta.json")] };
  });
}
async function load(entry) {
  const file = fileOf(entry), all = await rows(file);
  const subFile = path.basename(path.dirname(file)) === "subagents";
  const data = entry.sidechain ? all.filter(r => r.isSidechain && String(r.agentId ?? r.sessionId ?? "sidechain") === entry.sidechain) : subFile ? all : all.filter(r => !r.isSidechain);
  const names = {};
  for (const row of all) if (TITLES[row.type]) {
    const name = TITLES[row.type].map(k => row[k]).find(v => typeof v === "string" && v.trim());
    if (name) names[row.type] = name;
  }
  const side = await json(file.replace(/\.jsonl$/, ".meta.json"), {});
  const first = data.find(r => r.cwd || r.timestamp) ?? all[0] ?? {};
  const meta = { name: Object.keys(TITLES).map(k => names[k]).find(Boolean) || side.description,
    workspacePath: first.cwd ?? all.find(r => r.type === "workspace-directories")?.directories?.[0],
    createdAt: first.timestamp, updatedAt: data.findLast(r => r.timestamp)?.timestamp,
    modelId: data.findLast(r => r.message?.model)?.message?.model,
    subagent: subFile || !!entry.sidechain || (!data.some(r => r.type === "user" || r.type === "assistant") && all.some(r => r.isSidechain)),
    parentSessionId: entry.parentSessionId ?? side.parentSessionId ?? side.parent_session_id ?? null };
  const children = [];
  if (!subFile && !entry.sidechain) {
    for (const agent of new Set(all.filter(r => r.isSidechain).map(r => String(r.agentId ?? r.sessionId ?? "sidechain")))) {
      children.push({ descriptor: { ...entry, sessionId: `${entry.sessionId}:${agent}`, sessionPath: `${file}#sidechain=${encodeURIComponent(agent)}`, filePath: file, sidechain: agent },
        meta: { ...meta, name: undefined, subagent: true, parentSessionId: entry.sessionId }, messages: normalize(all.filter(r => r.isSidechain && String(r.agentId ?? r.sessionId ?? "sidechain") === agent)) });
    }
  }
  return { meta, messages: normalize(data), children };
}
module.exports = { enumerate, load };
