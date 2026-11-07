"use strict";

// Legacy callers share the harness parser; old scanner files remain in place.
const { registry } = require("../../registry");
module.exports = new Proxy({}, {
  get(_target, id) {
    const h = registry.get(id);
    return h ? (root, ctx) => h.scan(root, ctx) : undefined;
  },
});
