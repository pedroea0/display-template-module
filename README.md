# Display Template & Click To Graph Chart — an Ignition Perspective module

A two-component Ignition 8.3 Perspective module written in-house for click-to-graph (CTG) trending:

- **Display Template** — a single-tag value label. Right-click a value → **Trend Tag** to send it to the chart. Optional setpoint write modal. Optional bounds highlighting driven by the tag's own Engineering Low/High limits.
- **Click To Graph Chart** — a session-scoped trend chart (uPlot-based) that picks up whatever tags the user has trended. Includes a date-range modal, three interaction modes (X-Trace / Pan / Zoom), and a stats-table legend.

> These are the palette display names. The underlying component IDs are unchanged — `com.example.simpletagdisplay.SimpleTagDisplay` and `com.example.simpletagdisplay.CtgChart` — so existing views keep working after an upgrade.

The two components live in the same `.modl` and talk to each other via a small set of HTTP routes on the gateway plus a window-level browser event.

---

## Download / install

The signed `.modl` is published as a GitHub Release. Grab it from the **Releases** tab and install it via **Gateway → Config → Modules → Install or Upgrade a Module**.

After install, drop **Display Template** and **Click To Graph Chart** onto any Perspective view from the **Display** palette category.

> **Heads up:** the signed `.modl` in releases is signed with a self-signed dev certificate. On a gateway that has *Allow Unsigned Modules* disabled, the upload will fail. Either enable that setting in the gateway config or re-sign the module with your own keystore (see [docs/07-signing.md](docs/07-signing.md)).

---

## Repository layout

```
Display Template Module/
├── README.md                       ← this file
├── CLAUDE.md                       ← context file used by AI coding assistants
├── docs/                           ← all documentation lives here
│   ├── 01-architecture.md            How the module is structured (scopes, data flow)
│   ├── 02-javascript-primer.md       JS concepts you'll need to read the frontend
│   ├── 03-backend-java.md            Every Java class and method
│   ├── 04-frontend-javascript.md     SimpleTagDisplay + CtgChart deep dive
│   ├── 05-building.md                Prerequisites + build instructions
│   ├── 06-deployment.md              The Ignition 8.3 deploy API
│   ├── 07-signing.md                 Keystores and module-signer
│   └── 08-extending-and-contributing.md  How to add features / cut a release
│
├── simple-tag-display/             ← THE module source
│   ├── common/                       (shared code: descriptors + prop schemas)
│   ├── gateway/                      (gateway hook + REST routes + frontend assets)
│   ├── designer/                     (designer hook)
│   ├── build.gradle.kts              (root Gradle build, uses the IA SDK plugin)
│   ├── build-and-sign.ps1            (one-shot build + sign + deploy)
│   ├── sign-module.ps1               (sign-only, called by the above)
│   ├── deploy_ignition_module.py     (uploads .modl + restarts gateway via HTTP API)
│   ├── simpletagdisplay.jks          (DEV-ONLY signing keystore)
│   └── simpletagdisplay.p7b          (DEV-ONLY cert chain)
│
├── module-signer/                  ← Gradle project that builds the signing JAR
└── archive/                        ← parked content (older modules, old docs, etc.)
```

---

## I want to…

| If you want to… | Read |
|---|---|
| Understand how the whole thing fits together | [docs/01-architecture.md](docs/01-architecture.md) |
| Read the JavaScript without knowing JavaScript | [docs/02-javascript-primer.md](docs/02-javascript-primer.md) |
| Understand the Java (gateway hook, routes, historian wrapper) | [docs/03-backend-java.md](docs/03-backend-java.md) |
| Understand the frontend components in detail | [docs/04-frontend-javascript.md](docs/04-frontend-javascript.md) |
| Build the `.modl` yourself | [docs/05-building.md](docs/05-building.md) |
| Push a new build to a gateway automatically | [docs/06-deployment.md](docs/06-deployment.md) |
| Replace the dev keystore with your own | [docs/07-signing.md](docs/07-signing.md) |
| Add a new prop / component / route | [docs/08-extending-and-contributing.md](docs/08-extending-and-contributing.md) |

---

## Quickstart for the impatient

```powershell
# Prerequisites: JDK 17, Python 3.8+ with `pip install requests`, an Ignition 8.3 gateway

# 1. Clone
git clone <repo-url>
cd "Display Template Module"

# 2. Configure deployment: copy the example to a local (git-ignored) config
#    and fill in your own gateway URL + API token.
#    (API token: Gateway → Config → Security → API Keys. In Ignition 8.3, create the
#     key with "Require secure connections for API Keys" UNCHECKED if you deploy over
#     plain HTTP — otherwise the gateway rejects it with an empty 401. See docs/06-deployment.md.)
copy simple-tag-display\deploy_config.example.json simple-tag-display\deploy_config.local.json
# ...then edit deploy_config.local.json with your values

# 3. Build, sign, and deploy in one shot
.\simple-tag-display\build-and-sign.ps1
```

The script does five things in order: pins JAVA_HOME to JDK 17, builds the `.modl`, builds the `module-signer` JAR if missing, signs the `.modl` with the dev keystore, and uploads + installs it on the gateway, then triggers a gateway restart.

Full step-by-step including "what to do when Gradle complains" is in [docs/05-building.md](docs/05-building.md).

---

## Audience and conventions

This documentation assumes you know Ignition, Perspective, Designer, gateways, tags, and the historian. It does **not** assume JavaScript expertise — the frontend doc starts with a primer on the JS concepts you'll see in `simpletagdisplay.js`.

When code is referenced, file paths are clickable and lines are linked when relevant — for example [simpletagdisplay.js:137](simple-tag-display/gateway/src/main/resources/mounted/js/simpletagdisplay.js#L137).
