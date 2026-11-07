---
name: search
description: 按关键词查找跨 Harness 会话
---

调用已注册的 `session_hub_search` MCP 工具搜索以下内容：

$ARGUMENTS

JSON 参数按工具 inputSchema 传递；自然语言映射到工具的查询字段和用户指定的筛选字段。展示返回的标题、来源、时间和可供后续 read/import 使用的实际 ref。仅在工具指出索引缺失时调用 sync 后重试，不自行导入搜索结果。
