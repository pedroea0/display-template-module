# Module Signing Script for Simple Tag Display (PowerShell)
# This script helps sign the module using the module-signer tool
#
# Before running this script:
# 1. Create a keystore with a code signing certificate
# 2. Build the module-signer.jar tool
# 3. Update the variables below with your actual values

# Use Java 17 when available (same as module build)
$Java17 = "C:\Program Files\Java\jdk-17"
if (Test-Path $Java17) {
    $env:JAVA_HOME = $Java17
    $env:Path = "$env:JAVA_HOME\bin;" + $env:Path
}

$MODULE_SIGNER_JAR = "..\module-signer\build\libs\module-signer-1.0.0-jar-with-dependencies.jar"
$KEYSTORE = "simpletagdisplay.jks"
$KEYSTORE_PWD = "simpletagdisplay123"
$ALIAS = "simpletagdisplay"
$ALIAS_PWD = "simpletagdisplay123"
$CERT_CHAIN = "simpletagdisplay.p7b"  # Certificate chain file for self-signed certificate
$MODULE_IN = "build\Tag-Display.unsigned.modl"
$MODULE_OUT = "build\Tag-Display.modl"

# Check if module-signer.jar exists
if (-not (Test-Path $MODULE_SIGNER_JAR)) {
    Write-Host "ERROR: module-signer.jar not found at: $MODULE_SIGNER_JAR" -ForegroundColor Red
    Write-Host "Please build it first using: cd ..\module-signer; mvn clean package" -ForegroundColor Yellow
    exit 1
}

# Check if unsigned module exists
if (-not (Test-Path $MODULE_IN)) {
    Write-Host "ERROR: Unsigned module not found at: $MODULE_IN" -ForegroundColor Red
    Write-Host "Please build the module first using: .\gradlew.bat build" -ForegroundColor Yellow
    exit 1
}

# Check if keystore exists
if (-not (Test-Path $KEYSTORE)) {
    Write-Host "ERROR: Keystore not found at: $KEYSTORE" -ForegroundColor Red
    Write-Host "Please create a keystore first. See SIGNING_GUIDE.md for instructions." -ForegroundColor Yellow
    exit 1
}

Write-Host "Signing module..." -ForegroundColor Green
Write-Host ""

# Build the command arguments
$args = @(
    "-jar", $MODULE_SIGNER_JAR,
    "-keystore=$KEYSTORE",
    "-keystore-pwd=$KEYSTORE_PWD",
    "-alias=$ALIAS",
    "-alias-pwd=$ALIAS_PWD"
)

# Add chain parameter only if CERT_CHAIN is specified
if ($CERT_CHAIN -and (Test-Path $CERT_CHAIN)) {
    $args += "-chain=$CERT_CHAIN"
}

$args += @(
    "-module-in=$MODULE_IN",
    "-module-out=$MODULE_OUT"
)

# Execute the signing
$result = & java $args

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: Module signed successfully!" -ForegroundColor Green
    Write-Host "Signed module: $MODULE_OUT" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "ERROR: Module signing failed!" -ForegroundColor Red
    Write-Host "Check the error messages above." -ForegroundColor Yellow
    exit 1
}

