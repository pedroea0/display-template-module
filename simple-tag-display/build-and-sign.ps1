# =============================================================================
#  build-and-sign.ps1  -  build, verify and sign the module; deploy only on request
# =============================================================================
#
#  Usage (from anywhere; paths are resolved from $PSScriptRoot):
#      .\simple-tag-display\build-and-sign.ps1                  # build + verify + sign
#      .\simple-tag-display\build-and-sign.ps1 -Deploy          # ... then deploy (asks first unless localhost)
#      .\simple-tag-display\build-and-sign.ps1 -Deploy -Force   # ... deploy without asking
#      .\simple-tag-display\build-and-sign.ps1 -Deploy -DeployConfig C:\path\deploy.json
#      .\simple-tag-display\build-and-sign.ps1 -VerifyModl C:\path\Tag-Display.unsigned.modl   # verify only
#
#  Pipeline (any failing step stops the script with a non-zero exit code):
#      1. JDK 17 is REQUIRED. Ignition 8.3 runs on Java 17; newer bytecode fails
#         to load and can deadlock the gateway on startup, so a missing JDK 17
#         is a hard failure, not a warning.
#      2. Gradle's user home goes to %LOCALAPPDATA%\Gradle\TagDisplayBuild, outside
#         OneDrive (its cloud-file reparse points break Gradle's file locks).
#      3. gradlew build (compiles, runs the JUnit tests, assembles the .modl).
#         Only the OneDrive "stale outputs" / file-lock failure is retried once
#         (after deleting build\classes, resources, tmp); a failing test or a
#         compile error stops the script.
#      4. .modl verification (exit 3): exactly one common/designer/gateway jar of
#         THIS version, no other jar, every class file Java 17, module.xml version,
#         and mounted/build-id.txt (gateway jar) equals the SHA-256 recomputed over
#         every entry of the three jars (algorithm: gateway/build.gradle.kts).
#         (deploy_ignition_module.py repeats the same check on the file it uploads.)
#         This is the hard precondition of every deploy (it catches stale jars).
#      5. module-signer jar: its Gradle build always runs (incremental, content-based).
#      6. sign-module.ps1 -> build\Tag-Display.modl (checked to exist and be new),
#         then the SIGNED .modl is verified again (step 4 rules, exit 3).
#      7. Only with -Deploy: deploy_ignition_module.py (upload, certificate,
#         install (= upgrade; no uninstall), restart, health check). A gateway that
#         is not localhost/127.0.0.1 needs a typed confirmation unless -Force.
#
#  Exit codes: 0 ok | 1 build/sign/precondition failure | 2 deploy configuration
#  error (the deploy target could not be resolved) | 3 .modl verification
#  failed | 4 deployment cancelled | 10..17 deploy stage failures (see the
#  deploy script). During the deploy step the deploy script's exit code is
#  passed through (there 1/2/3 = general error / configuration / .modl
#  verification failed, nothing was sent; a wrong installed version after the
#  restart is 17).
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Deploy,
    [string]$DeployConfig,
    [switch]$Force,
    [string]$VerifyModl
)

$ErrorActionPreference = "Stop"
$ModuleDir = $PSScriptRoot
$SignerDir = Join-Path $ModuleDir "..\module-signer"

# Native tools (gradle, java, python) write progress and warnings to stderr. Under
# $ErrorActionPreference = "Stop", Windows PowerShell 5.1 turns redirected stderr
# lines into terminating errors, so native calls run with a local "Continue" and
# are judged by their exit code only.
function Invoke-Native([scriptblock]$Block) {
    $ErrorActionPreference = "Continue"
    & $Block
    return $LASTEXITCODE
}

function Fail([int]$code, [string]$message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    exit $code
}

# -----------------------------------------------------------------------------
# Module version from build.gradle.kts (allprojects { version = "x.y.z" })
# -----------------------------------------------------------------------------
function Get-ModuleVersion {
    $gradle = Get-Content (Join-Path $ModuleDir "build.gradle.kts") -Raw
    $m = [regex]::Match($gradle, '(?m)^\s*version\s*=\s*"([^"]+)"')
    if (-not $m.Success) { Fail 1 "Cannot find 'version = ""...""' in build.gradle.kts" }
    return $m.Groups[1].Value
}

# -----------------------------------------------------------------------------
# .modl verification. Returns a list of problems (empty = OK).
# -----------------------------------------------------------------------------
function Get-ZipEntryBytes($entry) {
    $ms = New-Object System.IO.MemoryStream
    $s = $entry.Open(); try { $s.CopyTo($ms) } finally { $s.Dispose() }
    return ,$ms.ToArray()
}

# Build id: same algorithm as gateway/build.gradle.kts and
# deploy_ignition_module.py compute_build_id. For jar in common, designer,
# gateway; entries sorted by name (ordinal); every file entry except
# META-INF/MANIFEST.MF and the gateway's mounted/build-id.txt:
#   UTF-8 "<jar>/<name>", 0x00, 8-byte big-endian length, bytes.
# Returns @(embedded id or $null, recomputed id).
function Get-BuildIds([System.IO.Compression.ZipArchive]$zip, [string]$version) {
    $sha = [System.Security.Cryptography.IncrementalHash]::CreateHash([System.Security.Cryptography.HashAlgorithmName]::SHA256)
    $embedded = $null
    foreach ($kind in @('common', 'designer', 'gateway')) {
        $entry = $zip.Entries | Where-Object { $_.Name -eq "$kind-$version.jar" } | Select-Object -First 1
        $ms = [System.IO.MemoryStream]::new((Get-ZipEntryBytes $entry))
        $inner = New-Object System.IO.Compression.ZipArchive($ms, [System.IO.Compression.ZipArchiveMode]::Read)
        try {
            $byName = @{}
            $names = New-Object System.Collections.Generic.List[string]
            foreach ($e in $inner.Entries) {
                $n = $e.FullName
                if ($n.EndsWith('/') -or $n -ceq 'META-INF/MANIFEST.MF') { continue }
                if ($kind -eq 'gateway' -and $n -ceq 'mounted/build-id.txt') {
                    $embedded = [System.Text.Encoding]::ASCII.GetString((Get-ZipEntryBytes $e)).Trim()
                    continue
                }
                $names.Add($n)
                $byName[$n] = $e
            }
            $names.Sort([System.StringComparer]::Ordinal)
            foreach ($n in $names) {
                $data = Get-ZipEntryBytes $byName[$n]
                $sha.AppendData([System.Text.Encoding]::UTF8.GetBytes("$kind/$n"))
                $sha.AppendData([byte[]]@(0))
                $len = [System.BitConverter]::GetBytes([long]$data.Length)
                if ([System.BitConverter]::IsLittleEndian) { [Array]::Reverse($len) }
                $sha.AppendData($len)
                $sha.AppendData([byte[]]$data)
            }
        } finally { $inner.Dispose(); $ms.Dispose() }
    }
    $hex = -join ($sha.GetHashAndReset() | ForEach-Object { $_.ToString('x2') })
    $sha.Dispose()
    return @($embedded, $hex)
}

function Test-Modl([string]$path, [string]$version) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # .NET resolves a relative path against the PROCESS directory, Test-Path against the PowerShell location; a
    # relative -VerifyModl path would crash (or open another checkout's file). Resolve it here once.
    $path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($path)
    $problems = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path $path)) { $problems.Add("file not found: $path"); return $problems }
    $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
    try {
        $jars = @($zip.Entries | Where-Object { $_.FullName -like '*.jar' })
        $expected = @("common-$version.jar", "designer-$version.jar", "gateway-$version.jar")
        foreach ($name in $expected) {
            $n = @($jars | Where-Object { $_.Name -eq $name }).Count
            if ($n -ne 1) { $problems.Add("expected exactly one $name, found $n") }
        }
        foreach ($j in $jars) {
            if ($expected -notcontains $j.Name) { $problems.Add("unexpected jar in .modl: $($j.FullName)") }
        }
        # Every expected jar: EVERY .class entry must be Java 17 bytecode (major 61 = 0x3D). Checking only one
        # class per jar would let a jar that mixes Java 17 and newer bytecode through.
        # module-info.class / multi-release entries are checked like any other class.
        foreach ($j in ($jars | Where-Object { $expected -contains $_.Name })) {
            $ms = New-Object System.IO.MemoryStream
            $s = $j.Open(); try { $s.CopyTo($ms) } finally { $s.Dispose() }
            $ms.Position = 0
            $inner = New-Object System.IO.Compression.ZipArchive($ms, [System.IO.Compression.ZipArchiveMode]::Read)
            try {
                $classes = @($inner.Entries | Where-Object { $_.FullName -like '*.class' })
                if ($classes.Count -eq 0) { $problems.Add("$($j.Name) contains no classes"); continue }
                $maxMajor = 0
                $bad = New-Object System.Collections.Generic.List[string]
                $buf = New-Object byte[] 8
                foreach ($cls in $classes) {
                    $cs = $cls.Open()
                    try {
                        $read = 0
                        while ($read -lt 8) { $r = $cs.Read($buf, $read, 8 - $read); if ($r -le 0) { break }; $read += $r }
                    } finally { $cs.Dispose() }
                    $isClass = $read -eq 8 -and $buf[0] -eq 0xCA -and $buf[1] -eq 0xFE -and $buf[2] -eq 0xBA -and $buf[3] -eq 0xBE
                    if (-not $isClass) { $bad.Add("$($cls.FullName) (not a class file)"); continue }
                    $major = ($buf[6] * 256) + $buf[7]
                    if ($major -gt $maxMajor) { $maxMajor = $major }
                    if ($major -ne 61) { $bad.Add("$($cls.FullName) (major $major)") }
                }
                if ($bad.Count -gt 0) {
                    $shown = ($bad | Select-Object -First 5) -join ", "
                    $problems.Add("$($j.Name): $($bad.Count) of $($classes.Count) classes are not Java 17 bytecode (expected major 61, highest $maxMajor): $shown")
                }
            } finally { $inner.Dispose(); $ms.Dispose() }
        }
        $mx = $zip.Entries | Where-Object { $_.FullName -eq 'module.xml' } | Select-Object -First 1
        if (-not $mx) {
            $problems.Add("module.xml missing")
        } else {
            $sr = New-Object System.IO.StreamReader($mx.Open())
            try { $xml = $sr.ReadToEnd() } finally { $sr.Dispose() }
            # Anchored like the Python check: <version>2.0.0-rc1</version> or <version>2.0.01</version> must NOT pass.
            if ($xml -notmatch "<version>\s*$([regex]::Escape($version))\s*</version>") { $problems.Add("module.xml does not declare <version>$version") }
        }
        if ($problems.Count -eq 0) {
            $ids = Get-BuildIds $zip $version
            if (-not $ids[0]) {
                $problems.Add("gateway-$version.jar has no mounted/build-id.txt")
            } elseif ($ids[0] -ne $ids[1]) {
                $problems.Add("build id mismatch: mounted/build-id.txt says $($ids[0].Substring(0, [Math]::Min(16, $ids[0].Length))), the jar entries hash to $($ids[1].Substring(0, 16)) (a jar was changed after the build, or the build id algorithms disagree)")
            }
        }
    } finally {
        $zip.Dispose()
    }
    return $problems
}

# The one Gradle failure the build retries is the OneDrive stale-output / file-lock one; never a failing test or
# compile error (pure; tests/js/tools-migrator-and-build-script.test.mjs runs it).
function Test-GradleRetryable([string]$logText) {
    if (-not $logText) { return $false }
    # (the stale-output failure itself is reported as "> Task :gateway:compileJava FAILED", so that line is no veto)
    if ($logText -match 'There were failing tests|> Task :[\w:-]*test FAILED|Compilation failed') { return $false }
    return [bool]($logText -match 'Failed to clean up stale outputs|Unable to delete (directory|file)|being used by another process|Could not delete|AccessDeniedException')
}

function Invoke-ModlVerification([string]$path, [string]$version) {
    Write-Host "Verifying $path (version $version) ..." -ForegroundColor Gray
    $problems = @(Test-Modl $path $version)
    if ($problems.Count -gt 0) {
        foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
        Fail 3 ".modl verification failed; refusing to sign or deploy."
    }
    Write-Host ".modl verification OK: common/designer/gateway-$version.jar, Java 17 bytecode, module.xml $version, build id matches the jar contents" -ForegroundColor Green
}

$version = Get-ModuleVersion

if ($VerifyModl) {
    $VerifyModl = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($VerifyModl)
    Invoke-ModlVerification $VerifyModl $version
    exit 0
}

# -----------------------------------------------------------------------------
# 1. JDK 17 (hard requirement). JAVA17_HOME overrides the default location.
# -----------------------------------------------------------------------------
$Java17 = if ($env:JAVA17_HOME) { $env:JAVA17_HOME } else { "C:\Program Files\Java\jdk-17" }
if (-not (Test-Path (Join-Path $Java17 "bin\java.exe"))) {
    Fail 1 "JDK 17 not found at $Java17. Install JDK 17 or set JAVA17_HOME. (Ignition 8.3 runs on Java 17; never build with a newer JDK.)"
}
$env:JAVA_HOME = $Java17
$env:Path = "$Java17\bin;" + $env:Path
Write-Host "Using Java 17: $Java17" -ForegroundColor Gray

# -----------------------------------------------------------------------------
# 2. Gradle user home outside OneDrive
# -----------------------------------------------------------------------------
$env:GRADLE_USER_HOME = Join-Path $env:LOCALAPPDATA "Gradle\TagDisplayBuild"
if (-not (Test-Path $env:GRADLE_USER_HOME)) { New-Item -ItemType Directory -Path $env:GRADLE_USER_HOME -Force | Out-Null }

# -----------------------------------------------------------------------------
# 3. Build
# -----------------------------------------------------------------------------
Write-Host "=== Building module $version ===" -ForegroundColor Cyan
Push-Location $ModuleDir
try {
    $gradleLog = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-gradle-" + [guid]::NewGuid().ToString("N") + ".log")
    $code = Invoke-Native { & .\gradlew.bat build --console=plain 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $gradleLog | Out-Host }
    if ($code -ne 0) {
        # Most often "Failed to clean up stale outputs": Gradle cannot delete outputs of files that were
        # removed from the sources (OneDrive reparse points), and `gradlew clean` fails the same way.
        # Removing the compiled outputs ourselves and building once more fixes it. ONLY that failure is
        # retried — any other one stops the script (a failing JUnit test above all: a timing-sensitive
        # concurrency test that passes on a second run must not get signed and deployed).
        $logText = if (Test-Path $gradleLog) { Get-Content $gradleLog -Raw } else { "" }
        Remove-Item $gradleLog -ErrorAction SilentlyContinue
        if (-not (Test-GradleRetryable $logText)) {
            Fail 1 "Gradle build failed (exit $code). Not a stale-output / file-lock failure, so it is not retried (see the Gradle output above)."
        }
        Write-Host "Build failed on stale outputs / a file lock; removing compiled outputs (common/designer/gateway build\classes, build\resources) and retrying once ..." -ForegroundColor Yellow
        foreach ($sub in @("common", "designer", "gateway")) {
            foreach ($dir in @("classes", "resources", "tmp")) {
                $p = Join-Path $ModuleDir "$sub\build\$dir"
                if (Test-Path $p) { Remove-Item -Recurse -Force $p }
            }
        }
        $code = Invoke-Native { & .\gradlew.bat build --console=plain | Out-Host }
        if ($code -ne 0) { Fail 1 "Gradle build failed (exit $code)." }
    }
} finally {
    Pop-Location
}

$unsignedPath = Join-Path $ModuleDir "build\Tag-Display.unsigned.modl"
if (-not (Test-Path $unsignedPath)) { Fail 1 "Build did not produce $unsignedPath" }

# -----------------------------------------------------------------------------
# 4. Verify the unsigned .modl (hard precondition of signing and deploying)
# -----------------------------------------------------------------------------
Invoke-ModlVerification $unsignedPath $version

# -----------------------------------------------------------------------------
# 5. module-signer jar: always run its Gradle build
# -----------------------------------------------------------------------------
# Gradle decides freshness from file CONTENTS (task inputs/outputs), so an
# up-to-date signer costs about a second, and a changed source is always
# rebuilt. An mtime comparison would be unreliable: a fresh checkout or a git
# worktree gives every file a new timestamp, and a source edited before the
# last jar build but checked out later looks older than the jar.
$signerJar = Join-Path $SignerDir "build\libs\module-signer-1.0.0-jar-with-dependencies.jar"
Write-Host "=== Building module-signer (incremental) ===" -ForegroundColor Cyan
Push-Location $SignerDir
try {
    $code = Invoke-Native { & (Join-Path $ModuleDir "gradlew.bat") build --console=plain -q | Out-Host }
    if ($code -ne 0) { Fail 1 "module-signer build failed (exit $code)" }
} finally {
    Pop-Location
}
if (-not (Test-Path $signerJar)) { Fail 1 "module-signer build did not produce $signerJar" }

# -----------------------------------------------------------------------------
# 6. Sign
# -----------------------------------------------------------------------------
Write-Host "=== Signing module ===" -ForegroundColor Cyan
Push-Location $ModuleDir
try {
    $code = Invoke-Native { & (Join-Path $ModuleDir "sign-module.ps1") | Out-Host }
    if ($code -ne 0) { Fail 1 "Signing failed (exit $code)" }
} finally {
    Pop-Location
}
$modlPath = Join-Path $ModuleDir "build\Tag-Display.modl"
Write-Host "Signed module: $modlPath" -ForegroundColor Green

# The signed file is what gets uploaded: verify IT, not only its unsigned input. The signer adds
# signatures.properties + certificates.p7b but must not change the jar set, the bytecode or module.xml.
Invoke-ModlVerification $modlPath $version

if (-not $Deploy) {
    Write-Host "Not deploying (pass -Deploy to install it on a gateway)." -ForegroundColor Gray
    exit 0
}

# -----------------------------------------------------------------------------
# 7. Deploy (opt-in)
# -----------------------------------------------------------------------------
$deployScript = Join-Path $ModuleDir "deploy_ignition_module.py"
$pythonExe = if ($env:PYTHON_EXE) { $env:PYTHON_EXE } else { "python" }
$configArgs = @()
if ($DeployConfig) { $configArgs = @("--config", $DeployConfig) }

$targetLines = $null
$code = Invoke-Native { $script:targetLines = & $pythonExe $deployScript @configArgs --print-target }
$target = @($targetLines) | Select-Object -Last 1
if ($code -ne 0 -or -not $target) { Fail 2 "Could not resolve the deploy target (check the deploy configuration)." }
$targetHost = ([System.Uri]$target).Host
if (-not $Force -and $targetHost -ne "localhost" -and $targetHost -ne "127.0.0.1") {
    Write-Host "About to install $version on $target (the gateway will restart)." -ForegroundColor Yellow
    $answer = Read-Host "Type the host name ($targetHost) to continue"
    if ($answer -ne $targetHost) { Write-Host "Deployment cancelled." -ForegroundColor Yellow; exit 4 }
}

Write-Host "=== Deploying to $target ===" -ForegroundColor Cyan
$deployExit = Invoke-Native { & $pythonExe $deployScript @configArgs --module-file $modlPath --expect-version $version | Out-Host }
if ($deployExit -ne 0) {
    Write-Host "Deployment failed (exit $deployExit)." -ForegroundColor Red
    exit $deployExit
}
Write-Host "Deployment completed." -ForegroundColor Green
exit 0
