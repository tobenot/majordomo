# notify-done.config.ps1 - default configuration
# NOTE: keep this file ASCII-friendly for Windows PowerShell 5.1 parser compatibility.

if (-not $Config) {
    $Config = @{}
}

# ============================================================
# General
# ============================================================
$Config.DefaultMessage     = "Task done!"
$Config.DefaultVolume      = 100
$Config.TTS                = @{
    Rate           = 0
    SinglePrefix   = ""
}

# ============================================================
# Popup
# ============================================================
$Config.Popup = @{
    Width          = 520
    Height         = 340
    CornerRadius   = 14
    Opacity        = 0.98
    FadeStep       = 0.05

    # Fonts
    FontFamily     = "Microsoft YaHei UI"
    FontFamilyMono = "Segoe UI"
    TitleFontSize  = 11
    MsgFontSize    = 10
    HintFontSize   = 9
    BtnFontSize    = 9

    # Colors (R, G, B)
    BgColor           = @(18, 20, 28)
    TitleColor        = @(26, 29, 39)
    AccentColor       = @(66, 153, 255)
    AccentSoft        = @(34, 78, 132)
    BorderColor       = @(58, 65, 82)
    TextPrimary       = @(242, 245, 250)
    TextSecondary     = @(162, 170, 184)
    BtnBg             = @(42, 46, 58)
    BtnHover          = @(56, 62, 76)
    BtnPrimaryBg      = @(38, 115, 220)
    BtnPrimaryHover   = @(55, 140, 250)
    SeparatorColor    = @(44, 50, 64)
    GlowTopColor      = @(48, 86, 138)
    CopiedBtnColor    = @(42, 146, 78)
}

# ============================================================
# Tone (notify-tone-boot.ps1)
# ============================================================
$Config.Tone = @{
    Duration       = 4.5
    SampleRate     = 44100
}

# ============================================================
# Alert Tone (notify-tone.ps1)
# ============================================================
$Config.AlertTone = @{
    Duration       = 10.0
    SampleRate     = 44100
}
