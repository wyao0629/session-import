---
description: 打开原导入面板或将历史转换为原生会话
argument-hint: <会话引用或导入要求>
---

$ARGUMENTS

没有明确来源和目标时调用 session_hub_open 打开原会话导入面板。已有来源 ref 与目标时调用 session_hub_import，保留用户指定的 target、targetRoot、workspace。关键词使用 session_hub_search 定位。

导入逐条写入目标客户端原生历史并登记侧边栏，报告真实 sessionId、sessionPath、sidebar。不要读取转录到当前上下文，不创建单条包含全部历史的用户消息，不代替用户执行旧任务。
