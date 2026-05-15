# full clean rebuild + seed for backend tests
# usage: powershell -ExecutionPolicy Bypass -File tests\setup.ps1

$ErrorActionPreference = 'Stop'

Write-Host "==> wiping volumes and containers"
docker compose down -v

Write-Host "==> building and starting stack"
docker compose up -d --build

Write-Host "==> waiting for gateway, inventory and catalog to report healthy"
$attempts = 0
while ($attempts -lt 60) {
    try {
        $g = (Invoke-WebRequest -Uri http://localhost:3000/health -UseBasicParsing -TimeoutSec 2).StatusCode
        $i = (Invoke-WebRequest -Uri http://localhost:3001/health -UseBasicParsing -TimeoutSec 2).StatusCode
        $c = (Invoke-WebRequest -Uri http://localhost:3002/health -UseBasicParsing -TimeoutSec 2).StatusCode
        if ($g -eq 200 -and $i -eq 200 -and $c -eq 200) {
            Write-Host "==> all services ready"
            break
        }
    } catch {
        Write-Host "    still waiting..."
    }
    Start-Sleep -Seconds 3
    $attempts++
}

if ($attempts -eq 60) {
    Write-Host "==> services failed to become healthy after 3 minutes"
    exit 1
}

Write-Host "==> seeding products"
Push-Location backend\api-gateway
node seed-products.js
Pop-Location

Write-Host "==> sanity check: products in postgres"
docker exec spa-postgres-1 psql -U user -d ecommerce_db -c "SELECT id, sku, name, stock FROM products ORDER BY id LIMIT 5;"

Write-Host "==> done. now open postman and run the BD2 Backend Tests collection."
