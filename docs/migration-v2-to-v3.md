# 第二代 → 第三代工作流迁移指南

> **第二代**：CLAUDE.md 管一切（行为规则 + 代码架构 + 通知指令），每次回复末尾手动 `write-diary.ps1` + `notify-done.ps1`。
> **第三代**：majordomo 做调度层。CLAUDE.md = 行为规则 + 代码架构（工作层直接读）；说话风格进 `.majordomo/persona.md`（人设层读）；日记/通知由 hook 系统自动触发。

## 核心变化

| 维度 | 第二代 | 第三代 |
|------|--------|--------|
| 行为规则 | `CLAUDE.md`（和架构混在一起） | `CLAUDE.md`（独立 Behavior 段，工作层读取） |
| 说话风格 | `CLAUDE.md` 或全局规则 | `.majordomo/persona.md`（人设层读取） |
| 日记 | 每次手动调 `write-diary.ps1` | `after_task` hook 自动写 |
| 通知 | 每次手动调 `notify-done.ps1` | `after_task` hook 自动弹 |
| 自定义工作流 | 不存在 | `shell` hook / `markdown_report` hook |
| 项目专属配置 | `./config.jsonc` | `./.majordomo/config.jsonc`（优先级更高） |
| 全局人设 | `~/.claude-internal/CLAUDE.md` | `~/.majordomo/config.jsonc` + `~/.majordomo/persona.md` |

## 三层文件各司其职

| 文件 | 谁读 | 放什么 |
|------|------|--------|
| `CLAUDE.md` | SDK Worker（settingSources） | **纯代码架构**（命令、分层、关键文件） |
| `.majordomo/rules.md` | SDK Worker（systemPrompt 注入） | **行为规则**（Just Do It / Must Ask / 长任务模式） |
| `.majordomo/persona.md` | 人设层 API / 模板 | **说话风格**（语气、颜文字、称呼） |
| `.majordomo/config.jsonc` | HookRunner | **工作流触发**（diary/notify/shell/report） |
| `.env` | majordomo 启动 / Persona | **敏感配置**（API key、token、端点地址） |

> **安全边界**：`.majordomo/` 三个文件进 git 仓库（多设备共享），`.env` 不进仓库。敏感信息（PERSONA_API_KEY、PERSONA_API_BASE 等）一律放 `.env`，`.env.example` 作为模板提交。

> **关键设计**：`rules.md` 不放在 CLAUDE.md 里——majordomo 读取后通过 SDK 的 `systemPrompt.append` 注入工作层，和 CLAUDE.md 同等耐久（跨 compaction 不丢），但保持了 CLAUDE.md 的纯粹性。已有长 CLAUDE.md 的项目无需修改——直接创建 `.majordomo/rules.md` 即可，两套行为规则会叠加生效。

## 迁移步骤（一个项目约 5 分钟）

### 第一步：创建 `.majordomo/` 目录

```bash
mkdir -p .majordomo/reports
```

### 第二步：拆分 CLAUDE.md

打开你现有的 `CLAUDE.md`，把内容分成四份：

**留在 CLAUDE.md 的（纯代码架构）：**
- 常用命令（build / test / lint）
- 架构概述、数据流
- 关键设计决策
- 关键文件索引

**移到 `.majordomo/rules.md` 的（行为规则）：**
- "可以直接做" vs "必须先问" 清单
- 长任务模式规则
- "别过度热心"规则

**移到 `.majordomo/persona.md` 的（只有说话风格）：**
- 口吻设定（猫娘 maid / 专业 / 随意）
- 称呼习惯（"主人" / "你" / 无特定称呼）
- 颜文字偏好、喵语习惯
- 汇报格式偏好

**删掉（hook 系统接管了）：**
- `powershell write-diary + notify-done` 手动命令
- "每次回复末尾做 X" 类指令

> **已有长 CLAUDE.md 的项目不需要大改**：可以保留原样不动，只创建 `.majordomo/rules.md` 写行为规则。两套内容会叠加生效。
- 健康提示规则（通常放在全局层）

### 第三步：创建 `.majordomo/config.jsonc`

最小配置，保持和原来一样的行为：

```jsonc
{
  "hooks": {
    "after_task": [
      { "type": "diary" },
      { "type": "notify" }
    ]
  }
}
```

### 第四步：（可选）添加项目专属工作流

```jsonc
{
  "hooks": {
    "after_task": [
      { "type": "diary" },
      { "type": "notify" },
      // 任务完成后自动生成 markdown 汇报
      { "type": "markdown_report", "output_dir": ".majordomo/reports" }
    ],
    "on_error": [
      { "type": "notify" }
    ]
  }
}
```

UE 项目示例：

```jsonc
{
  "hooks": {
    "after_task": [
      { "type": "diary" },
      { "type": "notify" },
      { "type": "shell", "command": "Engine\\Build\\BatchFiles\\Build.bat MyProject Win64 Development", "timeoutMs": 300000 }
    ]
  }
}
```

### 第五步：清理 CLAUDE.md

- 删掉所有 `powershell write-diary + notify-done` 命令（hook 系统自动做了）
- **行为规则留在 CLAUDE.md**，整理成独立的 `## Behavior Rules` 段
- 说话风格/人设指令移到 `.majordomo/persona.md`
- 在顶部注明：`> 本项目用 majordomo 管理。`
- 最终结构：`Behavior Rules → Common Commands → Architecture`

### 第六步：验证

```bash
npm run build        # 确保项目能构建
npm run selftest     # 跑端到端自测
node dist/cli.js doctor  # 环境诊断
```

然后启动 majordomo TUI，随便输入一个任务，确认：
- [ ] 工作层有响应
- [ ] 人设层汇报了
- [ ] 日记写入了（检查 `.codebuddy/memory/`）
- [ ] 通知弹了
- [ ] （如果配了 markdown_report）`.majordomo/reports/` 有文件

## 全局用户层迁移

除了每个项目迁移，还需要把全局规则从 `~/.claude-internal/CLAUDE.md` 迁移到 majordomo。

### 创建 `~/.majordomo/config.jsonc`

```jsonc
{
  "hooks": {
    "after_task": [
      { "type": "diary" },
      { "type": "notify" }
    ]
  }
}
```

### 创建 `~/.majordomo/persona.md`

把全局 CLAUDE.md 里的人设规则搬过来（猫娘 maid、健康提示、英文学习等）。这些是 majordomo 人设层的"默认人格"，对所有项目生效。项目自己的 `.majordomo/persona.md` 可以追加项目专属指令。

### 全局 CLAUDE.md 之后

全局 CLAUDE.md 仍然会被 Claude Code 直接读取（不经过 majordomo 时）。可以保留精简版，或直接删掉——取决于你是否还在 majordomo 之外使用 Claude Code。

## Hook 类型速查

| 类型 | 作用 | 配置示例 |
|------|------|----------|
| `diary` | 写日记到 `diaryDir` | `{"type": "diary"}` |
| `notify` | 触发通知（PowerShell/console） | `{"type": "notify"}` |
| `shell` | 执行 shell 命令 | `{"type": "shell", "command": "make build", "timeoutMs": 60000}` |
| `markdown_report` | 生成任务汇报 markdown | `{"type": "markdown_report", "output_dir": ".majordomo/reports"}` |

## 生命周期事件

| 事件 | 触发时机 | 默认行为 |
|------|----------|----------|
| `after_task` | 工作层完成 + 人设层汇报后 | `[diary, notify]` |
| `on_session_create` | 创建/续接会话后 | 无 |
| `on_session_close` | 关闭会话后 | 无 |
| `on_error` | 发生错误时 | 无 |

`after_task` 不配置时默认 `[diary, notify]`。显式设 `[]` 可完全禁用。

## 常见问题

### Q: 迁移后 CLAUDE.md 里的手动命令还要保留吗？
**不保留。** hook 系统自动触发，再写手动命令就重复了。

### Q: majordomo 坏了怎么办？
CLAUDE.md 里保留极简的 fallback 指令即可：
```bash
# fallback: 不经过 majordomo 时手动调
powershell "& 'tools\notify-done\write-diary.ps1' '...'; & 'tools\notify-done\notify-done.ps1' '...'"
```

### Q: 多个项目共用一个全局配置吗？
`~/.majordomo/config.jsonc` 是全局默认。每个项目的 `.majordomo/config.jsonc` 会覆盖全局配置（deep merge）。hook 数组是**完全替换**，不是追加。

### Q: shell hook 能访问会话信息吗？
能。shell 命令运行时注入了这些环境变量：`MJ_SESSION_ID`、`MJ_SESSION_NAME`、`MJ_CWD`、`MJ_PROFILE`、`MJ_TEXT`、`MJ_EVENT_TYPE`。

---

> 本指南随 majordomo 版本迭代持续更新。最新版本见 majordomo 仓库 `docs/migration-v2-to-v3.md`。
