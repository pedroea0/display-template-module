<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Operator guide**

<!-- /nav:top -->

# Operator guide: what the colours and markers mean

A one-page guide for the people who use the screens. Integrators: the exact colours can be changed per project, so
check that this page matches your theme before you hand it out.

## Values (Display Template)

| What you see | Meaning | What to do |
|---|---|---|
| Plain value, e.g. `72.4 degF` | live value, good quality | – |
| Value in the **accent colour** (blue in the default theme), pointer cursor, sometimes a ✎ pencil | you can change this value | click it (or double-click / press, for protected values) |
| Same colour, but **faded**, "not allowed" cursor | the value is a setpoint, but you may not change it now | click it to see why (log in, missing permission, bad quality, ...) |
| Value with a **coloured background and a numbered shape** | an **alarm** is active on this tag | follow your alarm procedure |
| ◆ **1** dark red | Critical alarm | |
| ▲ **2** orange | High alarm | |
| ● **3** yellow | Medium alarm | |
| ▼ **4** blue | Low alarm | |
| ■ **D** grey | Diagnostic | |
| The shape **blinks** | the alarm is **not acknowledged** yet | acknowledge it in the alarm screen |
| **Slate border** with **▲** | value is **above its normal high limit** (not an alarm) | |
| **Slate border** with **▼** | value is **below its normal low limit** (not an alarm) | |
| **Magenta dashed outline** + small icon | the value is **uncertain** (for example the last known value) | treat with care |
| **Magenta solid outline** + small icon | the value has **bad quality**: it may be wrong or old | do not rely on it; report it if it stays |
| Value **dimmed and underlined (dashed)** + a "disconnected" icon | the screen has **lost its connection** to the gateway; the value shown is the last one received | wait; it updates by itself when the connection is back |
| `Tag not found`, `No access`, `Invalid tag path` | the screen is configured for a tag that does not exist or that you may not see | tell the engineer |
| `…` | waiting for the first value | |

## Changing a value (setpoints)

- **Click** the value (or use **Set Value…** in the right-click menu). A dialog shows the current value, the allowed
  range and the new value. Type it and press **Write** (or Enter). **Esc** cancels.
- **On/off and lists** (Start/Stop, Auto/Manual) never change on the first tap: you pick, then **confirm**.
- If the change is too big, the screen says so (*Change is larger than allowed*). Make it in smaller steps or ask the
  engineer.
- After writing, the value briefly flashes green. *Written, but the tag reads X* means the controller did not keep
  your value: check it.
- *No confirmation received…* means the screen does not know whether the write happened. **Look at the current value
  before trying again**; never press Write twice in a row.

## The right-click menu

Right-click a value (on a touch screen: press and hold) for:

- **Trend Tag** / **Remove from Trend**: add the tag to the trend chart(s) of this screen. *No history available*
  means the tag is not recorded.
- **Go to Trend Page** / **Open Trend Popup**: open a trend of this tag.
- **Tag Configuration…** (engineers): change units and limits for **every** screen.
- **Change History…**: who changed this value and when.
- **Copy Tag Path**.

Greyed items show the reason underneath (*Log in to trend*, *Not permitted*, *Not connected*, ...).

## Trend chart (Click To Graph Chart)

| What you see | Meaning |
|---|---|
| **Live** (green) | the chart follows the current time |
| **Paused** + *Return to live* | you moved back in time; press *Return to live* to follow again |
| **Historical** | a fixed time range is shown |
| **Stale since hh:mm:ss** (amber) | the chart has not been updated since then; it keeps retrying |
| **Disconnected** (grey) | no connection to the gateway; it resumes by itself |
| A pen row with a **red or amber edge** and a reason | that pen has a problem (no permission, no history, too many points, ...) |
| **Hatched** stretch on a line (or a dashed flat line) | the value had bad quality during that time (the dashed line repeats the last good value) |
| Part of a line in **another colour** (often amber), maybe thicker | the value was above its high limit or below its low limit there |
| A Boolean line in two colours with **shaded** periods | shaded / first colour = on (true), second colour = off (false) |
| A **strip under the chart** with a framed window | the overview: the whole time range, with the part shown above framed. Drag the frame to move it, drag its edges to resize it, drag elsewhere to choose a new part, double-click to reset. *More > Hide overview* hides it |
| `≈` in front of a number | calculated from summarised data (not every sample) |

Tools on the toolbar: **X-Trace** (point at the plot to read values; click to pin a cursor), **Pan** (drag to move,
wheel to zoom), **Zoom** (drag a box), **Range** (drag across a range to get min, max, average and more for it),
**Note** (add a note to the history, if enabled). The date button chooses the time range. Double-click resets the zoom
in Pan and Zoom modes. The checkbox in each pen row hides or shows that pen.

**Tags** (≡, shown on most charts) opens the tag browser: open folders, tick tags and press **Add selected**. To
find a tag without knowing its folder, tick **Search all folders** and type part of its name or path (for example
`pump101`, or `temp*` with `*` as a wildcard). The list shows matching tags with their folder; tick them and press
**Add selected**. If the line under the field says the search stopped early, type more to narrow it.

<!-- nav:bottom -->

---

← Previous: [Working in the Designer](designer.md) · [Back to index](README.md) · Next: [Upgrading from 1.x](upgrading-from-v1.md) →

<!-- /nav:bottom -->
