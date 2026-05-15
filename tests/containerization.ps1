# manual tests for containerization
# usage: powershell -ExecutionPolicy Bypass -File tests\containerization.ps1

$ErrorActionPreference = 'Continue'
$global:failed = 0

function Assert($name, $condition, $details = "") {
    if ($condition) {
        Write-Host "PASS  $name" -ForegroundColor Green
    } else {
        Write-Host "FAIL  $name  $details" -ForegroundColor Red
        $global:failed++
    }
}

Write-Host "==> test 1: .env.example exists"
Assert ".env.example present" (Test-Path .env.example)

Write-Host "==> test 2: multi-stage Dockerfiles in each backend service"
$gatewayDocker = Get-Content backend\api-gateway\Dockerfile -Raw
$invDocker     = Get-Content backend\inventory-order-service\Dockerfile -Raw
$catDocker     = Get-Content backend\catalog-analytics-service\Dockerfile -Raw
$frontDocker   = Get-Content frontend\Dockerfile -Raw

Assert "gateway Dockerfile uses multi-stage (AS builder)"      ($gatewayDocker -match "AS builder")
Assert "inventory Dockerfile uses multi-stage (AS builder)"     ($invDocker     -match "AS builder")
Assert "catalog Dockerfile uses multi-stage (AS builder)"       ($catDocker     -match "AS builder")
Assert "frontend Dockerfile uses multi-stage (AS builder)"      ($frontDocker   -match "AS builder")

Write-Host "==> test 3: docker-compose declares healthchecks for db and microservices"
$compose = Get-Content docker-compose.yml -Raw
Assert "postgres has healthcheck"      ($compose -match "postgres:[\s\S]*?healthcheck:")
Assert "mongodb has healthcheck"       ($compose -match "mongodb:[\s\S]*?healthcheck:")
Assert "pg-service has healthcheck"    ($compose -match "pg-service:[\s\S]*?healthcheck:")
Assert "mongo-service has healthcheck" ($compose -match "mongo-service:[\s\S]*?healthcheck:")
Assert "api-gateway has healthcheck"   ($compose -match "api-gateway:[\s\S]*?healthcheck:")

Write-Host "==> test 4: depends_on uses service_healthy condition"
Assert "service_healthy condition used at least 4 times" ((($compose | Select-String -Pattern "service_healthy" -AllMatches).Matches.Count) -ge 4)

Write-Host "==> test 5: full clean rebuild without any manual step"
docker compose down -v 2>&1 | Out-Null
docker compose up -d --build 2>&1 | Out-Null

Write-Host "==> waiting for stack to become healthy..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $g = (Invoke-WebRequest -Uri http://localhost:3000/health -UseBasicParsing -TimeoutSec 2).StatusCode
        if ($g -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 3
}
Assert "all gateways/services reach /health 200 after up" $ready

Write-Host "==> waiting for seeder one-shot to finish (max 60s)"
$seederDone = $false
for ($i = 0; $i -lt 20; $i++) {
    $state = docker inspect -f '{{.State.Status}}' spa-seeder-1 2>$null
    if ($state -eq 'exited') { $seederDone = $true; break }
    Start-Sleep -Seconds 3
}
Assert "seeder one-shot exited" $seederDone

Write-Host "==> test 6: products were seeded automatically"
$count = (docker exec spa-postgres-1 psql -U user -d ecommerce_db -tA -c "SELECT COUNT(*) FROM products;").Trim()
Assert "products table populated (count = $count)" ([int]$count -gt 0)

Write-Host ""
if ($failed -eq 0) {
    Write-Host "==> ALL CHECKS PASSED" -ForegroundColor Green
} else {
    Write-Host "==> $failed CHECK(S) FAILED" -ForegroundColor Red
    exit 1
}
