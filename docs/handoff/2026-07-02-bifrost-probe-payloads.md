# 交接文档：Bifrost 探针实测 payload 形状

> 日期：2026-07-02
> 状态：探针使命完成，六事件形状全采齐并回填设计稿；正式 report.ps1 未开工
> 上一位：tobenot（本会话 session_id `430fb654`）

---

## 做了什么

跑完设计稿 §2.6 的「施工第 0 步」——用探针插件 `bifrost/scripts/probe.ps1` 实测了 6 个候选 hook 事件的真实 stdin payload，把结论回填进 `docs/design/bifrost-hub-v1.md`，并修正了几处被实测推翻的承重设计。

采样方式：`--plugin-dir ./bifrost` 加载，就在真实 CC 窗口里干活触发事件，probe.ps1 把每次 stdin 原样落 `bifrost/dump.jsonl`（一事件一行）。SessionEnd 靠 `/exit` 触发、resume 靠退出后重进触发。

## 当前状态

**改动文件（均未 commit）：**

| 文件 | 改动 |
|------|------|
| `bifrost/.claude-plugin/plugin.json` | 删掉重复的 `"hooks"` 行——它和自动加载的 `hooks/hooks.json` 撞车，报 `[ERROR] Duplicate hooks file` 且 bifrost 被标 `hook-load-failed`（挂 MCP 会被挡）|
| `bifrost/scripts/probe.ps1` | 加 `[Console]::InputEncoding = [System.Text.Encoding]::UTF8`——否则 PS 按 GBK 解 UTF-8，`last_assistant_message` 中文全乱码 |
| `docs/design/bifrost-hub-v1.md` | §2.2 公共字段纠正 + 新增 §2.2.1 实测形状表；§2.3 重写路 B 依据；§2.5/§2.6/§8 同步 |

⚠️ plugin.json / probe.ps1 的改动**对采样当时的会话不生效**（inline 插件启动时加载），需重开窗口才生效。编码修复已在 resume 后的新进程验证有效（dump 第 13 行中文正常，对比第 12 行乱码）。

## 实测结论（六事件 payload · CC v2.1.154）

**公共字段**（每个事件都有）：`session_id` `transcript_path` `cwd` `hook_event_name`。

| 事件 | 独有字段 | 关键点 |
|------|---------|--------|
| `SessionStart` | `source`(startup/resume)、`model` | ⚠️ `model` 只在 startup 有，resume 无 |
| `Stop` | **`last_assistant_message`(本轮全文)**、`permission_mode`、`effort:{level}`、`stop_hook_active`、`background_tasks:[]`、`session_crons:[]` | ⭐ 直接带全文，无需读 transcript |
| `Notification` | `message`、`notification_type` | permission_prompt / idle_prompt 两子类，matcher 可分 |
| `TaskCreated` | `task_id`、`task_subject`、`task_description` | 一 task 一次 |
| `TaskCompleted` | 同 TaskCreated | 结构一致 |
| `SessionEnd` | `reason`(`/exit`=prompt_input_exit) | 极简 |

**三处被推翻/修正的承重结论：**
1. ⭐ **`Stop` 直接带全文**——推翻旧稿「Stop 不带文本、必须读 transcript」。路 B 依据随之从「唯一手段」改为「本地副作用 + 离线韧性 + 上报预处理」三条（详见 §2.3）。
2. `permission_mode` **非公共字段**，只在 Stop 出现。
3. `SessionStart` 的 `model` 仅 startup 有。

## 已知限制

1. **单次单版本采样**：CC v2.1.154，一次会话。字段可能随版本演进。
2. **notification_type 未穷举**：只触发到 `permission_prompt` / `idle_prompt`；文档提到还有 `auth_success` / `elicitation_*` 等，report.ps1 别假设穷举。
3. **SessionEnd.reason 只见一种**：`/exit` 的 `prompt_input_exit`；崩溃/其它退出的 reason 值未知。
4. **dump.jsonl 首行 BOM**：PS 5.x `Add-Content -Encoding UTF8` 在文件首写 BOM，严格 JSONL 解析器读要跳首字节。

## 下一步：写正式 report.ps1

探针使命完成，正式版要做（设计稿 §2.3）：

1. **读 stdin 前设 UTF-8**（同 probe.ps1）
2. **按 `hook_event_name` 分流**
3. **Stop 直取 `last_assistant_message`**；缺字段（老版本 CC）才回退读 `transcript_path` 尾部 assistant 消息
4. **整形统一载荷 POST /ingest**（载荷字段见 §2.5，需与中枢那边对齐）
5. **本地提示音/弹窗**（迁移二代 `tools/notify-done` 的 PS 逻辑）
6. **离线缓存补送**（中枢没开时落盘）

⚠️ 开工前建议先对齐 `/ingest` 载荷字段与中枢实现——这是 bifrost↔中枢的协议边界。

## 关键文件

```
bifrost/scripts/probe.ps1          探针（使命完成，可留作回归工具）
bifrost/dump.jsonl                 15 行原始采样（gitignore，不入仓）
docs/design/bifrost-hub-v1.md      §2.2.1 = 现在最硬的事实源
```

memory：`cc-stop-hook-no-text`（已更正为「Stop 带全文」+ 六事件形状）
