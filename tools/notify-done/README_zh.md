[English](README.md) | **中文**

# notify-done

AI 任务完成后的交接提醒：**提示音 + 中文语音播报 + 持久浮窗**。

浮窗不阻塞 AI 执行链路，需人工确认关闭。

## 用法

```powershell
powershell -ExecutionPolicy Bypass -File notify-done.ps1 "你的交接消息"
```

## 参数

| 参数 | 说明 |
|------|------|
| `-Message <string>` | 提醒正文（默认 "任务完成！"） |
| `-Volume <0-100>` | 语音音量（默认 100） |
| `-NoBeep` | 不播放提示音 |
| `-NoPopup` | 不弹浮窗 |

## 浮窗按钮

- **知道了** — 关闭提醒
- **10/30 分钟后** — 延后再弹
- **复制** — 复制正文到剪贴板

## 文件结构

| 文件 | 作用 |
|------|------|
| `notify-done.ps1` | 主脚本（提示音 + 任务栏闪烁 + TTS + 启动浮窗） |
| `notify-popup.ps1` | 浮窗脚本（独立进程，WinForms UI） |
| `notify-tone.ps1` | 提示音合成器（纯 PowerShell 逐采样生成 WAV） |
| `notify-done.config.ps1` | 默认配置（颜色、字体、音量、时长等） |
| `音效设计探索记录.md` | 音效设计探索与迭代记录 |

## 配置

所有可调参数（默认音量、TTS 语速、浮窗颜色/字体/窗口尺寸、音效时长等）都集中在 `notify-done.config.ps1` 中。

**不要直接改这个文件！** 请在同目录下创建 `notify-done.config.user.ps1`，只写你想覆盖的项：

```powershell
# notify-done.config.user.ps1（示例）
$Config.DefaultVolume = 60
$Config.TTS.Rate = 1
$Config.Popup.AccentColor = @(255, 128, 0)
```

用户配置在默认配置之后加载，会覆盖同名项。`notify-done.config.user.ps1` 已被 gitignore。

## 建议的 Message 写法

写成 **结果 / 风险 / 下一步**，让浮窗成为可执行的交接卡片：

```text
完成内容：用户导出模块重构已完成，支持 CSV 和 Excel。
风险说明：大数据量场景尚未压测。
建议下一步：请用生产数据跑一次导出验证。
```
