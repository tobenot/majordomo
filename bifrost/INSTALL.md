# Bifrost 安装指南（多机）

把虹桥装到任意一台 Windows 机器。脚本不复制：所有宿主都指向**本机克隆里的** `bifrost/scripts/report.ps1`。

设计背景：`docs/design/bifrost-cursor-dual-v1.md`。

---

## 0. 前置

| 项 | 要求 |
|---|---|
| 系统 | Windows（提示音/弹窗依赖 PowerShell 工具链） |
| 仓库 | 已 clone majordomo（或至少有完整 `bifrost/` 目录） |
| 中枢 | 本机或可达机器上跑着 majordomo daemon（默认 `http://127.0.0.1:4350/ingest`） |
| 宿主 | Claude Code 和/或 Cursor Agent CLI |

中枢不在本机时：改 `bifrost/report.config.jsonc` 的 `ingestUrl` 指向那台机器（中枢挂了会离线缓存，下次通了再补送）。

---

## 1. Claude Code（一分钟）

每次开窗口带上插件目录即可（把路径换成**本机**绝对路径）：

```bat
claude --dangerously-skip-permissions --plugin-dir D:\GitRep\majordomo\bifrost
```

或 PowerShell：

```powershell
claude --dangerously-skip-permissions --plugin-dir "D:/GitRep/majordomo/bifrost"
```

可选：在 `~/.claude/settings.json` 加 statusline（路径同样改成本机）：

```json
"statusLine": {
  "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\GitRep\\majordomo\\bifrost\\scripts\\bifrost-statusline.ps1\""
}
```

---

## 2. Cursor（推荐：一键脚本）

> **不要**指望 `agent --plugin-dir …`：现行 CLI **不会**加载插件 hooks。  
> **不要**把仓库软链进 `~/.cursor/plugins/local`：外仓 symlink 会被拒。

### 2.1 安装用户级 hooks

在**已 clone 好的**仓库里执行（脚本会用自己的位置推算 `report.ps1` 绝对路径）：

```powershell
cd D:\GitRep\majordomo\bifrost
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-cursor-hooks.ps1
```

做了什么：

- 写入 `%USERPROFILE%\.cursor\hooks.json`
- `command` 指向本机 `...\bifrost\scripts\report.ps1`
- 若已有 hooks，会**保留**非 bifrost 条目，并更新/补上 bifrost 那几条
- 装前备份为 `hooks.json.bak-yyyyMMddHHmmss`

可选：连 statusline 一起写（合并进 `~/.cursor/cli-config.json`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-cursor-hooks.ps1 -StatusLine
```

> Statusline 只在 **Cursor Agent CLI（终端里的 `agent`）** 生效，协议对齐 Claude Code。IDE 聊天侧栏没有这条 statusline。
卸载 bifrost hooks（只删本插件相关条目，其它 hooks 保留）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-cursor-hooks.ps1 -Uninstall
```

### 2.2 新开窗口

装完后**新开** Cursor Agent 窗口（旧窗口可能仍用旧 hooks）：

```bat
agent --force
```

不必再加 `--plugin-dir`。

### 2.3 手写 hooks（脚本不可用时）

编辑 `%USERPROFILE%\.cursor\hooks.json`，把所有 `D:/GitRep/majordomo` 换成你的 clone 路径：

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/YOUR/PATH/majordomo/bifrost/scripts/report.ps1\"" }],
    "sessionEnd": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/YOUR/PATH/majordomo/bifrost/scripts/report.ps1\"" }],
    "afterAgentResponse": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/YOUR/PATH/majordomo/bifrost/scripts/report.ps1\"" }],
    "beforeSubmitPrompt": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/YOUR/PATH/majordomo/bifrost/scripts/report.ps1\"" }],
    "preToolUse": [{ "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"D:/YOUR/PATH/majordomo/bifrost/scripts/report.ps1\"", "matcher": "AskUserQuestion" }]
  }
}
```

---

## 3. 配置中枢地址

默认本机：

```jsonc
// bifrost/report.config.jsonc
"ingestUrl": "http://127.0.0.1:4350/ingest"
```

中枢在另一台机器：改成 `http://<hub-host>:4350/ingest`，并保证网络可达。  
每台干活机各自一份 `report.config.jsonc`（或改完别误提交别人的地址）。

本机起中枢（在 majordomo 仓）：

```bat
npm run build
npm run daemon
```

---

## 4. 验收（别问模型）

虹桥对 Agent **不可见**（几乎只有 hooks）。问「你有没有 bifrost」没有意义。

按下面验：

1. 开中枢（或确认 `ingestUrl` 可达）。
2. 新开一个 CC / Cursor 窗口，随便跑一轮。
3. 看任一项：
   - `bifrost/cache/status.json` 里 `hue` 递增、`reachable` 为 true
   - 中枢 Web / 面板出现该窗口上报
   - Windows 上 stop 后有本地提示（`notifyStop: full` 时）

快速自检脚本（不经过宿主，只测 report → hub）：

```powershell
'{"hook_event_name":"sessionStart","session_id":"install-check","cwd":"D:/tmp","source":"install"}' |
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\report.ps1
Get-Content .\cache\status.json
```

---

## 5. 换机清单（复制用）

```text
[ ] git clone majordomo（或同步 bifrost 目录）
[ ] 确认 / 修改 bifrost/report.config.jsonc 的 ingestUrl
[ ] CC：启动命令带 --plugin-dir <本机绝对路径>/bifrost
[ ] Cursor：在 bifrost 目录跑 scripts/install-cursor-hooks.ps1
[ ] Cursor：新开 agent 窗口（agent --force）
[ ] 可选：statusline（CC settings / 安装脚本 -StatusLine）
[ ] 跑一轮，看 cache/status.json 或中枢面板
```

---

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| Cursor 问插件列表没有 bifrost | 正常。看 `cache/status.json` / 中枢 |
| `agent --plugin-dir` 无效 | 已知；改用 `install-cursor-hooks.ps1` |
| 换了 clone 路径后不上报 | 再跑一次安装脚本（重写绝对路径） |
| 中枢没开 | 会进 `cache/ingest.offline.jsonl`，中枢起来后自动补送 |
| 弹窗没有 / 只要静音 | 改 `report.config.jsonc` 的 `notifyStop` / `popup` |
| 中文变成「浣犲ソ」之类乱码 | 已修：`report.ps1` 按 UTF-8 原始字节读 stdin，并对 CP936 误读做恢复。请拉最新脚本后再开一轮 |
| 非 Windows | 上报脚本可改，本地弹窗工具链目前按 Windows 做 |

更多设计与事件映射：`docs/design/bifrost-cursor-dual-v1.md`。
