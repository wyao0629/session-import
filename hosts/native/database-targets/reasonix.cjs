"use strict";
const { path, json, randomUUID, context, result, writeNew, writeRows, mergeJson, samePath, NL } = require("./common.cjs");

function projectKey(workspace) {
  return workspace.toLowerCase().split(String.fromCharCode(92)).join("/").replace(/[^a-z0-9_-]/g, "-");
}
function* transcript(c) {
  for (const m of c.records) yield { role: m.role, content: m.content, createdAt: m.time, ...(m.role === "user" ? { raw_content: m.content } : {}) };
}
module.exports = {
  id: "reasonix", label: "Reasonix",
  defaultRoot: ({ home, env }) => env.REASONIX_HOME || (env.APPDATA ? path.join(env.APPDATA, "reasonix") : path.join(home, ".reasonix")),
  async importSession(input) {
    const c = context("reasonix", input);
    const topicId = c.projectId || randomUUID();
    const catalogPath = path.join(c.root, "desktop-projects.json");
    const catalog = await json(catalogPath, { projects: [] });
    if (!Array.isArray(catalog.projects)) throw new Error(`reasonix: ${catalogPath} requires a projects array`);
    if (c.projectId && !catalog.projects.some(project => samePath(project.root, c.workspace) && project.topics?.includes(c.projectId))) throw new Error("reasonix: destination.projectId must identify a topic in the selected desktop workspace");
    const sessionPath = path.join(c.root, "projects", projectKey(c.workspace), "sessions", `${c.id}.jsonl`);
    await writeNew(sessionPath + ".meta", JSON.stringify({ id: c.id, created_at: new Date(c.created).toISOString(), updated_at: new Date(c.updated).toISOString(), scope: "project", workspace_root: c.workspace, topic_id: topicId, topic_title: c.title, schema_version: 1 }, null, 2) + NL);
    await writeRows(sessionPath, transcript(c));
    await mergeJson(catalogPath, { projects: [] }, data => {
      if (!Array.isArray(data.projects)) throw new Error(`reasonix: ${catalogPath} requires a projects array`);
      let project = data.projects.find(item => samePath(item.root, c.workspace));
      if (!project) { project = { root: c.workspace, topics: [] }; data.projects.push(project); }
      if (!Array.isArray(project.topics)) throw new Error("reasonix: desktop project topics must be an array");
      if (!project.topics.includes(topicId)) project.topics.push(topicId);
      return data;
    });
    return result(c, sessionPath);
  }
};
