# Bifrost 探针版（v0 · 施工第 0 步）

对应设计稿 `docs/design/bifrost-hub-v1.md` §2.6。

**这不是正式插件。** 唯一目的：把每个 hook 的 stdin 原样落盘，实测各事件真实 payload 形状，再据实回填设计稿的事件表/载荷（§2.2 / §2.5），然后才写正式的 `report.ps1`。「加日志定位」代替「拿文档当真」。

## 装上（开发期）

```bash
claude --plugin-dir ./bifrost        # 从磁盘目录直接加载
# 改完热载：/reload-plugins
```

订阅了 6 个候选事件：`SessionStart` `Stop` `Notification` `TaskCreated` `TaskCompleted` `SessionEnd`。每次触发，`scripts/probe.ps1` 把 stdin 原样追加一行到本目录的 `dump.jsonl`：

```jsonc
{ "receivedAt": "<ISO 时刻>", "rawStdin": "<hook 原始 stdin 文本>" }
```

## 怎么用

1. 装上，开一个真实 CC 窗口干点活（触发回合结束、建任务、等许可、退出）。
2. 看 `dump.jsonl` 里各事件到底长什么样——尤其确认：
   - `Stop` 是否真的**不带**助手输出文本（只有公共字段）；
   - `TaskCreated` / `TaskCompleted` 是否存在、带哪些字段；
   - `Notification` 的语境字段。
3. 据实回填设计稿，再写正式 `report.ps1`（读 transcript + 上报 /ingest + 本地提示音）。

## 已知小事

- 脚本必须存为 **UTF-8 with BOM**，否则 PowerShell 5.x 按 ANSI 读，中文注释会让脚本解析失败。
- PS 5.x 的 `Add-Content -Encoding UTF8` 会在 `dump.jsonl` **文件首**写一个 BOM，只影响第一行开头，肉眼分析无碍；若用严格 JSONL 解析器读，记得跳过首字节。
- 探针只写盘、不上报、不阻断、无本地副作用，永远 `exit 0`。
