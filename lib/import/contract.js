"use strict";

const CONTENT_MAX = 512 * 1024;
const TOOL_PAYLOAD_MAX = 256 * 1024;
const BATCH_MAX_BYTES = 32 * 1024 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const VALID_ROLES = new Set(["user", "assistant", "tool"]);
const TOOL_FIELDS = ["toolName", "toolCallId", "toolStatus", "toolArgs", "toolResult"];

function serializedBytes(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? Infinity : Buffer.byteLength(text, "utf8");
  } catch { return Infinity; }
}

function jsonDepth(value, ancestors = new Set()) {
  if (value === null || typeof value !== "object") return 1;
  if (ancestors.has(value)) return Infinity;
  ancestors.add(value);
  let deepest = 0;
  for (const child of Object.values(value)) deepest = Math.max(deepest, jsonDepth(child, ancestors));
  ancestors.delete(value);
  return deepest + 1;
}

function validTime(value) {
  return typeof value === "string" && RFC3339.test(value) && Number.isFinite(Date.parse(value));
}

function validate({ session, messages }) {
  const errors = [];
  if (!session || typeof session !== "object") return ["missing session object"];
  if (typeof session.title !== "string" || !session.title.trim()) errors.push("title is empty or not a string");
  else if ([...session.title].length > 200) errors.push("title exceeds 200 code points");
  if (typeof session.externalId !== "string" || !session.externalId.trim()) errors.push("externalId is empty or not a string");
  else if (session.externalId.length > 256) errors.push("externalId exceeds 256 characters");
  if (!validTime(session.createdAt)) errors.push("createdAt is not RFC3339");
  if (!validTime(session.updatedAt)) errors.push("updatedAt is not RFC3339");
  if (Date.parse(session.createdAt) > Date.parse(session.updatedAt)) errors.push("createdAt exceeds updatedAt");
  if (session.projectId != null && (!Number.isInteger(session.projectId) || session.projectId <= 0)) errors.push("projectId must be a positive integer");
  if (!Array.isArray(messages)) return [...errors, "messages is not an array"];
  if (!messages.length) errors.push("no readable messages");
  if (messages.length > 2000) errors.push("messages exceed 2000");
  let previous = -Infinity;
  for (const [index, message] of messages.entries()) {
    const label = `messages[${index}]`;
    if (!message || typeof message !== "object") { errors.push(`${label} is not an object`); continue; }
    if (!VALID_ROLES.has(message.role)) errors.push(`${label} invalid role`);
    if (typeof message.content !== "string") errors.push(`${label} content must be a string`);
    else if (Buffer.byteLength(message.content, "utf8") > CONTENT_MAX) errors.push(`${label} content exceeds 512 KiB`);
    if (!validTime(message.createdAt)) errors.push(`${label} createdAt is not RFC3339`);
    else {
      const time = Date.parse(message.createdAt);
      if (time < previous) errors.push(`${label} non-monotonic timestamp`);
      previous = time;
    }
    if (message.role === "tool") {
      if (typeof message.toolName !== "string" || !message.toolName.trim()) errors.push(`${label} toolName is required`);
      if (typeof message.toolCallId !== "string" || !message.toolCallId.trim()) errors.push(`${label} toolCallId is required`);
      if (!["success", "error"].includes(message.toolStatus)) errors.push(`${label} invalid toolStatus`);
      for (const field of ["toolArgs", "toolResult"]) {
        if (message[field] !== undefined && serializedBytes(message[field]) > TOOL_PAYLOAD_MAX) errors.push(`${label} ${field} exceeds 256 KiB`);
      }
    } else if (TOOL_FIELDS.some((field) => message[field] !== undefined)) {
      errors.push(`${label} tool fields are only valid for tool messages`);
    }
  }
  if (jsonDepth({ source: "source", sessions: [{ ...session, messages }], mode: "skip" }) > 8) errors.push("session JSON depth exceeds 8");
  return errors;
}

function validateBatch(payload) {
  const errors = [];
  if (typeof payload.source !== "string" || !payload.source.trim()) errors.push("source is required");
  if (!["skip", "fail"].includes(payload.mode)) errors.push("invalid batch mode");
  if (!Array.isArray(payload.sessions) || !payload.sessions.length) return [...errors, "sessions must be a non-empty array"];
  if (payload.sessions.length > 100) errors.push("batch exceeds 100 sessions");
  if (serializedBytes(payload) > BATCH_MAX_BYTES) errors.push("session payload exceeds 32 MiB");
  const seen = new Set();
  for (const session of payload.sessions) {
    if (seen.has(session.externalId)) errors.push(`duplicate externalId in batch: ${session.externalId}`);
    seen.add(session.externalId);
    errors.push(...validate({ session, messages: session.messages }).map((error) => `${session.externalId}: ${error}`));
  }
  return errors;
}

function summarizeReport(report) {
  const parts = [];
  if (report.injectedDropped) parts.push(`${report.injectedDropped} 条注入消息已省略`);
  if (report.noiseDropped) parts.push(`${report.noiseDropped} 条噪声消息已省略`);
  if (report.cappedDropped) parts.push(`前 ${report.cappedDropped} 条消息已省略（超出 2000 条上限）`);
  if (report.byteCappedDropped) parts.push(`前 ${report.byteCappedDropped} 条消息已省略（超出 32 MiB 载荷上限）`);
  if (report.contentTruncated) parts.push(`${report.contentTruncated} 条超长正文已截断`);
  return parts.join("；");
}

module.exports = { validate, validateBatch, serializedBytes, summarizeReport, jsonDepth, BATCH_MAX_BYTES };
