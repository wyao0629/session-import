"use strict";
const { harness } = require("./_shared/other");
const { enumerate, load } = require("./_shared/other-claude");
module.exports = harness({ id: "claude", label: "Claude Code", order: 40, importSource: "claude-code",
  aliases: ["claude-code"], roots: ["~/.claude", "%CLAUDE_CONFIG_DIR%"], markers: ["projects"], enumerate, load });
