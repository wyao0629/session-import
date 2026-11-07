"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
module.exports = async function installedVersion(target) {
  const command = ({ opencode: "opencode", zcode: "zcode" })[target];
  const { stdout } = await exec(command, ["--version"], { windowsHide: true, shell: process.platform === "win32" });
  const version = stdout.match(/[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
  if (!version) throw new Error(`${target} 未返回可识别的版本号。`);
  return version;
};
