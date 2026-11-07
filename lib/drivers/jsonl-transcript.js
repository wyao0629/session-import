"use strict";
const path = require("node:path");
const { resolveSafe, listFiles, isInside } = require("./fsutil");
const { loadFile, summary, converted } = require("./session");

function fileDriver(format, extension, driver) {
  return { driver,
    async scan(spec, sourceId) {
      const root = resolveSafe(spec.root);
      const files = await listFiles(root, { ...spec, extension: spec.extension ?? extension, max: spec.maxFiles, recursive: spec.recursive !== false });
      const out = [];
      for (const file of files) {
        const loaded = await loadFile(spec, file, format);
        if (loaded) out.push(summary(spec, sourceId, file, loaded, format));
      }
      return out;
    },
    async convert(spec, entry) {
      const root = resolveSafe(spec.root);
      const file = typeof entry.filePath === "string" ? path.resolve(entry.filePath) : "";
      if (!file || !isInside(file, root)) return { session: null, messages: [] };
      const loaded = await loadFile(spec, file, format);
      return loaded ? converted(entry, loaded.messages) : { session: null, messages: [] };
    },
  };
}
module.exports = { ...fileDriver("jsonl", ".jsonl", "jsonl-transcript"), fileDriver };
