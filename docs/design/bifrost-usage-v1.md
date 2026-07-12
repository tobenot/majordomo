# Bifrost usage / ctx 上报 v1

> 承接 `session-metrics-v1.md`（miss% 仍走 transcript）与 statusline 双端适配。  
> 目标：CC 与 Cursor **都**把上下文占用与 token 用量送进虹桥中枢；Cursor **不算** miss%。

## 要什么

| 信号 | 用途 | Cursor | Claude Code |
|---|---|---|---|
| `usedPercent` + `windowSize` | 上下文多满、上限多少 | ✅ | ✅ |
| 本轮 token（last in/out，可选 cache_read） | 刚结束这一下花了多少 | ✅ | ✅ |
| 累计 / 窗内 total in/out | 会话量级 | ✅ | ✅ |
| miss% / 轮数 / 慢峰 | 缓存塌方旁观 | ❌ 无意义则不装 | ✅ 原 transcript 路不动 |

## 定路（瘦）

statusline 是唯一稳定带 `context_window` 的通道；hook 多数不带。

1. **`bifrost-statusline.ps1`**：每次刷新写 `bifrost/cache/usage-<session_id>.json`（不 POST，避 timeout）。
2. **`report.ps1`**：组 envelope 时若该文件存在 → `payload.usage` 透传。
3. **中枢**：`WindowInfo.usage` 覆盖更新；有 transcript 的 CC 窗口继续算 `metrics`（miss%）。
4. **面板**：列表/详情显示 `ctx N% · 200k` 与本轮/累计 token；有 `metrics` 再显示 miss 行。

## 文件形状

```json
{
  "usedPercent": 18,
  "windowSize": 200000,
  "lastInputTokens": 1200,
  "lastOutputTokens": 340,
  "lastCacheReadTokens": 88000,
  "totalInputTokens": 15234,
  "totalOutputTokens": 5456,
  "updatedAt": 1710000000000
}
```

字段全可选；宿主缺什么就空什么。`total_*` 语义随宿主版本（窗内 vs 会话累计），v1 原样显示、不重定义。

## 不做

- statusline 直 POST 中枢  
- 给 Cursor 伪造 miss%  
- 改 transcript 读器口径  
