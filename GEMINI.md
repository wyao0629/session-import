# 会话导入

使用 session_hub_open 打开原会话导入面板，选择来源、目标客户端与侧边栏工作区。自动同步、GUI 标题、预览和原生导入沿用同一解析核心。

session_hub_import 逐条转换并写入目标原生历史，返回 sessionId、sessionPath、sidebar。用户已指定目标时使用其 target、targetRoot、workspace；不要把历史作为当前 Agent 上下文，不把全文塞成单条消息。

四个会话工具 session_hub_sync/search/resolve/read 继续可用。导入后由用户打开目标客户端的原生会话查看完整历史并继续。
