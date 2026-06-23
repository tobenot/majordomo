# 交接文档：Phase 2 Raw Mode 多行编辑

> 日期：2026-06-23
> 状态：Phase 1 + 2 完成，待手动验证
> 上一位：tobenot

---

## 做了什么

**Phase 1** (`788998e`)：在 readline 上加 Ctrl+J 换行、Ctrl+L 清屏、Esc+Esc 清空、历史箭头、banner 更新。

**Phase 2** (`df01c2a`)：完全弃用 readline，切 `process.stdin.setRawMode(true)` + `emitKeypressEvents` 自己管理原始键盘事件。实现了多行文本 buffer（`string + character offset`，Claude Code 同款模式）、光标移动、行编辑快捷键、历史导航、粘贴插入 buffer 可编辑。

## 当前状态

`src/tui/client.ts` — 唯一变更文件，~560 行。build + selftest 通过。

关键设计决策：
- **Enter 提交，Shift+Enter/Ctrl+J 换行** — 保留单行快路径（majordomo 90% 输入场景）
- Buffer 模型：单个 string + 字符偏移量 cursor
- 渲染：每次输入全量清屏重绘（`\x1b[NA` + `\x1b[0J`），跟踪 `renderedLines`
- 特殊模式（y/n 权限、AskUserQuestion）用单行阻塞输入，不碰主 buffer

## 待手动验证

build + selftest 只验证协议链路，**raw mode 键盘交互需要真实终端验证**：

| 验证项 | 操作 | 预期 |
|--------|------|------|
| 单行提交 | 打字 + Enter | 正常发送 |
| 多行 Ctrl+J | 打一行 → Ctrl+J → 再打一行 → Enter | 多行合并发送 |
| 多行 Shift+Enter | 同上 | 同上 |
| 光标移动 | 输入多行 → 左右箭头 / Home/End / Ctrl+A/E | 光标正确移动 |
| 行编辑 | Ctrl+K / Ctrl+U / Ctrl+W | 删除正确 |
| 粘贴多行 | 粘贴多行文本 | 内容留在 buffer，可编辑后 Enter 提交 |
| 上下箭头历史 | 上下箭头 | 历史导航，编辑后回 -1 |
| Ctrl+L | 清屏 | 屏幕清空，buffer 保留 |
| Esc+Esc | 双击 Esc | buffer 清空 |
| Ctrl+C 空闲 | 无 session 或 idle 时 Ctrl+C | 退出 |
| Ctrl+C 打断 | session busy 时 Ctrl+C | 发 interrupt |
| y/n 权限 | 触发权限请求 | 单行 y/n 输入，不干扰 buffer |
| AskUserQuestion | 触发多选 | 输入编号选择 |
| 命令 | `/new` `/sessions` `/resume` 等 | 正常工作 |

## 已知限制

1. **长行折行**：naive 折行（无词边界检测），中英文混排可能显示偏移
2. **中文/emoji**：宽字符（2 列宽）未做特殊处理，光标可能偏位
3. **ConPTY 粘贴**：Windows 剥离 Bracketed Paste 标记时，粘贴内容逐字插入（没问题，只是看起来像快速打字）
4. **Yank 未实现**：Ctrl+K/U/W 删了但 Ctrl+Y 不会贴回

## 下一步候选

1. **手动验证**（最急）— 见上表
2. **Ctrl+Y yank**（~10 行）— 杀戒环闭环
3. **Ctrl+G 外部编辑器**（~30 行）— `$EDITOR` / `notepad`
4. **宽字符修正** — 需要 `wcwidth` 或类似，影响不大
5. **Phase 3 高级特性** — 调研报告 Roadmap 里有完整清单

## 代码关键路径

```
start() → setupRawMode()
  ├─ emitKeypressEvents + setRawMode
  ├─ printBanner() + renderBuffer()
  └─ stdin.on('keypress') → dispatch
       ├─ normal mode → buffer ops → renderBuffer()
       │   └─ Enter → submit() → submitText() or handleCommand()
       ├─ Ctrl+C → handleCtrlC()
       ├─ paste markers → pasting state
       └─ special modes → handleSpecialKeypress()
            └─ Enter → handlePermissionAnswer/handleAskAnswer → back to normal

println() → clearRender() + write + renderBuffer()
renderBuffer() → clear old + draw prompt+buffer + position cursor
```

参照文件：`src/tui/client.ts`，调研报告：`docs/research/claude-code-input-system.md`
