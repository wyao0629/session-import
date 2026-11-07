"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { isInjected } = require("../../core/inject");
const legacyInjection = require("../../hub/inject");

const clip = (value, length = 200) => [...String(value ?? "")].slice(0, length).join("");
const baseName = (value) => value ? path.win32.basename(value.split("/").join("\\")) : undefined;

function iso(value) {
  if (value == null || value === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// Check ancestors too: an ordinary file beneath a junction is not a safe root.
async function safeStat(file) {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  let stat;
  for (const part of ["", ...absolute.slice(root.length).split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    try { stat = await fsp.lstat(current); } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return null;
  }
  return stat;
}

async function* sessionFiles(root, { recursive = true, maxFiles = Infinity } = {}) {
  if (!(await safeStat(root))?.isDirectory()) return;
  const pending = [path.resolve(root)];
  let count = 0;
  while (pending.length && count < maxFiles) {
    const dir = pending.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && recursive) pending.push(file);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.endsWith(".revisions.jsonl")) continue;
      yield file;
      if (++count >= maxFiles) return;
    }
  }
}

async function* records(file) {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line.replace(/^\uFEFF/, "")); } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (record && typeof record === "object" && !Array.isArray(record)) yield record;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function injected(text, role) {
  return isInjected(text.trimStart(), role) || legacyInjection.isInjected(text);
}

function prompt(text) {
  const request = legacyInjection.userRequest(text).trim();
  return request && !injected(request, "user") ? clip(request) : undefined;
}

function imageLabel(block) {
  // Never copy base64 blobs or source URLs into index entries or tool output.
  return block.mimeType || block.mime_type || "图片保留在来源会话中";
}

function contentParts(content, withThinking = true) {
  const out = { text: [], thinking: [], images: [], calls: [] };
  for (const block of typeof content === "string" ? [{ type: "text", text: content }] : content ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") out.text.push(block.text);
    if ((block.type === "thinking" || block.type === "reasoning") && withThinking) {
      const text = block.thinking ?? block.text;
      if (typeof text === "string" && text) out.thinking.push(text);
      else if (block.redacted) out.thinking.push("[推理已由来源隐藏]");
    }
    if (block.type === "image" || block.type === "attachment") out.images.push(imageLabel(block));
    if (block.type === "toolCall" || block.type === "tool_call") out.calls.push(block);
  }
  return out;
}

function resultText(result) {
  if (result == null) return undefined;
  const parts = contentParts(result.content ?? (Array.isArray(result) || typeof result === "string" ? result : []), false);
  const text = [...parts.text, ...parts.images.map((image) => `[图片：${image}]`)].join("\n");
  return text || result.details || (typeof result === "object" && !Array.isArray(result) && !("content" in result) ? result : "");
}

async function sessionDirectory(root) {
  const nested = path.join(root, "sessions");
  return (await safeStat(nested))?.isDirectory() ? nested : path.resolve(root);
}

async function existingRoots(candidates) {
  const found = [];
  const seen = new Set();
  for (const { root, via } of candidates) {
    const resolved = path.resolve(root);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key) || !(await safeStat(resolved))?.isDirectory()) continue;
    seen.add(key);
    found.push({ root: resolved, via });
  }
  return found;
}

module.exports = { clip, baseName, iso, safeStat, sessionFiles, records, injected, prompt, contentParts, resultText, sessionDirectory, existingRoots };
