---
name: resolve
description: 定位跨 Harness 会话引用
---

调用已注册的 `session_hub_resolve` MCP 工具，定位以下会话：

$ARGUMENTS

JSON 按工具 inputSchema 传递，纯文本作为 ref；来源 harness 仅在用户指定时传递。展示工具实际返回的会话来源、标题、引用和路径；本命令只定位，不执行导入。
