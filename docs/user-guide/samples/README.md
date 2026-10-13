<!-- nav:top -->

[Docs home](../../README.md) › [User Guide](../README.md) › **Samples**

<!-- /nav:top -->

# Samples

| File | What |
|---|---|
| [TrendPopup.view.json](TrendPopup.view.json) | a popup view for the Display Template's **Open Trend Popup** menu item, for both popup modes |
| [AuditLogView.md](AuditLogView.md) | a Table that lists setpoint writes and tag edits from the audit profile |
| [setpoint-log-script.md](setpoint-log-script.md) | `onSetpointWrite` scripts (gateway log, database table) and `auditId` reconciliation |

## Trend popup

The view takes the parameters the menu item passes (`tagPath`, `tagName`, `trendGroup`, `mode`) and holds one Click To
Graph Chart:

- `mode: "trendList"` (default): the chart's `trendGroup` is bound to the parameter, so it shows the session trend
  list, which the menu item has just added the tag to (`menu.trendPopup.addTag`).
- `mode: "singleTag"`: `trendGroup` becomes empty (the trend list is ignored) and `pens` is bound to the one tag.

**Install it** in a project folder on the gateway (needs file access to `data/projects`):

1. Create the folder `<Ignition install>/data/projects/<Project>/com.inductiveautomation.perspective/views/Popups/TrendPopup/`.
2. Copy `TrendPopup.view.json` into it as `view.json`, and add a `resource.json` next to it:

   ```json
   { "scope": "G", "version": 1, "restricted": false, "overridable": true, "files": ["view.json"], "attributes": {} }
   ```

3. Let the gateway pick it up (it scans projects periodically; with an API key: `POST /data/api/v1/scan/projects`),
   then update the project in the Designer.

Or in the Designer: create a view `Popups/TrendPopup` with the four parameters (input), add a Label and a Click To Graph
Chart and copy the two bindings from the JSON (`props.trendGroup` expression, `props.pens` property binding with a
script transform).

**Use it** on a Display Template:

```json
"menu": {
  "trendPopup": { "enabled": true, "viewPath": "Popups/TrendPopup", "mode": "trendList" }
}
```

Use `"mode": "singleTag"` to show only the clicked tag. In `trendList` mode one popup is open per trend group
(`menu.trendPopup.id` defaults to `ctg-trend-<trendGroup>`); in `singleTag` mode one per tag (the default id adds a hash
of the tag path). Choosing the item again brings that popup to the front. An explicit `menu.trendPopup.id` shared by
several displays means one shared popup, which is only brought to the front (it does not switch tags).

Binding `pens` to a view parameter means anyone who can open this popup can chart any tag they are allowed to read
(the same as a tag binding on that parameter). See [../security.md](../security-and-permissions.md#chart-read-scope).

<!-- nav:bottom -->

---

← Previous: [Glossary](../glossary.md) · [Back to index](../README.md) · Next: [Audit log view](AuditLogView.md) →

<!-- /nav:bottom -->
