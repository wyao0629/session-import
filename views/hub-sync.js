"use strict";
/*
 * Sync bar + tabs for the Session Import panel. Loaded before the inline
 * script in importer.html and used only after it has run, so it relies on the
 * page globals `bridge`, `t`, `$` and `setStatus`.
 */
const hubState = { data: null, saveTimer: null, lastSyncAt: null };

function hubNotice(text, kind = "") {
  const el = $("hub-msg");
  if (!el) return;
  el.textContent = text;
  el.className = kind;
}

function fmtStamp(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function paintHubChrome() {
  if (!$("syncbar")) return;
  $("sync-auto-l").textContent = t("hub.sync.auto");
  $("sync-every-l").textContent = t("hub.sync.every");
  for (const opt of $("sync-unit").options) opt.textContent = t(`hub.unit.${opt.value}`);
  if (typeof paintViewSwitch === "function") paintViewSwitch();
  $("tab-import").textContent = t("hub.tab.import");
  $("tab-all").textContent = t("hub.tab.all");
  renderSync();
  if (typeof paintAllChrome === "function") paintAllChrome();
}

function renderSync() {
  const d = hubState.data;
  if (!d || !$("syncbar")) return;
  const c = d.config;
  const s = d.status;
  if (document.activeElement !== $("sync-value")) $("sync-value").value = c.syncIntervalValue;
  $("sync-auto").checked = c.autoSyncEnabled;
  $("sync-unit").value = c.syncIntervalUnit;
  $("sync-value").disabled = !c.autoSyncEnabled;
  $("sync-unit").disabled = !c.autoSyncEnabled;
  $("sync-now").disabled = s.syncing;
  $("sync-now").textContent = s.syncing ? t("hub.sync.syncing") : t("hub.sync.now");
  const parts = [s.lastSyncAt ? t("hub.sync.last", { time: fmtStamp(s.lastSyncAt) }) : t("hub.sync.never"), t("hub.sync.total", { count: s.total })];
  if (!c.autoSyncEnabled) parts.push(t("hub.sync.off"));
  else if (d.schedule.nextRunAt) parts.push(t("hub.sync.next", { time: fmtStamp(d.schedule.nextRunAt) }));
  if (s.errors.length) parts.push(t("hub.sync.errors", { count: s.errors.length }));
  if (s.lastError) parts.push(t("hub.sync.lastError", { error: s.lastError }));
  $("sync-info").textContent = parts.join(" · ");
  $("sync-info").title = s.errors.slice(0, 12).map((e) => `${e.harness}: ${e.message}`).join("\n");
}

async function refreshHub() {
  try {
    hubState.data = await bridge.invoke("hub.state");
  } catch {
    return;
  }
  renderSync();
  const last = hubState.data.status.lastSyncAt;
  if (hubState.lastSyncAt && last !== hubState.lastSyncAt && typeof onHubSynced === "function") onHubSynced();
  hubState.lastSyncAt = last;
}

function queueSaveConfig() {
  clearTimeout(hubState.saveTimer);
  hubState.saveTimer = setTimeout(async () => {
    const n = Number($("sync-value").value);
    const patch = { autoSyncEnabled: $("sync-auto").checked, syncIntervalUnit: $("sync-unit").value };
    if (Number.isFinite(n) && n > 0) patch.syncIntervalValue = n;
    try {
      hubState.data = await bridge.invoke("hub.setConfig", patch);
      renderSync();
      hubNotice(t("hub.sync.saved"), "ok");
    } catch (error) {
      hubNotice(t("hub.sync.failed", { error: (error && error.message) || error }), "err");
    }
  }, 600);
}

async function runHubSync() {
  $("sync-now").disabled = true;
  $("sync-now").textContent = t("hub.sync.syncing");
  try {
    hubState.data = await bridge.invoke("hub.sync");
    hubState.lastSyncAt = hubState.data.status.lastSyncAt;
    renderSync();
    if (typeof onHubSynced === "function") onHubSynced();
    if (typeof scanSources === "function") await scanSources();
  } catch (error) {
    hubNotice(t("hub.sync.failed", { error: (error && error.message) || error }), "err");
    await refreshHub();
  }
}

function showTab(name) {
  $("view-import").classList.toggle("hidden", name !== "import");
  $("view-all").classList.toggle("hidden", name !== "all");
  $("tab-import").classList.toggle("active", name === "import");
  $("tab-all").classList.toggle("active", name === "all");
  if (name === "all" && typeof loadAll === "function") loadAll(true);
}

async function initHubSync() {
  if (!$("syncbar")) return;
  $("sync-auto").addEventListener("change", queueSaveConfig);
  $("sync-unit").addEventListener("change", queueSaveConfig);
  $("sync-value").addEventListener("input", queueSaveConfig);
  $("sync-now").addEventListener("click", runHubSync);
  $("tab-import").addEventListener("click", () => showTab("import"));
  $("tab-all").addEventListener("click", () => showTab("all"));
  paintHubChrome();
  await refreshHub();
  setInterval(() => {
    if (document.visibilityState === "visible") refreshHub();
  }, 5000);
}
