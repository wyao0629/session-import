"use strict";
const destinationState = { native: true, host: null, roots: new Map() };
function isPiDesktopTarget() { return document.getElementById("target-host").value === "pi-desktop"; }
function canOpenPiNative() { return !destinationState.native && isPiDesktopTarget() && document.getElementById("target-root").value === destinationState.roots.get("pi-desktop"); }
function canImportToTarget(session) { return session.messageCount !== 0 && session.hiddenReason !== "deleted"; }
function targetNotice() {
  return state.activeSource === "pi" && canOpenPiNative() ? "宿主已原生支持 Pi，默认原生打开；需要快照时请勾选显式导入。" : "所选历史将逐条导入到目标客户端及工作区。";
}

function importDestination() {
  return { target: document.getElementById("target-host").value || undefined,
    targetRoot: document.getElementById("target-root").value.trim() || undefined,
    placement: document.getElementById("target-placement").value,
    workspace: document.getElementById("target-workspace").value.trim() || undefined };
}
async function initDestination() {
  const info = await bridge.invoke("import.targets");
  destinationState.native = info.native; destinationState.host = info.host;
  destinationState.roots = new Map(info.targets.map(target => [target.id, target.root || ""]));
  const select = document.getElementById("target-host");
  for (const target of info.targets) {
    const option = document.createElement("option"); option.value = target.id; option.textContent = target.label; select.appendChild(option);
  }
  if (info.targets.some(target => target.id === info.host)) select.value = info.host;
  const refresh = () => {
    const target = info.targets.find(item => item.id === select.value);
    document.getElementById("target-root").value = target?.root || "";
    document.getElementById("target-root-label").hidden = !target?.root;
  };
  const repaint = () => { document.getElementById("runtime-notice").textContent = targetNotice(); renderList(); updateCount(); };
  select.addEventListener("change", () => { refresh(); repaint(); }); refresh();
  document.getElementById("target-root").addEventListener("input", repaint);
  document.getElementById("target-workspace").value = info.workspace || "";
  const placement = document.getElementById("target-placement");
  const update = () => { document.getElementById("target-workspace-label").hidden = placement.value !== "workspace"; };
  placement.addEventListener("change", update); update();
  if (info.native) {
    const label = document.getElementById("subagent-summary").parentElement;
    label.lastChild.textContent = "同时导入子代理完整会话";
    for (const option of placement.options) if (option.value === "standalone") option.textContent = "当前工作区会话列表";
  }
}
