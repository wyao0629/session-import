---
name: sync
description: 刷新跨 Harness 会话索引
---

调用已注册的 `session_hub_sync` MCP 工具。用户参数：

$ARGUMENTS

JSON 按工具 inputSchema 传入；自然语言仅映射到该 schema 已有字段。没有参数时使用工具默认值。报告工具实际返回的同步结果；不额外导入会话或执行测试。
