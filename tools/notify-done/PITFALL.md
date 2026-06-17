# PowerShell 5.1 + WinForms 踩坑记录

> 基于开发 `notify-done.ps1` / `notify-popup.ps1` 时的实战经验。

---

## 1. UTF-8 编码

**问题**：PS 5.1 默认用 GBK 读脚本，UTF-8 无 BOM 的中文会乱码或语法报错。

**解法**：源码保持 ASCII，中文用 Base64 运行时解码：

```powershell
function Decode-Utf8Text {
    param([string]$Base64)
    return [System.Text.Encoding]::UTF8.GetString(
        [System.Convert]::FromBase64String($Base64)
    )
}
```

生成 Base64：`python -c "import base64; print(base64.b64encode('你的中文'.encode()).decode())"`

---

## 2. New-Object 表达式参数

**问题**：括号内含表达式时解析出错。

```powershell
# ❌ 会报错
$form.Size = New-Object System.Drawing.Size($w - 2, 48)

# ✅ 预存变量 + -ArgumentList
$val = $w - 2
$form.Size = New-Object -TypeName System.Drawing.Size -ArgumentList $val, 48
```

**规则**：`New-Object` 一律用 `-TypeName` + `-ArgumentList`。

---

## 3. ScriptBlock 不是闭包

**问题**：WinForms 事件回调里引用外部局部变量，触发时变量已不存在（`$null`）。

**原因**：ScriptBlock 运行时按当前作用域链查找变量，不捕获定义时的上下文。

---

## 4. 嵌套回调中 $this 指向

`$this` 始终指向触发事件的控件本身。嵌套回调（如 Click 里创建 Timer）中，Timer 的 Tick 里 `$this` 是 Timer，不是外层的 Button。

---

## 5. Tag 属性传值（解决 3 & 4）

用控件的 `.Tag` 属性绑定数据，回调通过 `$this.Tag` 读取：

```powershell
# 单控件数据
$btn.Tag = @{ Normal = $BgColor; Hover = $HvColor }
$btn.Add_MouseEnter({ $this.BackColor = $this.Tag.Hover })

# 跨控件引用：Timer → Button
$timer.Tag = $this   # 把 Button 存到 Timer.Tag
$timer.Add_Tick({
    $btn = $this.Tag  # $this 是 Timer
    $btn.Text = $btn.Tag.CopyText
})
```

窗口级共享状态用 `$script:` 变量。

---

## 6. WinForms 独立进程

`[Application]::Run($form)` 会阻塞。用 `Start-Process` 启动独立子进程来避免阻塞调用方。

关键：`-WindowStyle Hidden` 在 `Start-Process` 参数和 `powershell.exe` 参数两处都要设。

---

## 7. 调试：错误日志

WinForms 子进程崩溃时无任何输出，必须主动写日志：

```powershell
try { <# 主逻辑 #> } catch {
    $log = Join-Path $PSScriptRoot "notify-popup-error.log"
    $text = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $($_.Exception.Message)`r`n$($_.ScriptStackTrace)`r`n"
    [System.IO.File]::AppendAllText($log, $text, [System.Text.Encoding]::UTF8)
}
```

也可用 `Start-Process -RedirectStandardError 'err.txt'` 捕获进程输出做诊断。
