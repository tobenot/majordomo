# 全面 Review（2026-07-03）

> 一次外部视角的通读：设计脉络 + 里程碑进度 + 代码。目标是帮项目更稳地达成「管家中枢」这个目标。
> 结论先行：**转型方向是对的，v1 链路是通的，工程素养很高**。真正值得动手的问题只有两三个，且都在「组装层」而非「架构层」——正好印证了 pivot 的判断。

## 一、先说结论：进度与健康度

| 维度 | 状态 |
|---|---|
| 核心链路（窗口 → Bifrost → 中枢 → 三张表 → persona → 面板/Bark） | ✅ 打通 |
| 编译 | ✅ 干净通过（无 error，无 TODO/FIXME/HACK 遗留标记） |
| 防御性 / 自愈 | ✅ 全项目最亮的部分（离线缓存排空、TCP 预检、编码修正、非阻塞契约、stale 跳过） |
| 「加日志定位胜过信文档」的纪律 | ✅ 探针插件先跑、回填实测形状，教科书级 |
| **文档与现实脱节** | ⚠️ 最需要修（见 §三·1） |
| **本地默认配置下的双弹窗** | ⚠️ 最值得验证的一处（见 §三·2） |

里程碑上，README 的 Roadmap 还停在「旧世界」（SdkWorker 调度器），而实际已经走到 Bifrost/Hub v1 + Web 浮窗。**代码跑在 v1，文档挂在 v0.2** —— 这个差距本身就是第一条意见。

## 二、值得肯定的判断

这些不是客套，是真觉得做对了、希望别在后续迭代里丢掉：

- **pivot 的自我否定很诚实**。"SdkWorker 的交互干不过原生 Claude Code"——肯承认自建工作层是逆水行舟、及时转向旁观者中枢，比硬撑一个追不上官方的 TUI 明智得多。项目存在的唯一理由（跨窗口视野 + persona 复命）被想清楚了。
- **Bifrost「零中枢依赖」的约束**（只依赖一个能 POST 的 URL）。这让 `git subtree split` 拆独立仓是零成本的，反向合并才痛——方向选对了。
- **report.ps1 的顺序推理**：本地弹窗排在上报之前，因为同步 POST 会把弹窗推后 timeoutSec 秒。这个「弹窗慢半拍」真凶找得准，注释也把 why 写清楚了。
- **探针先行**：不信文档抓来的字段表，先 dump 真实 payload 再回填承重结论（`Stop` 直带 `last_assistant_message` 推翻了「必须读 transcript」）。这是这个项目最该保留的工作习惯。

## 三、需要你拍板 / 动手的问题

### 1. 文档漂移：README / architecture.md 还在讲旧世界 ⚠️ 优先

**现象**：`README.md` 和 `docs/architecture.md` 通篇描述的是「有人设前端的 Claude Code **调度器**」——SdkWorker 常驻会话、canUseTool 权限 UI、Session 生命周期。而 `pivot-to-hub.md` 已经把这套**退役为可选/mock**，真正的产品是「旁观 N 个原生窗口的中枢」。

一个新人（或半年后的你）打开 README，建立的是**错误的心智模型**：他以为 majordomo 自己驱动 Claude Code 干活，实际上 v1 根本不驱动，只旁观上报。Roadmap 里甚至没有 Bifrost / Hub / 三张表 / 浮窗的任何字样。

**背景思考**：这不是「文档没写」，是「文档写了但指向已废弃的方向」，比空白更误导。`main-mind.md` / `pivot-to-hub.md` / `bifrost-hub-v1.md` 作为**历史脉络**保留是对的（它们明确声明「不回改历史判断」）；但 README 和 architecture.md 是**门面**，应该讲现在。

**建议**（你拍板要不要做、做到什么程度）：
- README「设计要点 / Status / Roadmap」三节重写成中枢版：主体是「旁观窗口 + 三张表 + persona 复命 + Bark/浮窗触达」，把 SdkWorker 明确标为「可选/退役，非主路径」。
- architecture.md 顶部加一句「本文描述的调度器形态已于 2026-07-02 转型，当前形态见 `design/pivot-to-hub.md`」，或直接补一张中枢架构图。
- 这是「操作类」任务，按规则我可以直接做；但因为涉及门面表述，我先列出来等你点头。

### 2. 本地默认配置下，每个回合可能弹两次窗 ⚠️ 值得你对着实际体验验证

**链路追踪**（同一台 Windows、daemon 与窗口同机 —— 正是 v1「本地版」场景）：

```
一个 Stop 事件
 ├─ Bifrost report.ps1 → Invoke-FullNotify → 本地弹窗（Edge 浮窗 / WinForms）+ 声音   ← 窗口侧
 └─ POST /ingest → hub.stop → reportPersona → this.notifier.notify(persona文本)
                                              └─ NotifierBus → PowershellNotifier → notify-done.ps1 再弹一次 + 声音   ← 中枢侧
```

`DEFAULT_CONFIG.notifiers = ["powershell", "console"]`，Bark 不在默认里。于是中枢在 stop 时也会走 **PowershellNotifier** 在本机弹 notify-done。**同一台机器上，一个回合结束 = Bifrost 弹一次 + 中枢弹一次。**

而 `web-popup.md` 明明立了「一处出声、一处兜底，账才干净」的原则，`bifrost-hub-v1.md §2.4` 也写了两层接力：**本机弹窗归 Bifrost（你在场，即时、不节流），Bark 归中枢（你离场，节流）**。也就是说——**中枢在本地场景下压根不该再走 PowerShell 弹窗**，它的出口应该是 Bark。

**为什么会这样**：`notifiers` 默认值是 pivot 之前留下的（那时中枢就是本机唯一的通知方）。转型后中枢的通知职责让给了 Bifrost，但默认 notifier 列表没跟着改。声音那边有 `majordomo-beep.lock` 互斥兜底，但**视觉弹窗没有跨进程互斥**，所以会真的叠两个。

**建议**（这条我更倾向于是个真 bug，但请你先用真实的 8 窗口跑一轮确认体验）：
- 本地 profile 的中枢 `notifiers` 改成 `["console"]` 或 `["bark", "console"]`——把本机弹窗彻底让给 Bifrost，中枢只负责「你离场」的 Bark。
- 或者反过来：如果你其实喜欢中枢也弹（因为它带 persona 全文，Bifrost 只有首句），那就该让 **Bifrost 的 stop 弹窗降级为 beep**，避免视觉叠加。二选一，取决于你想让「回合结束的富文本」从哪个窗口出。
- 这是「架构取舍/影响体验」的决定，按规则必须先问你。

### 3. 待验收表可能被 `idle_prompt` 刷屏（噪音）

`hub.ts` 的 `notification` 分支：**每一条 notification 都无条件 `acceptance.add`**。而实测 `notification_type` 有两类：`permission_prompt`（等许可，真需要你）和 `idle_prompt`（等你输入，几乎每次空闲都触发）。

后者会让待验收清单不断堆重复条目——窗口每空闲一次就 +1 条「等待你」。`kind` 虽然区分了 permission/review，但两类都进了表、都推了通知。

**建议**：`idle_prompt` 要么不进待验收（它不是「待验收事项」，只是「窗口闲着」），要么按 `windowId + pending` 去重（一个窗口最多一条 pending 待验收）。这条是「操作类」小修，可直接做，等你确认取向。

### 4. 三张表无上限 / 无淘汰（低优，记一笔）

- `WindowRegistry`：offline 窗口永久留在 `hub-windows.json`，只增不删。跑几个月后全是死窗口。
- `TodoStore`：done 的待办不清理。
- `AcceptanceStore`：resolved 的不清理。

v1 量小无妨，但这是「自包含、自愈」哲学的一个缺口——系统应该能自己收敛状态。建议某个时点加个轻量淘汰（offline 超 N 天清、done/resolved 超 N 天归档）。不急。

### 5. stale 判定跨机器依赖时钟一致（为「远程愿景」埋的坑）

`report.ps1` 在**窗口机**打 `ts`（UTC 毫秒），`hub.isStale` 拿**中枢机**的 `Date.now()` 比。本地同机没问题；但整个架构的野心是**中枢跑在无桌面服务器、窗口在别处**——那时两机时钟偏移会让 stale 误判（把新鲜事件当积压丢掉 persona/Bark，或反之）。

**建议**：记一笔即可，v1 不用改。真上服务器时，stale 应改用「中枢**收到**的时刻」而非窗口打的 `ts` 来算积压（`ts` 只用于展示）。

## 四、我没动的东西 / 假设

- 没跑 `selftest`（需要真实多窗口 + Edge + 可能的 Bark key，属于你的验收环节）。上面「双弹窗」「idle 刷屏」两条都建议你用真实 8 窗口跑一轮体验来证实/证伪我的静态追踪。
- 没改任何代码——本次是纯 Review，所有动手项都等你拍板。
- SDK worker 那条老链路（sdkWorker.ts / sessionManager / session）我确认它仍完整编译、TUI 仍可用它，但没深挖——因为它已被 pivot 判为非主路径，深挖的边际收益低。若你打算彻底退役它（而非「保留为可选」），那是另一个决策，值得单独聊。

## 五、一句话总览

**方向对、链路通、工程稳；欠的是让门面文档追上转型、以及把 pivot 后通知职责的重新划分在默认配置里兑现。** 按优先级：先修文档漂移（§三·1）与双弹窗（§三·2），其余是可以从容处理的收敛性小账。
