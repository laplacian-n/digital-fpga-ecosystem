# ============================================================================
#  setup.ps1 - one-time system setup for FPGA Builder (portable minimal ISE)
#  ISE is bundled in tools\ise_min - NO separate 17GB install needed.
#  This only applies system-level fixes the ISE tools require.
#  (setup.bat calls this with admin rights.)
# ============================================================================
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m,$c="White"){ Write-Host $m -ForegroundColor $c }

Say "==================================================================" Cyan
Say " FPGA Builder - System Setup (bundled minimal ISE)" Cyan
Say "==================================================================" Cyan

# ---- 1) VC++ 2008 runtime (ISE tools need it) ----
Say "`n[1/3] Installing VC++ 2008 runtime ..." Cyan
foreach ($vc in @("$here\tools\vcredist_x64.exe","$here\tools\vcredist_x86.exe")) {
    if (Test-Path $vc) {
        Start-Process $vc -ArgumentList "/q" -Wait -EA SilentlyContinue
        Say "   ran $(Split-Path $vc -Leaf)" Gray
    }
}

# ---- 2) network provider fix (P9NP/WSL + webclient make ISE tools hang) ----
Say "`n[2/3] Fixing network provider order (P9NP/WebDAV hang) ..." Cyan
$kO = "HKLM:\SYSTEM\CurrentControlSet\Control\NetworkProvider\Order"
$kH = "HKLM:\SYSTEM\CurrentControlSet\Control\NetworkProvider\HwOrder"
foreach ($k in @($kO,$kH)) {
    $cur = (Get-ItemProperty $k -EA SilentlyContinue).ProviderOrder
    if ($cur) {
        $keep = ($cur -split ',' | Where-Object { $_ -and $_.Trim() -notmatch '^(P9NP|webclient|RsFx.*)$' })
        $new = ($keep -join ',')
        if ($new -ne $cur) {
            Set-ItemProperty $k -Name ProviderOrder -Value $new
            Say "   $cur  ->  $new" Gray
        }
    }
}
Restart-Service LanmanWorkstation -Force -EA SilentlyContinue

# ---- 3) stage FT2232 JTAG WinUSB driver into the driver store ----
# NOTE: only /add-driver (NO /install) - staging lets Windows auto-bind WinUSB
# when a NEW board is plugged on machines WITHOUT the FTDI VCP driver.
# We must NOT use /install: on machines that HAVE FTDI VCP it would re-evaluate
# and revert the device back to the FTDI driver.
Say "`n[3/4] Staging JTAG driver (FT2232 WinUSB) ..." Cyan
$drvinf = Join-Path $here "tools\ft2232_winusb\dual_rs232-hs_(interface_0).inf"
if (Test-Path $drvinf) {
    pnputil /add-driver "$drvinf" 2>&1 | Out-Null
    Say "   driver staged." Gray
    Say "   - PCs without FTDI driver: board works directly when plugged in." Gray
    Say "   - PCs that ever installed FTDI VCP: run tools\zadig.exe ONCE per board" Gray
    Say "     (Interface 0 -> WinUSB -> Replace Driver). It stays after that." Gray
} else {
    Say "   [!] driver inf not found - use tools\zadig.exe manually" Yellow
}

# ---- 3.5) enable Windows long path support (Vivado has deep folders) ----
Say "`nEnabling long path support (fix 'Path too long' when copying)..." Cyan
Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -Type DWord -EA SilentlyContinue
Say "   done" Gray

# ---- 4) Defender exclusion for this folder (speeds up / avoids tool hang) ----
Say "`n[4/4] Adding Windows Defender exclusion ..." Cyan
Add-MpPreference -ExclusionPath $here -EA SilentlyContinue
Add-MpPreference -ExclusionProcess "xst.exe","ngdbuild.exe","map.exe","par.exe","bitgen.exe","openFPGALoader.exe" -EA SilentlyContinue
Say "   done" Gray

Say "`n==================================================================" Green
Say " SETUP COMPLETE!" Green
Say " ISE is bundled (tools\ise_min) - ready to build Spartan-6." Green
Say " JTAG driver installed - plug board in, it should work directly." Green
Say " For Spartan-7: install Vivado separately (see readme)." Green
Say "==================================================================" Green
Read-Host "`nPress Enter to exit"
