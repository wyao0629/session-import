"use strict";

const fs = require("node:fs");
const readline = require("node:readline");
const { makeMessage } = require("../../model");
const NL = String.fromCharCode(10);

function iso(value) {
  if (value == null) return undefined;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : undefined;
}

async function* rows(file) {
  let stream;
  try {
    const handle = await fs.promises.open(file, "r");
    stream = handle.createReadStream();
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let terminated = true;
  stream.on("data", chunk => { terminated = chunk[chunk.length - 1] === 10; });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let pending, number = 0;
  function parse(text, line, last) {
    if (!text.trim()) return null;
    try { return { data: JSON.parse(text.replace(/^\uFEFF/, "")), line }; }
    catch {
      if (last && !terminated) return null; // A writer may still be appending its last record.
      throw new Error(`Invalid Kimi JSONL at ${file}:${line}`);
    }
  }
  try {
    for await (const text of lines) {
      if (pending !== undefined) {
        const row = parse(pending, number, false);
        if (row) yield row;
      }
      pending = text;
      number++;
    }
    if (pending !== undefined) {
      const row = parse(pending, number, true);
      if (row) yield row;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function parts(content) {
  const out = { text: "", thinking: [], images: [] };
  for (const part of Array.isArray(content) ? content : [content]) {
    if (typeof part === "string") out.text += part;
    else if (part?.type === "think" || part?.type === "thinking") out.thinking.push(part.think ?? part.thinking ?? part.text ?? "");
    else if (typeof part?.text === "string") out.text += part.text;
    else if (["image_url", "image"].includes(part?.type)) { out.text += "[图片]"; out.images.push("[图片]"); }
    else if (part?.type === "audio_url") out.text += "[音频]";
  }
  return out;
}

function cleanUser(text) {
  return text.replace(/^\s*<(meta|git-context)\b[^>]*>[\s\S]*?<\/\1>\s*/i, "")
    .replace(/^\s*<(meta|git-context)\b[^>]*\/?>\s*/i, "").trim();
}

function userParts(content, origin) {
  const out = parts(content);
  const metadata = origin?.clientMetadata;
  const values = Array.isArray(metadata) ? metadata : [metadata];
  const display = values.find(value => typeof value?.display_text === "string");
  out.text = display ? display.display_text : cleanUser(out.text);
  if (!out.text && out.images.length) out.text = out.images.join(NL);
  return out;
}

function args(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

class Builder {
  constructor(withThinking) {
    this.withThinking = withThinking;
    this.messages = [];
    this.steps = new Map();
    this.calls = new Map();
    this.ids = new Map();
  }
  message(role, content, time, origin) {
    const value = role === "user" ? userParts(content, origin) : parts(content);
    if (!value.text && !value.thinking.length && !value.images.length) return null;
    const message = makeMessage({ role, text: value.text, createdAt: iso(time) });
    if (this.withThinking && value.thinking.length) message.thinking = value.thinking;
    if (value.images.length) message.images = value.images;
    this.messages.push(message);
    return message;
  }
  step(key, time) {
    if (!this.steps.has(key)) {
      const message = makeMessage({ role: "assistant", createdAt: iso(time) });
      this.steps.set(key, message);
      this.messages.push(message);
    }
    return this.steps.get(key);
  }
  part(key, content, time) {
    const value = parts(content);
    const message = this.step(key, time);
    message.text += value.text;
    if (this.withThinking && value.thinking.length) {
      message.thinking ??= [""];
      message.thinking[0] += value.thinking.join(NL);
    }
    if (value.images.length) (message.images ??= []).push(...value.images);
  }
  call(message, event, time) {
    const uuid = event.uuid;
    const id = event.toolCallId ?? event.id ?? uuid;
    if (uuid && this.calls.has(uuid)) return this.calls.get(uuid);
    const tool = { id: id ?? `tool-${this.messages.length}`, name: event.name ?? event.function?.name ?? "tool", args: args(event.args ?? event.arguments ?? event.function?.arguments), status: "pending" };
    (message.tools ??= []).push(tool);
    if (uuid) this.calls.set(uuid, tool);
    if (id) this.ids.set(id, tool);
    return tool;
  }
  result(event, time) {
    const id = event.toolCallId ?? event.tool_call_id;
    let tool = event.parentUuid ? this.calls.get(event.parentUuid) : this.ids.get(id);
    if (!tool) {
      const message = this.step(`orphan:${event.parentUuid ?? id}`, time);
      tool = this.call(message, { id, uuid: event.parentUuid }, time);
    }
    const result = event.result ?? event.return_value ?? {};
    const error = result.isError === true || result.is_error === true || event.isError === true;
    if (tool.status === "pending") {
      tool.result = result.output ?? result.content ?? result;
      tool.status = error ? "error" : "success";
      tool.isError = error;
    } else if (error) { tool.status = "error"; tool.isError = true; }
  }
  finish() {
    return this.messages.filter(message => message.text || message.thinking?.length || message.tools?.length || message.images?.length);
  }
}

const DIALOGUE = new Set(["turn.prompt", "context.append_message", "context.append_loop_event", "agent.message.appended"]);

async function activeRows(file, agentId) {
  const active = [];
  let appliedUndo = false;
  function undoTurns(event) {
    const turns = [];
    for (let i = 0; i < active.length; i++) if (active[i].data.type === "turn.prompt") turns.push(i);
    let from = event.fromTurnId == null ? -1 : active.findIndex(row => row.data.type === "turn.prompt" && String(row.data.turnId) === String(event.fromTurnId));
    if (from < 0) from = turns[Math.max(0, turns.length - (event.turns ?? event.count ?? 1))] ?? -1;
    if (from < 0) {
      const users = active.map((row, i) => ({ row, i })).filter(({ row }) => {
        const event = row.data;
        const message = event.type === "agent.message.appended" ? event.message?.message : event.message;
        const origin = event.type === "agent.message.appended" ? event.message?.meta?.origin ?? message?.origin : message?.origin;
        return message?.role === "user" && origin?.kind === "user";
      });
      from = users[Math.max(0, users.length - (event.turns ?? event.count ?? 1))]?.i ?? -1;
    }
    if (from >= 0) active.splice(from);
  }
  for await (const row of rows(file)) {
    const event = row.data;
    if (event.agentId && event.agentId !== agentId) continue;
    if (event.type === "agent.switched" && event.reason === "undo") {
      if (Number.isInteger(event.base?.line) && event.base.line > 0) {
        // base.line is the 1-based first record of the discarded turn.
        const index = active.findIndex(item => item.line >= event.base.line);
        if (index >= 0) active.splice(index);
      } else undoTurns(event);
      appliedUndo = true;
    } else if (event.type === "context.undo" || event.type === "context.undone") {
      if (!appliedUndo) undoTurns(event);
      appliedUndo = true;
    } else if (DIALOGUE.has(event.type)) {
      active.push(row);
      appliedUndo = false;
    }
  }
  return active;
}

function renderTurn(segment, builder, serial) {
  const events = segment.map(row => row.data);
  const cams = events.filter(event => event.type === "context.append_message");
  const loop = events.some(event => event.type === "context.append_loop_event" && ["content.part", "tool.call", "tool.result"].includes(event.event?.type));
  const camUser = cams.some(event => event.message?.role === "user" && event.message.origin?.kind === "user");
  const camAssistant = cams.some(event => event.message?.role === "assistant");
  const amaUser = events.some(event => event.type === "agent.message.appended" && event.message?.message?.role === "user" && (event.message.meta?.origin ?? event.message.message.origin)?.kind === "user");
  let step = "0";
  const seenMessages = new Set();
  for (const row of segment) {
    const event = row.data;
    const time = event.time;
    if (event.type === "turn.prompt" && !camUser && !amaUser && event.origin?.kind === "user") builder.message("user", event.input, time, event.origin);
    if (event.type === "context.append_loop_event") {
      const part = event.event;
      if (!part) continue;
      if (part.type === "step.begin") step = part.uuid ?? part.step ?? row.line;
      const key = `${serial}:${part.stepUuid ?? part.step ?? step}`;
      if (part.type === "content.part") builder.part(key, part.part, time);
      if (part.type === "tool.call") builder.call(builder.step(key, time), part, time);
      if (part.type === "tool.result") builder.result(part, time);
      continue;
    }
    let message, origin, createdAt;
    if (event.type === "context.append_message") {
      message = event.message; origin = message?.origin; createdAt = time;
    } else if (event.type === "agent.message.appended") {
      message = event.message?.message;
      origin = event.message?.meta?.origin ?? message?.origin;
      createdAt = event.message?.meta?.createdAt ?? time;
      if (message?.role === "user" ? camUser : message?.role === "assistant" ? (loop || camAssistant) : loop) continue;
    } else continue;
    if (!message) continue;
    if (message.role === "user") {
      if (origin?.kind !== "user") continue;
      if (message.id && seenMessages.has(message.id)) continue;
      if (message.id) seenMessages.add(message.id);
      builder.message("user", message.content, createdAt, origin);
    } else if (message.role === "assistant" && !loop) {
      const target = builder.message("assistant", message.content, createdAt) ?? builder.step(`message:${serial}:${row.line}`, createdAt);
      for (const call of message.toolCalls ?? message.tool_calls ?? []) builder.call(target, call, createdAt);
    } else if (message.role === "tool") {
      builder.result({ toolCallId: message.toolCallId ?? message.tool_call_id, result: { output: parts(message.content).text, isError: message.isError } }, createdAt);
    }
  }
}

async function modernMessages(file, options = {}) {
  const active = await activeRows(file, options.agentId ?? "main");
  const builder = new Builder(options.withThinking !== false);
  let segment = [], serial = 0;
  for (const row of active) {
    if (row.data.type === "turn.prompt" && segment.length) { renderTurn(segment, builder, serial++); segment = []; }
    segment.push(row);
  }
  renderTurn(segment, builder, serial);
  return builder.finish();
}

function legacyInput(content, origin) {
  if (origin) return origin.kind === "user";
  const text = parts(content).text.trim();
  return !/^<(notification|system|system-reminder)\b|^Skill tool loaded instructions|^Continue working to/i.test(text);
}

async function legacyMessages(file, contextFile, options = {}) {
  const builder = new Builder(options.withThinking !== false);
  let step = 0, lastTool, streamedArgs, hasDialogue = false;
  for await (const { data } of rows(file)) {
    const event = data.message;
    if (!event) continue;
    const payload = event.payload ?? {};
    const time = typeof data.timestamp === "number" ? data.timestamp * 1000 : data.timestamp;
    if (event.type === "TurnBegin") {
      hasDialogue = true; step++;
      if (legacyInput(payload.user_input, payload.origin)) builder.message("user", payload.user_input, time, payload.origin);
    } else if (event.type === "StepBegin") step++;
    else if (event.type === "ContentPart") { hasDialogue = true; builder.part(step, payload, time); }
    else if (event.type === "ToolCall") {
      hasDialogue = true; lastTool = builder.call(builder.step(step, time), payload, time);
      streamedArgs = typeof payload.function?.arguments === "string" ? payload.function.arguments : "";
    } else if (event.type === "ToolCallPart" && lastTool) {
      streamedArgs += payload.arguments_part ?? ""; lastTool.args = args(streamedArgs);
    } else if (event.type === "ToolResult") { hasDialogue = true; builder.result(payload, time); }
  }
  if (hasDialogue) return builder.finish();
  for await (const { data: message, line } of rows(contextFile)) {
    if (message.role === "user" && legacyInput(message.content, message.origin)) {
      builder.message("user", message.content, options.createdAt, message.origin);
    } else if (message.role === "assistant") {
      const target = builder.message("assistant", message.content, options.createdAt) ?? builder.step(`context:${line}`, options.createdAt);
      for (const call of message.tool_calls ?? []) builder.call(target, call, options.createdAt);
    } else if (message.role === "tool") builder.result({ tool_call_id: message.tool_call_id, result: { output: parts(message.content).text, isError: message.isError ?? message.is_error } }, options.createdAt);
  }
  return builder.finish();
}

module.exports = { rows, iso, cleanUser, modernMessages, legacyMessages };
