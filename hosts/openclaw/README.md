# OpenClaw / AutoClaw 入口

完整插件根目录提供 `openclaw.plugin.json`，根 `package.json` 的 `openclaw.extensions` 指向 `hosts/openclaw/index.cjs`。通过宿主插件管理加载完整插件目录，不要单独复制 index.cjs。

当前复用原 importer UI，17 个目标的 native writers 正在集成；此前的上下文搬运方案已撤回。原 `session_hub_sync/search/resolve/read` 保留，新增 `session_hub_import/forge/open`，共七个工具。服务按当前工作区建立共享 runtime，默认自动同步；停止时关闭 runtime。插件配置可指定 `host`（openclaw/autoclaw）、`workspace`、`dataDir`、`autoSync`。

`session_hub_open` 打开原会话导入面板，保留自动同步、来源 GUI 标题和 preview。面板包含 `target`、`root`、`workspace`、`placement`；import 工具中的根目录参数为 `targetRoot`。

`session_hub_import` 选择 `target: openclaw` 或 `autoclaw`，通过 native writer 创建真正的原生会话，逐条保存完整历史并登记目标工作区/侧栏，返回会话 ID、路径和导入回执，不把转录塞入当前上下文。打开目标客户端的对应会话后继续聊天。历史工具内容按目标格式保存，不重放执行。大体量 PI-Desktop 历史采用 native fallback，不裁剪。

原 PI Forge 保留；跨宿主 `session_hub_forge` 将会话素材和提炼指令交给当前宿主模型，传入 `content` 与 `outputPath` 可保存结果。

既有 `hosts/configs/openclaw/` 与 `hosts/configs/autoclaw/` 是此前生成的独立工具包和技能材料，不代表当前源码。完整插件与独立工具包择一接入，避免重复注册。以下生成命令仅供说明，本轮未执行：

```text
node hosts/install.cjs openclaw --workspace <工作区>
node hosts/install.cjs autoclaw --workspace <工作区>
```

真实安装、实际导入、侧栏显示和继续聊天均未验证。历史测试只覆盖旧来源解析与 PI 路径；旧 `.piplug` 未更新，不代表本 checkout。本轮仅更新文档，未运行检查、模型、安装或实际导入。
