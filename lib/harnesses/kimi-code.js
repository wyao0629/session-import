"use strict";

const store = require("./_shared/kimi-store");
const id = "kimi-code";

module.exports = {
  id, label: { en: "Kimi Code", "zh-CN": "Kimi Code" }, order: 20,
  importSource: id, aliases: [], schemes: [],
  capabilities: { import: true, nativeInHost: false, children: true },
  discover: ctx => store.discoverLocal(id, ctx),
  scan: (root, ctx) => store.scanModern(id, root, ctx),
  messages: store.messages,
};
