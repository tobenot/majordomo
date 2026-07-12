# Bifrost（虹桥）

[![Version](https://img.shields.io/badge/version-0.2.0-blue)](https://github.com/tobenot/majordomo)
[![License](https://img.shields.io/badge/license-AGPL--3.0-green)](../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-orange)](https://codebuddy.woa.com)
[![Cursor](https://img.shields.io/badge/Cursor-Plugin-blue)](https://cursor.com/docs/plugins)

装进每个干活窗口的插件。用 hook 把窗口活动上报中枢，并在本地放提示音/弹窗。
对应设计稿：

- 中枢与载荷：`docs/design/bifrost-hub-v1.md`
- **Claude Code + Cursor 双端**：`docs/design/bifrost-cursor-dual-v1.md`

> **壳双开、肉单开**：两份清单 + 两份 hooks 声明；一份 `scripts/report.ps1` + 共用 notify / config。

## 装上（开发期）

**Claude Code**（`--plugin-dir` 可用）：

```bash
claude --dangerously-skip-permissions --plugin-dir D:/GitRep/majordomo/bifrost
```

**Cursor**（现行可靠做法）：

> 实测 `agent --plugin-dir …` **目前不会加载插件 hooks**（CLI 插件能力未对齐）。外仓软链进 `~/.cursor/plugins/local` 也会被拒。  
> 现行装法：用户级 hooks 指到**同一份** `scripts/report.ps1`（零脚本复制）。

把下面写进 `~/.cursor/hooks.json`（路径按本机改），然后**新开**一个 agent 窗口：

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

本机若已写过这份 hooks，直接新开窗口即可。验收看 `bifrost/cache/status.json` 的 `hue` 是否递增，或中枢是否收到上报——**不要**问模型「你有没有 bifrost」（hooks 对 agent 不可见）。

详情：`docs/design/bifrost-cursor-dual-v1.md` §6。
## Statusline 徽章

`[BIFROST]` 彩虹渐变徽章——中枢连通时每回合换色。中枢不在 → 不显示。

**Claude Code**（`~/.claude/settings.json`）：

```json
"statusLine": {
  "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\GitRep\\majordomo\\bifrost\\scripts\\bifrost-statusline.ps1\""
}
```

**Cursor CLI**（`~/.cursor/cli-config.json`）：

```json
"statusLine": {
  "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\GitRep\\majordomo\\bifrost\\scripts\\bifrost-statusline.ps1\""
}
```

路径按实际插件目录改。插件内可用 `${CLAUDE_PLUGIN_ROOT}` / `${CURSOR_PLUGIN_ROOT}`。

**7 色循环**（均为中等亮度）：🟠橙 → 🟡金 → 🟢绿 → 🩵青 → 🔵蓝 → 🟣紫 → 🩷玫红。

`report.ps1` 每次成功的 stop 上报后写入 `cache/status.json`（`{"reachable":true, "hue":N}`），statusline 只读文件。

## 它做什么

**Claude Code** 订阅：`SessionStart` `Stop` `Notification` `TaskCreated` `TaskCompleted` `SessionEnd` `UserPromptSubmit`（及 AskUserQuestion 的 PreToolUse）。

**Cursor** 订阅：`sessionStart` `sessionEnd` `afterAgentResponse` `beforeSubmitPrompt` `preToolUse`(AskUserQuestion)。  
Cursor 的 `stop` 不带全文，故用 `afterAgentResponse` 对齐 CC 的 `Stop`（全文 + 弹窗）。无 `Notification` / `Task*` 对等事件，v1 不强行伪造。

每次触发 `scripts/report.ps1`：

1. **设 UTF-8 输入编码**再读 stdin。
2. **归一化宿主事件名与字段**，整形成设计稿 §2.5 统一载荷。
3. **POST 到中枢 `/ingest`**（短超时，best-effort）。
4. **中枢没开就落盘缓存**，下次应答时补送。
5. **本地副作用**（Windows）：stop → 完整提示工具链；notification → 同样弹窗。
6. 永远 `exit 0`。

## 配置：`report.config.jsonc`

Bifrost 唯一的对外依赖就是一个能 POST 的 `/ingest` URL（设计稿 §8：零中枢依赖）。

| 键 | 说明 |
|---|---|
| `ingestUrl` | 中枢上报地址，默认 `http://127.0.0.1:4350/ingest` |
| `timeoutSec` | POST 超时秒数，保持短 |
| `maxTextLen` | 上报前截断长度（0 = 不限）|
| `notifyStop` | stop 本地效果：`beep` / `full` / `none` |
| `notifyNotify` | notification 本地效果：`full` / `beep` / `none` |

## 本地提示工具链

`notify-*.ps1` + `notify-done.config.ps1` 迁移自第二代 `tools/notify-done`。插件自包含——未来可 `git subtree split`。用户覆盖写 `notify-done.config.user.ps1`（不入仓）。

> 本机提示音（Bifrost）和 手机 Bark（中枢）是两层接力。

## 已知小事

- 脚本读 stdin 前必须设 UTF-8，否则中文全文乱码。
- `report.ps1` 源码故意全 ASCII 注释，PS 5.1 无论 BOM 与否都能解析。
- Cursor `afterAgentResponse` 若实测每回合多次触发导致弹窗吵，见设计稿 §8（探针后再节流）。
- Cursor stdin 偶发带 BOM/前缀字符，`report.ps1` 已跳到第一个 `{` 再解析。
- `dump.jsonl` / `cache/` / `*.offline.jsonl` / `*.log` 均 gitignore，不入仓。
