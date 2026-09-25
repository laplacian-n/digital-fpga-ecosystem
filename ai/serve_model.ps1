<#
  serve_model.ps1 - start llama-server with the right flags per model, on port 8080
  (the endpoint the editor chat + intent_client expect).

  Usage (from ai/):
    powershell -ExecutionPolicy Bypass -File .\serve_model.ps1 -Model coder30b
    powershell -ExecutionPolicy Bypass -File .\serve_model.ps1 -Model qwen8b
    powershell -ExecutionPolicy Bypass -File .\serve_model.ps1 -Model qwen7b

  Models:
    coder30b  Qwen3-Coder-30B-A3B-Instruct  (MoE, best code+tools; experts kept in
              system RAM via -ot so it fits a 6GB GPU; ~18GB total, ~5-10 tok/s)
    qwen8b    Qwen3-8B                       (dense, thinking+tools; fits 6GB VRAM, fast)
    qwen7b    Qwen2.5-Coder-7B-Instruct      (older; partial offload)
    qwen3b    Qwen2.5-Coder-3B-Instruct      (older; fits fully, fastest)

  KEY: -c 8192 (RAG prompt ~4300 tok overflows the old -c 4096 -> HTTP 400),
       --jinja (required for tool/function calling),
       coder30b uses `-ot "exps=CPU"` to keep the MoE expert tensors in system RAM
       (only ~3B active params compute per token, so this stays usable) and offloads
       the rest to the GPU. Bump/lower via -GpuLayers if VRAM is tight.
#>
param(
  [ValidateSet("coder30b","coder30b-q3","qwen14b","qwen8b","qwen7b","qwen3b")] [string]$Model = "coder30b",
  [int]$Port = 8080,
  [int]$Ctx = 6144,               # RAG prompt ~4300 tok; 6144 leaves headroom, smaller KV = more VRAM for experts
  [int]$GpuLayers = 999,
  # MoE tuning (coder30b*): keep experts of the first N layers in system RAM, the rest go
  # to the GPU. LOWER N = more experts on GPU = less RAM (until VRAM fills, ~32 here on 6GB).
  # Paired with --load-mode none so the GPU-offloaded experts are NOT also kept resident in
  # RAM by mmap (that mmap double-counting is what pinned RAM at 23.7GB). Net on this box:
  # Q4 full quality during inference ~21GB RAM (was 23.7), VRAM ~full, KV quantized to q8_0.
  [int]$NCpuMoe = 32
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root "llama\llama-server.exe"
$mdl = Join-Path $root "models"

$file = switch ($Model) {
  "coder30b-q3" { "Qwen3-Coder-30B-A3B-Instruct-UD-Q3_K_XL.gguf" }  # ~13GB, ~20GB RAM - fits 24GB
  "coder30b"    { "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf" }      # ~18GB, ~25GB RAM - tight/OOM risk
  "qwen14b"     { "Qwen3-14B-Q4_K_M.gguf" }         # ~9GB; too big for 6GB -> partial offload
  "qwen8b"      { "Qwen3-8B-Q4_K_M.gguf" }
  "qwen7b"      { "qwen2.5-coder-7b-instruct-q4_k_m.gguf" }
  "qwen3b"      { "qwen2.5-coder-3b-instruct-q4_k_m.gguf" }
}
$path = Join-Path $mdl $file
if (-not (Test-Path $path)) { throw "model not found: $path (download it first)" }

$args = @("-m", $path, "--port", $Port, "-c", $Ctx, "--host", "127.0.0.1", "--jinja")
if ($Model -like "coder30b*") {
  # MoE: experts of the first N layers stay in RAM, rest on GPU; --load-mode none stops
  # mmap from also keeping the GPU tensors resident in RAM; quantized KV frees VRAM.
  $args += @("-ngl", "99", "--n-cpu-moe", "$NCpuMoe", "--load-mode", "none", "-ctk", "q8_0", "-ctv", "q8_0")
} elseif ($Model -eq "qwen14b") {
  # 14B dense (~9GB) can't fit 6GB VRAM: put ~16 layers on GPU, rest in RAM, and
  # quantize the KV cache so a 6144-ctx RAG prompt still fits. Slow (CPU-bound) but works.
  $args += @("-ngl", "16", "-ctk", "q8_0", "-ctv", "q8_0")
} elseif ($Model -eq "qwen7b") {
  $args += @("-ngl", "20")        # 7B partial offload on 6GB
} else {
  $args += @("-ngl", "$GpuLayers")
}
Write-Host "Starting $Model on :$Port  ->  $file" -ForegroundColor Cyan
Write-Host ("  " + $server + " " + ($args -join " ")) -ForegroundColor DarkGray
& $server @args
