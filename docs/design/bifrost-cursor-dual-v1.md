# Bifrost 双端（Claude Code + Cursor）v1

> 承接 `bifrost-hub-v1.md`。中枢协议（`POST /ingest`、§2.5 载荷）不变；本篇只解决：**同一 `bifrost/` 目录既能给 Claude Code `--plugin-dir` 用，也能给 Cursor `agent --plugin-dir` 用，且脚本不复制。**

## 0. 目标与非目标

**目标**

- 装法同构：
  - `claude --dangerously-skip-permissions --plugin-dir D:/GitRep/majordomo/bifrost`
  - `agent --force --plugin-dir D:/GitRep/majordomo/bifrost`
- **壳双开、肉单开**：两份清单 + 两份 hooks 声明；一份 `report.ps1` + 共用 notify / config。
- 上报仍走中枢 §2.5 信封；本地弹窗/提示音行为与 CC 侧一致（`stop` → full notify）。

**非目标**

- 不做 Cursor 市场发布、不做 IDE 聊天区换皮。
- 不强行伪造 Cursor 没有的 CC 事件（`Notification` / `TaskCreated` / `TaskCompleted`）的完整语义。
- 不改中枢 ingest 协议、不拆第二套 report 脚本。

## 1. 为什么不能「一份 hooks.json」

| | Claude Code | Cursor |
|---|---|---|
| 清单目录 | `.claude-plugin/plugin.json` | `.cursor-plugin/plugin.json` |
| hooks 文件形状 | 嵌套 `{ hooks: [ { type, command } ] }` | 扁平 `{ version, hooks: [ { command } ] }` |
| 根变量 | `${CLAUDE_PLUGIN_ROOT}` | `${CURSOR_PLUGIN_ROOT}`（亦认 CLAUDE 名） |
| 默认 hooks 路径 | `hooks/hooks.json` | `hooks/hooks.json` |

两边都会默认找 `hooks/hooks.json`，但 **schema 互不兼容**。因此 Cursor 清单必须显式指到另一文件，避免抢 CC 那份。

## 2. 目录形态（拍板）

```
bifrost/
├── .claude-plugin/plugin.json     # CC（已有）
├── .cursor-plugin/plugin.json     # Cursor；"hooks": "hooks/cursor-hooks.json"
├── hooks/
│   ├── hooks.json                 # CC 事件声明（现有，格式不动）
│   └── cursor-hooks.json          # Cursor 事件声明（新建）
├── scripts/report.ps1             # 唯一上报核心：归一化两套 stdin → §2.5
├── scripts/notify-*.ps1           # 共用
├── scripts/bifrost-statusline.ps1 # 共用（CC settings / Cursor CLI statusLine）
└── report.config.jsonc            # 共用
```

重复只允许出现在「事件名 → 调同一条 powershell 命令」的 JSON 行；业务逻辑只在 `report.ps1`。

## 3. 事件映射

中枢只认归一后的 `event` 字符串（`session_start` / `stop` / …）。脚本内做名称别名。

| 中枢 event | Claude Code hook | Cursor hook | 备注 |
|---|---|---|---|
| `session_start` | `SessionStart` | `sessionStart` | Cursor：`session_id`；cwd 取 `cwd` 或 `workspace_roots[0]` |
| `session_end` | `SessionEnd` | `sessionEnd` | Cursor：`reason` / `final_status` |
| `stop` | `Stop`（带 `last_assistant_message`） | **`afterAgentResponse`**（带 `text`） | ⚠️ Cursor 的 `stop` **不带全文**，不能当主路径 |
| `user_prompt` | `UserPromptSubmit` | `beforeSubmitPrompt` | 字段均为 `prompt` |
| `notification` | `Notification` / `PreToolUse(AskUserQuestion)` | `preToolUse`（matcher 尽量对齐 AskUserQuestion；无则静默跳过） | Cursor 无 1:1 Notification |
| `task_created` / `task_completed` | `TaskCreated` / `TaskCompleted` | （v1 不挂） | 无对等原生事件；`subagent*` 语义不同，推迟 |

### 3.1 为何 Cursor 用 `afterAgentResponse` 而不是 `stop`

Cursor 文档：

- `afterAgentResponse`：`{ text: "<assistant final text>" }` —— 有全文。
- `stop`：`{ status, loop_count }` —— 无全文。

CC 的 `Stop` = 回合结束 + 全文。Cursor 侧用 `afterAgentResponse` 对齐「带全文的 stop 上报 + 本地弹窗」。  
v1 **不**再挂 Cursor `stop`，避免与 `afterAgentResponse` 双响弹窗。若实测发现每回合多次 `afterAgentResponse`（工具间穿插），再加节流或改挂 `stop`+读 transcript；先探针、后改。

### 3.2 Cursor Windows：正文不信 stdin，信 transcript

Cursor 在非 UTF-8 系统代码页（中文 GBK）下，hook **stdin 写入前**就会弄坏非 ASCII（官方确认的 bug）。GBK「反解」修复是有损的（如「看」→`�?`），不能当主路径。

**定路**：`report.ps1` 对 `Stop` / `UserPromptSubmit` **优先从 `transcript_path` JSONL（盘上 UTF-8）取正文**；stdin 的 `text`/`prompt` 仅作无 transcript 时的回退。中枢对乱码/空 `text` 再兜一层读 transcript。ASCII 字段（路径、id）stdin 仍可用。

### 3.2 windowId / cwd

| 字段 | CC | Cursor |
|---|---|---|
| `windowId` | `session_id` | `session_id` ?? `conversation_id` |
| `cwd` | `cwd` | `cwd` ?? `workspace_roots[0]` |

## 4. `report.ps1` 归一化（唯一改动面）

入口顺序：

1. UTF-8 读 stdin（已有）。
2. 插件根：`CURSOR_PLUGIN_ROOT` → `CLAUDE_PLUGIN_ROOT` → `scripts/` 父目录。
3. 读 `hook_event_name`；按下表别名进现有 `switch`（或先 normalize 再 switch）：
   - `sessionStart` → `SessionStart`
   - `sessionEnd` → `SessionEnd`
   - `afterAgentResponse` → 视同 `Stop`，文本取 `text`（兼认 `last_assistant_message`）
   - `beforeSubmitPrompt` → `UserPromptSubmit`
   - `preToolUse` → `PreToolUse`（保留 AskUserQuestion 过滤）
4. 其余 POST / 离线缓存 / 弹窗 / status.json —— **不动**。

未知事件仍 `exit 0`（或 raw forward），永不挡窗口。

## 5. Cursor 清单与 hooks 样例

`.cursor-plugin/plugin.json`：

```json
{
  "name": "bifrost",
  "version": "0.2.0",
  "description": "虹桥：hook 上报中枢 /ingest + 本地提示。Claude Code 与 Cursor 共用脚本。",
  "hooks": "hooks/cursor-hooks.json"
}
```

`hooks/cursor-hooks.json`（示意）：

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"${CURSOR_PLUGIN_ROOT}/scripts/report.ps1\"" }],
    "sessionEnd": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"${CURSOR_PLUGIN_ROOT}/scripts/report.ps1\"" }],
    "afterAgentResponse": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"${CURSOR_PLUGIN_ROOT}/scripts/report.ps1\"" }],
    "beforeSubmitPrompt": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"${CURSOR_PLUGIN_ROOT}/scripts/report.ps1\"" }],
    "preToolUse": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"${CURSOR_PLUGIN_ROOT}/scripts/report.ps1\"", "matcher": "AskUserQuestion" }]
  }
}
```

CC 侧 `hooks/hooks.json` 保持 `${CLAUDE_PLUGIN_ROOT}`，不改为 Cursor 变量。

## 6. 装法（实测修订）

> **2026-07-12 实测**：`agent --plugin-dir …` **当前不会真正加载插件 hooks**（CLI 跑完 `status.json` hue 不变；日志仍是 `loadUserLocalPlugins … 0 plugins loaded`）。论坛亦有「CLI 插件未就绪 / 与 IDE 不对齐」记录。软链进 `~/.cursor/plugins/local` 也会被拒（symlink target outside local）。

| 场景 | 做法 | 状态 |
|---|---|---|
| Claude Code（首选） | `claude --dangerously-skip-permissions --plugin-dir <repo>/bifrost` | ✅ 可用 |
| **Cursor（现行可靠）** | 用户级 `~/.cursor/hooks.json`，`command` **绝对路径**指向同一份 `scripts/report.ps1` | ✅ 已验证路径 |
| Cursor 项目级备选 | `<repo>/.cursor/hooks.json` 同样指绝对路径（仅该仓） | 可用 |
| Cursor `agent --plugin-dir` | 文档有旗标，**现状不吃 bifrost** | ❌ 暂不可用 |
| Cursor `plugins/local` 软链 | 外仓 symlink/junction 会被拒 | ❌ 勿用 |
| Cursor `plugins/local` 实拷贝 | 拷贝整目录可被 IDE 发现，开发期易漂 | 备选 |
| Cursor statusline | `~/.cursor/cli-config.json` → `bifrost-statusline.ps1` | 与 CC 同脚本 |

**为何问「你有没有 bifrost」会得到「没有」**：虹桥 v1 几乎只有 hooks，没有 skill/rule 注册进 agent 可见列表；即便 hooks 已挂上，agent 枚举「已装插件」也看不到它。验收看中枢 `/ingest` 或 `bifrost/cache/status.json` 的 `hue` 是否递增，不要问模型自我介绍。

### 6.1 用户级 hooks 样例

`~/.cursor/hooks.json`（路径按本机改）：

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/GitRep/majordomo/bifrost/scripts/report.ps1\"" }],
    "sessionEnd": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/GitRep/majordomo/bifrost/scripts/report.ps1\"" }],
    "afterAgentResponse": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/GitRep/majordomo/bifrost/scripts/report.ps1\"" }],
    "beforeSubmitPrompt": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/GitRep/majordomo/bifrost/scripts/report.ps1\"" }],
    "preToolUse": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/GitRep/majordomo/bifrost/scripts/report.ps1\"", "matcher": "AskUserQuestion" }]
  }
}
```

改完 hooks.json 后新开 agent 窗口（或等 Cursor 热载）。仍是**同一份** `report.ps1`，零脚本复制。

## 7. 施工阶段

1. **设计文档**（本文）落地。
2. **壳**：`.cursor-plugin/plugin.json` + `hooks/cursor-hooks.json`；CC 清单 version bump 说明双端。
3. **肉**：`report.ps1` 双端 stdin / 根路径 / 事件别名。
4. **说明**：`bifrost/README.md` 写清双装法；`bifrost-hub-v1.md` 加一句指针。
5. **Cursor 现行装法**：改为用户级 hooks（§6）；纠正 `--plugin-dir` 预期。

验收：

- CC 原命令仍上报 /ingest + Stop 弹窗。
- Cursor：配置用户级 hooks 后跑一轮，中枢收到 `session_start` / `stop`（来自 afterAgentResponse），或 `cache/status.json` hue 递增。
- 无第二份 report 脚本；notify 与 config 仍单份。

## 8. 风险与后续

| 风险 | 处理 |
|---|---|
| `afterAgentResponse` 每回合多次触发 → 弹窗吵 | 探针 dump；必要时改挂 `stop` 或加简单去抖 |
| Cursor `preToolUse` 无 AskUserQuestion | matcher 不命中即不报，可接受 |
| `agent --plugin-dir` 名存实亡 | 现行走用户级 hooks；旗标恢复后再切回 |
| 外仓 symlink 进 `plugins/local` 被拒 | 勿软链；要插件面板可见再实拷贝 |
| Cursor hooks 字段漂移 | 与 CC 当年一样：必要时用 probe 追加 dump |

后续可做：Cursor 探针模式、`subagentStop` → task 近似、等 CLI `--plugin-dir` 真正可用后再把装法收敛回单命令。
