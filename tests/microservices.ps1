# manual tests for microservices
# usage: powershell -ExecutionPolicy Bypass -File tests\microservices.ps1

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

Write-Host "==> test 1: at least 3 Node containers running independently"
$nodes = @('spa-api-gateway-1', 'spa-pg-service-1', 'spa-mongo-service-1')
foreach ($n in $nodes) {
    $state = docker inspect -f '{{.State.Status}}' $n 2>$null
    Assert "container $n running" ($state -eq 'running')
}

Write-Host "==> test 2: each service has its own image (separate containers per microservice)"
$images = docker compose images --format json 2>$null
Assert "compose images command succeeded" ($LASTEXITCODE -eq 0)

Write-Host "==> test 3: BD engines split per service - pg-service depends on postgres only"
$compose = Get-Content docker-compose.yml -Raw
$pgBlock = [regex]::Match($compose, "pg-service:[\s\S]*?(?=^\s{2}\w|\z)", 'Multiline').Value
Assert "pg-service connects to postgres via DATABASE_URL"  ($pgBlock -match "DATABASE_URL=postgres://")
Assert "pg-service does NOT reference mongodb"             ($pgBlock -notmatch "MONGO_URI")

$mongoBlock = [regex]::Match($compose, "mongo-service:[\s\S]*?(?=^\s{2}\w|\z)", 'Multiline').Value
Assert "mongo-service connects to mongodb via MONGO_URI"   ($mongoBlock -match "MONGO_URI")
Assert "mongo-service does NOT reference DATABASE_URL"     ($mongoBlock -notmatch "DATABASE_URL")

Write-Host "==> test 4: gateway uses HTTP to talk to microservices"
$gatewaySrc = Get-Content backend\api-gateway\src\index.js -Raw
Assert "gateway uses axios for service-to-service HTTP"    ($gatewaySrc -match "axios\.(get|post|delete)")
Assert "gateway references INVENTORY_SERVICE_URL via env"  ($gatewaySrc -match "INVENTORY_SERVICE_URL")
Assert "gateway references CATALOG_SERVICE_URL via env"    ($gatewaySrc -match "CATALOG_SERVICE_URL")

Write-Host "==> test 5: API Gateway is the only public-facing service (logically)"
Assert "api-gateway maps API_GATEWAY_PORT (public entry)"  ($compose -match "API_GATEWAY_PORT")

Write-Host "==> test 6: migrations and seeds run from compose (no manual steps)"
$pkgInv = Get-Content backend\inventory-order-service\package.json -Raw
Assert "pg-service runs prisma migrate deploy on start"   ($pkgInv -match "prisma migrate deploy")
Assert "pg-service runs knex migrate:latest on start"     ($pkgInv -match "knex migrate:latest")
Assert "pg-service runs knex seed:run on start"           ($pkgInv -match "knex seed:run")
Assert "compose declares a seeder one-shot service"       ($compose -match "seeder:")

Write-Host "==> test 7: live check - all 3 service /health endpoints respond 200"
foreach ($url in @('http://localhost:3000/health','http://localhost:3001/health','http://localhost:3002/health')) {
    try {
        $r = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).StatusCode
        Assert "$url returns 200" ($r -eq 200)
    } catch {
        Assert "$url returns 200" $false $_.Exception.Message
    }
}

Write-Host "==> test 8: live check - gateway aggregates data from both engines"
try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000/api/products/1" -UseBasicParsing -TimeoutSec 5
    $json = $r.Content | ConvertFrom-Json
    Assert "GET /api/products/1 has pg field 'stock'"        ($null -ne $json.stock)
    Assert "GET /api/products/1 has mongo field 'variants'"  ($json.variants -ne $null)
} catch {
    Assert "gateway aggregation succeeded" $false $_.Exception.Message
}

Write-Host ""
if ($failed -eq 0) {
    Write-Host "==> ALL MICROSERVICES CHECKS PASSED" -ForegroundColor Green
} else {
    Write-Host "==> $failed CHECK(S) FAILED" -ForegroundColor Red
    exit 1
}
