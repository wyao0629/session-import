"use strict";

const { search, resolve, brief } = require("./query");
const { readSession } = require("./reader");

function createTools(hub) {
  const harness = { type: "string", description: "注册表中的 Harness ID 或别名；也接受声明式来源 ID，留空为全部。" };
  const ref = { type: "string", minLength: 1, maxLength: 2000, description: "会话 ID、ID 前缀、链接或文件路径。" };
  const schema = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
  const info = () => { const s = hub.status(); return { total: s.total, lastSyncAt: s.lastSyncAt, syncing: s.syncing, errorCount: s.errors.length }; };
  async function fresh() {
    if (!hub) throw new Error("会话索引初始化失败，请重新加载插件");
    await hub.ready();
    if (!hub.status().lastSyncAt) await hub.sync();
  }
  async function locate(args) {
    await fresh();
    let found = resolve(hub.entries(), args.ref, { harness: args.harness });
    if (!found.matches.length && Date.now() - Date.parse(hub.status().lastSyncAt ?? "") > 30000) {
      await hub.sync({ force: true });
      found = resolve(hub.entries(), args.ref, { harness: args.harness });
    }
    return found;
  }
  return [
    { name: "session_hub_sync", risk: "low",
      description: "重新扫描本地所有已注册 Harness 并更新插件索引；不修改来源会话。返回各来源计数与错误。",
      schema: schema({}), execute: async () => {
        if (!hub) throw new Error("会话索引初始化失败");
        const s = await hub.sync({ force: true });
        return { total: s.total, lastSyncAt: s.lastSyncAt, durationMs: s.lastDurationMs, sources: s.sources, errors: s.errors.slice(0, 20) };
      } },
    { name: "session_hub_search", risk: "low",
      description: "按元数据检索本地会话（名称、ID、首句、工作区），不搜索正文。默认只列 GUI 可见会话，返回 parentSessionId、childCount、visible、hiddenReason；指定 parentSessionId 可查隐藏子会话。",
      schema: schema({
        query: { type: "string", maxLength: 500 }, harness, workspace: { type: "string", maxLength: 300 },
        parentSessionId: { type: "string", maxLength: 256 }, includeHidden: { type: "boolean", description: "默认 false。" },
        since: { type: "string" }, until: { type: "string" }, includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 }, offset: { type: "integer", minimum: 0 },
      }), execute: async (args = {}) => { await fresh(); return { ...search(hub.entries(), args), index: info() }; } },
    { name: "session_hub_resolve", risk: "low",
      description: "按 ID、前缀、会话链接或文件路径定位会话，包括隐藏子代理。ambiguous 表示需进一步指定 Harness 或完整 ID。",
      schema: schema({ ref, harness }, ["ref"]), execute: async (args) => {
        const found = await locate(args);
        return { ...found, matches: found.matches.slice(0, 20), matchCount: found.matches.length, index: info() };
      } },
    { name: "session_hub_read", risk: "low",
      description: "以 Markdown 分页读取会话（包括隐藏子代理）。思考默认保留，工具调用/结果作为文本；includeSubagents 展开子代理全文。分页时保持 withThinking、includeSubagents、toolDetail 不变，用 nextOffset 继续。",
      schema: schema({ ref, harness, fromEnd: { type: "boolean" }, offset: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 200000 },
        toolDetail: { type: "string", enum: ["none", "brief", "full"] },
        withThinking: { type: "boolean", description: "默认 true。" }, includeSubagents: { type: "boolean", description: "默认 false，只列子会话引用。" },
      }, ["ref"]), execute: async (args) => {
        const found = await locate(args);
        if (!found.matches.length) return { error: "未找到匹配的会话", index: info() };
        if (found.ambiguous) return { error: "匹配到多个会话", candidates: found.matches.slice(0, 20) };
        const entry = hub.entries().find((e) => e.key === found.matches[0].key);
        return { session: brief(entry), ...await readSession(entry, { ...args, roots: hub.roots(entry.harness), entries: hub.entries(), rootsFor: hub.roots }) };
      } },
  ];
}
module.exports = { createTools };
