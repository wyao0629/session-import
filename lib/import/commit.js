"use strict";

const { randomUUID } = require("node:crypto");
const { stableExternalId } = require("./project");
const { projectFull } = require("./full");
const { validate, validateBatch, serializedBytes, BATCH_MAX_BYTES } = require("./contract");

function makeUniqueExternalId(base, mode = "skip") {
  const id = stableExternalId(base);
  if (mode === "skip") return id;
  if (mode !== "new") throw new Error(`不支持的导入模式：${mode}`);
  const suffix = `~r${randomUUID().replace(/-/g, "")}`;
  let prefix = id.slice(0, 256 - suffix.length);
  if (/[\uD800-\uDBFF]/.test(prefix.at(-1))) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

function buildBatchMessage(message) {
  return { role: message.role, content: message.text, createdAt: message.createdAt };
}

async function commit(items, opts = {}, pi, bus) {
  const startedAt = Date.now();
  const mode = opts.mode ?? "skip";
  if (!["skip", "new"].includes(mode)) throw new Error(`不支持的导入模式：${mode}`);
  const failed = [];
  const reports = [];
  const warnings = [];
  const results = [];
  const batchTimes = [];
  const groups = new Map();
  const projectCache = new Map();
  const seen = new Set();
  let unreadable = 0;
  let truncated = 0;
  let imported = 0;
  let skipped = 0;

  // 按项解析并释放原始消息，避免同时持有整批大文本。
  for (const item of items) {
    const source = item.source ?? item.entry.importSource;
    const externalId = item.entry.externalId ?? item.entry.sessionId;
    try {
      if (!source) throw new Error("来源不可导入");
      const originalMessages = await (typeof item.messages === "function" ? item.messages() : item.messages);
      const projected = projectFull(item.entry, originalMessages, { ...opts.projectOpts, ...item.projectOpts });
      const session = { ...projected.session, externalId: makeUniqueExternalId(projected.session.externalId, mode), messages: projected.messages.map(buildBatchMessage) };
      if (opts.projectPath) session.projectPath = opts.projectPath;
      const errors = validate({ session, messages: session.messages });
      const malformed = errors.filter(error => !/exceed/.test(error));
      if (malformed.length) throw new Error(malformed.join("；"));
      const requiresNative = typeof pi?.session?.importBatch !== "function" || errors.length > 0 || serializedBytes({ source, sessions: [session], mode: "skip" }) > BATCH_MAX_BYTES;
      if (requiresNative) {
        const { importNative } = require("../../hosts/native/index.cjs");
        const native = await importNative({ target: "pi-desktop", entry: item.entry, messages: originalMessages,
          destination: { workspace: opts.projectPath || item.entry.workspacePath, root: opts.targetRoot, placement: opts.bindProjects === false ? "standalone" : "project" }, mode: mode === "new" ? "copy" : "skip",
          dataDir: opts.dataDir ?? await pi.plugin.getDataPath(), options: { ...opts.projectOpts, ...item.projectOpts, placement: opts.bindProjects === false ? "standalone" : "project" } });
        if (native.status === "skipped") skipped++; else imported++;
        results.push({ source, externalId: session.externalId, ...native });
        reports.push({ source, externalId: session.externalId, ...projected.report });
        continue;
      }
      const key = `${source}\u0000${session.externalId}`;
      if (seen.has(key)) { skipped++; results.push({ source, externalId: session.externalId, status: "skipped", reason: "本次选择重复" }); continue; }
      seen.add(key);
      if (opts.bindProjects === false) {
        session.projectPath = null;
      } else if (session.projectPath && typeof pi?.project?.create === "function") {
        if (!projectCache.has(session.projectPath)) {
          try {
            const result = await pi.project.create({ path: session.projectPath });
            const id = Number(result?.projectId ?? result?.id);
            if (!Number.isInteger(id) || id <= 0) throw new Error("宿主未返回有效项目 ID");
            projectCache.set(session.projectPath, id);
          } catch (error) {
            projectCache.set(session.projectPath, null);
            warnings.push({ source, externalId, error: `项目绑定失败：${error.message}` });
          }
        }
        const projectId = projectCache.get(session.projectPath);
        if (projectId != null) session.projectId = projectId;
      }
      const single = { source, sessions: [session], mode: "skip" };
      if (!groups.has(source)) groups.set(source, []);
      groups.get(source).push(session);
      reports.push({ source, externalId: session.externalId, ...projected.report });
      if (projected.report.cappedDropped || projected.report.byteCappedDropped || projected.report.contentTruncated) truncated++;
    } catch (error) {
      unreadable++;
      failed.push({ source, externalId, phase: "prepare", error: String(error.message ?? error) });
    }
  }

  async function submit(source, sessions) {
    const start = Date.now();
    const payload = { source, sessions, mode: "skip" };
    const errors = validateBatch(payload);
    if (errors.length) throw new Error(errors.join("；"));
    try {
      if (typeof pi?.session?.importBatch !== "function") throw new Error("当前宿主未提供 session.importBatch，请升级到支持批量导入的版本");
      const response = await pi.session.importBatch(payload);
      if (!response || !Number.isInteger(response.imported) || !Number.isInteger(response.skipped)) throw new Error("宿主返回无效导入结果，请核对会话列表后重试（默认去重）");
      imported += response.imported;
      skipped += response.skipped;
      let detailedFailed = 0;
      for (const result of response.results ?? []) {
        results.push({ source, ...result });
        if (result.status === "failed") {
          detailedFailed++;
          failed.push({ source, externalId: result.externalId, phase: "submit", error: result.errorMessage ?? result.errorCode ?? "导入失败" });
        }
      }
      const missingFailures = Math.max(response.failed ?? 0, sessions.length - response.imported - response.skipped) - detailedFailed;
      if (missingFailures > 0) failed.push({ source, phase: "submit", count: missingFailures, error: "宿主报告部分会话导入失败，未返回逐项详情" });
    } catch (error) {
      for (const session of sessions) failed.push({ source, externalId: session.externalId, phase: "submit", error: String(error.message ?? error) });
    } finally { batchTimes.push({ source, n: sessions.length, ms: Date.now() - start }); }
  }

  for (const [source, sessions] of groups) {
    const overhead = serializedBytes({ source, sessions: [], mode: "skip" });
    let batch = [];
    let size = overhead;
    for (const session of sessions) {
      const bytes = serializedBytes(session);
      if (batch.length && (batch.length >= 100 || size + bytes + 1 > BATCH_MAX_BYTES)) {
        await submit(source, batch);
        batch = [];
        size = overhead;
      }
      size += bytes + (batch.length ? 1 : 0);
      batch.push(session);
    }
    if (batch.length) await submit(source, batch);
  }
  if (imported && typeof bus?.recordImport === "function") {
    try { bus.recordImport({ count: imported, source: groups.size === 1 ? [...groups.keys()][0] : "mixed" }); }
    catch (error) { warnings.push({ error: `导入已完成，但界面通知失败：${error.message}` }); }
  }
  return { ok: failed.length === 0, imported, skipped, failed, unreadable, truncated, reports, warnings, results, timings: { totalMs: Date.now() - startedAt, batches: batchTimes } };
}

module.exports = { commit, makeUniqueExternalId, buildBatchMessage };
