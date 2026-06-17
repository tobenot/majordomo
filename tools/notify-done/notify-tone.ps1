# notify-tone.ps1 - 科幻远方警报音效
# 风格：空谷回响 + 弥散警报嗡鸣 + 穿雾金属击打
# 设计详情见 音效设计探索记录.md
# 纯 PowerShell 逐采样动态合成 WAV，无外部依赖

param(
    [ValidateRange(0, 100)]
    [int]$Volume,
    [switch]$CacheOnly
)

# --- 加载配置 ---
$Config = @{}
$configDefault = Join-Path $PSScriptRoot "notify-done.config.ps1"
$configUser    = Join-Path $PSScriptRoot "notify-done.config.user.ps1"
if (Test-Path $configDefault) { . $configDefault }
if (Test-Path $configUser)    { . $configUser }

if (-not $PSBoundParameters.ContainsKey('Volume')) {
    $Volume = if ($Config.DefaultVolume) { $Config.DefaultVolume } else { 80 }
}

function New-AlertTone {
    param([int]$Vol = 80)

    $sampleRate   = if ($Config.AlertTone.SampleRate) { $Config.AlertTone.SampleRate } else { 44100 }
    $duration     = if ($Config.AlertTone.Duration)   { $Config.AlertTone.Duration }   else { 10.0 }
    $totalSamples = [int]($sampleRate * $duration)
    $amplitude    = [math]::Min(($Vol / 100.0) * 0.95, 0.95)

    $bitsPerSample = 16
    $channels      = 1
    $byteRate      = $sampleRate * $channels * ($bitsPerSample / 8)
    $blockAlign    = $channels * ($bitsPerSample / 8)
    $dataSize      = $totalSamples * $blockAlign

    $samples = New-Object 'double[]' $totalSamples
    $twoPi   = 2.0 * [math]::PI

    $globalEnv = {
        param($t, $dur)
        if ($t -gt ($dur - 3.0)) {
            $fade = ($dur - $t) / 3.0
            return [math]::Max(0, $fade * $fade) # 平方淡出，更柔
        }
        return 1.0
    }

    for ($i = 0; $i -lt $totalSamples; $i++) {
        $t = $i / $sampleRate
        $sample = 0.0
        $gEnv = & $globalEnv $t $duration

        # ========================================
        # Layer 1: 远方空谷巨兽 (低频底色，音量提升)
        # ========================================
        $beacons = @(
            @{ T = 0.0; F = 174.6; Vol = 0.30 },  # F3
            @{ T = 2.8; F = 196.0; Vol = 0.30 },  # G3
            @{ T = 5.6; F = 130.8; Vol = 0.38 }   # C3
        )

        foreach ($b in $beacons) {
            $bT = [double]$b.T
            $bF = [double]$b.F
            $bV = [double]$b.Vol

            if ($t -ge $bT) {
                $td = $t - $bT

                # 极缓慢起音 + 极缓慢衰减
                $att = 0.5
                $env = 0.0
                if ($td -lt $att) {
                    $r = $td / $att
                    $env = $r * $r
                } else {
                    $env = [math]::Exp(-($td - $att) * 0.5)
                }

                $tone = [math]::Sin($twoPi * $bF * $td) * 0.8 +
                        [math]::Sin($twoPi * ($bF * 1.5) * $td) * 0.2

                $sample += $tone * $env * $bV

                # 多层弥散回声（低频）
                $lowDelays  = @(0.7, 1.3, 2.0, 2.8)
                $lowEchoVol = @(0.40, 0.28, 0.18, 0.10)
                for ($d = 0; $d -lt $lowDelays.Count; $d++) {
                    $eTd = $td - $lowDelays[$d]
                    if ($eTd -gt 0) {
                        # 涌动式包络：缓起缓落
                        $rise = 1.2 / ($d + 1)
                        $eEnv = ($eTd * $rise) * [math]::Exp(-$eTd * $rise)
                        $eTone = [math]::Sin($twoPi * $bF * $eTd)
                        $sample += $eTone * $eEnv * $bV * $lowEchoVol[$d]
                    }
                }
            }
        }

        # ========================================
        # Layer 2: 缓慢警报嗡鸣 (Slow Siren Drone)
        # ========================================
        # 设计：
        #   - 3 次缓慢的警报脉冲，跟随 Layer1 的巨兽节奏
        #   - 每次嗡鸣持续 ~2s，缓起缓落（像远方的防空警报穿过浓雾传来）
        #   - 中频为主（300~500Hz），不会轰耳朵，但有明确的"警报"辨识度
        #   - 音色：双频叠加 + chorus 失谐 = 厚实模糊的嗡鸣
        #   - 同样 5 层弥散回声，"糊上"

        # 三次警报脉冲：时间、基频、音量（提升音量）
        $sirens = @(
            @{ T = 0.5;  F = 392.0;  Vol = 0.42 },   # G4 — 第一声
            @{ T = 3.3;  F = 440.0;  Vol = 0.45 },   # A4 — 略升，渐紧迫
            @{ T = 6.1;  F = 349.2;  Vol = 0.50 }    # F4 — 下落，沉重收尾
        )

        foreach ($s in $sirens) {
            $sT   = [double]$s.T
            $sF   = [double]$s.F
            $sVol = [double]$s.Vol

            if ($t -ge $sT) {
                $td = $t - $sT

                # 缓起缓落的脉冲包络（像远方警报从雾中浮现再沉回去）
                # rise 0.6s → sustain → fall（总约 2.2s 有声）
                $sirenDur = 2.2
                $riseT = 0.6
                $fallT = 0.8
                $envS = 0.0
                if ($td -lt $riseT) {
                    $r = $td / $riseT
                    $envS = $r * $r  # 平滑曲线上升
                } elseif ($td -lt ($sirenDur - $fallT)) {
                    $envS = 1.0
                } elseif ($td -lt $sirenDur) {
                    $r = ($sirenDur - $td) / $fallT
                    $envS = $r * $r  # 平滑曲线下降
                }
                # sustain 之后继续一个极长的残留尾音
                if ($td -ge $sirenDur) {
                    $envS = [math]::Exp(-($td - $sirenDur) * 1.5)
                }

                # 音色：基频 + 五度泛音 + 双重 chorus 失谐 → 厚实模糊的嗡鸣
                $siren = [math]::Sin($twoPi * $sF * $td) * 0.40 +
                         [math]::Sin($twoPi * ($sF * 1.003) * $td) * 0.25 +  # chorus 1
                         [math]::Sin($twoPi * ($sF * 0.997) * $td) * 0.25 +  # chorus 2 (反向失谐)
                         [math]::Sin($twoPi * ($sF * 1.498) * $td) * 0.10    # 五度泛音（柔和）

                $sample += $siren * $envS * $sVol

                # 5 层弥散回声（与之前铃音版完全一致的"糊"法）
                $sDelays  = @(0.2, 0.5, 0.9, 1.5, 2.2)
                $sEchoVol = @(0.45, 0.32, 0.22, 0.14, 0.08)

                for ($d = 0; $d -lt $sDelays.Count; $d++) {
                    $eTd = $td - $sDelays[$d]
                    if ($eTd -gt 0) {
                        $riseRate = 2.5 / (1.0 + $d * 0.6)
                        $eEnv = ($eTd * $riseRate) * [math]::Exp(-$eTd * $riseRate)
                        $detune = 1.0 + ($d + 1) * 0.003
                        $eSiren = [math]::Sin($twoPi * ($sF * $detune) * $eTd) * 0.5 +
                                  [math]::Sin($twoPi * $sF * $eTd) * 0.5
                        $sample += $eSiren * $eEnv * $sVol * $sEchoVol[$d]
                    }
                }
            }
        }

        # ========================================
        # Layer 2.5: 穿雾金属敲击 (Foreground Strikes)
        # ========================================
        # 设计：每次警报嗡鸣的高潮时刻，一记清晰的金属敲击穿透嗡鸣
        # 比嗡鸣高 1-2 个八度，有明确瞬态（"铛！"），但也带弥散尾巴
        # 这就是"前景音"——让你在嗡嗡声中能明确抓到"有东西在响"

        $strikes = @(
            @{ T = 1.0;  F = 784.0;  Vol = 0.50 },   # G5 — 第一击（嗡鸣高潮处）
            @{ T = 1.6;  F = 880.0;  Vol = 0.35 },   # A5 — 回击（稍弱）
            @{ T = 3.8;  F = 880.0;  Vol = 0.52 },   # A5 — 第二击
            @{ T = 4.5;  F = 987.8;  Vol = 0.36 },   # B5 — 回击
            @{ T = 6.6;  F = 698.5;  Vol = 0.55 },   # F5 — 第三击（最重）
            @{ T = 7.2;  F = 784.0;  Vol = 0.40 }    # G5 — 回击
        )

        foreach ($st in $strikes) {
            $stT   = [double]$st.T
            $stF   = [double]$st.F
            $stVol = [double]$st.Vol

            if ($t -ge $stT) {
                $td = $t - $stT

                # 击打包络：快起音（0.008s 硬瞬态）+ 中速衰减（模拟金属余韵穿过空气）
                $attS = 0.008
                $envSt = 0.0
                if ($td -lt $attS) {
                    $envSt = $td / $attS
                } else {
                    # 衰减不太快，让金属声拖一个"糊"的尾巴
                    $envSt = [math]::Exp(-($td - $attS) * 3.0)
                }

                # 音色：基频 + 轻微非谐波泛音（金属感）+ chorus
                # 不用太多泛音，保持"圆润但可辨"
                $strike = [math]::Sin($twoPi * $stF * $td) * 0.50 +
                          [math]::Sin($twoPi * ($stF * 1.004) * $td) * 0.20 +   # chorus
                          [math]::Sin($twoPi * ($stF * 2.003) * $td) * 0.15 +   # 非谐波二次泛音（金属）
                          [math]::Sin($twoPi * ($stF * 2.997) * $td) * 0.08 +   # 非谐波三次泛音
                          [math]::Sin($twoPi * ($stF * 0.996) * $td) * 0.07     # 反向 chorus

                $sample += $strike * $envSt * $stVol

                # 4 层弥散回声（让击打也"糊上"，但保留一点瞬态清晰度）
                $stDelays  = @(0.18, 0.45, 0.85, 1.4)
                $stEchoVol = @(0.38, 0.26, 0.16, 0.09)

                for ($d = 0; $d -lt $stDelays.Count; $d++) {
                    $eTd = $td - $stDelays[$d]
                    if ($eTd -gt 0) {
                        # 回声：涌动式但比主击打衰减更快（保证主击打突出）
                        $riseRate = 3.0 / (1.0 + $d * 0.5)
                        $eEnv = ($eTd * $riseRate) * [math]::Exp(-$eTd * $riseRate)
                        $detune = 1.0 + ($d + 1) * 0.004
                        $eStrike = [math]::Sin($twoPi * ($stF * $detune) * $eTd) * 0.55 +
                                   [math]::Sin($twoPi * $stF * $eTd) * 0.45
                        $sample += $eStrike * $eEnv * $stVol * $stEchoVol[$d]
                    }
                }
            }
        }

        # ========================================
        # Layer 3: 极微弱的空气底噪
        # ========================================
        $noiseEnv = $gEnv * 0.002
        $noise = (($i * 1103515245 + 12345) % 2147483648) / 2147483648.0 * 2 - 1
        $sample += $noise * $noiseEnv

        $sample = $sample * $gEnv * $amplitude
        $sample = [math]::Max(-0.98, [math]::Min(0.98, $sample))
        $samples[$i] = $sample
    }

    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)

    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("RIFF"))
    $writer.Write([int](36 + $dataSize))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("WAVE"))

    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("fmt "))
    $writer.Write([int]16)
    $writer.Write([int16]1)
    $writer.Write([int16]$channels)
    $writer.Write([int]$sampleRate)
    $writer.Write([int]$byteRate)
    $writer.Write([int16]$blockAlign)
    $writer.Write([int16]$bitsPerSample)

    $writer.Write([System.Text.Encoding]::ASCII.GetBytes("data"))
    $writer.Write([int]$dataSize)

    for ($i = 0; $i -lt $totalSamples; $i++) {
        $val = [int]($samples[$i] * 32767)
        $val = [math]::Max(-32768, [math]::Min(32767, $val))
        $writer.Write([int16]$val)
    }

    $writer.Flush()
    $stream.Position = 0

    if ($script:CacheOnly) {
        # 缓存模式：写入文件
        $cacheDir = Join-Path $PSScriptRoot "cache"
        if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
        $cachePath = Join-Path $cacheDir "alert-tone.wav"
        $fileStream = [System.IO.File]::Create($cachePath)
        $stream.CopyTo($fileStream)
        $fileStream.Close()
        $stream.Dispose()
        $writer.Dispose()
    } else {
        # 播放模式：直接播放
        $player = New-Object System.Media.SoundPlayer($stream)
        $player.PlaySync()
        $player.Dispose()
        $writer.Dispose()
        $stream.Dispose()
    }
}

New-AlertTone -Vol $Volume
