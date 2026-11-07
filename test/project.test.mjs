// test/project.test.mjs — import/project.js unit tests
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { project } = require("../lib/import/project.js");

const BASE_ENTRY = {
  harness: "test",
  sessionId: "test-session-001",
  sessionPath: "/test/session.json",
  name: "Test Session",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T01:00:00.000Z",
};

function makeMsg(role, text, kind = "normal", createdAt = "2024-01-01T00:00:00.000Z") {
  return { role, kind, text, createdAt };
}

test("project: basic user/assistant alternation", () => {
  const msgs = [
    makeMsg("user", "Hello"),
    makeMsg("assistant", "Hi there"),
    makeMsg("user", "How are you?"),
    makeMsg("assistant", "I'm good!"),
  ];
  const { messages } = project(BASE_ENTRY, msgs);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[2].role, "user");
  assert.equal(messages[3].role, "assistant");
});

test("project: drops injected messages", () => {
  const msgs = [
    makeMsg("user", "AGENTS.md context", "injected"),
    makeMsg("user", "Real question"),
    makeMsg("assistant", "Answer"),
  ];
  const { messages, report } = project(BASE_ENTRY, msgs);
  // injected is dropped; remaining is user + assistant
  assert.equal(report.injectedDropped, 1);
  const userMsgs = messages.filter((m) => m.role === "user");
  assert.equal(userMsgs.length, 1);
  assert.equal(userMsgs[0].text, "Real question");
});

test("project: drops noise messages", () => {
  const msgs = [
    makeMsg("user", "Real question"),
    makeMsg("assistant", ""),       // empty assistant → dropped
    makeMsg("assistant", "Answer"),
  ];
  const { messages } = project(BASE_ENTRY, msgs);
  // Empty assistant turn dropped; adjacent assistants merged
  const assistants = messages.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 1);
});

test("project: merges adjacent same-role messages", () => {
  const msgs = [
    makeMsg("user", "Part 1"),
    makeMsg("user", "Part 2"),
    makeMsg("assistant", "Response"),
  ];
  const { messages } = project(BASE_ENTRY, msgs);
  const users = messages.filter((m) => m.role === "user");
  // 连续用户消息合并，不插入虚构助手消息。
  assert.equal(users.length, 1);
  assert.ok(users[0].text.includes("Part 1"));
  assert.ok(users[0].text.includes("Part 2"));
});

test("project: caps at 2000 messages", () => {
  const msgs = [];
  for (let i = 0; i < 1100; i++) {
    msgs.push(makeMsg("user", `q${i}`));
    msgs.push(makeMsg("assistant", `a${i}`));
  }
  const { messages, report } = project(BASE_ENTRY, msgs);
  assert.ok(messages.length <= 2000); // 省略提示同样计入上限
  assert.ok(report.cappedDropped > 0);
});

test("project: builds session metadata", () => {
  const msgs = [makeMsg("user", "Hello"), makeMsg("assistant", "Hi")];
  const { session } = project(BASE_ENTRY, msgs);
  assert.equal(session.externalId, "test-session-001");
  assert.equal(session.title, "Test Session");
  assert.ok(session.createdAt);
  assert.ok(session.updatedAt);
  assert.ok(session.createdAt <= session.updatedAt);
});

test("project: thinking blocks included by default", () => {
  const msgs = [
    { ...makeMsg("assistant", "The answer"), thinking: ["I think this is right"] },
    makeMsg("user", "ok"),
  ];
  // user first
  const ordered = [makeMsg("user", "Question"), ...msgs];
  const { messages } = project(BASE_ENTRY, ordered);
  const assistant = messages.find((m) => m.role === "assistant");
  assert.ok(assistant.text.includes("推理"));
  assert.ok(assistant.text.includes("I think this is right"));
});

test("project: thinking blocks excluded when withThinking=false", () => {
  const msgs = [
    makeMsg("user", "Question"),
    { ...makeMsg("assistant", "The answer"), thinking: ["I think this is right"] },
  ];
  const { messages } = project(BASE_ENTRY, msgs, { withThinking: false });
  const assistant = messages.find((m) => m.role === "assistant");
  assert.ok(!assistant.text.includes("推理"));
});

test("project: tool calls folded into text", () => {
  const msgs = [
    makeMsg("user", "Run a command"),
    {
      ...makeMsg("assistant", "Running..."),
      tools: [{ id: "tc1", name: "bash", args: { command: "ls" }, result: "file1\nfile2", status: "success" }],
    },
  ];
  const { messages } = project(BASE_ENTRY, msgs);
  const assistant = messages.find((m) => m.role === "assistant");
  assert.ok(assistant.text.includes("bash"));
  assert.ok(assistant.text.includes("ls"));
});

test("project: title truncated at 200 code points", () => {
  const longEntry = { ...BASE_ENTRY, name: "x".repeat(300) };
  const { session } = project(longEntry, [makeMsg("user", "hi"), makeMsg("assistant", "ok")]);
  assert.ok([...session.title].length <= 200);
});
