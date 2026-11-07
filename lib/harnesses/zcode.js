"use strict";
module.exports = require("./_shared/other-db").create({ id: "zcode", label: "ZCode", order: 51, roots: ["~/.zcode", "%ZCODE_HOME%"], markers: ["cli/db/db.sqlite"], databases: ["cli/db/db.sqlite", "db.sqlite"] });
