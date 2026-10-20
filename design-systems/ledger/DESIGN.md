---
name: Ledger
description: Dense, precise data look with semi-condensed headings, mono numbers and a fixed chart palette. For dashboards, admin panels, finance and analytics tools.
dark: yes
---

# Ledger

## Look
A trading desk at 9am: neutral grey ground, white panels, compact type, numbers that line up, and colour used only for meaning (one blue for actions, green and red for up and down, four fixed chart colours). The data is the decoration.

## Colours
All colours live in `tokens.css`. Use `var()`; never write hex values into rules.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #f4f5f7 | #0f141b | Page background |
| `--surface` | #ffffff | #161d27 | Panels, tables |
| `--surface-2` | #eceff3 | #1d2633 | Table header, selected row, hover |
| `--fg` | #1b2330 | #e3e8ef | Text |
| `--muted` | #5a6577 | #93a0b2 | Labels, axis text, units |
| `--line` | #dde1e7 | #283244 | Borders, grid lines |
| `--accent` | #1c64c4 | #5aa2f8 | Actions, links, the selected item |
| `--up` / `--down` | #1b7f3b / #c0261f | #5ccf84 / #ff7a70 | Changes, always with ▲ ▼ or + − |
| `--chart-1` to `--chart-4` | | | Series colours, in this fixed order |
| `--ok` / `--warn` / `--bad` | | | Status pills, always with a word |

## Type
- Display: Barlow Semi Condensed 600-700 for page and panel titles.
- Body: Barlow 400-500 at 15px, line-height 1.5.
- Numbers: JetBrains Mono 500 with `tabular-nums`, right-aligned in tables. Big KPI values in Barlow Semi Condensed 700 at `--text-2xl`.
- Labels: `--text-sm`, `--muted`, sentence case.

## Spacing and shape
- Spacing steps: 4, 8, 12, 16, 24, 40 px. Compact by default.
- Radius 8px for panels, 4px for inputs, pills and buttons. One faint shadow on panels in light mode only.
- Layout: a 12-column grid of panels with 16px gaps; up to 1440px wide.

## Components
- **Primary button:** `--accent` fill, `--accent-ink` text, 500, 6px by 12px, radius 4px.
- **Panels:** `--surface`, 1px `--line`, radius 8px; title row with the panel name left and its controls right.
- **Tables:** 36px rows, 1px `--line` dividers, sticky `--surface-2` header, numbers right-aligned in mono.
- **KPI tile:** label, big value, change in `--up`/`--down` with an arrow, and a small sparkline in `--chart-1`.
- **Charts:** 1px `--line` grid, `--muted` axis labels, series in the fixed chart order, direct labels where there are four or fewer series.
- **Status pills:** small pill, tinted background of the status colour at 12%, text in the status colour, with a word.

## Do and don't
- Do label units and periods ("USD · last 30 days").
- Do keep colour for meaning; everything else stays neutral.
- Don't invent numbers: use the user's data or clearly marked examples.
- Don't use left-border accent cards, gradients or decorative icons.
