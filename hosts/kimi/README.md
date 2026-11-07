# Kimi 入口

根目录 `kimi.plugin.json` 通过 Skills、commands 和 MCP 接入共用 `hosts/mcp.cjs`，工作目录为插件根目录；需要 Node.js 22.13.0 或更高版本，且 `node` 在 PATH 中。本目录不复制另一套会话解析器。

当前复用原 importer UI，目标原生写入器位于 `hosts/native/`。`kimi-code`、`kimi-desktop`、`kimi-legacy` 是不同目标，应根据实际宿主选择。

## 安装与使用

Kimi Code 可直接从 GitHub 安装：

```text
/plugins install https://github.com/wyao0629/session-import
/reload
```

也可安装完整本地源码目录。不能只安装 `hosts/kimi`。本地安装会复制到 Kimi Code 托管目录，修改原始源码后需要重新安装或重载才会使用新内容。

```text
/session-import:open
/session-import:search 要查找的会话关键词
/session-import:import {"ref":"<搜索返回的 ref>","target":"kimi-code","workspace":"D:/workspace/你的项目","placement":"workspace"}
```

调用 `session_hub_open` 打开原会话导入面板，保留自动同步、来源 GUI 标题和预览。面板可选 `target`、`root`、`workspace`、`placement`；选定真实来源 ref 后导入目标原生历史。

## 七个工具与导入契约

- 原有 `session_hub_sync/search/resolve/read` 保留，新增 `session_hub_import/forge/open`，共七个工具；宿主可能添加工具名前缀。
- import 参数包含 `ref`、`harness`（来源）、`target`、`targetRoot`（面板的 root）、`workspace`、`projectId`、`placement`、`title`、`withThinking`、`includeSubagents` 和 `mode`（`skip` / `copy`）。`target: kimi` 是 `kimi-code` 的别名；其他 Kimi 变体应明确指定。
- import 通过目标 native writer 创建真正的原生会话，逐条保存完整历史并登记目标工作区/侧栏，返回会话 ID、路径和导入回执；不将历史正文塞进当前对话。通过目标客户端打开返回的原生会话后继续聊天。
- 工具记录、可读思考等按目标格式保存，不重放工具执行。大体量 PI-Desktop 历史采用 native fallback，不裁剪。
- 原 PI Forge 保留；跨宿主 `session_hub_forge` 提供会话素材和提炼指令，由当前宿主模型生成规则或技能，传 `content` 与 `outputPath` 可保存结果。

## 自动刷新与验证状态

Kimi Code Windows 桌面端在实际导入成功后执行两阶段界面刷新：第一次触发宿主处理 `.index-dirty`，等待标记清理后第二次显示最新列表。窗口不存在或刷新失败不影响已完成的导入，状态通过 `refresh` 字段返回。该过程不启动、停止或重启宿主进程。

Kimi Code 的原生导入、侧栏显示和自动刷新已完成真实验证；其他 Kimi 变体及其他宿主仍需按实际版本验收，不能由单一宿主结果推定全部通过。
