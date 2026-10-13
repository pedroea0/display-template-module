<!-- nav:top -->

**Docs home**

<!-- /nav:top -->

# Documentation

**Display Template & Click To Graph Chart** is an Ignition 8.3 Perspective module with two components for operator
screens. The **Display Template** shows one tag (value, units, quality, alarm and limit markers) and can be a setpoint;
its right-click **Trend Tag** sends the tag to the **Click To Graph Chart**, a Power Chart-style trend chart with
multiple axes, stacked plots, X-Trace, zoom, statistics, a tag browser and export. Every action runs on the gateway as
the logged-in Perspective user.

These pages describe version **2.0.0**.

## Start here

| | |
|---|---|
| **[User Guide](user-guide/README.md)** | For integrators who build Perspective views with the module, and for gateway administrators. Installation, every component, property, event and gateway setting, security, troubleshooting. |
| **[Developer Guide](developer-guide/README.md)** | For contributors who change the module itself. Architecture, the Java and JavaScript code, building, testing, signing, deployment. |

## Find it fast

| I want to... | Go to |
|---|---|
| Install the module and build a first screen | [Getting started](user-guide/getting-started.md) |
| Look up what a Display Template property does | [Display Template properties](user-guide/components/display-template/properties.md) |
| Look up what a chart property does | [Click To Graph Chart properties](user-guide/components/ctg-chart/properties.md) |
| Let operators write setpoints, and decide who may | [Menu and setpoints](user-guide/components/display-template/menu-and-setpoints.md) |
| Configure the right-click menu (Trend Tag, trend popup, change history) | [The right-click menu](user-guide/components/display-template/menu-and-setpoints.md#the-right-click-menu) |
| Change a colour or font for every display in a project (e.g. the setpoint colour) | [Project stylesheet and theme](user-guide/components/display-template/styling.md#every-display-project-stylesheet-and-theme) |
| See every colour token and CSS class I can override | [Theme tokens](user-guide/components/display-template/styling.md#theme-tokens), [Class names](user-guide/components/display-template/styling.md#class-names) |
| Style one display (colours, fonts, padding) | [One display: style props](user-guide/components/display-template/styling.md#one-display-style-props) |
| Know which style wins (component vs project stylesheet vs state colours) | [The cascade](user-guide/components/display-template/styling.md#the-cascade-what-wins) |
| Style the chart (colours, axes, grid, panels) | [Chart styling](user-guide/components/ctg-chart/panels-and-tools.md#styling) |
| Configure pens, axes, plots and history queries | [Pens, axes and plots](user-guide/components/ctg-chart/pens-axes-plots.md) |
| Configure the tag browser, export or annotations | [Panels and tools](user-guide/components/ctg-chart/panels-and-tools.md) |
| React to a write or a chart change in a script | [Display Template events](user-guide/components/display-template/events.md), [chart events](user-guide/components/ctg-chart/events.md) |
| Copy a ready-made setup | [Display Template recipes](user-guide/components/display-template/recipes.md), [chart recipes](user-guide/components/ctg-chart/recipes.md), [Samples](user-guide/samples/README.md) |
| Change a gateway setting (`-Dctg.*`) | [Gateway settings](user-guide/gateway-settings.md) |
| Understand the security model and the defaults | [Security and permissions](user-guide/security-and-permissions.md) |
| Know what the Designer shows | [Working in the Designer](user-guide/designer.md) |
| Explain the colours and markers to operators | [Operator guide](user-guide/operator-guide.md) |
| Upgrade views from 1.x | [Upgrading from 1.x](user-guide/upgrading-from-v1.md) |
| Fix a problem | [Troubleshooting](user-guide/troubleshooting.md) |
| Know what is not supported or not yet tested before going to production | [Known limitations](user-guide/known-limitations.md) |
| Look up an error code (`WRITE_DENIED`, `OUT_OF_SCOPE`, ...) | [Error codes](user-guide/troubleshooting.md#error-codes) |
| Look up a term | [Glossary](user-guide/glossary.md) |
| Build the module from source | [Building and testing](developer-guide/05-building.md) |
| Add a prop, a message or a gateway setting | [Extending and contributing](developer-guide/08-extending-and-contributing.md) |

## Version

| | |
|---|---|
| Module version | 2.0.0 |
| Ignition | 8.3.x with Perspective (from 8.3.1; developed and tested on 8.3.10) |
| Module ID | `com.example.simpletagdisplay.SimpleTagDisplay` (unchanged since 1.x) |

The property and event tables are generated from the module's own schemas, and an automated test checks that every
property, event, gateway setting and error code is documented and that every link in these pages works.

<!-- nav:bottom -->

---

Next: [User Guide](user-guide/README.md) → · [Developer Guide](developer-guide/README.md) →

<!-- /nav:bottom -->
