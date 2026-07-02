# 验收指南：Bifrost report.ps1（保姆级）

> 目的：确认 `report.ps1` 挂进真实 Claude Code 窗口后，六事件能正确**上报/缓存 + 本地提示**。
> 这次只验 **Bifrost 这一侧**（中枢 `/ingest` 还没建，所以「上报」的验收 = 落进离线缓存）。
> 预计耗时：**5~10 分钟**。全程你只需开一个新窗口、干点活、看两样东西。

---

## 0. 开始前你要知道的三件事

1. **必须开一个「全新」的 Claude Code 窗口来验收。** 你现在这个窗口加载的还是旧插件配置，改动不生效——inline 插件只在窗口**启动时**加载。
2. **中枢没开是正常的。** 没开 → 上报会失败 → 脚本把消息**落盘缓存**。所以这次「上报成功」的标志是：`bifrost/cache/ingest.offline.jsonl` 里多出了行。
3. **不会卡你的窗口。** 上报超时 2 秒、best-effort，脚本永远 `exit 0`，失败也只是默默缓存。

---

## 1. 开一个挂了 Bifrost 的新窗口

打开一个**新的**终端（不是现在这个），`cd` 到项目再启动：

```bash
cd D:/GitRep/majordomo
claude --plugin-dir ./bifrost
```

**怎么确认插件真加载上了？** 启动日志里应有类似 `Loaded inline plugin ... bifrost` 的行。
> ⚠️ 如果看到 `[ERROR] Duplicate hooks file` —— 不用管，那是老问题，已在 `plugin.json` 修过，重开窗口就没了。真出现也不影响本次验收。

---

## 2. 触发六个事件（就在这个新窗口里干活）

不用刻意造场景，正常用就会触发。按下面顺序走一遍最省事：

| # | 你做的动作 | 触发的事件 | 预期本地反应 |
|---|-----------|-----------|-------------|
| 1 | 窗口刚启动 | `SessionStart` | 无声（只上报） |
| 2 | 随便问一句，等它答完 | `Stop` | **「叮」一声短提示音** |
| 3 | 让它做个需要许可的操作（比如删文件、跑命令），等它弹许可框 | `Notification` | **弹出提示浮窗 + 提示音** |
| 4 | 对它说「列个三步计划并逐条做」（触发它建 TodoWrite 任务） | `TaskCreated` | 无声（只上报） |
| 5 | 等那些任务被标记完成 | `TaskCompleted` | 无声（只上报） |
| 6 | 输入 `/exit` 退出窗口 | `SessionEnd` | 无声（只上报） |

> 第 3 步的浮窗就是从第二代 notify-done 迁过来的那个深色卡片（带「知道了 / 稍后提醒 / 复制」按钮）。看到它=本地弹窗链路通。

---

## 3. 看缓存：上报内容对不对

回到你的 git bash 终端，看缓存文件：

```bash
cd D:/GitRep/majordomo
cat bifrost/cache/ingest.offline.jsonl
```

**你应该看到**：每触发一个事件就有一行 JSON，形如：

```jsonc
{"windowId":"<一长串id>","event":"stop","cwd":"D:\\GitRep\\majordomo","ts":1782...,"payload":{"text":"..."}}
```

**重点逐项核对**（保姆级，一个个对）：

- [ ] **行数 ≈ 你触发的事件数**（SessionStart、每次问答的 Stop、Notification、每个 Task…）
- [ ] `event` 字段值是 `session_start` / `stop` / `notification` / `task_created` / `task_completed` / `session_end` 这类小写下划线名
- [ ] `stop` 事件的 `payload.text` 里，**中文是正常的**（比如「重构完成了」），**不是** `閲囨牱` 那种乱码 ← 这是最关键的一条，编码没坏
- [ ] `notification` 事件带 `notificationType`（`permission_prompt` 或 `idle_prompt`）
- [ ] `task_created` / `task_completed` 带 `taskId` / `taskSubject` / `taskStatus`

想看得清楚点，用这个把每行拆开看：

```bash
node -e 'require("fs").readFileSync("bifrost/cache/ingest.offline.jsonl","utf8").split("\n").filter(Boolean).forEach(l=>{const o=JSON.parse(l);console.log(o.event,"|",JSON.stringify(o.payload).slice(0,80))})'
```

---

## 4.（可选）想亲眼看到「真的 POST 出去了」？开个迷你中枢

上面第 3 步验的是「中枢没开→缓存」。如果你想看**上报真的发得出去 + 缓存补送**，开个一次性假中枢：

**终端 A**（开个假 `/ingest`，收到就打印）：

```bash
cd D:/GitRep/majordomo
node -e 'require("http").createServer((q,s)=>{let b="";q.on("data",c=>b+=c);q.on("end",()=>{console.log("收到:",JSON.parse(b).event);s.writeHead(200);s.end("{}")})}).listen(4350,"127.0.0.1",()=>console.log("假中枢在 4350 等着"))'
```

**终端 B**（新开个挂 Bifrost 的 CC 窗口，随便问一句等它答完）：

```bash
cd D:/GitRep/majordomo && claude --plugin-dir ./bifrost
```

**预期**：
- [ ] 终端 A 立刻打印 `收到: session_start`、`收到: stop`…
- [ ] **之前第 3 步攒下的离线缓存被顺带补送**（终端 A 会先刷出一批旧事件），然后 `bifrost/cache/ingest.offline.jsonl` **消失/清空** ← 这验证了「补送 + 清缓存」

看完 Ctrl+C 关掉终端 A 即可（它是一次性的，不留痕）。

---

## 5. 本地提示音/弹窗的开关（可选调整）

觉得每次问答都「叮」太吵、或想让 Stop 也弹完整浮窗？改 `bifrost/report.config.jsonc`：

```jsonc
"notifyStop":   "beep",   // beep=只响 | full=完整浮窗 | none=静音
"notifyNotify": "full"    // full=浮窗 | beep=只响 | none=静音
```

改完**重开窗口**生效。

---

## ✅ 验收结论（全打勾就算过）

- [ ] 新窗口能加载 bifrost 插件
- [ ] 问答结束听到提示音（Stop）
- [ ] 等许可时弹出浮窗（Notification）
- [ ] `cache/ingest.offline.jsonl` 里六类事件都出现过，字段名对
- [ ] Stop 的 `payload.text` 中文正常、无乱码
- [ ]（可选）开假中枢时，事件实时收到 + 旧缓存被补送清空

---

## 出问题怎么办

| 症状 | 大概率原因 / 怎么办 |
|------|-------------------|
| 缓存文件根本不存在 | 事件没触发，或插件没加载。确认启动日志有 `Loaded inline plugin`；确认你是在**新窗口**里操作的 |
| 中文全是 `閲囨牱` 乱码 | 编码没生效——但 `report.ps1` 已内置 UTF-8 修复，若真出现请把那行原样贴给我 |
| 没听到提示音 | 系统静音？或 `notifyStop` 被设成了 `none`。台式机没声卡也可能 |
| 没弹浮窗 | `notifyNotify` 是不是 `beep`/`none`？或 WPF 弹窗被拦——看 `bifrost/scripts/notify-popup-error.log` |
| 窗口感觉卡了一下 | 不应该。若持续，把 `report.config.jsonc` 的 `timeoutSec` 调到 1 |

---

> 这次验收**不覆盖**：中枢 `/ingest` 的真实实现、三张表、persona 复命、Bark 推送——那些是下一步的活。本指南只保证「Bifrost 这一侧」是好的。
