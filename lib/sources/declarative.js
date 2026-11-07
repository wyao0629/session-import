"use strict";
const { getDriver } = require("../drivers");
const { exists, resolveSafe } = require("../drivers/fsutil");
const { unified } = require("../drivers/session");
const { renderMessage } = require("../hub/render");

// Keep scan/convert for old configurations and Forge; messages is authoritative.
function makeDeclarativeSource(spec) {
  const driver = getDriver(spec.driver);
  if (!driver) throw new Error(`unknown driver "${spec.driver}"`);
  const root = resolveSafe(spec.root || spec.db);
  return { id: spec.id, source: spec.id, label: spec.label || spec.id, custom: true, driver: spec.driver, dataPath: root,
    importSource: "custom", aliases: [], schemes: [spec.id], capabilities: { import: true, nativeInHost: false, children: true },
    async discover() { return await exists(root) ? [{ root, via: "declarative" }] : []; },
    async scan(_root, ctx = {}) {
      const entries = await driver.scan(spec, spec.id);
      return entries.slice(0, ctx.maxSessions ?? Infinity).map(e => ({ ...e, importSource: "custom", importable: true }));
    },
    async messages(entry, opts = {}) {
      const out = await driver.convert(spec, entry.summary ?? entry);
      if (!out?.session) throw new Error(`Unreadable declarative session: ${spec.id}`);
      return out.messages.map(unified).map(m => {
        if (opts.withThinking !== false) return m;
        const { thinking, ...rest } = m;
        return { ...rest, content: renderMessage(rest, { toolDetail: "full", withThinking: false }) };
      });
    },
    async convert(entry) { return driver.convert(spec, entry.summary ?? entry); },
  };
}
module.exports = { makeDeclarativeSource };
