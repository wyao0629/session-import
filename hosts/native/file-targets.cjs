"use strict";

module.exports = { targets: [
  require("./file-targets/claude.cjs"),
  require("./file-targets/gemini.cjs"),
  require("./file-targets/grok.cjs"),
  ...require("./file-targets/claw.cjs").targets,
] };
