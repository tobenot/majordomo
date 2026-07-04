# Bifrost（虹桥）

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/tobenot/majordomo)
[![License](https://img.shields.io/badge/license-AGPL--3.0-green)](../LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-orange)](https://codebuddy.woa.com)

装进每个 Claude Code 窗口的插件。用 hook 把窗口活动上报中枢，并在本地放提示音/弹窗。
对应设计稿 `docs/design/bifrost-hub-v1.md`。

> 探针阶段（v0）已结束——六事件 payload 形状实测完毕（见设计稿 §2.2.1）。本目录现在是**正式上报版**：`report.ps1` 取代 `probe.ps1` 挂在六个 hook 上。`probe.ps1` 留作回归采样工具。

## 装上（开发期）

```bash
claude --plugin-dir ./bifrost        # 从磁盘目录直接加载
# 改完热载：/reload-plugins（改 plugin.json 需重开窗口）
```

## Statusline 徽章

`[BIFROST]` 在 Claude Code 状态栏显示彩虹渐变徽章——中枢连通时每回合换一个颜色，彩虹桥（Bifrost）本体。中枢不在 → 不显示。

**设置**：在 `~/.claude/settings.json` 加上：

```json
"statusLine": {
  "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\GitRep\\majordomo\\bifrost\\scripts\\bifrost-statusline.ps1\""
}
```

> 路径按实际插件目录改。装进 Claude Code 插件市场后可用 `${CLAUDE_PLUGIN_ROOT}` 自动定位。

**7 色循环**（均为中等亮度，深色/浅色终端均清晰）：🟠橙 → 🟡金 → 🟢绿 → 🩵青 → 🔵蓝 → 🟣紫 → 🩷玫红。

`report.ps1` 每次 Stop 成功后写入 `cache/status.json`（`{"reachable":true, "hue":N}`），statusline 脚本只读文件，无网络开销。多窗口竞争写无害——颜色偶尔跳一格而已。

## 它做什么

订阅六个事件：`SessionStart` `Stop` `Notification` `TaskCreated` `TaskCompleted` `SessionEnd`。每次触发 `scripts/report.ps1`：

1. **设 UTF-8 输入编码**再读 stdin（否则 `last_assistant_message` 中文乱码）。
2. **按 `hook_event_name` 分流**，整形成设计稿 §2.5 的统一载荷（`windowId`/`event`/`cwd`/`ts`/`payload`）。`Stop` 直取 `last_assistant_message` 全文。
3. **POST 到中枢 `/ingest`**（短超时，best-effort，绝不卡窗口）。
4. **中枢没开就落盘缓存**（`cache/ingest.offline.jsonl`），下次中枢应答时**顺带补送**整个积压队列。
5. **本地副作用**（Windows）：`Stop` → 完整提示工具链弹窗（每回合都触发，就是要回合一结束你立刻知道）；`Notification`（窗口等你）→ 同样完整弹窗。
6. 永远 `exit 0`。

## 配置：`report.config.jsonc`

Bifrost 唯一的对外依赖就是一个能 POST 的 `/ingest` URL（设计稿 §8：零中枢依赖，可 subtree-split 独立）。

| 键 | 说明 |
|---|---|
| `ingestUrl` | 中枢上报地址，默认 `http://127.0.0.1:4350/ingest`（4350 避开 WXWork 占的 4317）|
| `timeoutSec` | POST 超时秒数，保持短 |
| `maxTextLen` | `last_assistant_message` 上报前截断长度（0 = 不限）|
| `notifyStop` | `Stop` 本地效果：`beep` / `full` / `none`。Stop 每回合都触发，默认 `full`——每回合全提示，就是要你回合结束就知道 |
| `notifyNotify` | `Notification` 本地效果：`full` / `beep` / `none`。窗口真等你，默认整套弹窗 |

## 本地提示工具链

`notify-*.ps1` + `notify-done.config.ps1` 迁移自第二代 `tools/notify-done`（提示音合成 / TTS / WPF 浮窗 / 任务栏闪烁）。放进 bifrost 内部保持插件**自包含**——未来 `git subtree split` 可零成本拆独立仓。用户覆盖写 `notify-done.config.user.ps1`（不入仓）。

> 本机提示音（Bifrost）和 手机 Bark（中枢）是两层接力：你在电脑前靠 Bifrost，离场了靠中枢 Bark，不重复。

## 已知小事

- 脚本读 stdin 前必须设 UTF-8（`report.ps1` 已内置），否则中文全文乱码。
- `report.ps1` 源码故意全 ASCII 注释，PS 5.1 无论 BOM 与否都能解析。
- `Notification` 子类型未穷举（已见 `permission_prompt`/`idle_prompt`，还有 `auth_success` 等），脚本不假设穷举。
- `dump.jsonl` / `cache/` / `*.offline.jsonl` / `*.log` 均 gitignore，不入仓。
