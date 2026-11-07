---
name: import
description: 将来源会话转换为 Kimi 原生会话并登记到指定侧边栏工作区
---

$ARGUMENTS

没有参数时调用 session_hub_open 打开原会话导入面板，由用户预览和选择导入位置。用户已给出来源 ref 和目标位置时，调用 session_hub_import，target 使用 kimi-code，workspace 使用用户指定工作区，targetRoot 使用用户指定的 Kimi 数据目录（省略时使用默认目录）。有关键词而没有 ref 时用 session_hub_search 定位。

导入逐条写入原生历史并登记侧边栏。只报告工具实际返回的 sessionId、sessionPath 和 sidebar；不要把历史转录注入当前上下文，不替用户续写历史任务。用户可在目标工作区列表打开原生会话查看完整历史并继续对话。
