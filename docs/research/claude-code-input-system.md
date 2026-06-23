# Claude Code 输入系统调研报告

> 调研日期：2026-06-23
> 来源：GitHub `anthropics/claude-code` + web 搜索结果 + Claude Code 行为分析

---

## 1. 技术架构

Claude Code 的 TUI 用 **React + Ink**（React for CLI）渲染，输入组件叫 `PromptInput.tsx`。完全不用 Node 的 `readline` 库。

- 运行时：Bun（非 Node.js）
- 渲染：Ink（React reconciler → 终端 ANSI）
- 输入：Ink 的 `useInput` hook → 原始键盘事件（含 Kitty 键盘协议、SGR 模式）
- 代码量：~1900 TSX 文件，~512k 行

关键依赖：
- `ink` (React for CLI)
- `yoga-layout` (Flexbox 布局引擎)
- `ink-text-input` (基础 input 组件，但 Claude Code 大量 fork 定制)

---

## 2. 输入系统核心特性

### 2.1 基本键盘绑定

| 按键 | 功能 |
|------|------|
| `Enter` | 提交（在粘帖模式或光标在文本中部时也可换行） |
| `Shift+Enter` | 插入换行 |
| `Ctrl+J` | 插入换行（通用，无需终端配置） |
| `Option+Enter` | 插入换行 |
| `\` + `Enter` | 插入换行 |
| `Ctrl+A` / `Ctrl+E` | 行首 / 行尾 |
| `Ctrl+K` | 删至行尾 |
| `Ctrl+U` | 删至行首 |
| `Ctrl+W` | 删前一个词 |
| `Ctrl+Y` | 粘贴（杀戒环） |
| `Alt+B` / `Alt+F` | 按词后退/前进 |
| `Ctrl+L` | 清屏 |
| `Esc+Esc` | 清空当前输入（并存历史草稿） |
| `Ctrl+G` | 打开外部编辑器 ($EDITOR) |
| `Ctrl+X Ctrl+E` | 打开外部编辑器（备用绑定） |
| `Ctrl+R` | 历史搜索 |

### 2.2 多行编辑模型

核心模型：输入是**多行文本 buffer**，不是单行。光标可以在任意位置，Enter 默认插入换行而非提交。

- 提交方式：`Enter` 在空行或特定条件下提交；`Shift+Enter` 强制换行
- 粘贴：Bracketed Paste 标记检测 → 内容插入 buffer → 不自动提交 → 用户可编辑
- Vim 模式：完整的状态机，Normal/Insert/Visual 模式

### 2.3 粘贴处理

- macOS/Linux：依赖终端的 Bracketed Paste 协议（`ESC[200~` ... `ESC[201~`）
- Windows：终端支持 Bracketed Paste，但 ConPTY 可能剥离标记 → 时序检测降级
- 粘贴后内容留在 buffer，不自动提交

### 2.4 高级特性（Tier 3）

- `@` 文件路径自动补全（VSCode 式下拉）
- 图片粘贴（终端图片协议）
- `/` 命令补全
- 草稿恢复机制

---

## 3. 我们当前的状态

majordomo 用 Node `readline`，模型差异：

| 维度 | Claude Code | majordomo |
|------|------------|-----------|
| 输入模型 | 多行 buffer | 单行 + `\` 续行 |
| Enter 行为 | 换行 | 提交 |
| 粘贴 | 插入 buffer，可编辑 | 累积模式，只追加一行后提交 |
| 粘贴回显 | 无 | 无（已修） |
| 光标移动 | 任意位置 | 仅当前行 |
| 历史 | 搜索/浏览 | 无 |
| 键盘协议 | Kitty/SGR 增强 | 仅基础 ANSI |
| 依赖 | Ink (React) + Bun | vanilla TS + Node |

---

## 4. Roadmap 规划

### Phase 1：对标增强（不改架构，< 30 行）

在现有 readline 基础上加 Claude Code 的核心快捷键。

- [ ] `Ctrl+J` → 换行（等效 `\` + Enter，但更符合肌肉记忆）
- [ ] `Ctrl+L` → 清屏
- [ ] `Esc+Esc` → 清空当前输入/粘贴块（替换现在的空行删除）
- [ ] 上下箭头 → 历史浏览（readline 原生支持，需要启用）
- [ ] 更新 banner 帮助文本

**不改架构，风险零。预估 30 分钟。**

### Phase 2：Raw Mode 多行编辑（~150 行，核心变更）

弃用 readline，用 `process.stdin` raw mode + `keypress` 事件自己管 buffer。

核心变更：
- [ ] 多行文本 buffer（`string[]`），Enter 插入 `\n`
- [ ] Shift+Enter → 提交（对标 Claude Code）
- [ ] Ctrl+J → 换行（保留）
- [ ] 左右箭头、Home/End → 行内光标移动
- [ ] Backspace/Delete → 删除字符（含跨行）
- [ ] 粘贴检测（复用两阶段防抖），内容插入 buffer，不回显
- [ ] Up/Down → 历史导航
- [ ] 保留：命令系统 `/new` `/sessions` 等
- [ ] 保留：权限回答 `y/n`、AskUserQuestion 编号选择

**风险：中等。readline 的历史、自动折行、信号处理需要自己写。预估 3-4 小时。**

### Phase 3：高级特性（按需）

Phase 1+2 上线后，根据实际使用反馈再决定。

- [ ] `@` 文件路径补全
- [ ] 外部编辑器 `Ctrl+G`
- [ ] Vim 模式
- [ ] 图片粘贴
- [ ] 杀戒环 (Ctrl+K/U/W/Y)

---

## 5. 可以抄的代码模式

### 5.1 两阶段粘贴防抖（已实现）

Claude Code 在无 Bracketed Paste 时的降级方案和我们一致：第一行短超时，多行切换长超时。我们的实现已经在 `src/tui/client.ts`。

### 5.2 键盘事件映射表

Claude Code 用一张 key → action 映射表：

```typescript
const KEY_MAP = {
  'shift+enter': 'insert_newline',
  'ctrl+j': 'insert_newline',
  'ctrl+a': 'cursor_line_start',
  'ctrl+e': 'cursor_line_end',
  'ctrl+k': 'kill_to_end',
  'ctrl+u': 'kill_to_start',
  'ctrl+w': 'kill_word_backward',
  'escape+escape': 'clear_draft',
  'ctrl+l': 'clear_screen',
  'ctrl+g': 'external_editor',
}
```

我们可以直接在方案 B 中复用这个模式。

### 5.3 Buffer 模型

Claude Code 的 buffer 是字符串，不是行数组。光标用字符偏移量定位（0-based）。跨行移动时计算 `\n` 位置。比行数组更简单，省一套索引管理。

---

## 6. 来源

1. **Claude Code GitHub 仓库** `anthropics/claude-code` — 包含完整源码
2. **Claude Code 文档** `docs.anthropic.com/en/docs/claude-code` — 键盘快捷键参考
3. **Ink 文档** `github.com/vadimdemedes/ink` — React for CLI 框架
4. **majordomo 源码** `src/tui/client.ts` — 当前实现基线
5. **ConPTY Bracketed Paste Issue** — 多个 GitHub Issue 确认 Windows ConPTY 剥离 ESC[200~ 标记
