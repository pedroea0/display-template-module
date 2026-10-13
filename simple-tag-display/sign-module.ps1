# =============================================================================
#  sign-module.ps1  -  sign build\Tag-Display.unsigned.modl -> build\Tag-Display.modl
# =============================================================================
#
#  Normally run by build-and-sign.ps1. Standalone use (re-sign an existing
#  unsigned .modl):  cd simple-tag-display; .\sign-module.ps1
#  Paths are resolved from $PSScriptRoot, so the current directory does not
#  matter.
#
#  Keystore and passwords:
#    - Production: put the keystore OUTSIDE the repo and set
#          CTG_KEYSTORE        path to the .jks
#          CTG_CERT_CHAIN      path to the .p7b chain
#          CTG_KEY_ALIAS       key alias
#          CTG_KEYSTORE_PASSWORD, CTG_CERT_PASSWORD
#      (prod*.jks / prod*.p7b are git-ignored).
#    - Without CTG_KEYSTORE_PASSWORD the committed DEV keystore is used and a
#      warning is printed: it is a public, self-signed development credential,
#      fine for test gateways, never for production. Third-party signing
#      with a purchased certificate works through the same variables.
#    - Fail-closed rules: with CTG_KEYSTORE_PASSWORD set, both CTG_KEYSTORE and
#      CTG_CERT_CHAIN are required and must exist (a custom key is never paired
#      silently with the committed DEV chain); any CTG_KEYSTORE /
#      CTG_CERT_CHAIN / CTG_KEY_ALIAS / CTG_CERT_PASSWORD without
#      CTG_KEYSTORE_PASSWORD is an error (a mistyped password variable must not
#      fall back to the dev keystore with exit 0); and the signing key's
#      certificate must be in the chain (SHA-256 fingerprint, keytool), else
#      the gateway would reject the module at install time. Exit 1 for all.
#    - The passwords are handed to the signer through environment variables
#      (module-signer -keystore-pwd-env / -alias-pwd-env), not on its command
#      line: command lines are visible in the process list and EDR logs. The
#      signer jar is rebuilt by build-and-sign.ps1 when its sources change (the
#      -*-pwd-env options exist only in this repository's module-signer).
#
#  The signer's own output is shown, not captured into a variable (a variable
#  named $args would also shadow PowerShell's automatic $args).
# =============================================================================

$ErrorActionPreference = "Stop"
$ModuleDir = $PSScriptRoot

# Java 17 (same JDK as the build)
$Java17 = if ($env:JAVA17_HOME) { $env:JAVA17_HOME } else { "C:\Program Files\Java\jdk-17" }
if (Test-Path (Join-Path $Java17 "bin\java.exe")) {
    $env:JAVA_HOME = $Java17
    $env:Path = "$Java17\bin;" + $env:Path
}

$SignerJar = Join-Path $ModuleDir "..\module-signer\build\libs\module-signer-1.0.0-jar-with-dependencies.jar"
$ModuleIn = Join-Path $ModuleDir "build\Tag-Display.unsigned.modl"
$ModuleOut = Join-Path $ModuleDir "build\Tag-Display.modl"

if ($env:CTG_KEYSTORE_PASSWORD) {
    # Production: never mix in the committed dev files
    $missing = @()
    if (-not $env:CTG_KEYSTORE) { $missing += "CTG_KEYSTORE" }
    if (-not $env:CTG_CERT_CHAIN) { $missing += "CTG_CERT_CHAIN" }
    if ($missing.Count -gt 0) {
        Write-Host "ERROR: CTG_KEYSTORE_PASSWORD is set but $($missing -join ' and ') is not: refusing to sign with a mix of your key and the committed DEV files." -ForegroundColor Red
        exit 1
    }
    $Keystore = $env:CTG_KEYSTORE
    $CertChain = $env:CTG_CERT_CHAIN
    $Alias = if ($env:CTG_KEY_ALIAS) { $env:CTG_KEY_ALIAS } else { "simpletagdisplay" }
    $KeystorePwd = $env:CTG_KEYSTORE_PASSWORD
    $AliasPwd = if ($env:CTG_CERT_PASSWORD) { $env:CTG_CERT_PASSWORD } else { $env:CTG_KEYSTORE_PASSWORD }
    if (-not (Test-Path $CertChain)) {
        Write-Host "ERROR: certificate chain not found: $CertChain" -ForegroundColor Red
        exit 1
    }
} else {
    $partial = @("CTG_KEYSTORE", "CTG_CERT_CHAIN", "CTG_KEY_ALIAS", "CTG_CERT_PASSWORD") | Where-Object { [Environment]::GetEnvironmentVariable($_) }
    if ($partial) {
        Write-Host "ERROR: $($partial -join ', ') set without CTG_KEYSTORE_PASSWORD: refusing to fall back to the public DEV certificate (check the variable name)." -ForegroundColor Red
        exit 1
    }
    Write-Host "WARNING: signing with the public DEV certificate (not for production). Set CTG_KEYSTORE_PASSWORD (and CTG_KEYSTORE, CTG_CERT_CHAIN, CTG_KEY_ALIAS) to sign with your own certificate." -ForegroundColor Yellow
    $Keystore = Join-Path $ModuleDir "simpletagdisplay.jks"     # dev-only keystore, committed on purpose
    $CertChain = Join-Path $ModuleDir "simpletagdisplay.p7b"
    $Alias = "simpletagdisplay"
    $KeystorePwd = "simpletagdisplay123"                         # dev-only; never reuse
    $AliasPwd = "simpletagdisplay123"
}

if (-not (Test-Path $SignerJar)) {
    Write-Host "ERROR: module-signer jar not found: $SignerJar (build-and-sign.ps1 builds it)." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $ModuleIn)) {
    Write-Host "ERROR: unsigned module not found: $ModuleIn (run .\gradlew.bat build first)." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $Keystore)) {
    Write-Host "ERROR: keystore not found: $Keystore" -ForegroundColor Red
    exit 1
}

# Passwords travel to the signer through the ENVIRONMENT of the child process (-keystore-pwd-env /
# -alias-pwd-env name the variables), never as -keystore-pwd=<secret> on the command line, where the
# process list and EDR/audit logs would record them. The two variables are set for this process only
# and removed again below.
$env:CTG_SIGN_KEYSTORE_PWD = $KeystorePwd
$env:CTG_SIGN_ALIAS_PWD = $AliasPwd
$javaArgs = @(
    "-jar", $SignerJar,
    "-keystore=$Keystore",
    "-keystore-pwd-env=CTG_SIGN_KEYSTORE_PWD",
    "-alias=$Alias",
    "-alias-pwd-env=CTG_SIGN_ALIAS_PWD"
)
if ($CertChain -and (Test-Path $CertChain)) {
    $javaArgs += "-chain=$CertChain"
}

# The certificate of the signing key must be in the chain the .modl will carry: the signer copies the chain as-is,
# so otherwise a mismatch is only found by the gateway at install time. keytool reads the store password
# from the environment variable (-storepass:env), never from the command line.
function Get-Sha256Fingerprints([string]$text) {
    ([regex]::Matches($text, 'SHA-?256:\s*([0-9A-Fa-f:]{64,})') | ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() })
}
$keytool = Join-Path $Java17 "bin\keytool.exe"
if (-not (Test-Path $keytool)) { $keytool = "keytool" }
$ErrorActionPreference = "Continue"
$entryText = (& $keytool -list -v -keystore $Keystore -alias $Alias -storepass:env CTG_SIGN_KEYSTORE_PWD 2>&1 | Out-String)
$entryCode = $LASTEXITCODE
$chainText = if ($CertChain -and (Test-Path $CertChain)) { (& $keytool -printcert -file $CertChain 2>&1 | Out-String) } else { "" }
$ErrorActionPreference = "Stop"
$keyFp = @(Get-Sha256Fingerprints $entryText) | Select-Object -First 1
$chainFps = @(Get-Sha256Fingerprints $chainText)
if ($entryCode -ne 0 -or -not $keyFp) {
    Remove-Item Env:\CTG_SIGN_KEYSTORE_PWD, Env:\CTG_SIGN_ALIAS_PWD -ErrorAction SilentlyContinue
    Write-Host "ERROR: could not read the certificate of alias '$Alias' from $Keystore (keytool exit $entryCode)." -ForegroundColor Red
    exit 1
}
if ($chainFps -notcontains $keyFp) {
    Remove-Item Env:\CTG_SIGN_KEYSTORE_PWD, Env:\CTG_SIGN_ALIAS_PWD -ErrorAction SilentlyContinue
    Write-Host "ERROR: the certificate of the signing key ($keyFp) is not in the chain $CertChain. The gateway would reject this module; pass the chain that belongs to the key." -ForegroundColor Red
    exit 1
}
$javaArgs += @("-module-in=$ModuleIn", "-module-out=$ModuleOut")

$before = if (Test-Path $ModuleOut) { (Get-Item $ModuleOut).LastWriteTimeUtc } else { [DateTime]::MinValue }
$started = [DateTime]::UtcNow.AddSeconds(-2)

Write-Host "Signing $ModuleIn ..." -ForegroundColor Green
# Local "Continue": the signer's stderr must not become a terminating error when redirected.
$ErrorActionPreference = "Continue"
try {
    & java @javaArgs
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:\CTG_SIGN_KEYSTORE_PWD, Env:\CTG_SIGN_ALIAS_PWD -ErrorAction SilentlyContinue
}
$ErrorActionPreference = "Stop"
if ($code -ne 0) {
    Write-Host "ERROR: module signing failed (exit $code)." -ForegroundColor Red
    exit $code
}

# The signer has exited 0 without writing in the past: check the output really is new.
if (-not (Test-Path $ModuleOut)) {
    Write-Host "ERROR: signer reported success but $ModuleOut does not exist." -ForegroundColor Red
    exit 1
}
$after = (Get-Item $ModuleOut).LastWriteTimeUtc
if ($after -le $before -or $after -lt $started) {
    Write-Host "ERROR: $ModuleOut was not rewritten by the signer." -ForegroundColor Red
    exit 1
}
Write-Host "SUCCESS: signed module $ModuleOut" -ForegroundColor Green
exit 0
