# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **majordomo 自举**：本项目用 majordomo 开发自己。行为规则 → `.majordomo/rules.md`（SDK systemPrompt 注入）；说话风格 → `.majordomo/persona.md`（人设层读取）；日记/通知 → hook 系统自动触发。本文档只含代码架构。

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
Pluggable notifier chain: `PowershellNotifier` (sound/toast/TTS via notify-done.ps1) + `ConsoleNotifier` (cross-platform fallback) + `BarkNotifier` (phone push, needs `bark` config). Diary written in Node via `src/core/diary.ts`.

### Hub (`src/hub/`) — 接收 Bifrost 上报的中枢
v1：接收原生 CC 窗口经 **Bifrost 插件**（`bifrost/`）上报的 hook 事件，维护三张表，逐窗口 persona 复命。见 `docs/design/bifrost-hub-v1.md`。

- `HubService` (`src/hub/hub.ts`): `ingest(envelope)` → 按 event 更新三张表 → WebSocket 广播 + persona 复命（每窗口 `personaThrottleMs` 节流）。
- 三张表 (`src/hub/stores.ts`, JSON 落盘 `~/.majordomo/hub-*.json`): `WindowRegistry`（每窗口在做什么，state 由事件推导）/ `TodoStore`（全局待办，`task_created/completed` 走 taskId **确定性**增删，不烧 LLM）/ `AcceptanceStore`（待验收，`notification` 触发）。
- 入口：daemon 的 HTTP server 上 **`POST /ingest`**，与 WebSocket **共用端口 4350**（避开 WXWork 占的 4317）。Bifrost `report.config.jsonc` 的 `ingestUrl` 必须与此一致。
- 数据单向：窗口 → Bifrost → 中枢 → 你。v1 面板只读（展示三张表 + 勾/删待办、标记验收），不向窗口回话。

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
| `src/hub/hub.ts` | 中枢核心：ingest → 三张表 → 复命/广播 |
| `src/hub/stores.ts` | WindowRegistry / TodoStore / AcceptanceStore（JSON 落盘）|
| `src/hub/types.ts` | 上报载荷 + 三张表数据模型 |
| `src/notify/barkNotifier.ts` | Bark 手机推送 |
| `bifrost/scripts/report.ps1` | 窗口侧上报脚本（hook → POST /ingest + 本地弹窗）|
