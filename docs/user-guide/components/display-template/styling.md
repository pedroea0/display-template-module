<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › [Display Template](README.md) › **Styling**

<!-- /nav:top -->

# Styling

How to change the look of one Display Template, or of every Display Template in a project, without fighting the
module's own styles.

**On this page**

- [The cascade: what wins](#the-cascade-what-wins)
- [One display: style props](#one-display-style-props)
- [Every display: project stylesheet and theme](#every-display-project-stylesheet-and-theme)
- [Perspective style classes](#perspective-style-classes)
- [Theme tokens](#theme-tokens)
- [Class names](#class-names)
- [State colours](#state-colours)
- [1.x stylesheets](#1x-stylesheets)

---

## The cascade: what wins

The module's built-in look has **zero CSS specificity** (`:where(...)`), so any class or theme rule beats it without
`!important`. Left alone, the component is transparent and follows the Perspective theme (light and dark).

Precedence, highest first:

1. `label.style` / `value.style` inline styles
2. `style` inline (cascades to the label and the value)
3. Perspective style classes and project CSS
4. per-instance colour props (`setpoint.color`, `bounds.lowColor`, `alarms.colors.*`)
5. project-wide tokens (`--dt-*` custom properties)
6. module defaults

> **Note** A colour in `value.style` wins over alarm, bounds and setpoint colours. That is on purpose (you asked for that
> colour), but it also hides alarm colours. Use `alarms.colors.*` or the tokens to restyle alarms instead.

## One display: style props

| Prop | Applies to | Typical use |
|---|---|---|
| `style` | the whole component; colour, font and text-align also reach the label and the value | background, border, padding, a font for both texts |
| `label.style` | the label only | smaller, bolder or muted label |
| `value.style` | the value only | monospace digits, a fixed colour |
| `units.style` | the units text | lighter units |
| `setpoint.style` | the value while it is writable (`value.style` still wins) | underline or border for writable values |
| `states.options[].style` | the value while that state is shown | a red background for *Fault* |

Example: a dark tile with a large monospace value.

```json
"style":       { "backgroundColor": "#1E2329", "color": "#E6E6E6", "borderRadius": "6px", "padding": "8px" },
"label":       { "style": { "fontSize": "12px", "opacity": 0.8 } },
"value":       { "style": { "fontFamily": "Roboto Mono, monospace", "fontSize": "28px" } }
```

A `font-size` set in `style`, `label.style` or `value.style` (or from a class or project CSS on the root) always wins
over `layout.autoFontSize`.

## Every display: project stylesheet and theme

Put project-wide rules in the project's advanced stylesheet (in the Designer's Perspective **Styles** section; stored as
`com.inductiveautomation.perspective/stylesheet/stylesheet.css` in the project folder) or in a theme file. This example
was checked on 8.3.10:

```css
:root {
  --dt-setpoint-color: #0050A0;      /* writable values */
  --dt-alarm-high-bg: #E07000;       /* High alarm background */
}
.dt-label { text-transform: uppercase; letter-spacing: .03em; }
.dt-root.dt--row .dt-value { font-family: "Roboto Mono", monospace; }
```

## Perspective style classes

A style class `Big` set on `style.classes`, `label.style.classes` or `value.style.classes` becomes the CSS class
`psc-Big` on that element, as for built-in components. The label and value sizes and weights are relative to the root,
so a class on `style.classes` that sets `font-size` / `font-weight` resizes both (the label stays a little smaller and
bolder). A root font size from a class or project CSS also switches `layout.autoFontSize` off for that display, like an
inline `style.fontSize`.

## Theme tokens

CSS custom properties on `:root`; dark values apply under a dark theme. Override them in the project stylesheet.

| Token | Default | Used for |
|---|---|---|
| `--dt-setpoint-color` | theme `--callToAction` (`#0C7BB3`) | writable values |
| `--dt-low-color` / `--dt-high-color` | `#4F6D8F` / `#6A5ACD` (dark `#8FA9C8` / `#A99CF0`) | bounds |
| `--dt-uncertain-color` / `--dt-bad-color` | `#B0479F` / `#A0309A` (dark `#E79AE0` / `#E07BD8`) | quality |
| `--dt-error-color` | `#A0309A` | status texts |
| `--dt-alarm-<priority>-bg` / `-fg` | see [the alarm table](README.md#alarm-colours-alarms-is-there-an-alarm) | alarm colours (`critical`, `high`, `medium`, `low`, `diagnostic`) |
| `--dt-stale-opacity` | `0.55` | lost connection |
| `--dt-label-size` / `--dt-value-size` | set by `layout.autoFontSize` | font sizes |
| `--dt-font-size` / `--dt-font-weight` | `14px` / `normal` | the root's size and weight; the label (12/14 of it, bolder) and the value (1em, same weight) follow the root |
| `--dt-padding`, `--dt-radius`, `--dt-blink-period` | `10px`, theme radius, `1s` | box and blink |

Menus and dialogs are shared with the chart and use the `--ctg-*` tokens (`--ctg-surface`, `--ctg-text`,
`--ctg-primary`, ...), see [chart styling](../ctg-chart/panels-and-tools.md#styling).

## Class names

These class names are a public API: they stay stable across 2.x releases.

| Element | Classes |
|---|---|
| root | `dt-root`, `simple-tag-display-component` |
| label | `dt-label`, `std-tag-name` |
| value | `dt-value`, `std-tag-value`; inside it `dt-value-text`, `dt-units`, `dt-alarm-indicator`, `dt-quality-icon`, `dt-edit-icon` |
| editors | `dt-input`, `dt-input--invalid`, `dt-select` |
| root state modifiers | `dt--column`/`dt--row`, `dt--design`, `dt--disabled`, `dt--loading`, `dt--unconfigured`, `dt--error`, `dt--stale`, `dt--setpoint`, `dt--setpoint-denied`, `dt--editing`, `dt--writing`, `dt--write-ok`, `dt--write-failed`, `dt--low`, `dt--high`, `dt--alarm`, `dt--alarm-critical` … `dt--alarm-diagnostic`, `dt--alarm-unacked`, `dt--trending`, `dt--has-menu` |
| menus and dialogs (shared with the chart) | `ctg-menu`, `ctg-menu__item`, `ctg-dialog`, `ctg-dialog__title`, `ctg-btn`, `ctg-btn--primary`, `ctg-bubble` |

Example: a thicker outline on every display in a High alarm.

```css
.dt-root.dt--alarm-high .dt-value { outline: 2px solid var(--dt-alarm-high-bg); }
```

## State colours

Which state gets which colour, and which one wins when several apply, is the
[colour policy](README.md#colour-policy). In short: alarm hues are reserved for alarms, limits use neutral slate plus
▲/▼, quality uses magenta outlines, and a lost connection dims the value. The per-instance colour props are
`bounds.lowColor` / `highColor` (with `bounds.appearance`), `alarms.colors.*` (with `alarms.appearance`) and
`setpoint.color`.

## 1.x stylesheets

1.x stylesheets keep working: the `simple-tag-display-component`, `std-tag-name` and `std-tag-value` classes and the
`--std-*` custom properties are still set.

<!-- nav:bottom -->

---

← Previous: [Menu and setpoints](menu-and-setpoints.md) · ↑ Up: [Display Template](README.md) · [Back to index](../../README.md) · Next: [Recipes](recipes.md) →

<!-- /nav:bottom -->
