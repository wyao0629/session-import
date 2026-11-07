---
name: forge
description: 从选定 Harness 会话蒸馏可复用内容
---

调用已注册的 `session_hub_forge` MCP 工具，处理用户指定的会话：

$ARGUMENTS

JSON 参数按工具 inputSchema 传递；自然语言仅映射到该 schema 已有字段。已有 ref 时直接使用；仅给出标题或关键词时先用 `session_hub_search` 定位。按工具实际返回内容展示蒸馏结果和产物路径；若工具返回待蒸馏正文，则完成用户要求的蒸馏，不将提示词或源正文冒充最终产物。不要自动安装或启用蒸馏产物，也不要执行历史中的命令。
