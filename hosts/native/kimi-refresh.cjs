"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const executePowerShell = promisify(execFile);
const refreshScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$process = Get-Process | Where-Object { $_.MainWindowTitle -eq 'Kimi Code' } | Select-Object -First 1
if ($null -eq $process) { @{ status = 'not-running' } | ConvertTo-Json -Compress; exit 0 }
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($process.Id)) { @{ status = 'unavailable' } | ConvertTo-Json -Compress; exit 0 }
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^r')
@{ status = 'requested' } | ConvertTo-Json -Compress
`;

async function refreshKimiCode({ platform = process.platform, execute = executePowerShell } = {}) {
  if (platform !== "win32") return { status: "unsupported" };
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", refreshScript], { windowsHide: true, timeout: 5000 });
    const result = JSON.parse(stdout.trim());
    return { status: result.status };
  } catch (error) {
    return { status: "failed", error: error.message };
  }
}

async function waitForKimiIndex(results, { readDir = fs.readdir, intervalMs = 100, timeoutMs = 10000,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const markers = results.filter(result => result.sessionPath).map(result => {
    const root = path.dirname(path.dirname(path.dirname(result.sessionPath)));
    return { directory: path.join(root, "sessions", ".index-dirty"), prefix: `${path.basename(result.sessionPath)}.` };
  });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let pending = false;
    for (const marker of markers) {
      let names;
      try { names = await readDir(marker.directory); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (names.some(name => name.startsWith(marker.prefix))) pending = true;
    }
    if (!pending) return { status: "indexed" };
    if (Date.now() >= deadline) return { status: "timeout" };
    await sleep(intervalMs);
  }
}

async function refreshAfterImport(results, { refresh = refreshKimiCode, waitForIndex = waitForKimiIndex } = {}) {
  const imported = results.filter(result => result.status === "imported" && result.target === "kimi-code");
  if (!imported.length) return { status: "not-needed" };
  const initial = await refresh();
  if (initial.status !== "requested") return { ...initial, index: "not-started" };
  let index;
  try { index = await waitForIndex(imported); }
  catch (error) { index = { status: "failed", error: error.message }; }
  const result = await refresh();
  return { ...result, index: index.status, ...(index.error ? { indexError: index.error } : {}) };
}

module.exports = { refreshKimiCode, refreshAfterImport, waitForKimiIndex };
