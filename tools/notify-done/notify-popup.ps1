# notify-popup.ps1 - Persistent AI handoff popup (ASCII source for Windows PowerShell 5.1 compatibility)

param(
    [string]$Message = ""
)

# --- 加载配置 ---
$Config = @{}
$configDefault = Join-Path $PSScriptRoot "notify-done.config.ps1"
$configUser    = Join-Path $PSScriptRoot "notify-done.config.user.ps1"
if (Test-Path $configDefault) { . $configDefault }
if (Test-Path $configUser)    { . $configUser }

# 简便取色函数：从 @(R,G,B) 数组创建 Color
function Get-ConfigColor {
    param([int[]]$RGB)
    return [System.Drawing.Color]::FromArgb($RGB[0], $RGB[1], $RGB[2])
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Decode-Utf8Text {
    param([string]$Base64)
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Base64))
}

$TextDefaultMessage = Decode-Utf8Text "QUkg5bel5L2c5a6M5oiQ77yB"
$TextTitle = Decode-Utf8Text "QUkg5bel5L2c5Lqk5o6l"
$TextHint = Decode-Utf8Text "5LiN5b+F56uL5Yi75ZON5bqU77yM5L2G5LiN6KaB5b+Y6K6w6L+Z5Lu25LqL44CC"
$TextOk = Decode-Utf8Text "55+l6YGT5LqG"
$TextSnooze10 = Decode-Utf8Text "MTAg5YiG6ZKf5ZCO"
$TextSnooze30 = Decode-Utf8Text "MzAg5YiG6ZKf5ZCO"
$TextCopy = Decode-Utf8Text "5aSN5Yi2"
$TextCopied = Decode-Utf8Text "5bey5aSN5Yi2"
$TextCopyRec = Decode-Utf8Text "5aSN5Yi25o6o6I2Q"
$TextCopiedRec = Decode-Utf8Text "5bey5aSN5Yi25o6o6I2Q"
$TextOriginal = Decode-Utf8Text "5Y6fIA=="

if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = $TextDefaultMessage
}

function New-RoundedRectanglePath {
    param(
        [int]$Width,
        [int]$Height,
        [int]$Radius
    )

    $diameter = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rect = New-Object -TypeName System.Drawing.Rectangle -ArgumentList 0, 0, $diameter, $diameter


    $path.AddArc($rect, 180, 90)
    $rect.X = $Width - $diameter
    $path.AddArc($rect, 270, 90)
    $rect.Y = $Height - $diameter
    $path.AddArc($rect, 0, 90)
    $rect.X = 0
    $path.AddArc($rect, 90, 90)
    $path.CloseFigure()

    return $path
}

function Show-HandoffPopup {
    param(
        [string]$PopupMessage,
        [string]$Timestamp
    )

    $pc = $Config.Popup

    $formWidth = $pc.Width
    $formHeight = $pc.Height
    $cornerRadius = $pc.CornerRadius

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $rng = New-Object System.Random
    $minX = [Math]::Max(0, $screen.Width - $formWidth - 420)
    $maxX = [Math]::Max($minX + 1, $screen.Width - $formWidth - 40)
    $minY = 60
    $maxY = [Math]::Max($minY + 1, $screen.Height - $formHeight - 60)
    $posX = $rng.Next($minX, $maxX)
    $posY = $rng.Next($minY, $maxY)

    $bgColor = Get-ConfigColor $pc.BgColor
    $titleColor = Get-ConfigColor $pc.TitleColor
    $accentColor = Get-ConfigColor $pc.AccentColor
    $accentSoft = Get-ConfigColor $pc.AccentSoft
    $borderColor = Get-ConfigColor $pc.BorderColor
    $textPrimary = Get-ConfigColor $pc.TextPrimary
    $textSecondary = Get-ConfigColor $pc.TextSecondary
    $btnBg = Get-ConfigColor $pc.BtnBg
    $btnHover = Get-ConfigColor $pc.BtnHover
    $btnPrimaryBg = Get-ConfigColor $pc.BtnPrimaryBg
    $btnPrimaryHover = Get-ConfigColor $pc.BtnPrimaryHover
    $separatorColor = Get-ConfigColor $pc.SeparatorColor
    $glowTopColor = Get-ConfigColor $pc.GlowTopColor
    $copiedBtnColor = Get-ConfigColor $pc.CopiedBtnColor
    $white = [System.Drawing.Color]::White

    $fontFamily = $pc.FontFamily
    $fontFamilyMono = $pc.FontFamilyMono

    $form = New-Object System.Windows.Forms.Form
    $form.Text = $TextTitle
    $form.Size = New-Object -TypeName System.Drawing.Size -ArgumentList $formWidth, $formHeight
    $form.StartPosition = 'Manual'
    $form.Location = New-Object -TypeName System.Drawing.Point -ArgumentList $posX, $posY

    $form.FormBorderStyle = 'None'
    $form.BackColor = $bgColor
    $form.TopMost = $true
    $form.ShowInTaskbar = $true
    $form.Opacity = $pc.Opacity

    $formPath = New-RoundedRectanglePath -Width $formWidth -Height $formHeight -Radius $cornerRadius
    $form.Region = New-Object System.Drawing.Region($formPath)

    $form.Add_Paint({
        param($sender, $e)
        $g = $e.Graphics
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

        $glowBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object -TypeName System.Drawing.Rectangle -ArgumentList 0, 0, $sender.Width, 96),
            $glowTopColor,
            $bgColor,
            [System.Drawing.Drawing2D.LinearGradientMode]::Vertical
        )
        $g.FillRectangle($glowBrush, 0, 0, $sender.Width, 96)
        $glowBrush.Dispose()

        $borderPen = New-Object System.Drawing.Pen($borderColor, 2)
        $g.DrawPath($borderPen, $formPath)
        $borderPen.Dispose()

        $linePen = New-Object System.Drawing.Pen($separatorColor, 1)
        $g.DrawLine($linePen, 18, 48, $sender.Width - 18, 48)
        $linePen.Dispose()
    })

    $script:isDragging = $false
    $script:dragOffset = New-Object -TypeName System.Drawing.Point -ArgumentList 0, 0


    $dragDown = {
        param($sender, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $script:isDragging = $true
            $script:dragOffset = $e.Location
        }
    }
    $dragMove = {
        param($sender, $e)
        if ($script:isDragging) {
            $screenPoint = $sender.PointToScreen($e.Location)
            $newX = $screenPoint.X - $script:dragOffset.X
            $newY = $screenPoint.Y - $script:dragOffset.Y
            $form.Location = New-Object -TypeName System.Drawing.Point -ArgumentList $newX, $newY

        }
    }
    $dragUp = {
        $script:isDragging = $false
    }

    $form.Add_MouseDown($dragDown)
    $form.Add_MouseMove($dragMove)
    $form.Add_MouseUp($dragUp)

    $titleBar = New-Object System.Windows.Forms.Panel
    $titleBar.Location = New-Object -TypeName System.Drawing.Point -ArgumentList 1, 1
    $titleBarWidth = $formWidth - 2
    $titleBar.Size = New-Object -TypeName System.Drawing.Size -ArgumentList $titleBarWidth, 48

    $titleBar.BackColor = [System.Drawing.Color]::Transparent
    $titleBar.Add_MouseDown({
        param($sender, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $script:isDragging = $true
            $offsetX = $e.X + $sender.Left
            $offsetY = $e.Y + $sender.Top
            $script:dragOffset = New-Object -TypeName System.Drawing.Point -ArgumentList $offsetX, $offsetY

        }
    })
    $titleBar.Add_MouseMove($dragMove)
    $titleBar.Add_MouseUp($dragUp)

    $iconPanel = New-Object System.Windows.Forms.Panel
    $iconPanel.Location = New-Object -TypeName System.Drawing.Point -ArgumentList 18, 16
    $iconPanel.Size = New-Object -TypeName System.Drawing.Size -ArgumentList 16, 16

    $iconPanel.BackColor = $accentColor
    $iconPanel.Region = New-Object System.Drawing.Region((New-RoundedRectanglePath -Width 16 -Height 16 -Radius 8))
    $titleBar.Controls.Add($iconPanel)

    $pulsePanel = New-Object System.Windows.Forms.Panel
    $pulsePanel.Location = New-Object -TypeName System.Drawing.Point -ArgumentList 14, 12
    $pulsePanel.Size = New-Object -TypeName System.Drawing.Size -ArgumentList 24, 24

    $pulsePanel.BackColor = $accentSoft
    $pulsePanel.Region = New-Object System.Drawing.Region((New-RoundedRectanglePath -Width 24 -Height 24 -Radius 12))
    $titleBar.Controls.Add($pulsePanel)
    $pulsePanel.SendToBack()

    $titleLabel = New-Object System.Windows.Forms.Label
    $titleLabel.Text = $TextTitle
    $titleLabel.Font = New-Object System.Drawing.Font($fontFamily, $pc.TitleFontSize, [System.Drawing.FontStyle]::Bold)
    $titleLabel.ForeColor = $textPrimary
    $titleLabel.Location = New-Object -TypeName System.Drawing.Point -ArgumentList 46, 12

    $titleLabel.AutoSize = $true
    $titleLabel.BackColor = [System.Drawing.Color]::Transparent
    $titleBar.Controls.Add($titleLabel)

    $timeLabel = New-Object System.Windows.Forms.Label
    $timeLabel.Text = $Timestamp
    $timeLabel.Font = New-Object System.Drawing.Font($fontFamilyMono, $pc.HintFontSize)
    $timeLabel.ForeColor = $textSecondary
    $timeX = $formWidth - 142
    $timeLabel.Location = New-Object -TypeName System.Drawing.Point -ArgumentList $timeX, 15
    $timeLabel.Size = New-Object -TypeName System.Drawing.Size -ArgumentList 120, 22

    $timeLabel.TextAlign = [System.Drawing.ContentAlignment]::TopRight
    $timeLabel.BackColor = [System.Drawing.Color]::Transparent
    $titleBar.Controls.Add($timeLabel)

    $form.Controls.Add($titleBar)

    $msgBox = New-Object System.Windows.Forms.RichTextBox
    $msgBox.ReadOnly = $true
    $msgBox.ScrollBars = 'Vertical'
    $msgBox.WordWrap = $true
    $msgBox.Text = $PopupMessage
    $msgBox.Font = New-Object System.Drawing.Font($fontFamily, $pc.MsgFontSize)
    $msgBox.BackColor = $bgColor
    $msgBox.ForeColor = $textPrimary
    $msgBox.BorderStyle = 'None'
    $msgBox.Location = New-Object -TypeName System.Drawing.Point -ArgumentList 22, 66
    $msgBoxWidth = $formWidth - 44
    $msgBox.Size = New-Object -TypeName System.Drawing.Size -ArgumentList $msgBoxWidth, 160

    $msgBox.Add_GotFocus({ $form.ActiveControl = $titleLabel })
    $form.Controls.Add($msgBox)

    $hintDot = New-Object System.Windows.Forms.Label
    $hintDot.Text = "i"
    $hintDot.Font = New-Object System.Drawing.Font($fontFamilyMono, 8, [System.Drawing.FontStyle]::Bold)
    $hintDot.ForeColor = $accentColor
    $hintDot.BackColor = [System.Drawing.Color]::Transparent
    $hintDot.Location = New-Object -TypeName System.Drawing.Point -ArgumentList 22, 236
    $hintDot.Size = New-Object -TypeName System.Drawing.Size -ArgumentList 16, 16

    $hintDot.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $form.Controls.Add($hintDot)

    $hintLabel = New-Object System.Windows.Forms.Label
    $hintLabel.Text = $TextHint
    $hintLabel.Font = New-Object System.Drawing.Font($fontFamily, $pc.HintFontSize)
    $hintLabel.ForeColor = $textSecondary
    $hintLabel.Location = New-Object -TypeName System.Drawing.Point -ArgumentList 44, 235

    $hintLabel.AutoSize = $true
    $hintLabel.BackColor = [System.Drawing.Color]::Transparent
    $form.Controls.Add($hintLabel)

    function New-RoundedButton {
        param(
            [string]$Text,
            [int]$X,
            [int]$Y,
            [int]$Width,
            [System.Drawing.Color]$BgColor,
            [System.Drawing.Color]$HvColor,
            [System.Drawing.Color]$FgColor
        )

        $btn = New-Object System.Windows.Forms.Button
        $btn.Text = $Text
        $btn.Font = New-Object System.Drawing.Font($fontFamily, $pc.BtnFontSize, [System.Drawing.FontStyle]::Bold)
        $btn.Location = New-Object -TypeName System.Drawing.Point -ArgumentList $X, $Y
        $btn.Size = New-Object -TypeName System.Drawing.Size -ArgumentList $Width, 40

        $btn.FlatStyle = 'Flat'
        $btn.FlatAppearance.BorderSize = 0
        $btn.BackColor = $BgColor
        $btn.ForeColor = $FgColor
        $btn.Cursor = [System.Windows.Forms.Cursors]::Hand
        $btn.Region = New-Object System.Drawing.Region((New-RoundedRectanglePath -Width $Width -Height 40 -Radius 8))
        # Store colors in Tag so event scriptblocks can read them reliably
        $btn.Tag = @{ Normal = $BgColor; Hover = $HvColor }
        $btn.Add_MouseEnter({ $this.BackColor = $this.Tag.Hover })
        $btn.Add_MouseLeave({ $this.BackColor = $this.Tag.Normal })
        return $btn
    }

    $btnY = 276
    $btnOk = New-RoundedButton -Text $TextOk -X 20 -Y $btnY -Width 100 -BgColor $btnPrimaryBg -HvColor $btnPrimaryHover -FgColor $white
    $btnOk.Add_Click({ $form.Tag = "dismiss"; $form.Close() })
    $form.Controls.Add($btnOk)

    $btnSnooze10 = New-RoundedButton -Text $TextSnooze10 -X 128 -Y $btnY -Width 82 -BgColor $btnBg -HvColor $btnHover -FgColor $textPrimary
    $btnSnooze10.Add_Click({ $form.Tag = "snooze10"; $form.Close() })
    $form.Controls.Add($btnSnooze10)

    $btnSnooze30 = New-RoundedButton -Text $TextSnooze30 -X 218 -Y $btnY -Width 82 -BgColor $btnBg -HvColor $btnHover -FgColor $textPrimary
    $btnSnooze30.Add_Click({ $form.Tag = "snooze30"; $form.Close() })
    $form.Controls.Add($btnSnooze30)

    $btnCopy = New-RoundedButton -Text $TextCopy -X 308 -Y $btnY -Width 72 -BgColor $btnBg -HvColor $btnHover -FgColor $textPrimary
    # Store extra data for the click callback
    $btnCopy.Tag = @{
        Normal = $btnBg
        Hover = $btnHover
        CopyText = $TextCopy
        CopiedText = $TextCopied
        Message = $PopupMessage
    }
    $btnCopy.Add_Click({
        [System.Windows.Forms.Clipboard]::SetText($this.Tag.Message)
        $this.Text = $this.Tag.CopiedText
        $this.BackColor = $copiedBtnColor
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 1500
        # Store the button ref in timer's Tag so the Tick callback can find it
        $timer.Tag = $this
        $timer.Add_Tick({
            # $this here is the Timer; $this.Tag is the button
            $btn = $this.Tag
            $btn.Text = $btn.Tag.CopyText
            $btn.BackColor = $btn.Tag.Normal
            $this.Stop()
            $this.Dispose()
        })
        $timer.Start()
    })
    $form.Controls.Add($btnCopy)

    # 复制推荐回复按钮：提取 [推荐回复] 后的文本，单独复制
    $recText = $PopupMessage
    if ($PopupMessage -match '\[推荐回复\]\s*(.+?)(?:\r?\n|$)') {
        $recText = $Matches[1].Trim()
    }
    $btnCopyRec = New-RoundedButton -Text $TextCopyRec -X 388 -Y $btnY -Width 112 -BgColor $btnBg -HvColor $btnHover -FgColor $textPrimary
    $btnCopyRec.Tag = @{
        Normal = $btnBg
        Hover = $btnHover
        CopyText = $TextCopyRec
        CopiedText = $TextCopiedRec
        Message = $recText
    }
    $btnCopyRec.Add_Click({
        [System.Windows.Forms.Clipboard]::SetText($this.Tag.Message)
        $this.Text = $this.Tag.CopiedText
        $this.BackColor = $copiedBtnColor
        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 1500
        $timer.Tag = $this
        $timer.Add_Tick({
            $btn = $this.Tag
            $btn.Text = $btn.Tag.CopyText
            $btn.BackColor = $btn.Tag.Normal
            $this.Stop()
            $this.Dispose()
        })
        $timer.Start()
    })
    $form.Controls.Add($btnCopyRec)

    $form.Opacity = 0
    $targetOpacity = $pc.Opacity
    $fadeStepVal = $pc.FadeStep
    $fadeTimer = New-Object System.Windows.Forms.Timer
    $fadeTimer.Interval = 10
    $fadeTimer.Add_Tick({
        if ($form.Opacity -lt $targetOpacity) {
            $form.Opacity = [Math]::Min($targetOpacity, $form.Opacity + $fadeStepVal)
        } else {
            $fadeTimer.Stop()
            $fadeTimer.Dispose()
        }
    })
    $form.Add_Shown({
        $fadeTimer.Start()
        $form.Activate()
    })

    $form.Tag = "dismiss"
    [System.Windows.Forms.Application]::Run($form)
    return $form.Tag
}

$timestamp = Get-Date -Format "HH:mm"
$continue = $true

try {
    while ($continue) {
        $result = Show-HandoffPopup -PopupMessage $Message -Timestamp $timestamp
        switch ($result) {
            "snooze10" {
                Start-Sleep -Seconds 600
                $timestamp = "$(Get-Date -Format 'HH:mm') ($TextOriginal$timestamp)"
                try { [Console]::Beep(784, 100); Start-Sleep -Milliseconds 60; [Console]::Beep(988, 200) } catch {}
            }
            "snooze30" {
                Start-Sleep -Seconds 1800
                $timestamp = "$(Get-Date -Format 'HH:mm') ($TextOriginal$timestamp)"
                try { [Console]::Beep(784, 100); Start-Sleep -Milliseconds 60; [Console]::Beep(988, 200) } catch {}
            }
            default {
                $continue = $false
            }
        }
    }
} catch {
    $logPath = Join-Path $PSScriptRoot "notify-popup-error.log"
    $errorText = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $($_.Exception.Message)`r`n$($_.ScriptStackTrace)`r`n"
    [System.IO.File]::AppendAllText($logPath, $errorText, [System.Text.Encoding]::UTF8)
}
