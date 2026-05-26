# =============================================================================
#  build-and-sign.ps1  —  one-shot build+sign+deploy for the Tag Display module
# =============================================================================
#
#  Run this from anywhere — it relocates relative paths via $PSScriptRoot.
#  Typical invocation from the repo root:
#      .\simple-tag-display\build-and-sign.ps1
#
#  Pipeline (each step aborts the script on failure via $ErrorActionPreference):
#      1. Pin JAVA_HOME to JDK 17 (Ignition runs on Java 17 — newer bytecode
#         silently fails to load and can deadlock the gateway on startup).
#      2. Redirect Gradle's user home to %LOCALAPPDATA% so the cache lives
#         OUTSIDE OneDrive — OneDrive's "cloud file" reparse points break
#         Gradle's file locks with cryptic IOExceptions.
#      3. Build the .modl  →  build\Tag-Display.unsigned.modl
#      4. Build the module-signer JAR if missing  →  ..\module-signer\build\libs\...
#      5. Sign the .modl  →  build\Tag-Display.modl
#      6. Deploy via deploy_ignition_module.py (uninstall+upload+install+restart)
#
#  The script does NOT skip hooks, force-push, or do anything destructive.
#  Re-running it on success is safe — Gradle marks tasks UP-TO-DATE.
#
#  If a build error mentions "Failed to clean up stale outputs":
#      .\gradlew.bat clean build       # then re-run this script
# =============================================================================

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
Push-Location $ModuleDir
try {
    & (Join-Path $ModuleDir "sign-module.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Signing failed" }
} finally {
    Pop-Location
}

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

