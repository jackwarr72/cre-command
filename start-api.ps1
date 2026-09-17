param(
    [switch]$LoadEnvFromFile
)

# Set required environment variables
$env:AUTH_BYPASS = "true"
$env:NODE_ENV = "development"

# Change to packages/api directory
$apiDir = "C:\Users\Windows 11\Documents\cre-command\packages\api"
Set-Location $apiDir

Write-Host "Starting API server with AUTH_BYPASS=$env:AUTH_BYPASS, NODE_ENV=$env:NODE_ENV"
Write-Host "Working directory: $apiDir"

# Start the API server
& npx tsx src/index.ts