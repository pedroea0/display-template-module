<!-- nav:top -->

[Docs home](../../README.md) › [User Guide](../README.md) › [Samples](README.md) › **Audit log view**

<!-- /nav:top -->

# Sample: a setpoint audit log view

A Perspective Table that lists the setpoint writes and tag configuration edits recorded by the Display Template, newest
first, refreshed every 30 seconds. It reads the **audit profile**, which is the authoritative record (see
[../display-template.md](../components/display-template/menu-and-setpoints.md#audit-trail-who-changed-what)).

## What the module records

| Audit column | Content |
|---|---|
| `Timestamp` | time of the attempt |
| `Actor` / `Actor Host` | the Perspective user (`Unauthenticated` when anonymous) and the client address |
| `Action` | `tag write`, `tag edit`, `annotation add`, `annotation edit`, `annotation delete` |
| `Action Target` | full tag path, e.g. `[default]Area1/TempSP` |
| `Action Value` | writes: `<new> (was <old>) [ui=<popup\|direct\|protected>] [auditId=<id>]`; edits: `EngHigh: 100.0 -> 150.0 [auditId=<id>]`; a late result ends in `[auditId=<id>, late=true]` |
| `Result Code` / `Result` | 0 = Good; anything else = Bad or Uncertain (the write failed or its outcome was unknown) |
| `System` | gateway, project, page and component, e.g. `sys:<gateway>:/project:Plant:/page:…:/component:Area1/Overview@C/root/TempSP` |

These are the column names `system.util.queryAuditLog` returns on 8.3.10.

## The binding

Add a **Table** to a view. Bind `props.data` with an **expression** binding `now(30000)` (re-evaluates every 30 s) and
add this **script transform** (replace `PlantAudit` with your project's audit profile):

```python
	import re
	# The module's suffix is always at the very end of the value; a String value may contain the same text itself.
	tail = re.compile(r' \[auditId=([0-9a-fA-F-]{36})(, late=true)?\]$')
	end = system.date.now()
	start = system.date.addDays(end, -7)
	ds = system.util.queryAuditLog(auditProfileName='PlantAudit', startDate=start, endDate=end)
	rows = []
	for r in range(ds.getRowCount()):
		action = ds.getValueAt(r, 'Action')
		if action not in ('tag write', 'tag edit'):
			continue
		text = ds.getValueAt(r, 'Action Value') or ''
		m = tail.search(text)
		head = text[:m.start()] if m else text
		head = re.sub(r' \[ui=[a-z]+\]$', '', head)         # writes: drop the [ui=...] suffix too
		rows.append({
			'time': ds.getValueAt(r, 'Timestamp'),
			'user': ds.getValueAt(r, 'Actor'),
			'tag': ds.getValueAt(r, 'Action Target'),
			'change': head,
			'ok': ds.getValueAt(r, 'Result Code') == 0,
			'late': bool(m and m.group(2)),
			'auditId': m.group(1) if m else ''
		})
	rows.sort(key=lambda x: x['time'], reverse=True)
	return rows[:500]
```

The same in a view resource (`propConfig` of the table):

```json
"props.data": {
  "binding": {
    "type": "expr",
    "config": { "expression": "now(30000)" },
    "transforms": [ { "type": "script", "code": "\timport re\n\tend = system.date.now()\n\t..." } ]
  }
}
```

Notes:

- `system.util.queryAuditLog` runs on the gateway with the gateway's rights: everyone who can open this view sees every
  record. Protect the view (page or view security, roles) like any audit screen.
- The filter arguments (`actorFilter`, `actionFilter`, `targetFilter`, `valueFilter`) are SQL `LIKE` patterns on the
  internal audit profile (`_` and `%` are wildcards). To list one tag, pass `targetFilter='[default]Area1/TempSP'`. To
  find one write, pass `valueFilter='%auditId=<id>%'`, but **only after checking that `<id>` is a UUID**: an id taken
  from an event payload or a user input can be `%` and match every record. Then check the match the way
  [setpoint-log-script.md](setpoint-log-script.md#reconciling-with-the-audit-profile) does: the id must be the one in
  the module's suffix at the end of the value, not text inside a String value.
- For a single tag on an operator screen, the Display Template's **Change History…** menu item
  (`menu.changeHistory`) shows the same records without any scripting, filtered on the gateway by the user's Read
  permission.

Verified on Ignition 8.3.10 with an internal audit profile: the call signature, the column names
and the value format.

<!-- nav:bottom -->

---

← Previous: [Samples](README.md) · [Back to index](../README.md) · Next: [Setpoint log scripts](setpoint-log-script.md) →

<!-- /nav:bottom -->
