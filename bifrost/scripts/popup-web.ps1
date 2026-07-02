# popup-web.ps1 - Ensure the majordomo web handoff popup is alive and pinned on top.
#
# Design (web-popup.md): the popup is a chromeless Edge "app mode" window rendering
# the daemon-served /popup page. It is a LONG-LIVED, self-updating window -- so this
# launcher is idempotent: if the popup already exists, we only re-pin it on top and
# exit; we do NOT spawn a second Edge window. Single-instance is keyed on the window
# TITLE (the page's <title> = "majordomo-popup"), because msedge's multi-process model
# makes the launched PID unreliable for "is my window still up".
#
# Exit codes: 0 = popup is up (spawned or already alive). 2 = no Edge found -> caller
# should fall back to the WinForms popup. Never throws; best-effort by contract.
#
# ASCII-only source on purpose: parses under Windows PowerShell 5.1 regardless of BOM.

param(
    [string]$Url = 'http://127.0.0.1:4350/popup.html',
    [string]$TitleMatch = 'majordomo-popup'
)

$ErrorActionPreference = 'SilentlyContinue'

# --- Win32 interop: find a top-level window by title, pin it topmost without stealing focus ---
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MjWin {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    static IntPtr HWND_TOPMOST = new IntPtr(-1);
    const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;

    public static IntPtr Find(string needle) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = h; return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // Pin on top but do NOT activate -- the popup must never steal your keyboard focus.
    public static void Pin(IntPtr h) {
        SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}
'@
try { Add-Type -TypeDefinition $sig -Language CSharp -ErrorAction Stop } catch { }

function Pin-IfPresent {
    try {
        $h = [MjWin]::Find($TitleMatch)
        if ($h -ne [IntPtr]::Zero) { [MjWin]::Pin($h); return $true }
    } catch { }
    return $false
}

# Already up? Just re-pin and leave. This is the hot path (fires every turn).
if (Pin-IfPresent) { exit 0 }

# --- Locate msedge.exe: two Program Files roots, then App Paths registry fallback ---
function Find-Edge {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    $regPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
    )
    foreach ($rp in $regPaths) {
        try {
            $val = (Get-ItemProperty -Path $rp -ErrorAction Stop).'(default)'
            if ($val -and (Test-Path $val)) { return $val }
        } catch { }
    }
    return $null
}

$edge = Find-Edge
if (-not $edge) { exit 2 }  # caller falls back to WinForms popup

# --- Spawn the chromeless app window, bottom-right corner ---
# Isolated user-data-dir so this popup profile never collides with the user's real Edge.
$w = 440
$h = 560
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $px = $wa.Right - $w - 24
    $py = $wa.Bottom - $h - 24
} catch {
    $px = 900; $py = 400
}
$profileDir = Join-Path $env:TEMP 'majordomo-popup-edge'

$args = @(
    "--app=$Url",
    "--user-data-dir=`"$profileDir`"",
    "--window-size=$w,$h",
    "--window-position=$px,$py",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,msEdgeWelcomePage'
)
try {
    Start-Process -FilePath $edge -ArgumentList $args -WindowStyle Normal | Out-Null
} catch {
    exit 2
}

# Poll for the window to appear, then pin it topmost. Give up quietly after ~4s
# (the window still opened; it just won't be forced on top this once).
for ($n = 0; $n -lt 20; $n++) {
    Start-Sleep -Milliseconds 200
    if (Pin-IfPresent) { break }
}

exit 0
