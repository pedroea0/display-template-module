# Build and Sign Simple Tag Display Module
# Uses Java 17 for compatibility with Ignition's JVM.

$ErrorActionPreference = "Stop"
$ModuleDir = $PSScriptRoot
$SignerDir = Join-Path $ModuleDir "..\module-signer"

# Use Java 17 for build and sign (required for Ignition module bytecode compatibility)
$Java17 = "C:\Program Files\Java\jdk-17"
if (Test-Path $Java17) {
    $env:JAVA_HOME = $Java17
    $env:Path = "$env:JAVA_HOME\bin;" + $env:Path
    Write-Host "Using Java 17: $env:JAVA_HOME" -ForegroundColor Gray
} else {
    Write-Host "WARNING: Java 17 not found at $Java17. Ensure JAVA_HOME is set to JDK 17." -ForegroundColor Yellow
}

# Use a local Gradle cache to avoid OneDrive "cloud operation is invalid" errors
$env:GRADLE_USER_HOME = Join-Path $env:LOCALAPPDATA "Gradle\TagDisplayBuild"
if (-not (Test-Path $env:GRADLE_USER_HOME)) { New-Item -ItemType Directory -Path $env:GRADLE_USER_HOME -Force | Out-Null }

Write-Host "=== Building Tag Display module ===" -ForegroundColor Cyan
Push-Location $ModuleDir
try {
    & .\gradlew.bat build
    if ($LASTEXITCODE -ne 0) { throw "Gradle build failed" }
} finally {
    Pop-Location
}

$unsignedPath = Join-Path $ModuleDir "build\Tag-Display.unsigned.modl"
if (-not (Test-Path $unsignedPath)) {
    Write-Host "ERROR: Build did not produce $unsignedPath" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Building module-signer (if needed) ===" -ForegroundColor Cyan
$signerJar = Join-Path $SignerDir "build\libs\module-signer-1.0.0-jar-with-dependencies.jar"
if (-not (Test-Path $signerJar)) {
    Push-Location $SignerDir
    try {
        & (Join-Path $ModuleDir "gradlew.bat") build
        if ($LASTEXITCODE -ne 0) { throw "Module-signer build failed" }
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "=== Signing module ===" -ForegroundColor Cyan
& (Join-Path $ModuleDir "sign-module.ps1")
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Write-Host "Done. Signed module: $ModuleDir\build\Tag-Display.modl" -ForegroundColor Green

# Deploy the signed module to the Gateway (config is hardcoded in deploy_ignition_module.py).
$deployScript = Join-Path $ModuleDir "deploy_ignition_module.py"
$modlPath = Join-Path $ModuleDir "build\Tag-Display.modl"
if (Test-Path $deployScript) {
    Write-Host ""
    Write-Host "=== Deploying module via Ignition API ===" -ForegroundColor Cyan
    $pythonExe = if ($env:PYTHON_EXE) { $env:PYTHON_EXE } else { "python" }
    & $pythonExe $deployScript --module-file $modlPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Deployment failed (exit code $LASTEXITCODE)." -ForegroundColor Yellow
    } else {
        Write-Host "Deployment completed." -ForegroundColor Green
    }
}

