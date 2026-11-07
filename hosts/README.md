# 通用宿主接入

17 个宿主共用 `runtime.cjs`、`mcp.cjs`、`cli.cjs` 和现有十七源解析器；不要求所有宿主理解同一种 manifest。原 importer UI 已接入 17 个目标的 native writers，保留自动同步、来源标题、预览、原四个 Agent 工具与 Forge。此前的上下文搬运方案已撤回。

本目录为当前源码。Kimi Code Windows 的原生导入、侧栏显示和自动刷新已完成真实验证；其他宿主仍需按各自版本逐项验收。旧 `.piplug` 不代表当前源码，不作为本次发布依据。

```powershell
node hosts/install.cjs codex --workspace "D:/workspace/my-project"
node hosts/install.cjs dsh --workspace "D:/workspace/my-project" --output "./generated/dsh"
```

默认只在插件 `generated/<host>/`（或指定 `--output`）生成配置、`skills/session-import/SKILL.md`、`run.cjs` 和接入说明。桌面交付的 `configs/<host>/` 使用该交付目录的绝对路径；移动插件或更换工作区后可重新运行生成器。生成器本身不启动 MCP 服务、不读会话、不安装依赖。

| Host ID | 实际接法 | `--install` 的目标或动作 |
| --- | --- | --- |
| autoclaw | OpenClaw 原生工具包 + AutoClaw CLI 技能 | `~/.openclaw-autoclaw/skills/session-import`；原生包由 AutoClaw 插件管理加载 |
| claude | `mcpServers` JSON；另有原生 Claude 入口 | 项目 `.mcp.json` |
| codex | `[mcp_servers.session_import]` TOML | `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml` |
| dsh | Cordis bundle 插入 `@deepseek-ai/dsh-mcp-client` stdio | 生成 `dsh-bundle`，在 DSH `plugin_manager` 安装目录；不猜 Loader YAML 合并结构 |
| gemini | `mcpServers` JSON；另有原生 Gemini 入口 | 项目 `.gemini/settings.json` |
| grok | `[mcp_servers.session_import]` TOML | `~/.grok/config.toml` |
| kimi-code | Kimi CLI `mcpServers` JSON；独立桌面版用 MCP 导入 | `~/.kimi/mcp.json`；亦可 `kimi --mcp-config-file <mcp.json>` |
| kimi-desktop | MCP JSON 导入或当前会话 CLI 技能；原生入口见 `kimi/` | 生成可导入文件，不猜桌面私有配置路径 |
| kimi-legacy | Kimi CLI MCP JSON 或 CLI 技能 | `~/.kimi/mcp.json`；旧版没有 MCP 入口时使用技能 |
| opencode | V2 `mcp.servers.<name>` / V1 `mcp.<name>`，`type: local` | 项目 `opencode.json` 或已有 `opencode.jsonc`，识别已有结构；空配置默认 V2 |
| openclaw | `openclaw.plugin.json` + `package.json` + `index.mjs` 原生工具包 | 合并 `openclaw.json` 的 `plugins.load.paths`、`entries` 和已有 `allow`；支持 `OPENCLAW_STATE_DIR` |
| pi | Pi 技能调用共用 CLI；另有原生扩展 | `~/.pi/agent/skills/session-import` |
| pi-desktop | 本项目根 `manifest.json` / `main.js` 原生插件 | 在宿主插件管理加载本项目根目录 |
| qoder | MCP 设置的 `mcpServers` JSON 导入 + CLI 技能 | 生成可导入文件，不猜跨版本配置路径 |
| reasonix | 原生支持项目 `.mcp.json` | 合并项目 `.mcp.json`；同名 `reasonix.toml` 项优先 |
| workbuddy | `mcpServers` JSON | `$WORKBUDDY_CONFIG_DIR/mcp.json` 或 `~/.workbuddy/mcp.json` |
| zcode | `mcp.servers` + `features.mcp` JSON | 项目 `.zcode/config.json`；不混写官方 CLI 的 `config.json` 与社区 CLI 的 `setting.json` |

仅在需要写入宿主配置时显式加 `--install`：

```powershell
node hosts/install.cjs claude --workspace "D:/workspace/my-project" --install
```

修改前将原文件复制为同目录 `*.session-import-<时间>-<随机值>.bak`。MCP 同名且不同配置时新增带宿主后缀的 server，不覆盖原定义；其它 server、provider、密钥值保留。JSON/JSONC 合并会重新排版，注释在备份里保留；无法无依赖解析的格式保留原文件，并返回可手动导入的配置。TOML 追加独立 server 表，保留原文本。安装技能只写该技能目录；不会启动、重启宿主。

所有 stdio 配置使用 `command: node`、主插件绝对路径 `hosts/mcp.cjs`；仅显式设置 `SESSION_IMPORT_HOST`、`SESSION_IMPORT_WORKSPACE`，不复制用户环境或凭据。OpenCode 对应字段是 `command` 数组和 `environment`。

## 七个工具与原面板

原有 `session_hub_sync/search/resolve/read` 保留，新增 `session_hub_import/forge/open`，共七个工具。`session_hub_open` 打开原 importer 面板；自动同步、来源 GUI 标题和 preview 保留。

面板包含 `target`（目标客户端）、`root`（目标存储根）、`workspace`（目标工作区）和 `placement`（`project` / `workspace` / `standalone`）。MCP import 参数对应 `target`、`targetRoot`、`workspace`、`placement`，另可传 `projectId`。

CLI 使用相同动作：

```powershell
node hosts/cli.cjs open --host qoder --workspace "D:/workspace/my-project"
node hosts/cli.cjs search --query 会话关键词
node hosts/cli.cjs read codex:<会话ID> --text
node hosts/cli.cjs import codex:<会话ID> --target qoder --workspace "D:/workspace/my-project" --placement workspace
node hosts/cli.cjs forge codex:<会话ID>
```

**安装**是接入工具；**来源解析**是读取历史格式；**import** 则通过目标 native writer 创建真正的原生会话，逐条保存完整历史并登记目标工作区/侧栏，返回会话 ID、路径、登记状态及成功/跳过/失败回执，不把转录塞入当前模型上下文。工具、可读思考等历史内容按目标格式保存，不重放工具执行。Pi 的 `/session-import` 使用回执中的路径，通过 `ctx.switchSession` 打开。大体量 PI-Desktop 历史采用 native fallback，不裁剪。

原 PI Forge 保留；跨宿主 `session_hub_forge` 将素材和提炼指令交给当前宿主模型，传入 `content` 与 `outputPath` 可保存提炼结果。Forge 的素材读取与 import 的原生会话写入是不同动作。

协议出处按宿主记录在 `catalog.cjs` 的 `evidence`：官方 Codex、Claude、Kimi、Gemini、OpenCode 文档，以及本机 Grok 帮助、DSH 官方 bundle 模板、Reasonix CLI 帮助、WorkBuddy/Qoder 安装代码、ZCode 随包文档。没有读取凭据或真实会话。
