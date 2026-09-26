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
$icon = @()
if (Test-Path launcher\icon.ico) { $icon = "--icon", "launcher\icon.ico" }

python -m PyInstaller --noconfirm --clean --windowed --onedir `
  --name FPGAEcosystem --distpath dist --workpath build\pyi --specpath build `
  @icon @datas @hiddenArgs launcher\app.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

# console build of the MCP server: Claude talks to it over stdin/stdout, which a windowed
# exe doesn't reliably get. Small, stdlib only; it starts FPGAEcosystem.exe when needed.
python -m PyInstaller --noconfirm --onefile --console --name FPGAEcosystem-MCP `
  --distpath dist\FPGAEcosystem --workpath build\pyi-mcp --specpath build launcher\mcp_server.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller (MCP) failed" }

# optional side-by-side tools the user may drop in before building (see launcher\README.md)
if (Test-Path FPGA_Builder_Package\tools\openFPGALoader) {
  Copy-Item FPGA_Builder_Package\tools\openFPGALoader dist\FPGAEcosystem\tools\openFPGALoader -Recurse -Force
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
