# Display Template & Click To Graph Chart (Ignition 8.3 Perspective module)

Version **2.0.0**. Two Perspective components for operator screens:

- **Display Template** shows one tag: name, live value with the tag's own number format, units, quality, alarm state
  and limit markers. It can be a setpoint (popup, direct or protected entry; Boolean, option-list and string writes;
  limits, step guard and confirmation). Its right-click (or long-press) menu offers **Trend Tag**, a trend page or popup,
  tag configuration, change history and your own items.
- **Click To Graph Chart** is a trend chart in the style of the Power Chart: configured pens plus every tag the user
  trended with **Trend Tag**, multiple Y axes, stacked plots, X-Trace, pan, zoom, range brush with statistics, a pen
  table, a settings panel, a tag browser, CSV/PNG export and optional historian annotations. It refreshes
  incrementally and loads long ranges in chunks.

Both components talk to the gateway over Perspective's own component channel and run every action **as the logged-in
Perspective user**. Nothing in the browser can lower a security setting.

> **Upgrading from 1.x?** Props changed shape in 2.0.0. Read [Upgrading from 1.x](docs/user-guide/upgrading-from-v1.md)
> and run the offline migration script before you open your v1 views on a 2.0.0 gateway.

---

## Documentation

**[Documentation home](docs/README.md)**: start here. It has two parts:

| | For | Start with |
|---|---|---|
| **[User Guide](docs/user-guide/README.md)** | integrators building Perspective views, gateway administrators | [Getting started](docs/user-guide/getting-started.md) |
| **[Developer Guide](docs/developer-guide/README.md)** | contributors changing the module | [Architecture](docs/developer-guide/01-architecture.md) |

Component reference (every property, event and behaviour):

| Component | Overview | Properties | Events | Guides |
|---|---|---|---|---|
| **Display Template** | [Overview](docs/user-guide/components/display-template/README.md) | [Properties](docs/user-guide/components/display-template/properties.md) | [Events](docs/user-guide/components/display-template/events.md) | [Menu and setpoints](docs/user-guide/components/display-template/menu-and-setpoints.md), [Styling](docs/user-guide/components/display-template/styling.md), [Recipes](docs/user-guide/components/display-template/recipes.md) |
| **Click To Graph Chart** | [Overview](docs/user-guide/components/ctg-chart/README.md) | [Properties](docs/user-guide/components/ctg-chart/properties.md) | [Events](docs/user-guide/components/ctg-chart/events.md) | [Interaction](docs/user-guide/components/ctg-chart/interaction.md), [Pens, axes and plots](docs/user-guide/components/ctg-chart/pens-axes-plots.md), [Panels and tools](docs/user-guide/components/ctg-chart/panels-and-tools.md), [Recipes](docs/user-guide/components/ctg-chart/recipes.md) |

Gateway and operations: [Gateway settings](docs/user-guide/gateway-settings.md) (every `-Dctg.*` setting) ·
[Security and permissions](docs/user-guide/security-and-permissions.md) ·
[Working in the Designer](docs/user-guide/designer.md) · [Operator guide](docs/user-guide/operator-guide.md) ·
[Upgrading from 1.x](docs/user-guide/upgrading-from-v1.md) · [Troubleshooting](docs/user-guide/troubleshooting.md) ·
[Known limitations](docs/user-guide/known-limitations.md) · [FAQ](docs/user-guide/faq.md) ·
[Glossary](docs/user-guide/glossary.md)

---

## Security model in five lines

1. Every write, tag-configuration edit, trend change and history read is checked **on the gateway** with the Perspective
   user's own security context, so tag Read/Write Permissions always apply.
2. The props that decide "who may do what" (marked **[S]** in the docs) are read on the gateway. A browser that changes
   them gets the value put back, and the attempt is logged.
3. A **gateway-wide floor policy** (`-Dctg.write.*`) sets minimum requirements that no view can lower: it can require a
   login or roles for every write, limit writes to tag folders and deny providers (`[System]` by default). Like native
   Perspective, anonymous sessions may write by default when the tag's Write Permissions allow it.
4. Security props bound to anything a user can influence (view parameters, custom props, other components) **fail
   closed** unless an administrator opts out.
5. Every write and edit is recorded in the project's **audit profile** with an `auditId` that also appears in the
   component event and the gateway log.

Details, residual risks and the recommended role setup: [Security and permissions](docs/user-guide/security-and-permissions.md).

---

## Quick start

**Install.** Download the signed `.modl` from the GitHub release, then install it in the gateway web interface under **Platform > System >
Modules > Install or Upgrade Module** and restart when asked.

> The release is signed with the repository's self-signed **development** certificate. The gateway asks you to accept
> it during the install. For production, sign with your own certificate: [Signing](docs/developer-guide/07-signing.md).

**First screen** (a project with a login, users with the role `Operator`):

1. Drag **Display Template** from the *Display* palette category onto a view. Set `tagPath` to a numeric tag with
   history enabled, for example `[default]Area1/Tank1/Level`.
2. Drag a second one, use the **Display Template (Setpoint)** palette variant and point it at a writable tag. Set
   `setpoint.access.roles` to `["Operator"]`.
3. Drag **Click To Graph Chart** onto the same view. Leave its props at the defaults.
4. Launch the session and log in. Right-click the level value and choose **Trend Tag**: the pen appears in the chart.
   Click the setpoint value to write a new value.

Next steps: the step-by-step [Getting started](docs/user-guide/getting-started.md), then the
[Display Template](docs/user-guide/components/display-template/README.md) and
[Click To Graph Chart](docs/user-guide/components/ctg-chart/README.md) pages. A ready-made trend popup view is in the
[samples](docs/user-guide/samples/README.md).

**Build it yourself** (Windows, JDK 17, Node 22 LTS or newer for the tests):

```powershell
.\simple-tag-display\build-and-sign.ps1            # build (incl. the JUnit tests), verify and sign
.\simple-tag-display\build-and-sign.ps1 -Deploy    # ... and install on the gateway in your deploy config
node --test "simple-tag-display/tests/js/*.test.mjs"                  # Node tests (run separately)
python -m unittest discover -s simple-tag-display/tests/py -v        # deploy script tests (run separately)
```

See [Building and testing](docs/developer-guide/05-building.md) and [Deployment](docs/developer-guide/06-deployment.md).

---

## Repository layout

```
├── README.md                     this file
├── docs/                         all documentation: README.md (home), user-guide/, developer-guide/
├── simple-tag-display/           the module
│   ├── common/                   component descriptors, prop and event schemas, protocol constants
│   ├── designer/                 Designer hook (palette entries and icons)
│   ├── gateway/                  gateway hook, delegates, history route, services, frontend files
│   │   └── src/main/resources/mounted/js/   ctg-common.js, display-template.js, ctg-chart*.js, uplot.min.js
│   ├── tests/js/                 Node unit tests (node --test)
│   ├── tools/                    migrate-v1-views.mjs, gen-prop-docs.mjs, gen-docs-nav.mjs
│   ├── build-and-sign.ps1        build + verify + sign (+ deploy with -Deploy)
│   ├── sign-module.ps1           signing step
│   └── deploy_ignition_module.py deploy through the gateway REST API
└── module-signer/                builds the signing tool used by sign-module.ps1
```

---

## Requirements

| Item | Version |
|---|---|
| Ignition gateway | 8.3.x with Perspective (developed and tested on 8.3.10) |
| Historian | any 8.3 historian provider; tested with the built-in **Core Historian** (annotations included). SQL Historian is untested. |
| Browsers | tested on current Chrome (automated, headless). Edge, Firefox and Safari are expected to work (standard DOM and Canvas APIs only) but are untested. Perspective Workstation and the mobile app: expected to work with the limits listed in the component docs, not yet checked by hand |
| Build | Windows PowerShell 5.1+, JDK 17 (exactly 17), Python 3.8+ for deploys, Node 22+ for the tests (the quoted test glob needs Node 21+), Node 18+ for the migration script |

The module ID (`com.example.simpletagdisplay.SimpleTagDisplay`) and the component IDs are unchanged since 1.x, so an
upgrade keeps every view's components in place.

What is not supported or not yet tested, with workarounds: [Known limitations](docs/user-guide/known-limitations.md).

## Feedback and contributing

Report bugs and request features through the repository's GitHub issues. To change the module, start with the
[Developer Guide](docs/developer-guide/README.md) and its [Extending and contributing](docs/developer-guide/08-extending-and-contributing.md)
page.

## Third-party code

| Code | Where | Licence |
|---|---|---|
| [uPlot](https://github.com/leeoniya/uPlot) 1.6 | `mounted/js/uplot.min.js`, `mounted/css/uplot.min.css` (bundled, served by the gateway) | MIT |
| [d3-shape](https://github.com/d3/d3-shape) v3 curve functions (ported) | `ctg-chart.js`, SECTION 14a (the Power Chart curve types) | ISC (notice kept in the source) |
