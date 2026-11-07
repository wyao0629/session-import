# Session Import（会话导入）

跨 Harness 的本地会话检索、预览与原生导入工具。把 Codex、Pi Desktop、Kimi Code 等工具中的历史会话转换为目标客户端的独立原生会话，并登记到指定工作区的侧边栏。

> **本项目全程由 AI 构建**，包括需求分析、代码实现、测试与文档编写。项目按 MIT 许可证开源，使用时仍应结合自己的宿主版本和数据备份进行验证。

## 主要功能

- 自动发现并索引本机多种 Harness 的会话，支持定时同步。
- 按标题、首句、工作区、会话 ID 等元数据搜索，分页读取完整历史。
- 保留原生标题、用户/助手消息、工具记录、可读思考和可选子会话。
- 导入为独立原生会话，不把整篇历史塞进当前对话，也不重放历史工具。
- 默认跳过重复导入；选择新副本时创建新的独立会话。
- 提供原会话导入面板、MCP 工具和命令行入口。
- Kimi Code Windows 桌面端支持导入后的自动侧边栏刷新。
- 支持声明式自定义来源和会话熔炉（Forge）。

## 环境要求

- Node.js **22.13.0 或更高版本**，并确保 `node` 在 `PATH` 中。
- 目标宿主使用当前支持的会话格式；不同宿主的接入方式见 [`hosts/README.md`](hosts/README.md)。

## 安装到 Kimi Code

在 Kimi Code 中执行：

```text
/plugins install https://github.com/wyao0629/session-import
/reload
```

安装后可以使用：

```text
/session-import:open
```

该命令打开会话导入面板。也可以直接安装本地源码目录：

```text
/plugins install D:/path/to/session-import
/reload
```

## 使用

### 可视化面板

1. 执行 `/session-import:open`。
2. 同步来源并选择需要预览的会话。
3. 选择目标客户端、目标工作区和导入选项。
4. 点击导入，通过返回的会话 ID 打开新会话。

### Agent 工具

| 工具 | 用途 |
| --- | --- |
| `session_hub_sync` | 重新扫描并更新会话索引 |
| `session_hub_search` | 按元数据搜索会话 |
| `session_hub_resolve` | 通过 ID、前缀、链接或路径定位会话 |
| `session_hub_read` | 分页读取会话正文 |
| `session_hub_import` | 原生导入到目标客户端和工作区 |
| `session_hub_open` | 打开可视化导入面板 |
| `session_hub_forge` | 为会话蒸馏生成素材和提炼指令 |

Kimi Code 命令示例：

```text
/session-import:search 旺店通
```

```text
/session-import:import {"ref":"pi-desktop:<会话ID>","target":"kimi-code","workspace":"D:/workspace/数据采集"}
```

### 命令行

```powershell
node hosts/cli.cjs sync --host kimi-code --workspace "D:/workspace"
node hosts/cli.cjs search --json '{"query":"会话关键词"}'
node hosts/cli.cjs read codex:<会话ID> --text
node hosts/cli.cjs import pi-desktop:<会话ID> --host kimi-code --workspace "D:/workspace/数据采集"
node hosts/cli.cjs open --host kimi-code --workspace "D:/workspace"
```

## 原生导入与自动刷新

导入会逐条写入目标客户端的原生历史，并返回 `sessionId`、`sessionPath`、侧边栏登记位置及成功、跳过或失败状态。导入的是历史内容，不恢复当时正在运行的工具状态，也不会自动执行旧任务。

Windows 上的 Kimi Code 使用两阶段界面刷新：

1. 第一次刷新触发宿主处理新会话索引。
2. 等待 `.index-dirty` 标记清理。
3. 第二次刷新显示最新侧边栏列表。

该过程可能短暂激活 Kimi Code 窗口，但不会启动、停止或重启宿主进程。窗口不存在、索引检查失败或刷新失败不会改变已经完成的原生导入结果；可通过返回的 `refresh` 字段检查状态。其他平台或未覆盖的宿主可能需要手动刷新。

## 支持的来源

当前注册的来源包括：AutoClaw、Claude、Codex、DSH、Gemini、Grok、Kimi Code、Kimi Desktop、Kimi Legacy、OpenCode、OpenClaw、Pi、Pi Desktop、Qoder、Reasonix、WorkBuddy 和 ZCode。

来源解析、宿主接入和原生写入是三个不同层次；安装成功不等于所有宿主的导入格式都已验证。实际写入器以 [`hosts/native/`](hosts/native/) 为准。

## 自定义来源

声明式来源配置位于工作区的 `docs/session-import-sources.json`，支持 JSONL、SQLite 和 JSON 树等格式。字段、安全边界和示例见 [`docs/CUSTOM-SOURCES.md`](docs/CUSTOM-SOURCES.md)。

## 隐私与安全边界

- 来源会话文件和数据库按只读方式读取。
- 导入过程在本机完成，不把历史会话上传到本项目仓库或其他外部服务。
- 目标端只会新增导入会话及必要的索引、项目登记，不覆盖当前活动会话。
- 不复制账号凭据、模型配置或宿主档案快照。
- 可视化面板使用带随机令牌的本机回环服务。
- 自定义来源只接受纯数据声明，不执行配置中的脚本。

## 开发与验证

专项测试示例：

```powershell
node --test test/kimi-refresh.test.mjs
```

完整测试需要显式提供隔离的夹具目录：

```powershell
$env:PI_SCRATCH_DIR = "D:/path/to/test-scratch"
node --test test/*.test.mjs
```

当前 Kimi Code Windows 自动刷新路径已完成 10 项专项测试和真实原生导入验证。完整套件仍有旧导入载荷及 PI 集成路径的既有失败，详见项目变更记录；不要把局部验证理解为所有宿主均已通过。

## 更多文档

- [`hosts/README.md`](hosts/README.md)：各宿主接入方式与安装参数。
- [`docs/CUSTOM-SOURCES.md`](docs/CUSTOM-SOURCES.md)：自定义来源配置。
- [`CHANGELOG.md`](CHANGELOG.md)：版本变更和既有验证记录。

## 许可证

[MIT](LICENSE)。保留原作者及许可证声明。
