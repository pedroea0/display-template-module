<!-- nav:top -->

[Docs home](../README.md) › [Developer Guide](README.md) › **Deployment**

<!-- /nav:top -->

# 06 — Deployment

How to install the signed `.modl` on a gateway, by hand or with the deploy script, and how to recover a gateway that
does not come back.

**On this page**

- [Install by hand](#install-by-hand)
- [Deploy with the script](#deploy-with-the-script)
- [Configuration lookup](#configuration-lookup)
- [What the script does](#what-the-script-does)
- [Exit codes](#exit-codes)
- [Checking what a gateway runs](#checking-what-a-gateway-runs)
- [After an upgrade](#after-an-upgrade)
- [Recovering a gateway that does not start](#recovering-a-gateway-that-does-not-start)
- [Rolling back to 1.x](#rolling-back-to-1x)

---

## Install by hand

1. Sign in to the gateway web interface as an administrator.
2. Open **Platform > System > Modules** and choose **Install or Upgrade Module**.
3. Select `Tag-Display.modl`. Accept the certificate (the development certificate is self-signed) and the license.
4. Restart the gateway when asked. The module is listed as **Display Template & Click-to-Graph** (vendor *Simple Tag
   Display*), version 2.0.0.

Upgrading from 1.x or from an older 2.0.0 build is the same procedure: the module ID is unchanged, so Ignition replaces
the installed module. Read [Upgrading from 1.x](../user-guide/upgrading-from-v1.md) before upgrading from 1.x.

## Deploy with the script

`simple-tag-display/deploy_ignition_module.py` deploys through the gateway's REST API (standard library only):

```powershell
python simple-tag-display\deploy_ignition_module.py                       # build\Tag-Display.modl, config lookup below
python simple-tag-display\deploy_ignition_module.py --print-target        # show which gateway it would use, then exit
python simple-tag-display\deploy_ignition_module.py --verify-running      # is the gateway running exactly this .modl?
python simple-tag-display\deploy_ignition_module.py --module-file C:\path\Tag-Display.modl --config C:\path\deploy.json
```

`build-and-sign.ps1 -Deploy` runs it after a successful build. A gateway that is not `localhost`/`127.0.0.1` needs a
typed confirmation unless you pass `-Force`.

| Option | Default | Meaning |
|---|---|---|
| `--module-file` | `simple-tag-display/build/Tag-Display.modl` | the signed module |
| `--gateway-url`, `--api-token`, `--module-id` | from the configuration | override one value (`--api-token` ends up in your shell history; prefer a config file or `IGNITION_API_TOKEN`) |
| `--config FILE` | – | JSON file with `gateway_url`, `api_token`, `module_id` |
| `--expect-version` | from `module.xml` | version to verify after the restart |
| `--no-restart` | off | upload and install only |
| `--timeout` | 240 | seconds to wait for the restart |
| `--print-target` | – | print the resolved gateway URL and exit |
| `--verify-running` | – | only the content proof (steps 3, 10, 17); exit 0 = running this build, 17 = not |

**API key.** Create one in the gateway web interface (**Platform > Security > API Keys**) with permission to manage
modules and restart the gateway. The gateway shows the key only once. Over plain HTTP, create the key with **Require
secure connections** unchecked, or the gateway answers every call with an empty 401; better, deploy over HTTPS
(`https://host:8043`).

## Configuration lookup

Per value, the first match wins:

1. command line (`--gateway-url`, `--api-token`, `--module-id`)
2. environment variables `IGNITION_GATEWAY_URL`, `IGNITION_API_TOKEN`
3. `--config FILE`
4. `%APPDATA%\ctg-module\deploy.json`
5. `simple-tag-display\deploy_config.local.json` (git-ignored; copy `deploy_config.example.json`)

```json
{
  "gateway_url": "http://your-gateway-host:8088",
  "api_token": "your-key-name:your-secret",
  "module_id": "com.example.simpletagdisplay.SimpleTagDisplay"
}
```

A configuration file that exists but is not valid JSON stops the script (exit 2); there is no silent fallback. The
token is never printed. Never commit a file with a real token.

## What the script does

| Step | Call | Fails with |
|---|---|---|
| 3 | verifies the `.modl` before anything is sent (jars, Java 17, `module.xml` version, build id) | 3 |
| 10 | `GET /data/api/v1/gateway-info`: reachable, token accepted | 10 |
| 11 | `POST /data/api/v1/modules/upload?fileName=Tag-Display-<version>.modl` | 11 |
| 12 | `POST /data/api/v1/modules/certificate` and `/eula` when the upload asks for them | 12 |
| 14 | looks up the installed module (must succeed), then `POST /data/api/v1/modules/install?moduleId=…` (first install **and** upgrade) | 14 |
| 15 | `POST /data/api/v1/restart-tasks/restart?confirm=true` (unless `--no-restart`) | 15 |
| 16 | `GET /StatusPing` until `RUNNING` | 16 |
| 17 | health: the module is ACTIVE at the expected version, its start time is later than before the restart, every file under `mounted/` in the uploaded jar (including `build-id.txt`, which hashes every jar entry) is served byte for byte by the gateway, and the module's startup completed (its history route no longer answers `MODULE_STOPPING`; a failed startup is also rethrown, so the gateway marks the module Faulted) | 17 |

There is **no uninstall step**: on 8.3 an upload + install of the same module ID registers an upgrade and the restart
swaps the file. (Uninstalling between upload and install made the restart bring the **old** version back.) The last
line on success is `com.example.simpletagdisplay.SimpleTagDisplay 2.0.0 RUNNING`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | general error (file not found, unreadable `module.xml`) |
| 2 | configuration error |
| 3 | `.modl` verification failed (nothing was sent) |
| 10 | gateway not reachable or token refused |
| 11 | upload failed |
| 12 | certificate / EULA acceptance failed |
| 13 | reserved (no uninstall step) |
| 14 | install failed, or the installed module could not be looked up |
| 15 | restart request failed |
| 16 | gateway not `RUNNING` within `--timeout` |
| 17 | the running module is not provably this build |

## Checking what a gateway runs

- `--verify-running` (above) compares the gateway's served files with a `.modl` on disk.
- The gateway log shows `Display Template / CTG 2.0.0-<hash> started (protocol 2)` and
  `Display Template / CTG build id <id>` after every start.
- In a Perspective session, the browser console command `window.__CTG.loaded` lists the build of each loaded part.

## After an upgrade

- Open sessions get a notice that the module was updated; Perspective reloads clients after the gateway restart.
- The Designer picks up the new JavaScript automatically (the resource URLs change with every build); reopen open views
  if one still shows old behaviour.
- After a 1.x → 2.0.0 upgrade, migrate the views ([Upgrading from 1.x](../user-guide/upgrading-from-v1.md)). A view with v1 props shows
  v2 defaults and a console warning (both components; a badge in the Designer) until it is migrated.

## Recovering a gateway that does not start

If the gateway hangs while starting after an install, the usual cause is a module built with a JDK newer than 17 (the
build scripts refuse that, but a hand-made build might not):

1. Stop the gateway service (Windows: `net stop Ignition` from an administrator prompt, or Services; Linux:
   `sudo systemctl stop ignition`).
2. Delete the module file(s) `Tag-Display*.modl` from `<Ignition install>/user-lib/modules/`.
3. Start the gateway; it comes up without the module.
4. Rebuild with JDK 17 (`build-and-sign.ps1` enforces it) and install again.

The gateway log (`<Ignition install>/logs/wrapper.log`) shows the reason; module problems also appear on the Modules
page as *Faulted* or *Quarantined*.

## Rolling back to 1.x

The last 1.x release is tagged `v1.1.5` and its `.modl` is attached to that GitHub release. Install it like an upgrade.
Migrated views need the `view.json.v1.bak` copies the migration script kept (1.x does not read v2 props), see
[Upgrading from 1.x](../user-guide/upgrading-from-v1.md#rolling-back).

<!-- nav:bottom -->

---

← Previous: [Building and testing](05-building.md) · [Back to index](README.md) · Next: [Signing](07-signing.md) →

<!-- /nav:bottom -->
