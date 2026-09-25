<#
  setup_llama.ps1 - one-shot local AI setup for the FPGA ecosystem (Windows).
  Downloads a prebuilt llama.cpp (CUDA) release + a GGUF model, then prints the
  command to launch the OpenAI-compatible server with the Intent grammar.

  Nothing here runs automatically from Claude - run it yourself after choosing a
  model. Re-runnable: it skips files that already exist (curl -C - resumes).

  NOTE: kept pure-ASCII on purpose. PowerShell 5.1 reads a no-BOM file as CP1252,
  where a UTF-8 em-dash's last byte becomes a smart-quote and breaks parsing.

  Usage (from ai/ folder):
    powershell -ExecutionPolicy Bypass -File .\setup_llama.ps1
    powershell -ExecutionPolicy Bypass -File .\setup_llama.ps1 -Model qwen3b
    powershell -ExecutionPolicy Bypass -File .\setup_llama.ps1 -Model qwen7b -GpuLayers 20

  Hardware here: RTX 4050 Laptop, 6 GB VRAM. qwen3b fits fully on GPU; qwen7b
  needs partial offload (-GpuLayers ~20) but writes better VHDL.
#>
param(
  [ValidateSet("qwen3b","qwen7b","both")] [string]$Model = "both",
  [int]$GpuLayers = 999,          # 999 = offload all that fit; lower for 7B on 6GB
  [int]$Port = 8080,
  [string]$LlamaTag = "b11016",   # pinned llama.cpp release (verified win-cuda-12.4 asset)
  [string]$Cuda = "12.4"          # driver 581.86 supports 13.x too; 12.4 = safe/universal
)
$ErrorActionPreference = "Stop"
$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = Join-Path $root "llama"
$mdlDir = Join-Path $root "models"
New-Item -ItemType Directory -Force -Path $binDir,$mdlDir | Out-Null

# --- model catalog (Qwen2.5-Coder - strong at structured JSON / VHDL) --------
$models = @{
  qwen3b = @{
    file = "qwen2.5-coder-3b-instruct-q4_k_m.gguf"
    url  = "https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf"
    note = "~2.0 GB, fits fully in 6 GB VRAM, fast. Good for topology/JSON."
  }
  qwen7b = @{
    file = "qwen2.5-coder-7b-instruct-q4_k_m.gguf"
    url  = "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
    note = "~4.7 GB, partial GPU offload on 6 GB (-GpuLayers ~20). Best VHDL/K-map."
  }
}
$base = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaTag"

# curl.exe (ships with Windows 10+) streams big files + resumes (-C -);
# PS5.1 Invoke-WebRequest buffers whole files in RAM and is unusable at GB size.
function Fetch($url, $out) {
  Write-Host "-> $url" -ForegroundColor Cyan
  & curl.exe -L --fail --retry 5 --retry-delay 3 -C - -o $out $url
  if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $url" }
}
function Get-Zip($url, $zipPath, $dest) {
  if (-not (Test-Path $zipPath)) { Fetch $url $zipPath }
  Expand-Archive -Path $zipPath -DestinationPath $dest -Force
}

# --- 1) llama.cpp prebuilt (CUDA) + cudart runtime ---------------------------
$server = Join-Path $binDir "llama-server.exe"
if (-not (Test-Path $server)) {
  Get-Zip "$base/llama-$LlamaTag-bin-win-cuda-$Cuda-x64.zip" (Join-Path $binDir "llama.zip")  $binDir
  Get-Zip "$base/cudart-llama-bin-win-cuda-$Cuda-x64.zip"    (Join-Path $binDir "cudart.zip") $binDir
} else { Write-Host "[ok] llama-server.exe present" -ForegroundColor Green }
if (-not (Test-Path $server)) { throw "llama-server.exe not found after extract - check the asset name for $LlamaTag" }

# --- 2) model(s) -------------------------------------------------------------
$want = if ($Model -eq "both") { @("qwen3b","qwen7b") } else { @($Model) }
foreach ($key in $want) {
  $mm = $models[$key]; $mp = Join-Path $mdlDir $mm.file
  if (Test-Path $mp) { Write-Host "[ok] model present: $($mm.file)" -ForegroundColor Green }
  else { Write-Host "downloading $key  ($($mm.note))" -ForegroundColor Cyan; Fetch $mm.url $mp }
}
$mdlPath = Join-Path $mdlDir $models[$(if($Model -eq "both"){"qwen7b"}else{$Model})].file

# --- 3) how to launch --------------------------------------------------------
$grammar = Join-Path $root "grammar\intent.gbnf"
Write-Host "`nSetup done. Start the server with:`n" -ForegroundColor Yellow
# -c 8192: the RAG-augmented intent prompt (system + retrieved context + a worked
# exemplar) runs ~4300 tokens, so -c 4096 makes llama-server reply HTTP 400
# "exceeds context size" and every generation fails. 8192 leaves headroom.
Write-Host "  `"$server`" -m `"$mdlPath`" --port $Port -ngl $GpuLayers -c 8192 --host 127.0.0.1" -ForegroundColor White
Write-Host "`nThen from ai/ :  py -3.10 intent_client.py `"full adder a b cin`"" -ForegroundColor White
Write-Host "(client reads grammar from $grammar and points at http://127.0.0.1:$Port)" -ForegroundColor DarkGray
