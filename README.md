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

### Worker 引擎

| engine | 作用 |
|---|---|
| `auto` | 优先 `@anthropic-ai/claude-code` SDK；没有 SDK 则走 profile CLI；再没有就 mock |
| `sdk` | 强制走 TypeScript SDK（需自行 `npm install @anthropic-ai/claude-code`） |
| `cli` | 强制走 profile.command 的 Claude Code CLI |
| `claude` | `cli` 的兼容别名 |
| `mock` | 回显引擎，无需任何凭证，用于验收整条链路 |

支持 `maxTurns`、`timeoutMs`、`allowedTools`、`disallowedTools`。`permissionMode: "auto"` 在 MCP 权限桥接完成前会按更保守的 `default` 处理；如果明确想自动接受编辑类操作，可设为 `acceptEdits`。

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

公开资料显示 TypeScript SDK 包名是 `@anthropic-ai/claude-code`，主 API 是 `query()` async iterator；当前公开文档没有稳定的 `ClaudeSDKClient/canUseTool`。因此 v0.1 的真实工作层做成两级：

1. 可选 SDK Worker：安装 SDK 后 `auto` 优先使用 `query()`。
2. CLI fallback：用 `claude -p --output-format stream-json --resume <session_id>`，prompt 走 stdin，避免命令行注入。

SDK 做成可选依赖是工程防御：公共 API 仍在变化、权限桥接尚未落稳，而且项目要在没装 SDK 的机器上也能完成主链路验收。这不是为了支持 codex；当前产品边界仍是 Claude Code 调度器，`WorkerEngine` 只是隔离工作层实现。

真正的交互式权限确认后续应走 Claude Code 文档里的 `--permission-prompt-tool` + MCP 桥接，而不是假设存在未公开的 `canUseTool`。

## 验收

打开 [`docs/acceptance/index.html`](docs/acceptance/index.html)，保姆级步骤 + 回归测试要点。

```bash
npm run build
npm run doctor
npm run selftest
```

Web 面板启动后也有 `GET /healthz` 可做健康检查；返回 `web/assets/daemonWs` 三段状态，不泄露本机绝对路径。

## Status

🚧 v0.2 WIP。核心链路已跑通（TUI / Web / 会话池 / profile / 通知 / 日记 / mock + SDK/CLI 工作层）。
未做：MCP permission-prompt-tool 桥接、文档层、立绘渲染、远程接入（架构口子已留）。

## Roadmap

- [x] core daemon + 会话池 + session_id 持久化
- [x] worker：mock + SDK 可选接入 + CLI fallback（`--resume` 续接）
- [x] 最小 TUI 跑通主链路（你输入 → 工作层 → 人设层汇报）
- [x] Web 面板（会话列表 / 历史 / profile 切换 / healthz）
- [x] 人设层（API + 离线模板）+ notifier（PowerShell / console）+ 日记
- [x] doctor / selftest 可验收命令
- [ ] MCP permission-prompt-tool 桥接真实权限 UI
- [ ] 文档层（另开 session 写验收文档）
- [ ] 立绘 / CG
- [ ] 远程接入（Cloudflare Access / 推手机）

## License

AGPL-3.0
