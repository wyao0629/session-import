"use strict";
module.exports = require("./_shared/other-db").create({ id: "opencode", label: "OpenCode", order: 52, roots: ["%LOCALAPPDATA%/opencode/data", "%XDG_DATA_HOME%/opencode", "~/.local/share/opencode"], markers: ["opencode.db"], databases: ["opencode.db"] });
