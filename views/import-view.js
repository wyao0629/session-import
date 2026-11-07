"use strict";
/*
 * Workspace / Archived switch for the import list. Loaded before the inline
 * script in importer.html; uses the page globals `state`, `t`, `$`,
 * `renderList`, `updateCount` and `renderPreviewEmpty` at call time.
 */
const importView = { mode: "active" };

function inView(session) {
  return (importView.mode === "archived") === (session.archived === true);
}

function visibleSessions() {
  return state.sessions.filter(inView);
}

function paintViewSwitch() {
  const a = $("vs-active");
  if (!a) return;
  const archivedTotal = state.sessions.filter((s) => s.archived === true).length;
  const activeTotal = state.sessions.length - archivedTotal;
  a.textContent = `${t("hub.view.active")} ${activeTotal}`;
  $("vs-archived").textContent = `${t("hub.view.archived")} ${archivedTotal}`;
  a.classList.toggle("active", importView.mode === "active");
  $("vs-archived").classList.toggle("active", importView.mode === "archived");
}

function setImportView(mode) {
  if (importView.mode === mode) return;
  importView.mode = mode;
  state.selected.clear();
  state.activeKey = null;
  paintViewSwitch();
  renderList();
  renderPreviewEmpty();
  updateCount();
}

function emptyViewText() {
  return importView.mode === "archived" ? t("hub.view.emptyArchived") : t("hub.view.emptyActive");
}

function initImportView() {
  if (!$("vs-active")) return;
  $("vs-active").addEventListener("click", () => setImportView("active"));
  $("vs-archived").addEventListener("click", () => setImportView("archived"));
}
