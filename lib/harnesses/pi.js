"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { makeEntry } = require("../model");
const { clip, baseName, iso, safeStat, sessionFiles, sessionDirectory, existingRoots } = require("./_shared/pi-common");
const { readTree, projectBranch } = require("./_shared/pi-tree");

const id = "pi";
const label = { en: "Pi", "zh-CN": "Pi" };
const order = 30;
const importSource = "pi";
const aliases = [];
const schemes = [];
const capabilities = { import: true, nativeInHost: true, children: false };

async function discover(ctx = {}) {
  const home = ctx.home ?? os.homedir();
  const env = ctx.env ?? process.env;
  const expand = (value, base = home) => path.resolve(base, value.replace(/^~(?=[\/\\]|$)/, home));
  const agent = expand(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"));
  const candidates = [{ root: path.join(agent, "sessions"), via: env.PI_CODING_AGENT_DIR ? "PI_CODING_AGENT_DIR" : "default" }];
  const settings = [{ file: path.join(agent, "settings.json"), base: agent }];
  for (const project of (ctx.projectPaths ?? []).slice(0, 500)) {
    settings.push({ file: path.join(project, ".pi", "settings.json"), base: project });
  }
  for (const { file, base } of settings) {
    if (!(await safeStat(file))?.isFile()) continue;
    let config;
    try { config = JSON.parse(await fsp.readFile(file, "utf8")); } catch (error) {
      if (error instanceof SyntaxError) { ctx.report?.(file, new Error("Invalid Pi settings JSON")); continue; }
      throw error;
    }
    if (typeof config?.sessionDir === "string" && config.sessionDir.trim()) {
      candidates.push({ root: expand(config.sessionDir, base), via: "settings.sessionDir" });
    }
  }
  for (const extra of ctx.extraRoots ?? []) candidates.push({ root: await sessionDirectory(expand(extra)), via: "extra" });
  return existingRoots(candidates);
}

function parentId(value) {
  if (typeof value !== "string" || !value) return undefined;
  return /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/i.exec(value)?.[1]
    ?? baseName(value).replace(/\.jsonl$/, "");
}

async function scan(root, ctx = {}) {
  const found = new Map();
  const dir = await sessionDirectory(root);
  let count = 0;
  for await (const file of sessionFiles(dir, { maxFiles: ctx.maxFiles })) {
    try {
      const stat = await safeStat(file);
      if (!stat?.isFile() || (ctx.maxFileBytes && stat.size > ctx.maxFileBytes)) continue;
      const tree = await readTree(file, { metadataOnly: true });
      if (!tree) continue;
      const { header, branch, name } = tree;
      const sessionId = header.id;
      const firstPrompt = branch.find((node) => node.firstPrompt)?.firstPrompt;
      const messageCount = branch.reduce((sum, node) => sum + node.count, 0);
      const modelId = branch.findLast((node) => node.modelId)?.modelId;
      const real = await fsp.realpath(file);
      const entry = makeEntry({
        key: `${id}:${sessionId}`, harness: id, sessionId, sessionPath: real,
        title: clip(name || firstPrompt || sessionId), name, firstPrompt,
        nameKind: name ? "native" : firstPrompt ? "prompt" : "none",
        workspacePath: header.cwd, workspaceName: baseName(header.cwd),
        createdAt: iso(header.timestamp), updatedAt: tree.updatedAt ?? iso(stat.mtimeMs),
        modelId, messageCount, parentSessionId: parentId(header.parentSession),
        visible: messageCount > 0, hiddenReason: messageCount ? null : "empty",
        importable: branch.some((node) => node.importable), importSource, nativeInHost: true,
        nativeSessionId: `native-pi:${createHash("sha256").update(`${real}\0${sessionId}`).digest("base64url").slice(0, 24)}`,
        sourceFormat: `pi-v${header.version}`, sig: `${stat.size}:${stat.mtimeMs}`,
      });
      const previous = found.get(sessionId);
      if (!previous || (entry.updatedAt ?? "") > (previous.updatedAt ?? "")) found.set(sessionId, entry);
    } catch (error) {
      if (!ctx.report) throw error;
      ctx.report(file, error);
    }
    if (++count % 20 === 0) await ctx.yieldNow?.();
  }
  return [...found.values()];
}

async function messages(entry, ctx = {}) {
  if (!(await safeStat(entry.sessionPath))?.isFile()) return [];
  const tree = await readTree(entry.sessionPath);
  if (!tree || tree.header.id !== entry.sessionId) return [];
  return projectBranch(tree.branch, ctx);
}

module.exports = { id, label, order, importSource, aliases, schemes, capabilities, discover, scan, messages };
