---
name: session-hub
description: 使用原会话导入面板同步、预览并转换为目标客户端的原生会话。
---

# 会话导入

用户要求打开插件时，调用 `session_hub_open`。面板沿用原插件的自动同步、GUI 标题、预览和导入流程。

四个原工具继续提供 `session_hub_sync/search/resolve/read`。导入使用 `session_hub_import`，传来源 ref、目标 target、用户指定的 workspace 和可选 targetRoot。它逐条转换历史并登记到目标客户端的侧边栏，返回真实 sessionId、sessionPath、sidebar。

Kimi 使用 `/session-import:open` 打开面板；`/session-import:import` 接受 ref 或 JSON 参数。仅有关键词时搜索定位；目标位置在面板选择或按用户已给参数传入。

导入成功后说明新会话 ID 和所在工作区。返回 `refresh.status: "requested"` 表示已请求 Kimi Code 自动刷新，不要再手动刷新；其他状态按返回提示处理，刷新失败不影响已完成的原生导入。不要将转录贴进当前上下文，不把一条包含整篇历史的用户消息当成原生会话，不代替用户执行旧任务。来源文件保持只读，目标新增独立原生会话。工具返回错误时如实说明，不改用上下文搬运。

会话熔炉沿用 `session_hub_forge`，只在用户要求蒸馏时使用。
