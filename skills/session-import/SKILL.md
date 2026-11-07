---
name: session-import
description: 打开原会话导入面板，或将本地历史转换成目标客户端的原生会话。
---

# 会话导入

保留原插件的自动同步、GUI 标题、会话预览、原生导入及四个会话工具。打开插件时调用 `session_hub_open`，由用户在原面板中选择来源、目标客户端、数据目录和侧边栏工作区。

用户明确指定会话与目标位置时，调用 `session_hub_import`，参数按当前工具 schema 传递。导入逐条写入历史并登记原生目录，返回 `sessionId`、`sessionPath`、`sidebar`；不把整个转录塞成一条用户消息，不注入当前上下文，不代替用户执行旧任务。

`session_hub_sync/search/resolve/read` 继续用于索引与预览。只在用户要求蒸馏时调用 `session_hub_forge`。

Kimi 使用 `/session-import:open`；Pi 使用 `/session-import-open`，或 `/session-import <ref>` 原生导入后切换会话。其他宿主可调用 MCP 的打开面板工具，或运行 `node hosts/cli.cjs open --host <宿主>`。
