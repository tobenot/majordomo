# 设计者的初始灵感

我需要一个orchestration wrapper，一个第三代AI工作流集中管理器。我也不知道我需不需需要的是不是这个，我只是写一写我的灵感和需求来问问你，和你沟通一下。不知道是不是 Shell wrapper。

AI工作流本体的名字叫苏雨晴，我会给他建一个类似名字的仓库，虽然这个仓库名字我还没想好，他大概是个机械女仆。

我初始的需求比较少。因为我开始用GLM-5.2来做主力，我暂时不需要制作心跳机制。

人设层和工作层分离，人设层我使用更便宜的模型，然后工作层使用更大的模型，更多是工作层的请求完成之后，他会把工作层的输出给读一遍，然后用人设层来和我沟通。

然后可能还有另一个层，就是我举个例子啊，可能有的层，这层也可能没有，也可能会有更多。比如说在做完一个需求之后，他需要去维护那个验收文档，然后验收文档是用htMl或者说其他的语言去写的，是图形化的，他要做的就是去写这个验收文档，唉，注意这一个是需要一定的调研的，我觉得直接api可能不足以能成功的做到，因为它需要更多的上下文。所以我倾向于开一个模型比较简单的claude code会话，甚至这个会话本身也可以是连续的，就是相当于一个任务维持了两个会话，然后有一个api层这样子。工作层可以改改规则输出一些便于汇总的内容，但不用太多。我们可以利用全局个人偏好：~/.claude/CLAUDE.md。利用项目共享规则。我们的工具可以在新开一个项目发现没有规则的时候尝试补，但是其实管理好全局的规则 ~/.claude/CLAUDE.md 就挺好的了。（注意这个目录也要可以配置，有些工具可能不太一样，比如claude-internal）

工作层：Claude Code CLI
人设层：Anthropic API / OpenAI-compatible API

我会想要像claude code一样，我使用任何一个随便的命令行终端就能用一个指令把它唤起来。

而且也很想要Claude Code 的那种交互式 TUI，如果claude code给我调用确认什么的，我希望我也看得到，我也可以直接去/compact，/model什么的。

也许她也可以负责唤起Claude Code TUI？但是她自己又怎么去组织多个对话呢？

以及工作层必须是一个连续  Claude Code session。不能每次都是新的 session。

我像claude code一样和他去交互，就是我去输入，然后他会把我的请求，他直接用这个claude指令（可以配置，比如我是内网版就是claude-interval，这个配置也可以放在后面提到的面板里面，方便配置。）

然后它会有一串工作流，我就举个例子吧，就是在每个任务完成之后，他会读一遍输出，然后使用另一个人设层来和我报告。这个人设层可以直接使用api调用，它没有必要有agent'的能力。然后他可能还有写日记以及放提示音以及弹窗提示的那种功能，这些功能我之前在第2代工作流都做过，我可以和后续给你一个示例代码以及脚本。

还有一些升级的需求。

就他有一个指令可以把它的本体换出来，就换出一个界面，我在windows情况下才需要这个功能，你在那充，本来就是命令行的服务器上就不需要了.

然后换出这个界面，它可以有其他的那种功能，这些事情以后再说了。哦，那个界面可以去看，就是所有的终端的历史记录。以及所有终端的那个报告。

比如 /resume 指令帮我分出来哪个会话是哪个。

如果你看到了我方案里不成熟的地方，请你指出来，比如claude code完全可以无头，我想compact就给助手发，她透传过去。

# Claude 4.8的调研

我已经搜集到足够的技术信息。让我直接和你深入聊聊这个方案——既肯定你想法里成熟的部分，也把不成熟、会踩坑的地方明确指出来。

---

## 先给你一个总判断

你想要的这个东西，**本质上不是 "shell wrapper"，也不应该是 "orchestration wrapper"**。这两个词都会把你引向错误的架构。

- **Shell wrapper**（用 pty/tmux 包住 `claude` 的 TUI，做屏幕抓取和按键注入）——你直觉里想到的这个，是**最坏的方案**，后面详细说为什么。
- 你真正想要的是一个 **"有人设的前端 + Claude Code 作为后端引擎" 的 conductor（指挥者）**。

苏雨晴不是包在 Claude Code 外面的壳，而是**站在你和 Claude Code 之间的一个有状态的中间人**。她自己是一个 TUI 程序，Claude Code 是她驱动的一个（或多个）子进程。

---

## 一、关于"无头 vs TUI"——这是你方案里最大的纠结点

你自己在结尾已经点破了关键："claude code 完全可以无头，我想 compact 就给助手发，她透传过去。" **这个直觉是对的，请坚持它。**

来对比一下两条路：

### ❌ 路线 A：包住 Claude Code 的真实 TUI（pty/tmux 屏幕抓取）
这是你提到的 "shell wrapper / 唤起 TUI / 我也看得到确认"。问题：
1. **你无法干净地拿到结构化输出**。屏幕上是给人看的彩色文字、进度条、光标移动，苏雨晴要"读一遍工作层的输出再汇报"——她拿到的是一坨 ANSI 转义序列，解析极其脆弱，Claude Code 一升级 UI 你就全崩。
2. **人设层和工作层无法干净分离**。你说要让人设层读工作层的输出，但屏幕抓取拿到的不是"输出"，是"画面"。
3. tmux passthrough、OSC 序列这些坑（搜索结果里全是这类 issue）会让你陷入终端兼容性地狱。

### ✅ 路线 B：无头驱动 + 自建 TUI（推荐）
Claude Code 官方现在叫 **Agent SDK**（旧名就是 "headless mode"，`-p` flag 和所有 CLI 选项不变）。关键能力：

- **`--input-format stream-json --output-format stream-json`**：这是唯一的官方**双向程序化通信**通道。你往里喂 JSON 消息，它吐出 JSON 消息（包含 assistant 文本、tool_use、tool_result、权限请求等），全部结构化。
- **`canUseTool` 回调 / 权限请求**：这正是你要的"Claude Code 想做危险操作时弹确认"。在 stream-json 模式下，权限请求会作为一条消息发给你，**苏雨晴可以把它渲染成她自己 TUI 里的一个确认框**，你按 y/n，她再把结果喂回去。你说的"如果 claude code 给我调用确认什么的，我希望我也看得到"——通过这条通道，你不仅看得到，还能让苏雨晴用她的口吻问你"主人，他想删掉 xxx，要允许吗？"
- **`/compact`、`/model`**：这些斜杠命令在 stream-json 输入模式下可以作为消息发进去（你结尾说的"透传"）。苏雨晴识别到你输入 `/compact`，直接转发给工作层 session。

**结论：放弃包真实 TUI。苏雨晴自己 own 一个 TUI，Claude Code 在背后以 stream-json 双向模式跑。** 你"看得到一切、能 compact、能确认"的需求，全部通过结构化消息在你自己的 TUI 里复刻，而且复刻得更漂亮（因为可以带人设）。

> ⚠️ 一个要提前知道的坑：`--input-format stream-json` 的文档非常不全（搜索结果里有人专门提 issue 抱怨），社区踩坑多。**所以更稳妥的做法不是自己拼 CLI 命令行，而是直接用 Agent SDK（Python 或 TypeScript）**，它把 stream-json 这层封装好了（`ClaudeSDKClient` 提供双向交互会话、`canUseTool` 回调）。你只管调 SDK，别去手搓 JSON 协议。

---

## 二、"连续 session" 的真相——也是个坑

你说"工作层必须是一个连续 Claude Code session，不能每次都是新 session"。这里有两种实现，含义不同：

1. **保持子进程常驻**：用 SDK 的 `ClaudeSDKClient`（流式输入模式）开一个长连接，进程不退出，多轮对话都在同一个活着的 session 里。这是真正的"连续"，上下文在内存里。
2. **靠 `--resume <session_id>` 续接**：每次新进程，但用上次的 session ID 接上。注意搜索结果里的关键区别——`--continue`（`-c`）只是"续最近一次"，**脚本化场景不可靠**；要保证连续性必须**捕获 session_id 然后显式 `--resume`**。

**给你的建议**：日常交互用方案 1（常驻 client），但**一定要把 session_id 持久化存下来**，因为：
- 进程崩了能恢复；
- 这正好实现你想要的 `/resume 帮我分清哪个会话是哪个` —— 你自己存一张表：`session_id ↔ 项目路径 ↔ 你给它起的名字/任务描述 ↔ 时间`。苏雨晴管理这张表，你 resume 时她报菜名给你听，而不是看 Claude Code 那个干巴巴的 hash 列表。

---

## 三、你的"分层架构"——很好，但要厘清

你描述了三层，我帮你正名一下，这其实是个清晰的好设计：

| 层 | 你的描述 | 实现 | 是否需要 agent 能力 |
|---|---|---|---|
| **人设层（苏雨晴的"嘴"）** | 便宜模型，读工作层输出后用人设跟你沟通、写日记、报告 | 直接 API 调用（Anthropic / OpenAI-compatible），无工具 | ❌ 纯文本对话 |
| **工作层（苏雨晴的"手"）** | GLM-5.2 主力，干活 | Claude Code / Agent SDK，连续 session | ✅ 完整 agent |
| **文档层（你说的"可能有的第三层"）** | 维护图形化验收文档（HTML），需要调研和长上下文 | **另开一个独立的 Claude Code session** | ✅ agent，且独立 |

关于第三层（验收文档），你的判断**非常准确**：

> "直接 api 可能不足以做到，因为它需要更多上下文……我倾向于开一个简单的 claude code 会话，甚至这个会话本身也可以是连续的"

完全正确。写图形化验收文档需要：读项目代码、看 git diff、迭代式修改 HTML、可能要预览——这是 agent 任务，不是一次性 API call。**所以一个任务确实会维持两个 session**（主工作 session + 文档 session），这正是你说的。

这反过来又证明了：**苏雨晴必须能管理多个并发 session**。这也是为什么她不能是"包住单个 TUI 的壳"——壳只能管一个。她得是个**会话池管理器**。

> 💡 关于"工作层改改规则输出便于汇总的内容"：用 `~/.claude/CLAUDE.md`（全局）做这件事很对。但更干净的做法是用 **Agent SDK 的 stream-json 输出本身就是结构化的**，你能直接拿到每个 tool_use、每条 assistant 消息、最后的 result，根本不需要让模型"刻意输出便于汇总的格式"。让模型为了汇总而改变输出，反而会污染它干活的质量。**汇总交给人设层去做就好**——把结构化的 result 喂给便宜模型，让它总结成人话。

---

## 四、关于 CLAUDE.md 规则管理（你考虑得挺周到）

你说的几点都对，补充建议：
- **全局 `~/.claude/CLAUDE.md` 为主**，新项目缺规则时尝试补 —— 可以，但**别自动写，要问你**。自动改用户全局/项目配置是危险操作。
- **目录可配置** —— 必须做。你提到 `claude-internal`（内网版）可能路径不同。所以配置项要有：
  - 工作层可执行命令名（`claude` / `claude-internal` / `claude-interval`，你前面写了好几个拼法，确认一下到底是哪个）
  - CLAUDE.md 目录（默认 `~/.claude/`，可覆盖）
  - 这些都放进你说的那个"面板"里。

---

## 五、Windows 的"换出界面"需求

你说"换出本体到一个界面，只在 Windows 需要，服务器命令行版不需要；界面能看所有终端历史 + 所有报告 + resume 分会话"。

这个需求其实指向一个清晰的架构决策：**苏雨晴的核心应该是一个 headless daemon（守护进程/服务），前端是可插拔的。**

```
                    ┌─ TUI 前端（任何终端，一条命令唤起，类似 claude）
苏雨晴 core daemon ──┼─ Web 面板（Windows 上"换出"的图形界面，看历史/报告/会话）
（管理会话池、         └─ [未来] 其他前端
 人设层、日记、
 session 数据库）
```

- core 守护所有状态：会话池、session_id 映射表、历史、日记、报告、配置。
- TUI 和 Web 都只是 core 的**客户端**，连同一个 core。
- 这样 "Windows 换出界面看所有终端历史" 就是 Web 前端读 core 的数据库，天然实现；服务器上不开 Web 就行。
- 你说"换出这个界面"——其实不是"换出"，是"再连一个前端"。core 一直在。

---

## 六、我直接点出的不成熟之处（汇总）

1. **不要包真实 TUI**（最重要）。改用 Agent SDK 的双向 stream-json。你结尾的直觉是对的，全程贯彻它。
2. **不要让苏雨晴去"唤起 Claude Code TUI"**。你自己问"她又怎么组织多个对话呢"——答案是：她根本不唤起 TUI，她用 SDK 在后台开多个 headless client，每个是一个 session，她做会话池管理。TUI 是给人看的，机器对机器用结构化通道。
3. **不要手搓 stream-json 协议**，用官方 Agent SDK（Python 或 TS），它封装好了 `ClaudeSDKClient` 和 `canUseTool`。
4. **`--continue` 不可靠，存 session_id + `--resume`**。
5. **别为了"便于汇总"去改工作层输出格式**，结构化数据本来就有，汇总是人设层的活。
6. **自动补/改 CLAUDE.md 要问你，不要静默写**。
7. **拼写确认**：工作层命令到底是 `claude-internal` 还是 `claude-interval`？（你写了两种）这个要定下来，做成配置项。

---

## 七、技术选型一句话建议

- **语言**：Python 或 TypeScript（Agent SDK 两者都有官方支持）。如果你想要漂亮的 TUI，Python + Textual 很合适；TS 生态对 Web 面板更友好。考虑到你要同时做 TUI + Web 面板 + 长驻 daemon，**TypeScript/Node 一套到底可能更省心**（前后端同语言、SDK 一等公民），但如果你 Python 更熟，Python 也完全够用。
- **第三代相比你说的"第二代"**：第二代你已经做过日记/提示音/弹窗这些，这些作为人设层的"副作用动作"挂上去就行，架构上是最不需要担心的部分。

---

要不要我们下一步具体做这几件事之一：

1. **画一张完整的架构图 + 模块清单**（core daemon / 会话池 / 人设层 / 数据库 / TUI / Web 面板各自职责和接口）；
2. 你把**第二代的示例代码和脚本**发我，我帮你看哪些能直接迁移、哪些要重构；
3. 先确认几个关键决策：**语言（Py/TS）、工作层命令名、是否一开始就要 Web 面板还是先纯 TUI 跑起来**。

你想先从哪个开始？或者你先把脑子里还有的需求继续倒出来，我们先把范围聊透再动手。 $$$<i class="venus-icon icon-trag-tools mr10"></i>使用工具：<a class="ml5 mr10" target="_blank" href="https://trag.woa.com/#/tools/detail/ai_search_tools">AI搜索插件/ai_search</a><a class="ml5 mr10" target="_blank" href="https://trag.woa.com/#/tools/detail/ai_search_tools">AI搜索插件/ai_search</a>$$$

# 设计者的回复

我们就叫她指挥官吧。不硬写名字。

--permission-mode 用 auto的就好，我觉得auto的非常好。

说实话你说的头头是道，我都不知道该怎么。唉我我其实接受你说的所有事情，然后我比较喜欢ts啊，因为反正都是ai在写嘛。但是这个ts也能也能做到，就是我一打开这个命令行。我是我直接说这个程序名字他就能换起来吗？你就像Claude，其实我无论在哪里都换得出来。

我看了工作层是claude-internal（公司内网版），但是我自己也有一个 claude（我在家里和在公司都用），所以这东西甚至可能需要一键切换。claude-internal的话有些文档：


## 规则放置位置

> spec coding 乃至 agentic engineering最重要的规则，从IDE转过来，最大的摩擦就是规则的摩擦了，harness（工具、记忆、约束、反馈回路）要重新造，它不读目录下的`.codebuddy`或者其他AI IDE的目录。

- **项目规则**在根目录的 `CLAUDE.md`
- **个人规则**在 `~/你的用户名字/.claude-internal` 目录下的 `CLAUDE.md` 里面。对Windows来说，这个目录是 `C:\Users\你的用户名字\.claude-internal`

**注意：** 我们内网版的个人目录是 `.claude-internal` 目录，如果你问它本身它会说是 `.claude` 目录，但那不对。但是项目目录还是`.claude`


然后示例脚本我就直接和你说吧，就是我写了一个powershell的自动在项目目录里写日记。和自动提示音和弹窗的脚本。嗯，虽然说你可以直接进行更好的重新设计，因为我们都用ts了。

你觉得这个项目应该叫什么？我准备建github仓库。然后我确实意识到tui其实就是一种界面，但但我其实就是这个人设他是有立绘的呀，因他还有一些CG可以看，所以我希望一开始还是有外部面板比较好。但我觉得我也需要一个完整的。TUI。哦，但我还有另一个想法，就是我以后想要做远程的code server。云服务器，接入CLI，通过服务器和客户端一起写一块安全的公告板（CloudFlare Access控制）的方式，我给服务器发指令。服务器通过特定信道向我的手机发消息，同时也写公告板。

这种是不是要单独写了，就超出我们需求的范围了，还是说我们的需求完全可以兼容那种无头模式？

# claude 4.8的回复

好，叫**指挥官**，人设和代号分离——这个决定很对。`--permission-mode auto`（其实现在叫 `acceptEdits` / `default` 那套里的 auto 行为）也合理，省去大量确认噪音，需要时再让指挥官把真正高危的操作拦下来问你就行。

下面逐个回答你的问题。

---

## 1. TS 能不能做到"在任何地方打一个名字就唤起"？

**能，而且这正是 `claude` 自己的做法。**

机制很简单：你的 `package.json` 里写一个 `bin` 字段：

```json
{
  "name": "your-project",
  "bin": { "commander": "./dist/cli.js" }
}
```

然后 `npm install -g .`（或发布后 `npm i -g your-project`）。npm 会在全局 PATH 里放一个软链接/shim，于是你在**任何目录**下敲 `commander` 都能唤起。Windows 上 npm 会自动生成 `.cmd` shim，所以 PowerShell / CMD / Git Bash 都认。`claude` 本身就是个 Node 包，走的就是这条路，所以你的体验会和它一模一样。

> 一个细节：如果你想要"零安装、双击就能跑"的单文件 exe（给不装 Node 的机器），可以用 `bun build --compile` 或 `pkg` 打包成单可执行文件。但你自己开发机有 Node，`npm i -g` 就够了。

---

## 2. `claude` ↔ `claude-internal` 一键切换

你贴的文档暴露了一个**很重要的坑**，我们必须在配置层面把它建模成"profile（环境档案）"，而不是单个变量：

| | 家里版 `claude` | 内网版 `claude-internal` |
|---|---|---|
| 可执行命令 | `claude` | `claude-internal` |
| **个人规则目录** | `~/.claude/` | `~/.claude-internal/`（注意！它自己会说是 `.claude` 但那是错的） |
| 项目规则 | 根目录 `CLAUDE.md` | 根目录 `CLAUDE.md`（一样） |
| 项目目录 | `.claude/` | `.claude/`（一样，没改） |

所以配置不能是 "一个命令名" 这么简单，得是一组**profile**：

```jsonc
// 指挥官的配置
{
  "activeProfile": "home",
  "profiles": {
    "home": {
      "command": "claude",
      "personalDir": "~/.claude"          // 全局 CLAUDE.md 在这
    },
    "internal": {
      "command": "claude-internal",
      "personalDir": "~/.claude-internal" // 注意是这个，不是 .claude
    }
  }
}
```

"一键切换"就是把 `activeProfile` 从 `home` 切到 `internal`。在面板里做成一个下拉/开关，或者 TUI 里一条命令 `/profile internal`。**切换只影响新开的 session，已经在跑的 session 不动**（它绑死在自己启动时的 profile 上）。

这样设计还有个好处：以后你那个云服务器版可能又是另一套命令/路径，再加一个 profile 就行，架构不用改。

---

## 3. 项目叫什么

既然本体是"机械女仆"、代号"指挥官"、干的活是**调度一群 Claude Code 工人 session**——这其实是一个经典的"管家/总管调度仆役"的隐喻。我给你几个方向，按我的偏好排序：

**第一梯队（管家/总管隐喻，和"女仆调度工人"最贴）：**
- **`majordomo`** —— 大管家、宅邸总管，统领所有仆役。语义和你的架构（一个调度者管多个 worker session）**完美契合**，而且这个词本身够酷、不烂大街。我最推荐这个。
- **`seneschal`** —— 中世纪封邑的总管家，掌管家务与调度。更古典、更有"机械女仆+忠诚执事"的味道，但拼写稍难记。

**第二梯队（指挥/编排隐喻）：**
- **`maestro`** / **`conductor`** —— 指挥家，呼应"指挥官"。但 conductor/maestro 在开源界已经有一堆同名项目了，容易撞车。
- **`podium`** —— 指挥台。比较新颖，没人用。

**第三梯队（信使/桥接隐喻，呼应你未来的远程推送）：**
- **`hermes`** —— 信使神，呼应"读完输出来向你汇报 / 推消息到手机"。但 Hermes 这名字被用烂了。

**我的建议**：仓库名用 **`majordomo`**（或带个前缀避免 npm 撞名，比如 `majordomo-cli`），代号"指挥官"，人设名你以后再起立绘角色名。三层命名（仓库名 / 代号 / 角色名）分离，正好对应你"不硬写名字"的原则。

---

## 4. 外部面板 + 完整 TUI，一开始都要

你的理由很正当——**人设有立绘、有 CG**，这种东西 TUI 表现不了，必须有图形面板。所以我们上一轮讲的那个架构现在变得更有必要了：

```
              ┌─ TUI 客户端（任何终端，一条命令 commander）
指挥官 core ──┼─ Web 面板（看立绘/CG、会话历史、报告、profile 切换）
（daemon）     └─ [未来] 手机 / 远程
```

**关键决策：core 和前端从第一天就分离。** core 是个长驻进程（管会话池、人设层、session 数据库、profile），前端（TUI 和 Web）都是它的客户端，通过本地通信（WebSocket / IPC）连上来。

- 这样 TUI 和 Web 看到的是**同一份状态**——你在 TUI 里开的会话，Web 面板立刻能看到、能 resume。
- 立绘/CG 这种放 Web；TUI 给纯键盘党 / 服务器场景。
- **不要先做单体再拆**，那是返工。一开始就 core/client 分离，初期 TUI 可以简陋，但通信协议先立好。

> 提醒一个范围控制：第一个里程碑别一上来就做立绘动画。先让 core + 一个能跑通"你输入→工作层 session→人设层汇报"的最小 TUI 跑起来，Web 面板先做个"能看会话列表和历史"的朴素版本，立绘/CG 作为面板的迭代后续加。否则你会卡在画面上迟迟跑不通主链路。

---

## 5. 远程 code server / 推手机 / 公告板——这是同一个架构的自然延伸，**不用单独写**

这是我特别想强调的好消息：**你这个"远程"愿景，恰恰证明了我们前面选的 core daemon 架构是对的，它天生兼容。**

理由：因为我们坚持了"**Claude Code 全程无头（headless / SDK），core 是个长驻 daemon，前端只是客户端**"这个原则，所以"远程"在架构上**只是再接入一种客户端 + 一个推送出口**而已：

```
           云服务器
   ┌──────────────────────────┐
   │  指挥官 core (daemon)      │
   │   ├─ Claude Code sessions │ ← 无头，本来就不需要屏幕
   │   ├─ 会话池 / 数据库       │
   │   └─ 人设层               │
   └──────────┬───────────────┘
              │
      ┌───────┼─────────────────┐
      │       │                 │
   公告板   推送信道          你的客户端
 (Cloudflare (→ 手机)        (TUI / Web，
  Access 控制)                 从家里连上来)
```

- **Claude Code 无头**这一点，让它能在没有显示器的云服务器上跑——如果你当初选了"包真实 TUI"，这套远程方案直接没法做（TUI 要终端、要屏幕）。所以你之前那个"无头就好"的直觉，在这里又赢了一次。
- **公告板（Cloudflare Access 控制）** = core 的又一个"输出前端"，把人设层的汇报同时写到一个受 CF Access 保护的 Web 页面。
- **推手机** = 人设层的一个"副作用动作"（和你第二代做的弹窗/提示音/日记是同一类东西，只是出口从本地弹窗换成了推送服务，比如 ntfy / Bark / Telegram bot）。
- **你给服务器发指令** = 远程客户端连到 core 的同一个通信协议。

**所以结论：** 不用现在单独写，但要做一件"现在不花成本、以后省大钱"的事——**core 的通信层从一开始就设计成可以走网络（WebSocket），而不是写死成只能本机 IPC**。本地用的时候它就监听 `localhost`，远程的时候加上 CF Access / TLS 即可。人设层的"通知动作"做成**可插拔的 notifier 接口**（本地弹窗是一个实现，推手机是另一个实现）。

这两个抽象（网络通信层 + 可插拔 notifier）现在花几乎为零的额外设计成本，就能让远程愿景"水到渠成"。**这才是把它纳入范围的正确方式：不实现，但不堵死。**

---

## 当前明确的决策清单

- ✅ 代号"指挥官"，仓库名建议 **`majordomo`**（待你拍板）
- ✅ TypeScript，npm `bin` 全局安装，体验对标 `claude`
- ✅ 工作层 = Agent SDK 无头，`--permission-mode auto`
- ✅ profile 机制做 `claude` / `claude-internal` 一键切换（注意 `.claude-internal` 个人目录陷阱）
- ✅ core daemon + 客户端分离，TUI 和 Web 面板都从一开始就在协议层立好
- ✅ 通信层设计成可走网络、notifier 做成可插拔——为远程愿景留口子但不实现

---

下一步我建议二选一：

**A.** 你把第二代那个 **PowerShell 日记 / 提示音 / 弹窗脚本**发我，我帮你把它的"行为"抽象成 TS 里的 notifier 接口（这样能顺带验证我们的 notifier 抽象设计对不对）。

**B.** 我直接给你画**完整的模块清单 + 目录结构 + 通信协议草案**（core / 会话池 / 人设层 / notifier / TUI / Web 各自接口），你照着就能让 AI 开干。

# 设计者的回复2

就叫majordomo吧，虽然命名撞了但是npm可以搞作用域包。

我准备建立仓库了，嗯，请你给我一些建立仓库所需要的信息。

# Claude 4.8的整理

明白了，素材是你自己的 OC，那版权顾虑不存在，公开仓也完全没问题。下面是给你建仓用的**完整总结信息**，可以直接照着填。

---

# majordomo —— 建仓总结

## 一、仓库基本信息

| 字段 | 值 |
|---|---|
| **Repository name** | `majordomo` |
| **Visibility** | Public |
| **License** | AGPL-3.0 |
| **Description**（GitHub 简介） | `A persona-driven, multi-session orchestrator for Claude Code. Headless workers, a character frontend, TUI + Web panel.` |
| **Topics** | `claude-code` `agent-sdk` `ai-orchestration` `typescript` `tui` `cli` `headless` `multi-agent` |
| **初始化勾选** | README ✅ / .gitignore (Node) ✅ / License (AGPL-3.0) ✅ |

---

## 二、项目定位（一句话）

> 一个**有人设前端**的 **Claude Code 多会话调度器**。代号"指挥官"。
> 工作层无头干活，人设层用人话向你汇报，前端有 TUI + 带立绘/CG 的 Web 面板。

---

## 三、核心架构决策（已敲定）

1. **不包真实 TUI**。工作层全程走 **Claude Code Agent SDK（headless / stream-json 双向）**，不做屏幕抓取。
2. **core daemon + client 分离**，从第一天就立好。TUI 和 Web 都是 core 的客户端，看同一份状态。
3. **通信层用 WebSocket**，初期监听 localhost，为未来远程接入留口子（不实现，但不堵死）。
4. **三层模型分工**：
   - 人设层：轻量 API 模型（Anthropic / OpenAI-compatible），无 agent 能力，负责汇报 / 日记 / 通知。
   - 工作层：Claude Code，连续 session，`--permission-mode auto`。
   - 文档层：按需另开独立 Claude Code session（如写图形化验收文档）。
5. **连续 session**：日常用常驻 SDK client；**务必持久化 session_id**，用 `--resume` 续接（不依赖 `--continue`）。`/resume` 时由指挥官报会话的菜名（绑定项目/任务/时间）。
6. **不为"便于汇总"改工作层输出**——结构化数据 SDK 本就有，汇总交人设层。
7. **CLAUDE.md 自动补全要先问你**，不静默写。
8. **notifier 可插拔**（弹窗/提示音/日记 = 本地实现；未来推手机 = 另一实现）。

---

## 四、Profile 机制（claude / claude-internal 一键切换）

> 关键坑：内网版个人目录是 `.claude-internal`，**不是** `.claude`（它自己会说错）；项目目录仍是 `.claude`、项目规则仍是根目录 `CLAUDE.md`。

```jsonc
{
  "activeProfile": "home",
  "profiles": {
    "home":     { "command": "claude",          "personalDir": "~/.claude" },
    "internal": { "command": "claude-internal",  "personalDir": "~/.claude-internal" }
  }
}
```
- 切换只影响**新开**的 session，已跑的不动。
- 面板/TUI 里都能切（`/profile internal`）。
- 未来云服务器版再加一个 profile 即可。

---

## 五、全局唤起方式

`package.json` 配 `bin`，`npm i -g` 后任意目录敲 `commander` 唤起（对标 `claude` 的体验，Windows 自动生成 `.cmd` shim）。

```json
{ "bin": { "commander": "./dist/cli.js" } }
```

---

## 六、初始目录结构

```
majordomo/
├─ src/
│  ├─ core/        # daemon、会话池、profile、数据库
│  ├─ worker/      # Claude Code Agent SDK 封装（headless）
│  ├─ persona/     # 人设层（API 调用、汇报）
│  ├─ notify/      # 可插拔 notifier（弹窗/提示音/日记/未来推手机）
│  ├─ protocol/    # core↔client 通信协议（WebSocket）
│  ├─ tui/         # 终端客户端
│  ├─ web/         # Web 面板（立绘/CG/历史/会话管理）
│  └─ cli.ts       # bin 入口（commander）
├─ config.example.jsonc
├─ .env.example
├─ .gitignore
├─ LICENSE
├─ package.json
└─ README.md
```

---

## 七、`.gitignore`

```gitignore
# 依赖与构建
node_modules/
dist/
*.tsbuildinfo

# 环境与密钥
.env
.env.*
!.env.example

# 本地运行时数据（会话/日记/历史/缓存）
.commander/
data/
*.db
*.sqlite

# 你的真实配置（profile 模板用 .example 提交）
config.jsonc
config.json

# 日志
*.log
logs/

# 系统
.DS_Store
Thumbs.db
```
> 注：你的立绘/CG 是自有 OC 素材，可以进仓；但**真实运行数据（对话历史/日记/session 库）和密钥仍建议 gitignore**，纯属隐私和整洁考虑，不是版权问题。

---

## 八、配套示例文件

**`.env.example`**（提交，无真值）
```bash
PERSONA_API_KEY=
PERSONA_API_BASE=
PERSONA_MODEL=
```

**`config.example.jsonc`** —— 即上面第四节那段 profile 配置。

---

## 九、README 骨架

```markdown
# majordomo（代号：指挥官）

> A persona-driven multi-session orchestrator for Claude Code.
> 一个有人设前端的 Claude Code 多会话调度器。

## What it is
- 工作层：Claude Code (Agent SDK, headless)，多并发 session，permission-mode auto
- 人设层：轻量 API 模型，负责汇报 / 日记 / 通知，无 agent 能力
- 前端：TUI（任意终端一条命令唤起）+ Web 面板（立绘 / CG / 历史 / 会话管理）
- core daemon + client 架构，WebSocket 通信，为远程接入预留

## Status
🚧 Early WIP. Not usable yet.

## Profiles
支持 claude / claude-internal 一键切换（注意 .claude-internal 个人目录差异）。

## Roadmap
- [ ] core daemon + 会话池 + session_id 持久化
- [ ] worker：Agent SDK 封装（headless，连续 session）
- [ ] 最小 TUI 跑通主链路（你输入 → 工作层 → 人设层汇报）
- [ ] Web 面板（会话列表 / 历史）
- [ ] 人设层 + notifier（弹窗 / 提示音 / 日记）
- [ ] 立绘 / CG
- [ ] 远程接入（Cloudflare Access / 推手机）

## License
AGPL-3.0
```

---

仓库建好后，下一步建议走 **B：完整模块职责说明 + core↔client 通信协议草案**，或者你把第二代 PowerShell 脚本发我先定 `src/notify/` 接口。你建完仓告诉我走哪个就行。

# 开始开发

我已经建立了一个比较空的项目。你可以开始工作了，从头开始工作做一个长任务，你看到的那个规则就是第2代工作流，我尽量把第2代工作流的东西都放到了这个仓库里，以及全局的规则。

有一点补充，还有一套配置是tclaude，指令就是这个，全局配置是.tclaude。我注意到interval被弃用了。一样的。