# =============================================================================
#  sign-module.ps1  —  invoke module-signer JAR with our dev keystore
# =============================================================================
#
#  Normally run by build-and-sign.ps1 (which Push-Locations into $ModuleDir
#  first so the relative paths below resolve). Can also be run standalone
#  from the simple-tag-display\ directory if you only need to re-sign an
#  already-built unsigned .modl.
#
#  Inputs:
#      $MODULE_SIGNER_JAR   The signer tool, built from ..\module-signer
#      $KEYSTORE            JKS containing the private key (dev only — DO NOT
#                           reuse this credential for anything sensitive)
#      $CERT_CHAIN          PKCS#7 (.p7b) cert chain for the self-signed cert
#      $MODULE_IN           build\Tag-Display.unsigned.modl produced by Gradle
#      $MODULE_OUT          build\Tag-Display.modl — what gets uploaded to gw
#
#  The chain file is optional: if missing, signer skips -chain= and produces
#  a self-signed module that Ignition will accept only when "Allow Unsigned
#  Modules" is enabled in Gateway settings.
# =============================================================================

# Use Java 17 when available (matches module build — Ignition rejects newer bytecode)
$Java17 = "C:\Program Files\Java\jdk-17"
if (Test-Path $Java17) {
    $env:JAVA_HOME = $Java17
    $env:Path = "$env:JAVA_HOME\bin;" + $env:Path
}

# All paths relative to simple-tag-display\ (caller is expected to cd here first).
$MODULE_SIGNER_JAR = "..\module-signer\build\libs\module-signer-1.0.0-jar-with-dependencies.jar"
$KEYSTORE = "simpletagdisplay.jks"                 # dev-only keystore — committed to repo
$KEYSTORE_PWD = "simpletagdisplay123"               # dev-only — never reuse for anything real
$ALIAS = "simpletagdisplay"
$ALIAS_PWD = "simpletagdisplay123"
$CERT_CHAIN = "simpletagdisplay.p7b"               # PKCS#7 chain for the self-signed cert
$MODULE_IN = "build\Tag-Display.unsigned.modl"     # produced by `gradlew build`
$MODULE_OUT = "build\Tag-Display.modl"             # signed output (what we deploy)

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

