# majordomo（代号：指挥官）

> A persona-driven, multi-session orchestrator for Claude Code.
> 一个有人设前端的 Claude Code 多会话调度器。

工作层无头干活，人设层用人话向你汇报，前端有 TUI + 带立绘位的 Web 面板。
core daemon + 客户端分离，WebSocket 通信，为远程接入预留口子。

## 设计要点

- **工作层（手）**：Claude Code SDK / CLI / mock 三种引擎，连续 session，`session_id + --resume` 续接。
- **人设层（嘴）**：便宜模型 API / 离线模板，读工作层输出后用人话汇报，负责日记 / 通知。
- **前端**：TUI（任意终端一条命令）+ Web 面板（会话管理 / profile 切换 / 立绘位）。
- **开箱即跑**：没装 claude、没配 API key 也能跑通整条链路（自动降级 mock + 模板）。

详见 [`docs/architecture.md`](docs/architecture.md)，设计脉络见 [`docs/design/main-mind.md`](docs/design/main-mind.md)。

## 快速开始

```bash
npm install
npm run build
npm run doctor
npm run selftest

# 进入 TUI（默认命令；内嵌 daemon + 进入交互）
node dist/cli.js

# Web 面板
node dist/cli.js web

# 前台运行 core daemon（长驻，供多个客户端连接）
node dist/cli.js daemon
```

全局安装后可用 `commander` / `majordomo` 在任意目录唤起（对标 `claude`）：

```bash
npm install -g .
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

### Worker 引擎


| engine | 作用 |
|---|---|
| `auto` | 优先 `@anthropic-ai/claude-agent-sdk` 常驻会话；没有 SDK 则 mock |
| `sdk` | 强制走 TypeScript Agent SDK 常驻会话 |
| `mock` | 回显引擎，无需任何凭证，用于验收整条链路 |

支持 `maxTurns`、`timeoutMs`、`allowedTools`、`disallowedTools`。默认 `permissionMode: "auto"`，沿用 Claude Code 的 auto 分类器；需要人工介入时由 `canUseTool` 回调转发到 TUI / Web 权限确认。`acceptEdits` 仍可作为可选模式。

### Profiles（claude / claude-internal / tclaude 一键切换）

| profile | 命令 | 个人规则目录 |
|---|---|---|
| home | `claude` | `~/.claude` |
| internal | `claude-internal` | `~/.claude-internal`（**注意不是 `.claude`**） |
| tclaude | `tclaude` | `~/.tclaude` |

切换只影响新开会话，已跑的会话绑死启动时的 profile。

```bash
node dist/cli.js config
node dist/cli.js profile internal
node dist/cli.js doctor
```

## 网络调研后的 Claude Code 接入结论

正式 TypeScript Agent SDK 包名是 `@anthropic-ai/claude-agent-sdk`。主路径使用 `query({ prompt: AsyncIterable<SDKUserMessage> })` 的 streaming input 模式：每个 `SdkWorker` 持有一个常驻会话，多轮输入进入同一底层 session。

1. SDK Worker：`auto` 优先使用常驻 Agent SDK，会保存 `session_id`；`/compact`、`/model` 作为普通输入透传给同一个 session。
2. 不保留 CLI fallback：主要工作流必须修好常驻 SDK；SDK 不可用时只降级到 mock，用于验收 core / TUI / Web / persona / notifier 主链路。

真实权限 UI 走 SDK 原生 `canUseTool` 回调：默认 `permissionMode: "auto"`，分类器无法自动处理时才转给前端确认。

## 验收

打开 [`docs/acceptance/index.html`](docs/acceptance/index.html)，保姆级步骤 + 回归测试要点。

```bash
npm run build
npm run doctor
npm run selftest
```

Web 面板启动后也有 `GET /healthz` 可做健康检查；返回 `web/assets/daemonWs` 三段状态，不泄露本机绝对路径。

## Status

🚧 v0.2 WIP。核心链路已跑通（TUI / Web / 会话池 / profile / 通知 / 日记 / mock + 常驻 SDK 工作层）。
未做：文档层、立绘渲染、远程接入（架构口子已留）。

## Roadmap

- [x] core daemon + 会话池 + session_id 持久化
- [x] worker：mock + 常驻 SDK（`session_id + resume` 崩溃恢复）
- [x] 最小 TUI 跑通主链路（你输入 → 工作层 → 人设层汇报）
- [x] Web 面板（会话列表 / 历史 / profile 切换 / healthz）
- [x] 人设层（API + 离线模板）+ notifier（PowerShell / console）+ 日记
- [x] doctor / selftest 可验收命令
- [x] SDK 原生 `canUseTool` 权限 UI
- [ ] 文档层（另开 session 写验收文档）
- [ ] 立绘 / CG
- [ ] 远程接入（Cloudflare Access / 推手机）

## License

AGPL-3.0
