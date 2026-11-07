"use strict";

const store = require("./_shared/kimi-store");
const id = "kimi-desktop";

module.exports = {
  id, label: { en: "Kimi Desktop", "zh-CN": "Kimi 桌面版" }, order: 21,
  importSource: id, aliases: [], schemes: [],
  capabilities: { import: true, nativeInHost: false, children: true },
  discover: store.discoverDesktop,
  scan: (root, ctx) => store.scanModern(id, root, ctx),
  messages: store.messages,
};
