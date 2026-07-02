# 交接文档：Bifrost 正式上报脚本 report.ps1

> 日期：2026-07-02
> 状态：`report.ps1` 写完并本地实测六事件通过；中枢 `/ingest` 仍未建（按计划下次单独开工）
> 上一位：tobenot（接续 `2026-07-02-bifrost-probe-payloads.md` 的探针交接）

---

## 做了什么

接手探针留下的六事件 payload 形状（设计稿 §2.2.1），写完 Bifrost 正式上报脚本 `report.ps1`，取代探针 `probe.ps1` 挂在六个 hook 上。脚本按设计稿 §2.3 路 B：一个脚本包办**分流 → 上报 /ingest → 离线缓存补送 → 本地提示音/弹窗**。并把第二代 notify 工具链字节级复制进插件，保持插件自包含（设计稿 §8 零中枢依赖）。

## 当前状态

**改动/新增文件（均未 commit）：**

| 文件 | 改动 |
|------|------|
| `bifrost/scripts/report.ps1` | **新**，203 行，核心。UTF-8 stdin → 按 `hook_event_name` 分流 → §2.5 载荷 POST /ingest → 离线缓存补送 → Stop beep / Notification 弹窗。全 ASCII 源、always exit 0 |
| `bifrost/report.config.jsonc` | **新**，插件唯一对外依赖：`ingestUrl`（默认 `http://127.0.0.1:4350/ingest`）+ 超时/截断/notify 三档开关 |
| `bifrost/scripts/notify-{done,tone,popup,tts}.ps1`、`notify-done.config.ps1` | **新**，从 `tools/notify-done/` 字节级复制（保留 BOM），本地提示工具链自包含 |
| `bifrost/hooks/hooks.json` | 六事件 `probe.ps1` → `report.ps1` |
| `bifrost/.claude-plugin/plugin.json` | v0.0.1 → v0.1.0，描述改为正式上报版 |
| `bifrost/.gitignore` | 补 `*.log`/`*.err`/`*.out` + `notify-done.config.user.ps1` |
| `bifrost/README.md` | 重写为正式版说明（原为探针版） |
| `docs/design/bifrost-hub-v1.md` | §2.2.1 补采：`/clear` 连发 `SessionEnd(reason:clear)`+`SessionStart(source:clear)` |

`probe.ps1` 保留作回归采样工具。

## 判断与取舍

1. **Stop 默认只 beep，Notification 才上完整弹窗。** Stop 每回合都触发，每次放 10 秒科幻警报会疯；设计稿 §2.2 本就把 Stop→提示音、Notification→弹窗分开。三档可配（`none`/`beep`/`full`）。
2. **本地提示走 ASCII，中文全文只发中枢。** 子进程 `-Message` 传中文会踩 Windows 命令行 ANSI 乱码坑；本地只是「你在电脑前」的存在信号，弹窗显 `projB | Claude needs your permission`（CC 原文本就英文），而 `last_assistant_message` 中文全文进 UTF-8 JSON body 发中枢。既贴 §2.4 分工又避坑。
3. **notify 工具链复制而非软链。** 符合 §8 自包含/可 subtree-split，代价是 `tools/notify-done` 以后改动不自动同步——用户自定义写 `notify-done.config.user.ps1`（gitignore）。
4. **没写中枢 `/ingest`。** 按既定「只配置 + 离线缓存」方案；离线缓存正好覆盖「中枢还没建」的当下状态，不阻塞。

## 实测结论（本地，PS 5.1 + mock hub）

- 六事件全部正确分流成 §2.5 载荷，`last_assistant_message` 中文 UTF-8 完好。
- 中枢宕机 → 落 `cache/ingest.offline.jsonl`；中枢恢复 → 下次事件顺带**按序补送并清空缓存**。✅
- `report.ps1` PS 5.1 解析通过、always exit 0。

**实测得到的 /ingest 载荷样例**（下个窗口照此实现中枢）：

```jsonc
{
  "windowId": "<session_id>",
  "event": "stop | notification | task_created | task_completed | session_start | session_end",
  "cwd": "D:\\GitRep\\majordomo",
  "ts": 1782991811986,
  "payload": {
    // stop:          text
    // notification:  text, notificationType
    // task_*:        taskId, taskSubject, taskDesc, taskStatus(created|completed)
    // session_start: source
    // session_end:   reason
  }
}
```

## 已知限制

1. **未跑真实 CC 窗口。** 只在 mock hub 上验证分流/缓存/补送；inline 插件要重开窗口才加载新脚本，真实 hook 触发链路 + 弹窗观感未点验。
2. **notify 完整工具链（TTS/WPF 浮窗）未在真实弹窗场景点验**，只验证了 `report.ps1` 会正确拉起它。
3. **载荷是单向约定，中枢侧尚不存在。** `/ingest` 未实现，字段契约以本文 + 设计稿 §2.5 为准。

## 下一步

1. 真实 CC 窗口挂 `--plugin-dir ./bifrost` 跑一轮，确认 hook 触发 + 弹窗观感。
2. 单独开工写中枢 `POST /ingest`（`src/web/server.ts` 同 HTTP server 上加），照上面载荷样例实现，归一 → 更新三张表 → persona → WebSocket 广播（设计稿 §3）。

## 关键文件

```
bifrost/scripts/report.ps1         正式上报脚本（核心）
bifrost/report.config.jsonc        ingestUrl + notify 开关
bifrost/scripts/notify-*.ps1       本地提示工具链（自包含）
docs/design/bifrost-hub-v1.md      §2.2.1 事件形状 / §2.5 载荷 = 协议事实源
```

memory：`cc-stop-hook-no-text`（已补记 report.ps1 写完 + `/clear` 的 source/reason=clear）
