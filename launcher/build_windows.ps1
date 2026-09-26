<#
  build_windows.ps1 - build FPGA Ecosystem for Windows: one-folder app + installer.

  Output:
    dist\FPGAEcosystem\FPGAEcosystem.exe      (portable - zip this folder and it runs anywhere)
    dist\FPGAEcosystem-Setup-<ver>.exe        (installer, if Inno Setup 6 is installed)

  Needs: Python 3.10+ (python.org build, includes tkinter). PyInstaller is pip-installed here.
  Inno Setup 6 (https://jrsoftware.org/isinfo.php) for the Setup.exe; skipped if missing.

  Usage (from the repo root or launcher\):
    powershell -ExecutionPolicy Bypass -File launcher\build_windows.ps1
#>
param([string]$Version = "")
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repo

if (-not $Version) {
  $Version = (Select-String -Path launcher\app.py -Pattern '^VERSION = "(.+)"').Matches[0].Groups[1].Value
}
Write-Host "== FPGA Ecosystem $Version =="

# ---- stage exactly what ships (no course material, no dev scripts) ----
$stage = Join-Path $repo "build\stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
function Stage($src, $dst) {
  $to = Join-Path $stage $dst
  New-Item -ItemType Directory -Force (Split-Path -Parent $to) | Out-Null
  Copy-Item $src $to -Recurse -Force
}
Stage "schematic&bus2vhdl.html"                  "schematic&bus2vhdl.html"
Stage "topdown\topdown-schematic.html"           "topdown\topdown-schematic.html"
Stage "topdown\td-engine.js"                     "topdown\td-engine.js"
Stage "launcher\web"                             "launcher\web"
Stage "designs_gate"                             "designs_gate"
Stage "FPGA_Builder_Package\source\fpga_builder.py" "FPGA_Builder_Package\source\fpga_builder.py"
New-Item -ItemType Directory -Force (Join-Path $stage "ai\rag") | Out-Null
Get-ChildItem ai\*.py | ForEach-Object { Stage $_.FullName ("ai\" + $_.Name) }
foreach ($d in "grammar", "prompts", "board") { Stage "ai\$d" "ai\$d" }
Get-ChildItem ai\rag\*.py | ForEach-Object { Stage $_.FullName ("ai\rag\" + $_.Name) }
Stage "ai\rag\labs" "ai\rag\labs"
foreach ($opt in "ai\rag\index.jsonl", "ai\rag\emb.npz") {       # RAG index if built locally
  if (Test-Path $opt) { Stage $opt $opt }
}

# ---- PyInstaller (one-folder: fast start, no temp unpacking, AV-friendly) ----
python -m pip install --quiet --upgrade pyinstaller
$datas = Get-ChildItem $stage | ForEach-Object {
  $name = $_.Name
  if ($_.PSIsContainer) { "--add-data", "$($_.FullName);$name" } else { "--add-data", "$($_.FullName);." }
}
# the ai/ + FPGA Builder sources are loaded from disk at runtime, so the stdlib
# modules only THEY use must be pulled in explicitly
$hidden = "sqlite3", "hashlib", "html", "argparse", "tempfile", "copy", "itertools", "string",
          "struct", "math", "datetime", "typing", "collections", "queue", "ctypes", "ctypes.wintypes",
          "tkinter", "tkinter.ttk", "tkinter.filedialog", "tkinter.messagebox", "tkinter.scrolledtext",
          "http.server", "urllib.request", "urllib.parse", "json", "glob", "shutil", "difflib",
          "unicodedata", "textwrap", "csv", "random", "statistics", "fractions", "decimal"
$hiddenArgs = $hidden | ForEach-Object { "--hidden-import", $_ }
# absolute: PyInstaller resolves --icon relative to --specpath (build\), not the cwd
$icon = @()
if (Test-Path launcher\icon.ico) { $icon = "--icon", (Resolve-Path launcher\icon.ico).Path }

python -m PyInstaller --noconfirm --clean --windowed --onedir `
  --name FPGAEcosystem --distpath dist --workpath build\pyi --specpath build `
  @icon @datas @hiddenArgs launcher\app.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

# console build of the MCP server: Claude talks to it over stdin/stdout, which a windowed
# exe doesn't reliably get. Small, stdlib only; it starts FPGAEcosystem.exe when needed.
python -m PyInstaller --noconfirm --onefile --console --name FPGAEcosystem-MCP `
  --distpath dist\FPGAEcosystem --workpath build\pyi-mcp --specpath build launcher\mcp_server.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller (MCP) failed" }

# ---- side-by-side tools ----
$tools = Join-Path $repo "dist\FPGAEcosystem\tools"   # absolute: [IO.File] ignores Set-Location
New-Item -ItemType Directory -Force $tools | Out-Null

# openFPGALoader (loads the .bit onto the board). A copy dropped into
# FPGA_Builder_Package\tools\openFPGALoader wins; otherwise take the MSYS2 package
# (Apache-2.0; the GitHub windows runner has MSYS2 at C:\msys64) with the DLLs it needs
# and the SPI-flash bridge for the course board. CI must ship it; a local build may skip it.
$ofl = Join-Path $tools "openFPGALoader"
if (Test-Path FPGA_Builder_Package\tools\openFPGALoader) {
  Copy-Item FPGA_Builder_Package\tools\openFPGALoader $ofl -Recurse -Force
} elseif (Test-Path C:\msys64\usr\bin\bash.exe) {
  $env:MSYSTEM = "UCRT64"; $env:CHERE_INVOKING = "1"
  & C:\msys64\usr\bin\bash.exe -lc "pacman -Sy --noconfirm --needed mingw-w64-ucrt-x86_64-openFPGALoader"
  if ($LASTEXITCODE -ne 0) { throw "pacman could not install openFPGALoader" }
  $u = "C:\msys64\ucrt64"
  New-Item -ItemType Directory -Force $ofl | Out-Null
  Copy-Item "$u\bin\openFPGALoader.exe" $ofl
  # every DLL it loads from the MSYS2 tree (libftdi1, libusb-1.0, zlib, libstdc++, ...)
  $dlls = & C:\msys64\usr\bin\bash.exe -lc "ldd /ucrt64/bin/openFPGALoader.exe | grep -o '/ucrt64/bin/[^ ]*\.dll' | sort -u"
  foreach ($d in $dlls) { Copy-Item ("$u\bin\" + (Split-Path -Leaf $d)) $ofl }
  if (-not $dlls) { throw "could not list openFPGALoader's DLLs" }
  # the MSYS2 build shells out to cygpath when writing flash (board.py puts this folder on PATH)
  foreach ($f in "cygpath.exe", "msys-2.0.dll") {
    if (Test-Path "C:\msys64\usr\bin\$f") { Copy-Item "C:\msys64\usr\bin\$f" $ofl }
  }
  # board.py / FPGA Builder pass this bridge with -B for "write to flash"; ship it un-gzipped
  $bridge = "spiOverJtag_xc7s15ftgb196.bit"
  $gz = [IO.File]::OpenRead("$u\share\openFPGALoader\$bridge.gz")
  $out = [IO.File]::Create((Join-Path $ofl $bridge))
  $z = New-Object IO.Compression.GZipStream($gz, [IO.Compression.CompressionMode]::Decompress)
  $z.CopyTo($out); $z.Close(); $out.Close(); $gz.Close()
  $lic = "$u\share\licenses\openFPGALoader"
  if (Test-Path $lic) { Copy-Item "$lic\*" $ofl }
  "openFPGALoader (Apache-2.0) from the MSYS2 package mingw-w64-ucrt-x86_64-openFPGALoader`r`n" +
  "source: https://github.com/trabucayre/openFPGALoader" | Set-Content (Join-Path $ofl "SOURCE.txt")
  # run it from its own folder, MSYS2 not on PATH: a missing DLL fails with 0xC0000135 (negative)
  & (Join-Path $ofl "openFPGALoader.exe") --Version
  if ($LASTEXITCODE -lt 0) { throw "bundled openFPGALoader does not start (exit $LASTEXITCODE) - a DLL is missing" }
} elseif ($env:CI) {
  throw "openFPGALoader not found (no FPGA_Builder_Package\tools\openFPGALoader and no MSYS2)"
} else {
  Write-Host "openFPGALoader not bundled - the board page will ask the user to install it"
}

# Zadig (GPLv3, unmodified) - switches the board's USB interface 0 to WinUSB, which
# openFPGALoader needs. The setup page opens it. Optional: skipped if the download fails.
$zadig = Join-Path $tools "zadig.exe"
if (Test-Path FPGA_Builder_Package\tools\zadig.exe) { Copy-Item FPGA_Builder_Package\tools\zadig.exe $zadig }
else {
  try {
    Invoke-WebRequest -UseBasicParsing -OutFile $zadig `
      https://github.com/pbatard/libwdi/releases/download/v1.5.1/zadig-2.9.exe
    "Zadig 2.9 (GPLv3) - source: https://github.com/pbatard/libwdi" | Set-Content (Join-Path $tools "zadig-SOURCE.txt")
  } catch { Write-Host "Zadig download failed - skipped ($_)" }
}
if (Test-Path ai\tools\ghdl) { Copy-Item ai\tools\ghdl dist\FPGAEcosystem\tools\ghdl -Recurse -Force }
Copy-Item FPGA_Builder_Package\examples dist\FPGAEcosystem\examples -Recurse -Force
Write-Host "portable app: dist\FPGAEcosystem\FPGAEcosystem.exe"

# ---- installer ----
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
          "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) {
  & $iscc "/DAppVersion=$Version" "/DSourceDir=$repo\dist\FPGAEcosystem" "/O$repo\dist" launcher\installer.iss
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }
  Write-Host "installer: dist\FPGAEcosystem-Setup-$Version.exe"
} else {
  Write-Host "Inno Setup 6 not found - skipped Setup.exe (the portable folder still works)"
}
