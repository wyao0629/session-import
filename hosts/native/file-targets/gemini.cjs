"use strict";

const { createReadStream } = require("node:fs");
const { createInterface } = require("node:readline");
const { fs, path, randomUUID, createHash, readOptional, readJson, object, serialize, mergeJson, writeNew, writeJsonl, segment, prepare, result, sameWorkspace } = require("./shared.cjs");

async function chatFormat(chats, projectHash) {
  let files;
  try { files = await fs.readdir(chats); }
  catch (error) { if (error.code === "ENOENT") return { extension: ".json", projectHash }; throw error; }
  const file = files.find(name => /^session-.*\.jsonl$/.test(name)) || files.find(name => /^session-.*\.json$/.test(name));
  if (!file) return { extension: ".json", projectHash };
  const extension = path.extname(file);
  let header;
  if (extension === ".json") header = await readJson(path.join(chats, file));
  else {
    const stream = createReadStream(path.join(chats, file), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of lines) { if (line.trim()) { header = JSON.parse(line.replace(/^\uFEFF/, "")); break; } } }
    finally { lines.close(); stream.destroy(); }
  }
  return { extension, projectHash: header?.projectHash || projectHash };
}
const target = {
  id: "gemini", label: "Gemini",
  defaultRoot: ({ home, env }) => path.join(env.GEMINI_CLI_HOME || home, ".gemini"),
  async importSession(input) {
    const data = prepare(target, input);
    return serialize(data.root, async () => {
      const registryPath = path.join(data.root, "projects.json");
      const registry = object(await readJson(registryPath, { projects: {} }), registryPath);
      const projects = object(registry.projects, registryPath);
      const registered = Object.entries(projects).find(([cwd]) => sameWorkspace(cwd, data.workspace));
      const projectHash = createHash("sha256").update(data.workspace).digest("hex");
      const projectId = segment(data.destination.projectId || registered?.[1] || projectHash, "Gemini projectId");
      if (registered && registered[1] !== projectId) throw new Error(`Gemini 工作区已经登记在 tmp/${registered[1]}，与指定 projectId ${projectId} 不一致。`);
      const projectDir = path.join(data.root, "tmp", projectId);
      const markerPath = path.join(projectDir, ".project_root");
      const marker = await readOptional(markerPath);
      if (marker !== null && !sameWorkspace(marker.trim(), data.workspace)) throw new Error(`Gemini 项目目录属于其他工作区：${markerPath}`);
      const chats = path.join(projectDir, "chats");
      const format = await chatFormat(chats, projectHash);
      const stamp = data.createdAt.replace(/[:.]/g, "-");
      const sessionPath = path.join(chats, `session-${stamp}-${data.sessionId}${format.extension}`);
      const header = { sessionId: data.sessionId, projectHash: format.projectHash, cwd: data.workspace,
        startTime: data.createdAt, lastUpdated: data.updatedAt, kind: "main", title: data.title, summary: data.title };
      const messages = data.messages.map(item => ({ id: randomUUID(), timestamp: item.timestamp,
        type: item.role === "user" ? "user" : "gemini",
        content: item.role === "user" ? [{ text: item.content }] : item.content,
        ...(item.role === "assistant" && data.options.model ? { model: data.options.model } : {}) }));
      if (format.extension === ".jsonl") await writeJsonl(sessionPath, [header, ...messages]);
      else await writeNew(sessionPath, { ...header, messages });
      if (marker === null) await writeNew(markerPath, data.workspace);
      await mergeJson(registryPath, { projects: {} }, current => {
        object(current, registryPath);
        object(current.projects, registryPath);
        const found = Object.entries(current.projects).find(([cwd]) => sameWorkspace(cwd, data.workspace));
        if (found) {
          if (found[1] !== projectId) throw new Error(`Gemini 工作区映射已改变：${registryPath}`);
          return;
        }
        if (Object.values(current.projects).includes(projectId)) throw new Error(`Gemini projectId 已属于其他工作区：${projectId}`);
        current.projects[data.workspace] = projectId;
        return current;
      });
      return result(target, data, sessionPath);
    });
  },
};
module.exports = target;
