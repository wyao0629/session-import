"use strict";
/* "All sessions" tab: browse the index, locate by ID / link, read a session. */
const allState = { harness: "", query: "", rows: [], total: 0, counts: {}, active: null, timer: null, token: 0 };
const PAGE = 100;

function harnessLabel(id) {
  const h = hubState.data && hubState.data.harnesses.find((x) => x.id === id);
  return (h && h.label) || id;
}

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function paintAllChrome() {
  if (!$("all-search")) return;
  $("all-search").placeholder = t("hub.all.search");
  $("all-locate").placeholder = t("hub.all.locate");
  $("all-locate-btn").textContent = t("hub.all.locateBtn");
  $("all-more").textContent = t("hub.all.more");
  renderHarnessChips();
}

function renderHarnessChips() {
  const box = $("all-chips");
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  const total = Object.values(allState.counts).reduce((a, b) => a + b, 0);
  const add = (id, label, n) => {
    const b = mk("button", "chip" + (allState.harness === id ? " active" : ""), `${label} ${n}`);
    b.addEventListener("click", () => {
      allState.harness = id;
      loadAll(true);
    });
    box.appendChild(b);
  };
  add("", t("hub.all.allHarness"), total);
  for (const id of Object.keys(allState.counts).sort()) add(id, harnessLabel(id), allState.counts[id]);
}

async function loadAll(reset) {
  const token = ++allState.token;
  const offset = reset ? 0 : allState.rows.length;
  let res;
  try {
    res = await bridge.invoke("hub.list", { query: allState.query, harness: allState.harness || undefined, offset, limit: PAGE });
  } catch (error) {
    hubNotice(t("hub.sync.failed", { error: (error && error.message) || error }), "err");
    return;
  }
  if (token !== allState.token) return;
  allState.rows = reset ? res.sessions : allState.rows.concat(res.sessions);
  allState.total = res.total;
  allState.counts = res.counts;
  renderHarnessChips();
  renderRows(allState.rows);
  $("all-more").classList.toggle("hidden", allState.rows.length >= allState.total);
  $("all-count").textContent = t("hub.all.shown", { shown: allState.rows.length, total: allState.total });
}

function renderRows(rows, note) {
  const list = $("all-list");
  while (list.firstChild) list.removeChild(list.firstChild);
  if (note) list.appendChild(mk("div", "all-note", note));
  if (!rows.length) {
    list.appendChild(mk("div", "all-note", t("hub.all.empty")));
    return;
  }
  for (const s of rows) {
    const row = mk("div", "all-row" + (allState.active && allState.active.sessionId === s.sessionId && allState.active.harness === s.harness ? " active" : ""));
    const top = mk("div", "all-top");
    top.append(mk("span", "badge", harnessLabel(s.harness)), mk("span", "all-title", s.title));
    if (s.nameKind === "prompt" || s.nameKind === "none") top.lastChild.title = t("hub.all.noName");
    if (s.imported) top.appendChild(mk("span", "badge", "已导入"));
    if (s.childCount) top.appendChild(mk("span", "badge", `子代理 ${s.childCount}`));
    if (s.nativeInHost) top.appendChild(mk("span", "badge", "宿主原生支持"));
    const meta = mk("div", "all-meta", [fmtStamp(s.updatedAt), s.workspacePath || "", s.messageCount != null ? t("importer.preview.Nmessages", { count: s.messageCount }) : ""].filter(Boolean).join(" · "));
    row.append(top, meta);
    row.addEventListener("click", () => openDetail(s));
    list.appendChild(row);
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

function field(label, value, copy) {
  const line = mk("div", "d-line");
  line.append(mk("span", "d-k", label), mk("span", "d-v", value || "-"));
  if (copy && value) {
    const b = mk("button", "link", copy);
    b.addEventListener("click", () => copyText(value));
    line.appendChild(b);
  }
  return line;
}

function openDetail(s) {
  allState.active = s;
  renderRows(allState.rows);
  const box = $("all-detail");
  while (box.firstChild) box.removeChild(box.firstChild);
  box.classList.remove("hidden");
  box.append(
    mk("div", "d-title", s.title),
    field(t("hub.all.id"), s.sessionId, t("hub.all.copyId")),
    field(t("hub.all.workspace"), s.workspacePath),
    field(t("hub.all.path"), s.sessionPath, t("hub.all.copyPath")),
    field(t("hub.all.updated"), fmtStamp(s.updatedAt)),
  );
  if (s.parentSessionId) box.appendChild(field("父会话", s.parentSessionId, t("hub.all.copyId")));
  if (s.visible === false) box.appendChild(field("隐藏原因", s.hiddenReason));
  const thinking = mk("input"); thinking.type = "checkbox"; thinking.checked = true;
  const thoughtLabel = mk("label"); thoughtLabel.append(thinking, document.createTextNode("保留思考"));
  const children = mk("input"); children.type = "checkbox";
  const childrenLabel = mk("label"); childrenLabel.append(children, document.createTextNode("展开子代理全文"));
  const read = mk("button", "primary", t("hub.all.read"));
  const more = mk("button", "hidden", "继续读取");
  const pre = mk("pre", "d-pre hidden");
  let offset = 0, options;
  const load = async (reset) => {
    read.disabled = more.disabled = true;
    if (reset) { offset = 0; pre.textContent = ""; options = { withThinking: thinking.checked, includeSubagents: children.checked }; }
    try {
      const r = await bridge.invoke("hub.read", { harness: s.harness, ref: s.key ?? s.sessionId, maxChars: 20000, offset, ...options });
      pre.textContent += r.content; offset = r.nextOffset;
      pre.classList.remove("hidden"); more.classList.toggle("hidden", offset == null);
    } catch (error) { pre.textContent = String(error.message ?? error); pre.classList.remove("hidden"); }
    finally { read.disabled = more.disabled = false; }
  };
  read.addEventListener("click", () => load(true));
  more.addEventListener("click", () => load(false));
  box.append(thoughtLabel, childrenLabel, read, pre, more);
  if (s.harness === "pi" && s.nativeInHost) {
    const open = mk("button", "primary", "在宿主中打开");
    open.addEventListener("click", async () => {
      try { await bridge.invoke("hub.openNative", { harness: s.harness, ref: s.key ?? s.sessionId }); }
      catch (error) { hubNotice(String(error.message ?? error), "err"); }
    });
    box.appendChild(open);
  }
}

async function locate() {
  const ref = $("all-locate").value.trim();
  if (!ref) return loadAll(true);
  let res;
  try {
    res = await bridge.invoke("hub.resolve", { ref });
  } catch (error) {
    hubNotice(String((error && error.message) || error), "err");
    return;
  }
  allState.token += 1;
  if (!res.matches.length) {
    renderRows([], t("hub.all.notFound"));
    $("all-more").classList.add("hidden");
    return;
  }
  allState.rows = res.matches;
  const note = res.ambiguous ? t("hub.all.ambiguous", { count: res.matches.length }) : t("hub.all.matched", { how: res.how });
  renderRows(res.matches, note);
  $("all-more").classList.add("hidden");
  $("all-count").textContent = t("hub.all.shown", { shown: res.matches.length, total: res.matches.length });
  if (!res.ambiguous) openDetail(res.matches[0]);
}

function onHubSynced() {
  if (!$("view-all").classList.contains("hidden") && !$("all-locate").value.trim()) loadAll(true);
}

function initAll() {
  if (!$("all-search")) return;
  $("all-search").addEventListener("input", () => {
    clearTimeout(allState.timer);
    allState.timer = setTimeout(() => {
      allState.query = $("all-search").value.trim();
      loadAll(true);
    }, 250);
  });
  $("all-locate-btn").addEventListener("click", locate);
  $("all-locate").addEventListener("keydown", (e) => {
    if (e.key === "Enter") locate();
  });
  $("all-more").addEventListener("click", () => loadAll(false));
  paintAllChrome();
}
