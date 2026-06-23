# 交接文档：对标 Claude Code 输入系统

> 日期：2026-06-23
> 状态：调研完成，Phase 1 待开工
> 上一位：tobenot

---

## 做了什么

- 调研了 Claude Code 的输入系统架构（Ink/React + 自定义 raw stdin）
- 修复了 Windows ConPTY 下多行粘贴的四个问题：防抖漏行、确认机制、回声抑制、尾行丢失
- 写了完整调研报告：`docs/research/claude-code-input-system.md`

## 当前状态

`src/tui/client.ts` 基于 Node `readline`，已实现：
- 两阶段粘贴防抖（10ms → 100ms）
- 多行粘贴累积模式
- 粘贴内容不回显
- 尾行捕获（`rl.write("\n")` 冲 readline buffer）
- 累积模式下：空行删除，打字回车提交
- `/clear` = `/new` 别名

## 下一步：Phase 1（对标增强，不改架构）

文件：`src/tui/client.ts`，改动量 < 30 行。

1. **Ctrl+J → 换行**  
   在 `setupReadline` 里监听 keypress，检测到 `ctrl+j` 时 `rl.write("\n")`

2. **Ctrl+L → 清屏**  
   写 `\x1b[2J\x1b[H` 到 stdout，再 `rl.prompt()`

3. **Esc+Esc → 清空粘贴块**  
   在 `processLine` 里检测空行 → 清 `pendingPaste`（已有）
   考虑加 `esc` 计数器检测双击 Esc

4. **上下箭头 → 历史**  
   readline 自带 `history` 属性，push 每条输入即可

5. **更新 banner 文字**  
   加 `Ctrl+J 换行 | Ctrl+L 清屏 | Esc+Esc 清空`

## Phase 2（需更多时间）

切 raw mode，对标 Claude Code 多行编辑模型。详见调研报告的 Phase 2 清单。

## 已知限制

- readline 不支持 Enter 换行 + 光标跨行移动
- Windows ConPTY 剥离 Bracketed Paste 标记 → 依赖时序防抖
- 粘贴后不能在 buffer 内编辑（readline 行模型固有限制）

## 相关文件

| 文件 | 内容 |
|------|------|
| `docs/research/claude-code-input-system.md` | 完整调研报告 + Roadmap |
| `src/tui/client.ts` | TUI 客户端（所有变更在这里） |
