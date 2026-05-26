# 05 — Building the module

This page walks through what you need installed and exactly what happens when you run the build script.

## Prerequisites

| Tool | Version | Why | Where to get it |
|---|---|---|---|
| **JDK 17** | 17.x (LTS) | Ignition 8.3 runs on Java 17. Newer bytecode silently fails to load and can deadlock the gateway on startup. | [Adoptium Temurin 17](https://adoptium.net/) |
| **Gradle Wrapper** | 7.x (bundled) | The repo ships with `gradlew.bat` so you don't install Gradle yourself. | (already in repo) |
| **Python 3.8+** | 3.8 or newer | Only needed to run the deploy script. | [python.org](https://www.python.org/downloads/) |
| **`requests`** | latest | Python HTTP library used by deploy script. | `pip install requests` |
| **PowerShell** | 5.1+ (Windows default) | The build scripts are written in PowerShell. | Ships with Windows |
| **An Ignition 8.3 gateway** | 8.3.0+ | To install and run the module. | [Inductive Automation](https://inductiveautomation.com/downloads/ignition) |

Optional:
- **Git** — to clone the repo.
- **VS Code or IntelliJ IDEA** — for editing.

### JDK 17 specifically

The build script ([build-and-sign.ps1](../simple-tag-display/build-and-sign.ps1) line 32) hard-codes:

```powershell
$Java17 = "C:\Program Files\Java\jdk-17"
```

If your JDK 17 lives somewhere else, either install it to that path, edit the script, or set `JAVA_HOME` to your JDK 17 location before running. The script logs a warning but doesn't abort if the path doesn't exist — your build will still run with whatever `JAVA_HOME` you have set, which might be the wrong JDK.

To check what you have:

```powershell
java -version
# openjdk version "17.0.X" ... → good
# openjdk version "21.0.X" ... → too new
```

## Verifying the dev keystore is intact

Two files in `simple-tag-display/` are used to sign the module:

- `simpletagdisplay.jks` — JKS keystore with the private key
- `simpletagdisplay.p7b` — PKCS#7 cert chain for the self-signed cert

Both are committed to the repo. The credentials are also hardcoded in [sign-module.ps1](../simple-tag-display/sign-module.ps1):

```powershell
$KEYSTORE_PWD = "simpletagdisplay123"
$ALIAS = "simpletagdisplay"
$ALIAS_PWD = "simpletagdisplay123"
```

**This is a dev-only credential.** If you want to publish modules outside of internal dev gateways, follow [07-signing.md](07-signing.md) to generate your own keystore.

## The build script: `build-and-sign.ps1`

From the repo root:

```powershell
.\simple-tag-display\build-and-sign.ps1
```

The script does 5 things in order. Any failure aborts (`$ErrorActionPreference = "Stop"`).

### Step 1 — Pin JAVA_HOME to JDK 17

```powershell
if (Test-Path $Java17) {
    $env:JAVA_HOME = $Java17
    $env:Path = "$env:JAVA_HOME\bin;" + $env:Path
}
```

This is local to the script's PowerShell process. Your machine's `JAVA_HOME` is unchanged after the script exits.

### Step 2 — Redirect Gradle's user home

```powershell
$env:GRADLE_USER_HOME = Join-Path $env:LOCALAPPDATA "Gradle\TagDisplayBuild"
```

By default Gradle puts its cache under `%USERPROFILE%\.gradle`. On Windows with OneDrive synced to the user folder, that lives inside a OneDrive root. OneDrive's "cloud file" reparse points break Gradle's file locks with cryptic `IOException` messages. Moving the cache to `%LOCALAPPDATA%` (which OneDrive doesn't touch) sidesteps the problem.

### Step 3 — Build the `.modl`

```powershell
Push-Location $ModuleDir
& .\gradlew.bat build
```

This invokes Gradle on `simple-tag-display/build.gradle.kts`. The build does:

1. Compiles `common`, `gateway`, and `designer` sub-projects in dependency order (common first).
2. Each sub-project produces a JAR in its own `build/libs/`.
3. The `io.ia.sdk.modl` Gradle plugin packages them into a `.modl` file at `simple-tag-display/build/Tag-Display.unsigned.modl`.
4. Because `skipModlSigning.set(true)` in [build.gradle.kts](../simple-tag-display/build.gradle.kts), the plugin doesn't try to sign it — we do that ourselves in step 5.

The Gradle plugin pulls Ignition SDK JARs from a Maven repo:

```kotlin
// simple-tag-display/settings.gradle
maven { url = "https://nexus.inductiveautomation.com/repository/public" }
```

First build downloads ~50–100 MB of JARs into `$GRADLE_USER_HOME`. Subsequent builds are cached.

#### If you see "Failed to clean up stale outputs"

Gradle thinks the previous build left files behind. Fix:

```powershell
Push-Location simple-tag-display
.\gradlew.bat clean build
Pop-Location
```

Then re-run `.\simple-tag-display\build-and-sign.ps1`.

### Step 4 — Build `module-signer` JAR if missing

```powershell
$signerJar = Join-Path $SignerDir "build\libs\module-signer-1.0.0-jar-with-dependencies.jar"
if (-not (Test-Path $signerJar)) {
    Push-Location $SignerDir
    & (Join-Path $ModuleDir "gradlew.bat") build
}
```

The `module-signer/` project is a separate Gradle build (with its own [build.gradle](../module-signer/build.gradle)) that produces a "fat JAR" containing Apache Commons CLI and Commons IO inlined. The fat JAR is then runnable with just `java -jar`. We borrow the module's `gradlew.bat` to invoke it.

This runs **only on first build**. Once `module-signer-1.0.0-jar-with-dependencies.jar` exists, future runs skip this step.

### Step 5 — Sign the `.modl`

```powershell
& (Join-Path $ModuleDir "sign-module.ps1")
```

`sign-module.ps1` invokes:

```powershell
java -jar ..\module-signer\build\libs\module-signer-1.0.0-jar-with-dependencies.jar `
     -keystore=simpletagdisplay.jks `
     -keystore-pwd=simpletagdisplay123 `
     -alias=simpletagdisplay `
     -alias-pwd=simpletagdisplay123 `
     -chain=simpletagdisplay.p7b `
     -module-in=build\Tag-Display.unsigned.modl `
     -module-out=build\Tag-Display.modl
```

The signer reads every file in the `.modl` (which is a zip), computes a SHA-256-with-RSA signature, base64-encodes it, and writes a `signatures.properties` file back into the zip. Ignition verifies these signatures on install.

Result: `simple-tag-display/build/Tag-Display.modl` (the signed module file).

### Step 6 — Deploy (optional)

```powershell
if (Test-Path $deployScript) {
    & $pythonExe $deployScript --module-file $modlPath
}
```

If [deploy_ignition_module.py](../simple-tag-display/deploy_ignition_module.py) is present and you have Python + `requests` installed, the script uploads the `.modl` to the configured gateway and triggers a restart. See [06-deployment.md](06-deployment.md) for the details.

To skip deployment (and produce only the `.modl` file), delete or rename `deploy_ignition_module.py`. The build will still complete successfully and report the signed `.modl` path.

## What gets produced

```
simple-tag-display/
├── common/build/libs/common-1.0.0.jar        ← compiled common scope
├── gateway/build/libs/gateway-1.0.0.jar       ← compiled gateway scope
├── designer/build/libs/designer-1.0.0.jar     ← compiled designer scope
└── build/
    ├── Tag-Display.unsigned.modl              ← what Gradle produced
    └── Tag-Display.modl                       ← what to upload to a gateway
```

`Tag-Display.modl` is the file you upload to a gateway, or attach to a GitHub Release.

## Building without the wrapper script

If you don't want to use PowerShell, the underlying commands are:

```powershell
# 1. Make sure JAVA_HOME points to JDK 17
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"

# 2. Build the module (from simple-tag-display/)
cd simple-tag-display
.\gradlew.bat build

# 3. Build the signer JAR (from module-signer/)
cd ..\module-signer
..\simple-tag-display\gradlew.bat build

# 4. Sign (from simple-tag-display/)
cd ..\simple-tag-display
java -jar ..\module-signer\build\libs\module-signer-1.0.0-jar-with-dependencies.jar `
     -keystore=simpletagdisplay.jks -keystore-pwd=simpletagdisplay123 `
     -alias=simpletagdisplay -alias-pwd=simpletagdisplay123 `
     -chain=simpletagdisplay.p7b `
     -module-in=build\Tag-Display.unsigned.modl `
     -module-out=build\Tag-Display.modl
```

On macOS/Linux, use `gradlew` instead of `gradlew.bat` and the appropriate path separators.

## Building without deploying

By default, the build script tries to deploy automatically. To produce the `.modl` without deploying:

- **Quick**: rename `deploy_ignition_module.py` to `_deploy_ignition_module.py` so the script skips it.
- **Explicit**: run Gradle and the signer directly (the manual commands above).

## Build outputs that are safe to delete

If something gets weird, you can nuke any of these and they'll regenerate:

| Path | What it is | Safe to delete? |
|---|---|---|
| `simple-tag-display/build/` | Module build artifacts | Yes (will trigger a full rebuild) |
| `simple-tag-display/*/build/` | Sub-project artifacts | Yes |
| `simple-tag-display/*/bin/` | Eclipse build output (if you use Eclipse) | Yes |
| `simple-tag-display/.gradle/` | Local Gradle metadata for this project | Yes |
| `%LOCALAPPDATA%\Gradle\TagDisplayBuild\` | Gradle global cache (downloaded JARs) | Yes (next build re-downloads — slow) |
| `module-signer/build/` | module-signer build artifacts | Yes (next build re-creates fat JAR — ~30 s) |

## Common errors and what they mean

| Error / symptom | Likely cause | Fix |
|---|---|---|
| Gateway restart hangs forever after install | Module built with JDK > 17 | Verify `java -version` is 17; `build-and-sign.ps1` pins this automatically |
| `Failed to clean up stale outputs` from Gradle | OneDrive lock or a partial previous build | `gradlew.bat clean build`, then re-run script |
| `Cloud operation is invalid` from Gradle | Build cache lives in OneDrive folder | Use `build-and-sign.ps1` (it redirects `GRADLE_USER_HOME`) |
| `module-signer.jar not found` | First-time build, signer JAR not built yet | Build script handles this; if running manually, see step 4 above |
| `Module signing failed` | Keystore missing, wrong password, or cert expired | Check `simpletagdisplay.jks` exists; check `sign-module.ps1` credentials |
| Designer can't find component in palette | Module didn't install, or COMPONENT_ID mismatch | Check gateway logs; verify Java COMPONENT_ID matches JS `getComponentType()` |
| Component renders blank in browser | JS bundle didn't load, or ID mismatch on the JS side | Check browser DevTools Network tab for the JS file 200; check the JS console for errors |

---

Next: [06-deployment.md](06-deployment.md) for what happens after the build.
