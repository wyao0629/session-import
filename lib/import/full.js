"use strict";
const { parseTime, maxTime, monotonic } = require("../core/time");
const { stableExternalId } = require("./project");
const { fullMessages } = require("../../hosts/native/index.cjs");

function projectFull(entry, messages, options = {}) {
  const rendered = fullMessages(messages, options);
  const createdAt = parseTime(entry.createdAt) ?? parseTime(rendered[0]?.createdAt) ?? new Date().toISOString();
  const times = monotonic(rendered.map(message => message.createdAt), createdAt);
  const result = rendered.map((message, index) => ({ role: message.role, text: message.content, createdAt: times[index] }));
  return { session: { externalId: stableExternalId(entry.externalId ?? entry.sessionId), title: entry.name || entry.title || entry.firstPrompt || entry.sessionId,
    projectPath: entry.workspacePath ?? null, modelId: entry.modelId ?? null, providerId: null, createdAt, updatedAt: maxTime(entry.updatedAt, times.at(-1) ?? createdAt) },
    messages: result, report: { inputCount: messages.length, outputCount: result.length, injectedDropped: messages.filter(message => message.kind === "injected").length,
      noiseDropped: messages.filter(message => message.kind === "noise").length, emptyDropped: 0, cappedDropped: 0, byteCappedDropped: 0, contentTruncated: 0 } };
}
module.exports = { projectFull };
