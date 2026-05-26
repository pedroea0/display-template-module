# 06 — Deployment

Once you have a signed `Tag-Display.modl`, you can install it on a gateway in three ways:

1. **Manually** via the gateway web UI — fine for first-time installs and trying a release on a new machine.
2. **Automatically** via [deploy_ignition_module.py](../simple-tag-display/deploy_ignition_module.py) — what `build-and-sign.ps1` calls. Uses the Ignition 8.3 HTTP API.
3. **From a GitHub Release** — pull the asset and use either of the above.

This doc covers all three.

## Manual install (browser)

For first install or trying a release on a new gateway:

1. Open `http://<gateway>:8088` and sign in as an administrator.
2. Go to **Config → Modules**.
3. Scroll to the bottom of the modules table and click **Install or Upgrade a Module…**.
4. Click **Choose File**, select `Tag-Display.modl`, click **Install**.
5. On the confirmation screen, click **Install**.
6. If prompted about the module being self-signed and your gateway has **Allow Unsigned Modules** disabled, you'll get an error. Enable that setting under **Config → Gateway Settings → Module Settings → Allow Unsigned Modules** and retry. (Or sign with your own trusted keystore — see [07-signing.md](07-signing.md).)
7. The module appears as **Tag Display** in the modules list.

To upgrade an installed module, repeat the same steps — Ignition recognizes the existing module ID and replaces it.

To uninstall, click **Uninstall** in the module's row, confirm, and restart the gateway when prompted.

## Automatic install via `deploy_ignition_module.py`

The Python script uses Ignition 8.3's HTTP API to do uninstall → upload → install → restart with no manual clicks. It runs automatically as the last step of `build-and-sign.ps1`, but you can also call it manually.

### What it needs

- Python 3.8+ on your PATH.
- `pip install requests`.
- An **API token** from the gateway (see "Creating an API token" below).
- The gateway URL.

### Configuration

The Python script reads its gateway URL + API token from a **git-ignored local config file**: [deploy_config.local.json](../simple-tag-display/deploy_config.local.json) next to the script. The committed source file ships with placeholders only — no real credentials.

To configure for your gateway, copy the example file and fill in your own values:

```powershell
copy simple-tag-display\deploy_config.example.json simple-tag-display\deploy_config.local.json
# then edit deploy_config.local.json:
```

```json
{
  "gateway_url": "http://your-gateway:8088",
  "api_token": "PE:your-token-here",
  "module_id": "com.example.simpletagdisplay.SimpleTagDisplay"
}
```

The `.local.json` suffix is matched by [.gitignore](../.gitignore) — your API token will never be committed. Each developer (or each environment) keeps their own copy.

You can also override at the command line — CLI flags win over the local config:

```powershell
python deploy_ignition_module.py `
    --gateway-url http://my-gateway:8088 `
    --api-token PE:my-token-here `
    --module-file simple-tag-display\build\Tag-Display.modl
```

Flags:

| Flag | Default | Purpose |
|---|---|---|
| `--gateway-url URL` | hard-coded above | Gateway base URL |
| `--api-token TOK` | hard-coded above | API token (X-Ignition-API-Token header) |
| `--module-file PATH` | `simple-tag-display/build/Tag-Display.modl` | Path to the signed `.modl` |
| `--module-id ID` | `com.example.simpletagdisplay.SimpleTagDisplay` | Module ID to uninstall before reinstall |
| `--skip-uninstall` | (off) | Skip the uninstall step (use for the *very first* install on a clean gateway) |
| `--no-restart` | (off) | Skip the gateway restart at the end |

### Creating an API token

In the gateway:

1. **Config → Security → API Keys**.
2. Click **Create New API Key**.
3. Set a name (e.g. `module-deploy`) and a scope. For the deploy script to work, the key needs permission to read/write modules and restart the gateway. The simplest scope is the built-in **Administrator** role.
4. Click **Save**, then **copy the generated token immediately** — Ignition only shows it once.

The token format is `<prefix>:<secret>`, e.g. `PE:abcdef...`. Drop it into your `deploy_config.local.json` (or pass `--api-token`).

> **Tokens never go into committed code.** `deploy_config.local.json` is `.gitignore`d on purpose. For CI / production gateways, pass `--api-token` from an environment variable or a CI secret rather than checking in a local config file.

### What the script does

Four HTTP calls in sequence:

```python
MODULE_UNINSTALL_PATH = "/data/api/v1/modules/uninstall"   # DELETE
MODULE_UPLOAD_PATH    = "/data/api/v1/modules/upload"     # POST
MODULE_INSTALL_PATH   = "/data/api/v1/modules/install"    # POST
GATEWAY_RESTART_PATH  = "/data/api/v1/restart-tasks/restart"  # POST
```

Each call carries an `X-Ignition-API-Token` header for auth.

#### 1. Uninstall

```
DELETE /data/api/v1/modules/uninstall
Headers: X-Ignition-API-Token: <token>
Body:    { "uninstall": ["com.example.simpletagdisplay.SimpleTagDisplay"] }
```

**Schedules** the current version for removal on the next gateway restart. It doesn't immediately tear down the module — that happens when the gateway restarts. Skipped on first-ever install (use `--skip-uninstall`).

#### 2. Upload

```
POST /data/api/v1/modules/upload?fileName=Tag-Display.modl
Headers: X-Ignition-API-Token: <token>
         Content-Type: application/octet-stream
Body:    <binary .modl bytes>
```

Sends the binary content of the `.modl` file. The `fileName` query parameter is just metadata; the bytes go in the request body.

#### 3. Install

```
POST /data/api/v1/modules/install?moduleId=com.example.simpletagdisplay.SimpleTagDisplay
Headers: X-Ignition-API-Token: <token>
```

Finalizes the install — Ignition validates the signature and stages the new module to load on next restart.

#### 4. Restart

```
POST /data/api/v1/restart-tasks/restart?confirm=true
Headers: X-Ignition-API-Token: <token>
```

Triggers the gateway restart that applies both the uninstall and install. Gateway takes 30–90 seconds to come back up depending on size.

#### Sleep between uninstall and upload

```python
if module_id and not args.skip_uninstall:
    uninstall_module(base_url, api_token, module_id)
    time.sleep(2.0)
```

The 2-second sleep gives Ignition a moment to record the scheduled uninstall before we upload the replacement. Without it, on a fast machine the upload sometimes lands before the uninstall is registered and Ignition refuses the install ("module already exists").

### Exit codes

- `0` on success.
- `1` on any error (missing file, HTTP failure, etc.). Error message printed to stderr.

`build-and-sign.ps1` checks `$LASTEXITCODE` and prints a yellow warning if deployment fails but does not abort — the signed `.modl` is still produced, you can deploy manually.

## Installing from a GitHub Release

1. Go to the repo's **Releases** page on GitHub.
2. Find the latest release.
3. Under **Assets**, download `Tag-Display.modl`.
4. Either upload it manually via the gateway UI (see above), or use the deploy script:

   ```powershell
   python deploy_ignition_module.py --module-file Tag-Display.modl
   ```

## Multiple gateways

For deploying to several gateways, easiest pattern is a small wrapper script:

```powershell
$modl = "simple-tag-display\build\Tag-Display.modl"
$gateways = @(
    @{ url = "http://gw1.example:8088"; token = $env:GW1_TOKEN },
    @{ url = "http://gw2.example:8088"; token = $env:GW2_TOKEN }
)
foreach ($gw in $gateways) {
    python simple-tag-display\deploy_ignition_module.py `
        --gateway-url $gw.url --api-token $gw.token --module-file $modl
}
```

Each gateway has its own API token; store them in environment variables, not in the script.

## Recovering a stuck gateway

If a gateway restart hangs forever after installing this module, the cause is almost always **bytecode mismatch** — the module was built with a JDK newer than 17. To recover:

1. Stop the Ignition gateway service:
   - **Windows**: `net stop "Ignition Gateway"` (or via Services.msc)
   - **Linux**: `sudo systemctl stop ignition`
2. Remove the module file:
   - `<IgnitionInstallDir>/user-lib/modules/Tag-Display.modl`
3. Start the gateway. It will come up clean without the module.
4. Confirm your build environment uses JDK 17 (`build-and-sign.ps1` pins this) and rebuild.
5. Reinstall.

## CI / CD integration

The build is fully scriptable. A minimal GitHub Actions workflow that builds the `.modl` on every push:

```yaml
name: build
on: [push, pull_request]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '17', distribution: 'temurin' }
      - name: Build module
        run: |
          cd simple-tag-display
          .\gradlew.bat build
      - name: Build signer JAR
        run: |
          cd module-signer
          ..\simple-tag-display\gradlew.bat build
      - name: Sign module
        run: |
          cd simple-tag-display
          .\sign-module.ps1
      - uses: actions/upload-artifact@v4
        with:
          name: Tag-Display.modl
          path: simple-tag-display/build/Tag-Display.modl
```

For releases, add a job that runs on tag pushes and attaches the `.modl` to a GitHub Release. See [08-extending-and-contributing.md](08-extending-and-contributing.md) for the recommended release workflow.

---

Next: [07-signing.md](07-signing.md) for how to replace the dev keystore.
