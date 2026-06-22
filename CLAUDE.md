# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **majordomo 自举**：本项目用 majordomo 开发自己。说话风格由 `.majordomo/persona.md` 管理人设层；日记/通知由 hook 系统自动触发。本文档 = 行为规则 + 代码架构。

## Behavior Rules

以下规则由工作层（Claude Code SDK）直接读取，控制"什么可以自己做、什么必须先问"。

### Just Do It（操作类任务，直接动手）

- 凌乱的临时文件、混乱的目录
- 文档落后于代码、验收文档需要维护
- 缺失的 import、明显的拼写/格式错误
- 编辑代码后可选择性跑 build（忽略 exit code 6）
- 大改动后扫描一次同级/模板相似文件是否需要同步修改
- 日记和通知由 hook 系统自动处理，**无需手动调用**

### Must Ask First（思考类任务，必须先问）

- 需求不明确、目标模糊
- 发明新概念或不在 spec 中的命名
- 重命名/删除文件、修改核心系统、添加新依赖、改变公共 API
- 架构取舍

### Long-Task Mode

当主人说"长任务"、"take your time"、"I'll be back later"：
- 假设主人至少离开 30 分钟，不中途暂停提问
- 卡住：加日志 → 搜索 → 尝试替代方案 → 3 次失败后停止
- 完成后交付完整交接报告

### Don't Be Over-Eager

- **不要主动同步规则文件**之间
- 不要自说自话重构或统一代码风格
- 不要替主人发明新名字

## Common Commands

```bash
npm run build      # tsc + copy web assets (scripts/copy-assets.js)
npm run dev        # tsc --watch
npm run doctor     # env diagnostics (Node, SDK, profiles, config, notify script)
npm run selftest   # end-to-end self-test (mock worker + WebSocket + permission flow)
npm start          # = node dist/cli.js (default: embedded daemon + TUI)
npm run daemon     # foreground core daemon
npm run web        # start web panel
```

No test suite or linter yet. After editing TypeScript, run `npm run build` to verify compilation (exit code 6 is normal — don't retry).

## Architecture

Three layers, all communicating over **WebSocket via structured JSON** (`src/protocol/messages.ts`):

### 1. Core Daemon (`src/core/`)
Long-lived process (`src/core/daemon.ts`) holding session pool, persona engine, notifier bus, and config. Exposes a single WebSocket server that TUI, Web, and future remote clients all connect to — same state for everyone.

**Session lifecycle** (`src/core/session.ts`):
```
user_input → Worker.send() → stream WorkerEvent("text") → broadcast worker_message
                          → WorkerEvent("permission") → broadcast permission_request → await human
                          → WorkerEvent("done") → Persona.report(workerText) → broadcast persona_message
                          → HookRunner.fire("after_task") → configured hooks (diary, notify, shell, report...)
```

`SessionManager` (`src/core/sessionManager.ts`) creates/resumes/closes sessions. Sessions bind to a profile at creation and never switch; `activeProfile` changes only affect new sessions.

`Store` (`src/core/store.ts`) persists sessions as `~/.majordomo/sessions.json` and history as per-session `.jsonl` files. JSON, not SQLite — avoids Windows native module compilation.

### 2. Worker Layer (`src/worker/`)
`WorkerEngine` (abstract, `src/worker/types.ts`) — one instance per session.

| Engine | File | When used |
|--------|------|-----------|
| `SdkWorker` | `src/worker/sdkWorker.ts` | `@anthropic-ai/claude-agent-sdk` available. Streaming input via `AsyncIterable<SDKUserMessage>` queue — single persistent session, multi-turn via queue pushes. `--resume` only as crash recovery. |
| `MockWorker` | `src/worker/mockWorker.ts` | SDK unavailable — echoes input, auto-approves permissions. |

Engine selection: `auto` → SDK if resolvable else mock; `sdk` → SDK or mock fallback; `mock` → always mock. `src/worker/factory.ts`.

### 3. Persona Layer (`src/persona/`)
`PersonaEngine` interface (`src/persona/types.ts`): reads worker output → reports in human language. No agent capability. Two implementations:
- `ApiPersona` (`src/persona/apiPersona.ts`): OpenAI-compatible or Anthropic Messages API (key via `PERSONA_API_*` env vars)
- `TemplatePersona` (`src/persona/templatePersona.ts`): offline template, no key needed

### Frontends
- **TUI** (`src/tui/client.ts`): readline-based interactive client. `/new`, `/sessions`, `/resume <id>`, `/profile <name>`, `/compact`, `/model`. Permission prompts inline (y/n for tools, numbered selection for AskUserQuestion).
- **Web** (`src/web/server.ts`): static file server over `src/web/public/`, injects daemon's WebSocket URL via `{{WS_URL}}` placeholder in HTML, healthz endpoints at `/healthz` and `/readyz`.

### Notify (`src/notify/`)
Pluggable notifier chain: `PowershellNotifier` (sound/toast/TTS via notify-done.ps1) + `ConsoleNotifier` (cross-platform fallback). Diary written in Node via `src/core/diary.ts`.

## Key Design Decisions

- **Config layer** (`src/core/config.ts`): JSONC with comments support, custom parser. Merge order (low→high priority): `~/.majordomo/config.jsonc` → `./config.jsonc` → `./.majordomo/config.jsonc`. `activeProfile` persisted to global config. `.majordomo/persona.md` loaded into persona engine.
- **Profiles** (claude/internal/tclaude): Bind at session creation. Internal profile key gotcha: personal dir is `~/.claude-internal`, NOT `~/.claude`.
- **permissionMode**: `"auto"` by default — Claude Code's model classifier decides; `canUseTool` callback forwards unresolved cases to frontend for human approval.
- **No CLI fallback** for worker layer. If SDK is unavailable, falls back to mock only. Mock exists solely to validate the core→TUI/Web→persona→notifier chain without credentials.
- **`MAJORDOMO_HOME`** env var can override `~/.majordomo/` storage directory (used by selftest for isolation).
- **TypeScript strict mode** enabled. Target ES2021, CommonJS modules.
- **Hook system** (`src/hooks/`): Diary and notify are no longer hardcoded in daemon. Configurable via `hooks` in config. Built-in types: `diary`, `notify`, `shell` (runs commands with `MJ_*` env vars), `markdown_report`. Events: `after_task`, `on_session_create`, `on_session_close`, `on_error`. Project config in `.majordomo/config.jsonc`.

## Key Files

| File | Role |
|------|------|
| `src/cli.ts` | Commander CLI entry point |
| `src/core/daemon.ts` | WebSocket server, client dispatch |
| `src/core/session.ts` | Single conversation lifecycle |
| `src/core/sessionManager.ts` | Session pool CRUD |
| `src/core/config.ts` | JSONC config loader + validator |
| `src/core/store.ts` | JSON file persistence |
| `src/protocol/messages.ts` | All Client↔Server message types |
| `src/worker/sdkWorker.ts` | Claude Agent SDK integration |
| `src/worker/factory.ts` | Engine auto-selection |
| `src/tui/client.ts` | Readline TUI client |
| `src/web/server.ts` | Web panel static server |
| `src/persona/factory.ts` | Persona auto-selection (API vs template) |
| `src/hooks/types.ts` | Hook interfaces and config types |
| `src/hooks/hookRunner.ts` | Hook orchestration with defaults |
| `src/hooks/factory.ts` | Dependency-injected hook factory |
| `src/hooks/builtin/shellHook.ts` | Shell command hook (UE compile etc.) |
| `src/hooks/builtin/markdownReportHook.ts` | Markdown report generation |
