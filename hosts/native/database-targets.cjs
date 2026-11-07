"use strict";
module.exports = {
  targets: ["workbuddy", "qoder", "reasonix", "dsh", "opencode", "zcode"].map(name => require(`./database-targets/${name}.cjs`)),
};
