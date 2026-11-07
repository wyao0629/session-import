"use strict";

const store = require("./_shared/kimi-store");
const id = "kimi-legacy";

module.exports = {
  id, label: { en: "Kimi (legacy)", "zh-CN": "Kimi（旧版）" }, order: 22,
  importSource: id, aliases: ["kimi"], schemes: [],
  capabilities: { import: true, nativeInHost: false, children: true },
  discover: ctx => store.discoverLocal(id, ctx),
  scan: store.scanLegacy,
  messages: store.messages,
};
