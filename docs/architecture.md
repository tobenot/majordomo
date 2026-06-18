# majordomo 架构

> 代号「指挥官」。一个有人设前端的 Claude Code 多会话调度器。
> 设计来源见 `docs/design/main-mind.md`，本文是落地后的架构说明。

## 核心思路

不包真实 TUI、不做屏幕抓取。工作层（Claude Code）全程无头，吐结构化数据；
指挥官站在你和工作层之间，是一个有状态的中间人，自己拥有前端（TUI / Web）。

三层分工：

- **人设层（嘴）**：便宜模型 / 离线模板。读工作层输出，用人话向你汇报，负责日记 / 通知。无 agent 能力。
- **工作层（手）**：Claude Code，连续 session，干活。
- **文档层**：按需另开独立 session（后续迭代，写图形化验收文档）。

core 与前端从第一天就分离：core 是长驻 daemon，TUI / Web / 未来远程都是它的客户端，
通过 WebSocket 连同一份状态。这让「远程接入 / 推手机 / 公告板」成为自然延伸，而非重写。

## 模块图

```mermaid
graph TD
  subgraph Clients["前端（core 的客户端，看同一份状态）"]
    TUI["TUI 客户端<br/>readline 交互"]
    WEB["Web 面板<br/>会话列表 / 对话 / profile / 立绘位"]
    REMOTE["未来：远程 / 手机"]
  end

  subgraph Core["指挥官 core daemon（长驻）"]
    WS["WebSocket 服务<br/>协议分发"]
    SM["SessionManager<br/>会话池 / 创建 / 续接"]
    SESS["Session<br/>单会话生命周期编排"]
    STORE["Store<br/>会话元信息 + 历史持久化"]
    CFG["Config + Profile<br/>claude/internal/tclaude 切换"]
  end

  subgraph Worker["工作层（每会话一个）"]
    MOCK["MockWorker<br/>回显，开箱即跑"]
    SDK["SdkWorker<br/>@anthropic-ai/claude-code query()"]
    CC["ClaudeCodeWorker<br/>CLI fallback，--resume 续接"]
  end

  subgraph Persona["人设层（嘴）"]
    API["ApiPersona<br/>OpenAI 兼容接口"]
    TPL["TemplatePersona<br/>离线模板降级"]
  end

  subgraph Notify["可插拔通知器"]
    PS["PowershellNotifier<br/>提示音/浮窗/TTS"]
    CON["ConsoleNotifier<br/>跨平台降级"]
    DIARY["Diary<br/>Node 原生增量日记"]
  end

  TUI <-->|JSON 消息| WS
  WEB <-->|JSON 消息| WS
  REMOTE -.未来.-> WS

  WS --> SM
  SM --> SESS
  SM --> STORE
  SM --> CFG
  SESS --> Worker
  SESS --> Persona
  SESS -->|persona 汇报完成| Notify
```

## 一轮对话的数据流

```mermaid
sequenceDiagram
  participant U as 你（前端）
  participant C as core / Session
  participant W as 工作层
  participant P as 人设层
  participant N as 通知 + 日记

  U->>C: user_input
  C->>W: worker.send（prompt 走 stdin）
  W-->>C: 流式 text 事件（结构化）
  C-->>U: worker_message（原始，可看）
  opt 高危操作
    W-->>C: permission（请求批准）
    C-->>U: permission_request
    U->>C: permission_response (y/n)
    C->>W: resolvePermission
  end
  W-->>C: done（回合结束）
  C->>P: report(userText, workerText)
  P-->>C: 人话汇报（人设口吻）
  C-->>U: persona_message
  C->>N: notify + 增量日记
```

## 关键设计取舍

- **Claude Code 接入以公开文档为准**：网络调研确认 TS SDK 包是 `@anthropic-ai/claude-code`，主 API 是 `query()` async iterator；公开文档没有稳定 `ClaudeSDKClient/canUseTool`。
- **SDK 是可选依赖，不是硬依赖**：原因是 SDK 公共 API 仍在变化、权限桥接尚未落稳，而 CLI 是当前更可预期的真实工作层兜底。项目需要在未安装 SDK、未安装 Claude CLI 的机器上也能跑通 TUI / Web / 会话 / 人设 / 通知主链路，所以采用 `SDK -> CLI -> mock` 的防御式降级。
- **这不是为了支持 codex**：当前产品边界仍是 Claude Code 调度器。`WorkerEngine` 抽象只是在工程上隔离工作层实现，未来如果要接其他 agent 后端可以扩展，但不是这次 SDK 可选化的设计动机。
- **工作层三段降级**：`auto` 优先 SDK；没有 SDK 就走 profile CLI；没有 CLI 就 mock，保证开箱即跑。
- **工作层会话模型 = 常驻优先**（核心决策）：SDK Worker 用 streaming input 模式的 `query()`，传入一个受控 `AsyncIterable` 队列，进程全程不退、上下文在内存。这才是灵感文档说的"真连续"。`session_id` 仍持久化，但 `--resume` 退化为**崩溃恢复兜底**，不是日常每轮手段。CLI `-p` fallback 是无状态一次性兜底，明确不支持 compact / 交互权限。
- **`/compact` `/model` 透传在常驻 SDK 下天然生效**：作为普通用户消息喂进活着的 session 即可（SDK 官方支持 slash command 作为输入）；compact 返回 `SDKCompactBoundaryMessage`，Session 据此告知人设层。Auto-Compact 默认开启，多数时候无需手动。
- **安全启动**：CLI prompt 走 stdin，不把用户文本拼进命令行；Windows 下优先 `shell=false`，仅 `.cmd/.bat` shim 走 `cmd.exe /d /s /c` fallback。
- **自测与诊断**：`doctor` 检查 Node / SDK / profile 命令 / Web 资源 / 通知脚本；`selftest` 用临时 `MAJORDOMO_HOME` 隔离端到端验证。
- **权限走 `canUseTool` 真回调**：SDK 官方提供 `CanUseTool` 回调（权限主路径之一）。工具需要权限时回调触发 → Session 转 `permission_request` 给前端 → 用户应答 → resolve `{behavior:'allow'|'deny'}`。默认 `permissionMode: acceptEdits`（编辑自动过）+ `canUseTool` 兜高危；可切 TS 独有的 `auto`（模型分类器）。**不需要 MCP permission-prompt-tool 重桥接**。
- **profile 切换只影响新开会话**：已跑的会话绑死启动时的 profile；`activeProfile` 是用户级偏好，profile 命令写全局配置并覆盖项目示例值。坑：内网版个人目录是 `.claude-internal` 而非 `.claude`。
- **通知可插拔、日记走 Node 原生**：日记是人设层副作用，跨平台（Linux 服务器也能写），不绑死 PowerShell。
- **存储先用 JSON 文件**（`~/.majordomo/`，可用 `MAJORDOMO_HOME` 覆盖）：避开 Windows native 模块编译，协议层不依赖实现，未来可换 SQLite。

## 已知未做（留待后续）

- **工作层常驻化 + `canUseTool` 落地**（最高优先，已定方案见上）：SdkWorker 当前是"每轮新起 `query()` 后退出"的伪连续，需重构为 streaming input 常驻；`resolvePermission` 当前是空实现，需接 `canUseTool` 回调。包名升级到 `@anthropic-ai/claude-agent-sdk`。MockWorker 已演示完整权限 UI 流程，可直接复用前端协议。
- 文档层（另开 session 写验收文档）。
- 立绘 / CG 渲染（Web 面板已留位）。
- 远程接入（CF Access / 推手机 notifier）——通信层已是 WebSocket，留好口子。
