<!-- nav:top -->

[Docs home](../../README.md) › [User Guide](../README.md) › [Samples](README.md) › **Setpoint log scripts**

<!-- /nav:top -->

# Sample: logging setpoint writes from `onSetpointWrite`

The Display Template fires `onSetpointWrite` on the gateway after every write attempt that reached the tag (success or
failure), before the operator sees the result. A gateway-scope **Script** action on that event can record the write in
your own table or log, or notify someone.

> **The event is a notification, not proof.** Any page script can fire a component event with any payload. Use the
> event for convenience (a project log, a notification) and the **audit profile** as the record. Every event carries
> the `auditId` of its audit record, so the two can be reconciled (bottom of this page).

## Payload

`event.tagPath`, `event.value`, `event.previousValue`, `event.success`, `event.quality`, `event.errorCode`,
`event.user`, `event.timestamp` (epoch ms), `event.editMode` (`popup`, `direct`, `protected`, `unknown`),
`event.auditId`. Read them as attributes (`event.tagPath`), as for built-in component events.

## 1. Gateway log line (no database needed)

Component > Configure Events > `onSetpointWrite` > add a **Script** action:

```python
	log = system.util.getLogger('Plant.Setpoints')
	log.infof('setpoint %s: %s -> %s by %s (%s, %s) auditId=%s',
		event.tagPath, event.previousValue, event.value, event.user,
		'ok' if event.success else event.errorCode, event.editMode, event.auditId)
```

## 2. Your own database table

Create the table once (SQL Server syntax; adapt the types for your database):

```sql
CREATE TABLE setpoint_log (
  t_stamp     DATETIME     NOT NULL,
  username    VARCHAR(255) NOT NULL,
  tagpath     VARCHAR(1024) NOT NULL,
  old_value   VARCHAR(255),
  new_value   VARCHAR(255),
  success     BIT          NOT NULL,
  quality     VARCHAR(64),
  error_code  VARCHAR(64),
  edit_mode   VARCHAR(16),
  audit_id    VARCHAR(64)  NOT NULL UNIQUE   -- a re-fired copy of an event cannot add a second row
)
```

and use this **Script** action (replace `PlantDB` with your database connection). A missing value is stored as SQL
`NULL`, not as the text `None`, so the check below can tell it from a String value `None`:

```python
	text = lambda v: None if v is None else unicode(v)
	system.db.runPrepUpdate(
		"INSERT INTO setpoint_log (t_stamp, username, tagpath, old_value, new_value, success, quality,"
		" error_code, edit_mode, audit_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
		[system.date.fromMillis(event.timestamp), event.user, event.tagPath, text(event.previousValue),
		 text(event.value), event.success, event.quality, event.errorCode, event.editMode, event.auditId],
		'PlantDB')
```

(The database variant is **UNVERIFIED**: it has not been run against a database yet. The logger variant and the
payload are verified on 8.3.10.)

## 3. Client actions

Client-scope actions (Popup, Navigation) on the same event run after every write attempt, successful or not. The
display already tells the operator what went wrong, so use them only for project-specific follow-up, such as opening a
"reason for change" popup after successful writes to critical setpoints (check `event.success` in that popup's view).

## Reconciling with the audit profile

Every event carries the `auditId` that is also at the end of the audit record's value
(`<new> (was <old>) [ui=<mode>] [auditId=<id>]`) and in the `SimpleTagDisplay.Audit` log line. To check that a logged
write really happened, look the id up in the audit profile **and check that the record describes the same write**.

The whole event is under the sender's control, so the check must not trust any part of it:

- **The id must be a UUID** (the only form the module issues). The profile's filters are SQL `LIKE` patterns: an
  unchecked id such as `%` or 36 underscores matches every record.
- **The id must come from the module's suffix at the very end of the value.** A String setpoint value is recorded as
  typed, so a value can contain the text `[auditId=…]` itself.
- **The record must match the event:** action `tag write`, the same tag path, the same user, the same new and previous
  value. Otherwise the real id of one write could vouch for a made-up event about another tag, user or value.

Put this in a **project library script** (Project Library, for example a script named `auditcheck`). Call it from
gateway scope, for example in a gateway timer script that checks yesterday's rows of your table:

```python
import re

# The module's ids are random UUIDs; anything else is forged (and could hold the LIKE wildcards % and _).
UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
# A write record ends with the module's suffix: " [ui=<mode>] [auditId=<id>]", or "..., late=true]" for a late result.
WRITE = re.compile(r'^(.*) \[ui=[a-z]+\] \[auditId=([0-9a-fA-F-]{36})(?:, late=true)?\]$')

class _Unverifiable(object):
	"""The third result of audited(): the record exists, but it was cut at 255 characters before the previous value
	started, so the event's values cannot be checked against it. It is false in a test, so `if not audited(...)`
	treats it as "not verified"; compare with `is UNVERIFIABLE` to tell it apart from False."""
	def __nonzero__(self):
		return False
	def __repr__(self):
		return 'UNVERIFIABLE'

UNVERIFIABLE = _Unverifiable()

def text(value):
	"""The record's text of a value (Java's String.valueOf): None is 'null', anything else as is."""
	return u'null' if value is None else unicode(value)

def sameValue(recorded, value):
	"""The record's text of a value against the event's value (or its text in your table). Only a real None is
	'null': a String value 'None' stays 'None'."""
	t = text(value)
	if recorded == t or (recorded.lower() == t.lower() and t.lower() in (u'true', u'false')):
		return True
	try:
		a, b = float(recorded), float(t)
	except ValueError:
		return False
	return a == b or abs(a - b) <= 1e-6 * max(abs(a), abs(b))   # Float4 tags: 71.1 vs 71.0999984741211

def audited(auditId, tagPath, user, value, previousValue, timestamp, profile='PlantAudit'):
	"""True when the audit profile holds the write that an onSetpointWrite event (or a row of your log) describes,
	False when it does not, UNVERIFIABLE when the matching record was cut before the previous value (see below).
	timestamp: the event's epoch ms. Arguments: event.auditId, event.tagPath, event.user, event.value,
	event.previousValue, event.timestamp."""
	auditId = unicode(auditId or '')
	if not UUID.match(auditId):
		return False
	ds = system.util.queryAuditLog(auditProfileName=profile,
		startDate=system.date.fromMillis(long(timestamp) - 3600000), endDate=system.date.fromMillis(long(timestamp) + 3600000),
		actionFilter='tag write', valueFilter='%auditId=' + auditId + '%')
	written = text(value) + u' (was ' + text(previousValue) + u')'
	result = False
	for r in range(ds.getRowCount()):
		m = WRITE.match(ds.getValueAt(r, 'Action Value') or '')
		if (not m or m.group(2).lower() != auditId.lower() or ds.getValueAt(r, 'Action') != 'tag write'
				or ds.getValueAt(r, 'Action Target') != tagPath or ds.getValueAt(r, 'Actor') != user):
			continue                 # the id inside a written String value, or another tag or user
		head = m.group(1)            # "<new> (was <old>)", cut and ended with "..." when the record reached 255 characters
		cut = head.endswith('...')
		kept = head[:-3] if cut else head
		i = kept.find(' (was ')
		while i >= 0:                # a String value may itself contain " (was "
			if cut:                  # the new value in full, the previous one as far as it was kept
				if sameValue(kept[:i], value) and text(previousValue).startswith(kept[i + 6:]):
					return True
			elif head.endswith(')') and sameValue(head[:i], value) and sameValue(head[i + 6:-1], previousValue):
				return True
			i = kept.find(' (was ', i + 1)
		if cut and written.startswith(kept):
			result = UNVERIFIABLE      # cut inside the new value (or the split is past the cut): nothing to compare
	return result
```

For example, in a gateway timer script that walks yesterday's rows of the `setpoint_log` table:

```python
	log = system.util.getLogger('Plant.Setpoints')
	for row in system.db.runPrepQuery("SELECT * FROM setpoint_log WHERE t_stamp >= ?",
			[system.date.addDays(system.date.now(), -1)], 'PlantDB'):
		ok = auditcheck.audited(row['audit_id'], row['tagpath'], row['username'], row['new_value'],
				row['old_value'], system.date.toMillis(row['t_stamp']))
		if ok is auditcheck.UNVERIFIABLE:
			log.infof('audit record for %s (%s) was cut before its values; not checked', row['audit_id'], row['tagpath'])
		elif not ok:
			log.warnf('no audit record for %s (%s)', row['audit_id'], row['tagpath'])
```

A row in your log that fails this check was not written by the module as logged: someone fired the event by hand, or
changed its payload. What the check does **not** cover:

- **A copy of a genuine event** passes (it describes a real write). The `UNIQUE` constraint on `audit_id` above keeps
  it out of the table.
- `success` and `errorCode` are not compared: a timed-out write is recorded as Uncertain first and again when the
  provider answers (`late=true`). Read `Result Code` of the matching rows if you need the outcome.
- **Long values are only partly compared.** The audit value is at most 255 characters, so when `<new> (was <old>)` is
  longer than about 190 characters the module shortens it with `...` (the `[auditId=…]` suffix always survives). The
  helper then compares the new value in full and the previous value only as far as it was kept, so a made-up previous
  value that starts with the kept part passes. When the cut falls inside the new value, nothing of the event can be
  checked and the helper returns `UNVERIFIABLE` (not `True`).
- **Native `tag write` records on String tags.** Ignition also audits writes made outside the Display Template (another
  component, a script, the Designer) as `tag write`, with the written value as is. If a user can write a **String**
  tag that way, they can write a value that ends like the module's suffix, such as
  `x (was y) [ui=popup] [auditId=<any UUID>]`; that record then vouches for an event with the same id, values and
  user. For such tags the check proves that this user wrote that text to the tag, not that the Display Template did.
  Numeric and Boolean tags are not affected (their values cannot hold the suffix).
- Control characters in a String value are recorded as `?`, so such a value fails the check.

(`audited` is verified on 8.3.10 against an internal audit profile, including forged ids, an id hidden in a String
value, a real id with another tag, user or value, the String value `None`, and records cut at 255 characters before
and after the previous value. The timer-script loop over a database table is **UNVERIFIED**: it has not
been run against a database yet.)

<!-- nav:bottom -->

---

← Previous: [Audit log view](AuditLogView.md) · ↑ Up: [Samples](README.md) · [Back to index](../README.md)

<!-- /nav:bottom -->
