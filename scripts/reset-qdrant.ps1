# NANCE v0.4.0 — Qdrant reset + reseed (PowerShell / Windows)
# Usage: .\scripts\reset-qdrant.ps1
# Prompts for QDRANT_API_KEY if not set as env var.

param(
  [string]$QdrantApiKey    = $env:QDRANT_API_KEY,
  [string]$WorkerUrl       = "https://saumil-memory-gateway.saumil-nance.workers.dev",
  [string]$WorkerAuthToken = "saumilshah6@SS",
  [string]$QdrantHost      = "https://149ce9ac-b266-4ac8-aa2b-704bb5ef0725.europe-west3-0.gcp.cloud.qdrant.io",
  [string]$Collection      = "saumil_memory"
)

if (-not $QdrantApiKey) {
  $QdrantApiKey = Read-Host "Enter QDRANT_API_KEY"
}

$workerHeaders = @{
  "Authorization" = "Bearer $WorkerAuthToken"
  "Content-Type"  = "application/json"
}
$qdrantHeaders = @{
  "api-key"      = $QdrantApiKey
  "Content-Type" = "application/json"
}

Write-Host "`n[1/3] Deleting Qdrant collection '$Collection'..." -ForegroundColor Yellow
try {
  $r = Invoke-RestMethod -Method Delete `
    -Uri "$QdrantHost/collections/$Collection" `
    -Headers $qdrantHeaders
  Write-Host "      OK: $($r | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
  # 404 = already gone, that's fine
  if ($_.Exception.Response.StatusCode.value__ -eq 404) {
    Write-Host "      Collection not found (already deleted). Continuing." -ForegroundColor Cyan
  } else {
    Write-Host "      ERROR: $_" -ForegroundColor Red
    exit 1
  }
}

Write-Host "`n[2/3] Re-initialising collection via Worker..." -ForegroundColor Yellow
$body = '{"tool":"memory.vector.ensure_collection"}'
$r = Invoke-RestMethod -Method Post `
  -Uri "$WorkerUrl/call" `
  -Headers $workerHeaders `
  -Body $body
Write-Host "      OK: $($r | ConvertTo-Json -Compress)" -ForegroundColor Green

Write-Host "`n[3/3] Seeding bootstrap identity..." -ForegroundColor Yellow
$seed = @{
  tool   = "memory.context.ingest"
  params = @{
    id   = "bootstrap-v2"
    text = "Saumil Shah. 2nd year B.Tech Chemical Engineering, SVNIT Surat. CGPA 7.51. Building NANCE persistent memory system. GATE 2026 target. Python/ML background. Architect/Sovereign persona."
    tags = @("identity", "bootstrap")
    graph_updates = @{
      name           = "Saumil Shah"
      college        = "SVNIT Surat"
      year           = "2"
      cgpa           = "7.51"
      current_project = "NANCE"
      project_status = "v0.4.0-deployed"
      next_action    = "add_github_token"
    }
  }
} | ConvertTo-Json -Depth 10 -Compress

$r = Invoke-RestMethod -Method Post `
  -Uri "$WorkerUrl/call" `
  -Headers $workerHeaders `
  -Body $seed
Write-Host "      OK: $($r | ConvertTo-Json -Compress)" -ForegroundColor Green

Write-Host "`n[DONE] Qdrant reset and reseeded with real embeddings (bge-small-en-v1.5)." -ForegroundColor Green
