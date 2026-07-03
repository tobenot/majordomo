# majordomo（代号：指挥官）

> A persona-driven hub that watches your fleet of native Claude Code windows.
> 一个旁观你手边一群原生 Claude Code 窗口的人设管家中枢。

你手边同时开着 N 个原生 Claude Code 窗口在干活。majordomo **不驱动它们**，而是站在旁边：
每个窗口经 **Bifrost 插件**把工作报告推给中枢，中枢维护三张表（谁在做什么 / 全局待办 / 待验收），
用人设口吻合成**一句管家汇报**，并在你离场时用 Bark 推手机。core daemon + 多前端，WebSocket 通信，
可跑在无桌面服务器。

> 2026-07-02 转型：早期形态是「自建工作层的调度器」（SdkWorker 常驻会话 + canUseTool 权限 UI），
> 已退役为可选/mock —— 原生窗口的交互干不过它自己。转型脉络见 [`docs/design/pivot-to-hub.md`](docs/design/pivot-to-hub.md)。

## 设计要点

- **干活层（不归我管）**：你手边的原生 Claude Code 窗口 ×N，本地或服务器。majordomo 只旁观，不代劳。
- **运输管道**：[`bifrost/`](bifrost/) 插件装进每个窗口，用 hook（Stop / Notification）把报告 `POST /ingest` 给中枢。零中枢依赖——只认一个能 POST 的 URL。
- **中枢（core daemon）**：接收上报 → 维护三张表 → persona 复命 → 广播给前端 + 触达你。长驻，可 headless 跑在服务器。
- **人设层（嘴）**：便宜模型 API / 离线模板，读 N 个窗口的报告后用人话复命。majordomo 的灵魂——单窗口 hook 没有跨窗口视野，合成不了这句话。
- **触达你**：本机你在场 → Bifrost 弹窗/提示音（即时）；你离场 → 中枢推 Bark（节流）；随时 → 终端/网页看三张表。
- **可选旧路径**：SdkWorker（自建工作层）仍在、仍编译、TUI 仍可用它验收，但已非主路径。没装 SDK 自动降级 mock。

详见 [`docs/architecture.md`](docs/architecture.md)；中枢 v1 施工见 [`docs/design/bifrost-hub-v1.md`](docs/design/bifrost-hub-v1.md)，设计脉络见 [`docs/design/main-mind.md`](docs/design/main-mind.md) → [`pivot-to-hub.md`](docs/design/pivot-to-hub.md)。

## 快速开始（两步上手）

> 想要保姆级图文版：打开 [`docs/guide/quickstart.html`](docs/guide/quickstart.html)（双击即可，浏览器渲染）。

### 第 1 步 · 起中枢

```bash
npm install
npm run build
npm run doctor      # 环境自检：Node / SDK / 端口 / Bifrost 插件是否就位
npm run selftest    # 端到端自测（可选，验证核心链路）

node dist/cli.js    # 启动中枢 + Web 面板（内嵌 daemon，默认命令）
```

日志出现 `core daemon 监听 http+ws://127.0.0.1:4350（上报入口 /ingest）` 即中枢就绪。
浏览器开 `http://127.0.0.1:4351` 看面板（web 端口 = daemon+1）。

### 第 2 步 · 每个干活窗口装 Bifrost 插件

在你**干活的** Claude Code 窗口里（不是中枢那个终端），用 `--plugin-dir` 加载 [`bifrost/`](bifrost/)：

```bash
claude --plugin-dir <majordomo仓库路径>/bifrost
```

插件会用 hook 把这个窗口的活动（做完一轮 / 等你许可 / 建/销任务 / 上下线）`POST` 给中枢，
中枢的三张表和 persona 复命随即跟着动。默认上报地址 `http://127.0.0.1:4350/ingest`，与中枢
**共用端口 4350**（避开 WXWork 占的 4317）。中枢没开也不怕——插件先落盘缓存，下次中枢应答时补送。

改上报地址等：编辑 [`bifrost/report.config.jsonc`](bifrost/report.config.jsonc)。插件细节见 [`bifrost/README.md`](bifrost/README.md)。

### 其它入口

```bash
node dist/cli.js web       # 只起 Web 面板（看三张表 + 交接浮窗）
node dist/cli.js daemon    # 只前台跑 core daemon（长驻，供窗口上报 + 多前端连接）

npm install -g .           # 全局安装后可用 commander / majordomo 在任意目录唤起
commander
```

## 配置

复制 `config.example.jsonc` 为 `config.jsonc`（不进版本库）。人设层密钥放 `.env`（见 `.env.example`）。

人设层 API 支持两种格式：

```bash
# OpenAI-compatible
PERSONA_API_FORMAT=openai
PERSONA_API_BASE=https://api.openai.com/v1
PERSONA_MODEL=gpt-4o-mini

# Anthropic Messages API
PERSONA_API_FORMAT=anthropic
PERSONA_API_BASE=https://api.anthropic.com
PERSONA_MODEL=claude-3-5-haiku-latest
# 官方 Anthropic 接口可省略 PERSONA_API_BASE
```

### 通知与触达

| notifier | 作用 | 场景 |
|---|---|---|
| `bark` | 推手机（需 `bark` 配置） | 你离场时中枢的唯一出口；服务器无桌面时也靠它 |
| `console` | 跨平台命令行降级 | 默认，兜底 |
| `powershell` | 本机提示音/浮窗/TTS | **默认不含**——本机弹窗归 Bifrost，中枢同机再弹会叠一次 |

默认 `notifiers: ["console"]`。本机弹窗/提示音的职责已让给 Bifrost（窗口侧，你在场即时反馈）；
中枢的通知出口是「你离场时」的 Bark。要手机推送就在配置里加 `"bark"`。

### Hub（中枢）

`hub.ingestPath`（默认 `/ingest`）、`hub.personaThrottleMs`（默认 15s，每窗口复命节流）。
三张表落盘 `~/.majordomo/hub-*.json`，加载时自动淘汰陈旧死数据（offline 窗口 / done 待办 / resolved 验收超 7 天）。

### Worker 引擎（可选旧路径）

| engine | 作用 |
|---|---|
| `auto` | 优先 `@anthropic-ai/claude-agent-sdk` 常驻会话；没有 SDK 则 mock |
| `sdk` | 强制走 TypeScript Agent SDK 常驻会话 |
| `mock` | 回显引擎，无需凭证，用于验收链路 |

自建工作层已退役为可选，主路径是旁观原生窗口。保留它是为了 TUI 仍可直接驱动一个会话验收 core→persona→notify 链。

### Profiles（claude / claude-internal / tclaude 一键切换）

| profile | 命令 | 个人规则目录 |
|---|---|---|
| claude | `claude` | `~/.claude` |
| internal | `claude-internal` | `~/.claude-internal`（**注意不是 `.claude`**） |
| tclaude | `tclaude` | `~/.tclaude` |

切换只影响新开会话，已跑的会话绑死启动时的 profile。

```bash
node dist/cli.js config
node dist/cli.js profile internal
node dist/cli.js doctor
```

## 使用指南 & 验收

- 新手上手（图文）：[`docs/guide/quickstart.html`](docs/guide/quickstart.html) —— 装中枢、装插件、日常怎么用。
- 保姆级验收步骤 + 回归要点：[`docs/acceptance/index.html`](docs/acceptance/index.html)。
- 中枢 v1 专项验收：[`docs/acceptance/2026-07-02-hub-v1-acceptance.html`](docs/acceptance/2026-07-02-hub-v1-acceptance.html)。

```bash
npm run build
npm run doctor
npm run selftest
```

Web 面板启动后有 `GET /healthz` / `GET /readyz` 可做健康检查，不泄露本机绝对路径。

## Status

✅ **Hub v1 可交付自用**。完整闭环已实测跑通：**窗口 → Bifrost → 中枢 → 三张表 → persona 复命 → 面板/Bark**。
`build` / `selftest` 全绿，真窗口端到端已验收（见 `docs/acceptance`）。
可选旧路径（SdkWorker / TUI 驱动单会话）仍完整编译可用。

> ⚠️ **上服务器前必做**：v1 只在 localhost 无鉴权，`/ingest` 一旦暴露到公网必须加 token（否则谁都能往你待办灌数据）。本地自用无碍。

## Roadmap

- [x] core daemon + WebSocket + 多前端（终端 / 网页看同一份状态）
- [x] Bifrost 插件：探针实测六事件 payload → 正式 `report.ps1` 上报
- [x] 中枢三张表（窗口注册表 / 全局 TODO / 待验收），JSON 落盘 + 陈旧淘汰
- [x] persona 跨窗口复命（每窗口节流）+ Bark 手机推送
- [x] Web 交接浮窗（Edge app 常驻置顶，persona 富文本全显示）
- [x] 通知职责划分：本机弹窗归 Bifrost，Bark 归中枢
- [x] doctor / selftest 可验收命令
- [ ] 面板反向能力：从网页/手机插话或查岗任一窗口（v1 只读）
- [ ] 服务器场景：中枢跑无桌面服务器 + 窗口在别处（stale 判定改用中枢收到时刻）
- [ ] 立绘 / CG（Web 面板已留位）
- [ ] 服务器窗口直达（托管 pty + 网页终端，重路径，待拍板）

可选/退役：

- [x] worker：mock + 常驻 SDK（`session_id + resume` 崩溃恢复）
- [x] SDK 原生 `canUseTool` 权限 UI（旧调度器形态）

## License

AGPL-3.0
