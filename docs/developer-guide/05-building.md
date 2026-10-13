<!-- nav:top -->

[Docs home](../README.md) › [Developer Guide](README.md) › **Building and testing**

<!-- /nav:top -->

# 05 — Building and testing

How to turn the repository into a signed, verified `.modl`, and how to run the tests.

**On this page**

- [Prerequisites](#prerequisites)
- [One command: `build-and-sign.ps1`](#one-command-build-and-signps1)
- [What the build produces](#what-the-build-produces)
- [Versions and the cache buster](#versions-and-the-cache-buster)
- [The `.modl` verification](#the-modl-verification)
- [Building by hand](#building-by-hand)
- [Tests](#tests)
- [Iterating on the JavaScript](#iterating-on-the-javascript)
- [When the build fails](#when-the-build-fails)

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Windows PowerShell | 5.1 or newer | the build, sign and deploy scripts |
| **JDK 17** | exactly 17 (default path `C:\Program Files\Java\jdk-17`, or set `JAVA17_HOME`) | Ignition 8.3 runs on Java 17. Newer bytecode fails to load and can keep the gateway from starting, so the script refuses to build without JDK 17. |
| Python | 3.8+ (standard library only) | `deploy_ignition_module.py` |
| Node.js | 22 LTS or newer for the unit tests (developed with 24); 18+ for the migration script and the docs generator | the test command passes a quoted glob to `node --test`, which Node supports from 21; the tests also use `t.mock.timers` |
| Git | any | |

Gradle itself comes with the wrapper (`gradlew.bat`); the Ignition SDK artifacts are downloaded from Inductive
Automation's Nexus on the first build, so the first build needs internet access.

## One command: `build-and-sign.ps1`

From the repository root:

```powershell
.\simple-tag-display\build-and-sign.ps1                 # build + test + verify + sign
.\simple-tag-display\build-and-sign.ps1 -Deploy         # ... then deploy (asks first unless the gateway is localhost)
.\simple-tag-display\build-and-sign.ps1 -Deploy -Force  # ... deploy without asking
.\simple-tag-display\build-and-sign.ps1 -Deploy -DeployConfig C:\path\deploy.json
.\simple-tag-display\build-and-sign.ps1 -VerifyModl C:\path\Tag-Display.modl   # only verify a .modl
```

Steps (any failure stops the script with a non-zero exit code):

1. Pins `JAVA_HOME` to JDK 17 (hard failure when missing).
2. Points Gradle's user home to `%LOCALAPPDATA%\Gradle\TagDisplayBuild`, outside OneDrive or other synced folders
   (their placeholder files break Gradle's file locks).
3. `gradlew build`: compiles, runs the JUnit tests, assembles `build\Tag-Display.unsigned.modl`. Only the OneDrive
   "Failed to clean up stale outputs" / file-lock failure is retried, once, after deleting `build\classes`,
   `build\resources` and `build\tmp` of the three subprojects; a failing test or a compile error stops the script.
4. Verifies the unsigned `.modl` ([below](#the-modl-verification)); exit 3 on failure.
5. Builds the `module-signer` jar (incremental).
6. Runs `sign-module.ps1` → `build\Tag-Display.modl`, then verifies the **signed** file again.
7. With `-Deploy` only: runs `deploy_ignition_module.py` ([Deployment](06-deployment.md)).

Exit codes: `0` ok, `1` build/sign/precondition failure, `2` deploy configuration error (the deploy target could not be
resolved: no or invalid deploy configuration, placeholder token), `3` `.modl` verification failed, `4` deployment
cancelled, `10`–`17` deploy stage failures. During the deploy step the deploy script's own exit code is passed through,
so there `1`, `2` and `3` have the meanings of [Deployment](06-deployment.md) (general error, configuration,
`.modl` verification failed: nothing was sent). A wrong installed version after the restart is `17`.

Without `CTG_KEYSTORE_PASSWORD` the module is signed with the repository's public **development** certificate and the
script prints a warning. That is fine for test gateways; for production see [Signing](07-signing.md).

## What the build produces

| File | Content |
|---|---|
| `simple-tag-display\build\Tag-Display.unsigned.modl` | the module before signing |
| `simple-tag-display\build\Tag-Display.modl` | the signed module to install |
| inside: `common-2.0.0.jar`, `designer-2.0.0.jar`, `gateway-2.0.0.jar`, `module.xml` | one jar per scope |

The `.modl` file name is kept from 1.x (`Tag-Display`), so recovery instructions and scripts keep matching.

## Versions and the cache buster

- The **module version** is set once in `simple-tag-display/build.gradle.kts` (`version = "2.0.0"`).
- The **resource version** is computed by the `generateVersionResource` task in `common/build.gradle.kts`:
  `2.0.0-<first 8 hex of a SHA-256 over every file under gateway/src/main/resources/mounted>`. It is written into
  `module-version.properties` in the common jar together with the protocol version, and every browser resource URL
  carries it as `?v=`.
- So **any** change to a JavaScript or CSS file changes the URLs, and browsers and the Designer load the new files
  without a manual version bump. (In 1.x the version had to be bumped by hand for every frontend change.)
- The **build id** is a SHA-256 over every entry of the three jars, embedded as `mounted/build-id.txt` and logged at
  startup; the deploy script uses it to prove the gateway runs exactly the uploaded build.

Kotlin build files (`*.gradle.kts`) use `//` comments only: Kotlin block comments nest, and a path glob with `/*` inside
one silently comments out the rest of the file while the build still "succeeds".

## The `.modl` verification

Run by `build-and-sign.ps1` (twice) and again by the deploy script before anything is uploaded:

- exactly one `common-<version>.jar`, `designer-<version>.jar` and `gateway-<version>.jar`, and no other jar
  (Gradle's `assembleModlStructure` never removes old jars, so a version change used to ship both; the build now prunes
  the folder before assembly);
- every class file is Java 17 bytecode (class file major version 61);
- `module.xml` carries the expected version;
- the embedded build id equals the SHA-256 recomputed over the jar entries, so a `.modl` changed after the build is
  refused.

## Building by hand

```powershell
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
$env:GRADLE_USER_HOME = "$env:LOCALAPPDATA\Gradle\TagDisplayBuild"
cd simple-tag-display
.\gradlew.bat build          # compile + JUnit + unsigned .modl
.\gradlew.bat :gateway:test  # JUnit only
```

## Tests

| Suite | Command (repository root) | Scope |
|---|---|---|
| JUnit 5 (~400 tests) | run by `gradlew build`; reports in `simple-tag-display/gateway/build/reports/tests/test/` | path rules, write coercion, value codec, access rules, trusted props, binding lint, floor policy, read scope, trend lists, history request/plan/cache/budgets/fair executor/JSON writer, tokens, live sessions, audit, annotations, source hygiene |
| Node (~430 tests) | `node --test "simple-tag-display/tests/js/*.test.mjs"` | prop schemas and defaults, resource URLs, formatting, input parsing, time zones, delegate base, display reducer and logic, chart reducer/plan/merge/stats/axes/engine/interaction/API, tools, panels, annotations, migration script, docs coverage |
| Python | `python -m unittest discover -s simple-tag-display/tests/py -v` | deploy script checks (no gateway needed) |
| Docs | `node simple-tag-display/tools/gen-prop-docs.mjs --check` | the generated prop tables match the schemas |

Use the quoted glob for Node: on Node 24, `node --test <directory>` does not find the files. Node 18 and 20 treat the
quoted glob as a literal file name ("Could not find"): use Node 22 LTS or newer for the tests.

The Node tests load the real browser files into a minimal Perspective/React stub (`tests/js/_stubs.mjs`); new tests
extend the stub through its factory instead of editing it. `docs-coverage.test.mjs` fails when a schema prop, an event
field, a `ctg.*` setting, an error code or a protocol message is missing from the docs, when a generated table is out
of date, when a relative link in the docs points nowhere, when a docs page lacks its navigation, or when a tracked
file contains a private IP address, an API key, a local user path or a reference to internal development notes
(work-package ids, private design documents and the like; code comments should explain the code, not the history of
the project).

Browser-level acceptance tests (headless Chrome against a live gateway with test projects) were run during the
development of 2.0.0; that harness depends on a local gateway setup and is not part of this repository.

## Iterating on the JavaScript

Every JavaScript change needs a rebuild and redeploy to reach the gateway, because the files are served from the
module jar. For quick experiments in a browser you can serve your working copy instead: Chrome DevTools > Sources >
**Overrides** maps `/res/simpletagdisplay/js/*.js` to local files (the `?v=` query string is ignored by the gateway, so
the page keeps its URLs). Reload the Perspective page after each change. Rebuild and deploy before you trust a result,
and never test security behaviour that way: the gateway, not the browser, enforces it.

## When the build fails

| Symptom | Fix |
|---|---|
| `JDK 17 is required` | install JDK 17 or set `JAVA17_HOME` |
| `Failed to clean up stale outputs` / file lock errors | keep the repository and `GRADLE_USER_HOME` out of OneDrive-synced folders (the script already moves the Gradle home); then run `.\gradlew.bat build` again |
| exit 3, `.modl verification failed` | read the listed problem; a stale or foreign jar means the build folder was not pruned, so delete `simple-tag-display\build\moduleContent` and rebuild |
| JUnit failures | the report path above lists the failing test with its message |
| Node test hangs | a test left a timer running after a failed assertion; run the single file (`node --test simple-tag-display/tests/js/<file>.test.mjs`) to see it |

<!-- nav:bottom -->

---

← Previous: [Frontend JavaScript](04-frontend-javascript.md) · [Back to index](README.md) · Next: [Deployment](06-deployment.md) →

<!-- /nav:bottom -->
