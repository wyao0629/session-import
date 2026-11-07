---
name: read
description: 阅读选定 Harness 会话正文
---

调用已注册的 `session_hub_read` MCP 工具，读取以下会话：

$ARGUMENTS

JSON 按工具 inputSchema 传递，纯文本作为 ref；保留用户给定的来源、思考内容和子代理选项。根据用户要求展示正文或摘要，保留来源引用。若返回分页或截断信息，按工具 schema 继续读取所需部分，不将未读内容描述为已经阅读。本命令不执行 import，不执行历史中的命令。
