# Archive

Soft-deleted content from the project root. Nothing here is required to build,
sign, or run the `simple-tag-display` module — but it's preserved in case any
of it becomes useful later (or is needed for forensic / historical reference).

If you can confirm a folder is truly no longer needed, you can hard-delete it.

## Layout

| Folder | What's in it | Why it was archived |
|---|---|---|
| `abandoned-modules/ignition-apexcharts-module/` | A separate Ignition Perspective module (TypeScript + React + ApexCharts + Webpack + Lerna). Different architecture entirely. | The active module (`simple-tag-display/`) was originally going to use ApexCharts, then migrated to **uPlot**. This module was a parallel spike never finished. |
| `reference-repos/ignition-module-tools/` | Inductive Automation's tooling for module development (gradle plugin, archetypes). | Used as a reference during initial module bootstrapping. The active module already has its own `gradle-wrapper` + `build.gradle.kts`, so this repo isn't pulled in by the build. |
| `reference-repos/ignition-sdk-examples/` | Inductive Automation's SDK example modules. | Reference only — none of it is compiled or linked into the active build. |
| `old-perspective-exports/` | Saved Perspective view JSON exports (`DisplayTemplateView.json`, `SimpleTagDisplayView.json`) and one stale unsigned modl (`Simple-Tag-Display.unsigned.modl`). | These are gateway-side runtime artifacts. The current build produces fresh `.modl` files into `simple-tag-display/build/`. |
| `old-docs/` | Earlier per-step docs: `COMPLETE_GUIDE.md`, `DEVELOPMENT_WORKFLOW.md`, `GATEWAY_RECOVERY.md`, the old per-module `README.md`, `SIGNING_GUIDE.md`. | All current developer / AI context lives in `CLAUDE.md` at the repo root. The most useful bits (build steps, signing, gateway recovery) were folded into `CLAUDE.md`. |
| `old-test-scripts/` | Standalone Jython/Python tag-read test scripts (`TEST_TAG_READING.py`, `TEST_TAG_READING_SIMPLE.py`) and an empty placeholder (`ReadAndWirteTagsDocumentation`). | Used during initial development for testing tag access from the Ignition Script Console. Not part of the build. |
| `old-frontend/apexcharts.min.js` | Bundled ApexCharts JS library. | Replaced by **uPlot** (`gateway/src/main/resources/mounted/js/uplot.min.js`). |
| `auxiliary-signing/` | `simpletagdisplay-chain.jks`, `simpletagdisplay.cer`, `sign-module.bat`. | Auxiliary files from generating the keystore. The active sign pipeline (`sign-module.ps1`) only uses `simpletagdisplay.jks` + `simpletagdisplay.p7b`. The `.bat` is a stale alternate to `.ps1`. |

## What stayed in the project root

| Path | Why kept |
|---|---|
| `simple-tag-display/` | The active Ignition Perspective module — main subject of this repo. |
| `module-signer/` | Required by `simple-tag-display/build-and-sign.ps1` to sign the `.modl`. |
| `CLAUDE.md` | Project context / architecture / pending work for AI assistants. |
| `.git/`, `.claude/`, `.vscode/` | Git history, Claude harness config, IDE settings. |
