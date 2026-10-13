<!-- nav:top -->

[Docs home](../README.md) › **Developer Guide**

<!-- /nav:top -->

# Developer Guide

For contributors who change the module itself: the Java gateway code, the browser-side JavaScript, the build, tests,
signing and deployment. If you only **use** the module in Perspective views, the [User Guide](../user-guide/README.md)
is the place to go.

## Recommended reading path

Read the pages in order the first time; each builds on the previous one.

| # | Page | What is in it |
|---|---|---|
| 1 | [Architecture](01-architecture.md) | scopes and files, the component channel (delegates), the message catalogue, the history route, security layers, versions and caching |
| 2 | [JavaScript primer](02-javascript-primer.md) | the JavaScript patterns used in the frontend, explained for Java and Python developers |
| 3 | [Backend (Java)](03-backend-java.md) | packages, lifecycle, `GatewayServices`, delegates, threads, tags, history, security classes, audit, logging |
| 4 | [Frontend JavaScript](04-frontend-javascript.md) | `ctg-common.js`, the two components, the `ChartApi` facade, panels, styles, tests |
| 5 | [Building and testing](05-building.md) | prerequisites, `build-and-sign.ps1`, the `.modl` verification, the test suites, iterating on JavaScript |
| 6 | [Deployment](06-deployment.md) | installing by hand and with the deploy script, exit codes, recovering a gateway that does not start, rolling back |
| 7 | [Signing](07-signing.md) | the development certificate, signing with your own keystore or a purchased certificate |
| 8 | [Extending and contributing](08-extending-and-contributing.md) | adding a prop, a security prop, a message, a panel, a gateway setting or an error code; releasing |

## Keeping the docs in step

The User Guide is checked by `simple-tag-display/tests/js/docs-coverage.test.mjs` (run with the other Node tests):

- the property and event tables in `docs/user-guide/components/*/properties.md` and `events.md` are generated from the
  schemas by `node simple-tag-display/tools/gen-prop-docs.mjs` (and `--check` fails when they are stale);
- every schema path, event and payload field, every `ctg.*` setting the gateway reads, every error code and every
  delegate message must appear on its page;
- every relative link and anchor must resolve, and every page must carry the breadcrumb and the navigation footer that
  `node simple-tag-display/tools/gen-docs-nav.mjs` writes (`--check` fails when one is missing or stale).

When you add a page, add it to the page list in `gen-docs-nav.mjs` and run the tool.

<!-- nav:bottom -->

---

[Back to index](../README.md) · Next: [Architecture](01-architecture.md) →

<!-- /nav:bottom -->
