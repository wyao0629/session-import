"use strict";
const { spawn } = require("node:child_process");
const sqliteTargets = new Set(["codex", "pi-desktop", "kimi-desktop", "workbuddy", "qoder", "opencode", "zcode", "openclaw", "autoclaw"]);

async function writeTarget(target, input) {
  if (!sqliteTargets.has(target.id)) return target.importSession(input);
  let sqlite;
  try { sqlite = require("node:sqlite"); }
  catch (error) { if (!["ERR_UNKNOWN_BUILTIN_MODULE", "MODULE_NOT_FOUND", "ERR_NO_SUCH_BUILTIN_MODULE"].includes(error.code)) throw error; }
  if (sqlite?.DatabaseSync && sqlite.backup) return target.importSession(input);
  return new Promise((resolve, reject) => {
    const child = spawn("node", [__filename, target.id], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", diagnostic = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { diagnostic += chunk; });
    child.on("error", reject); child.stdin.on("error", reject);
    child.on("close", code => {
      let response;
      try { response = JSON.parse(output); }
      catch { reject(new Error(diagnostic || `原生导入进程退出：${code}`)); return; }
      if (response.ok && code === 0) resolve(response.result);
      else reject(Object.assign(new Error(response.error), { code: response.code, sessionId: response.sessionId, sessionPath: response.sessionPath }));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

if (require.main === module) {
  (async () => {
    let input = ""; process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    const sqlite = require("node:sqlite");
    if (!sqlite.DatabaseSync || !sqlite.backup) throw new Error("已安装的 Node 缺少原生 SQLite 写入能力。");
    const target = require("./index.cjs").targetOf(process.argv[2]);
    const result = await target.importSession(JSON.parse(input));
    process.stdout.write(JSON.stringify({ ok: true, result }));
  })().catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message, code: error.code, sessionId: error.sessionId, sessionPath: error.sessionPath }));
    process.exitCode = 1;
  });
}
module.exports = { writeTarget };
