"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const panels = new WeakMap();

async function openPanel(runtime, { launch = true } = {}) {
  let panel = panels.get(runtime);
  if (!panel) {
    const token = randomBytes(24).toString("hex");
    const root = path.resolve(__dirname, "..");
    let origin;
    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, origin);
        if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
        if (url.pathname === "/invoke" && request.method === "POST") {
          if (request.headers["x-session-import"] !== token || (request.headers.origin && request.headers.origin !== origin)) { response.writeHead(403).end(); return; }
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const { channel, payload } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const value = await runtime.invoke(channel, payload);
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ value })); return;
        }
        if (request.method !== "GET") { response.writeHead(405).end(); return; }
        let file;
        if (url.pathname === "/" || url.pathname === "/views/importer.html") {
          if (url.searchParams.get("token") !== token) { response.writeHead(403).end(); return; }
          let html = await fs.readFile(path.join(root, "views/importer.html"), "utf8");
          const bridge = `<script>window.pluginBridge={invoke:async(channel,payload={})=>{const r=await fetch('/invoke',{method:'POST',headers:{'Content-Type':'application/json','X-Session-Import':${JSON.stringify(token)}},body:JSON.stringify({channel,payload})});const b=await r.json();if(!r.ok)throw new Error(b.error);return b.value;},on:()=>()=>{}};</script>`;
          html = html.replace(/(<head[^>]*>)/, `$1${bridge}`);
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          response.end(html); return;
        }
        if (/^\/views\/(hub-sync|hub-all|import-view|destination)\.js$/.test(url.pathname) || url.pathname === "/lib/i18n.js") file = path.join(root, url.pathname.slice(1));
        if (!file) { response.writeHead(404).end(); return; }
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        response.end(await fs.readFile(file));
      } catch (error) {
        if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    panel = { url: `${origin}/views/importer.html?token=${token}`, server };
    panels.set(runtime, panel);
    const close = runtime.close.bind(runtime);
    runtime.close = () => { server.close(); panels.delete(runtime); close(); };
  }
  if (launch) {
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [panel.url], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", error => console.error(`[session-import] 浏览器打开失败：${error.message}`));
    child.unref();
  }
  return { url: panel.url, panel: "original-importer", serverStarted: true, browserLaunchRequested: launch };
}
module.exports = { openPanel };
