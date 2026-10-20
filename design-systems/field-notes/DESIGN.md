---
name: Field Notes
description: A practical lab-notebook look with a condensed headline, mono labels and a faint grid. For tools, docs, dashboards and developer pages where clarity beats charm.
dark: yes
---

# Field Notes

## Look
A well-kept field notebook: paper-white ground with a faint grid, graphite text, condensed headings, small mono labels for data and metadata, and a single forest-green accent. Dense but orderly. It should feel like a tool someone relies on, not a brochure.

## Colours
All colours live in `tokens.css`. Use `var()`; never write hex values into rules.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #fafaf7 | #151816 | Page background |
| `--grid` | #eceee8 | #202521 | The 24px background grid, optional |
| `--surface` | #ffffff | #1c201d | Panels, tables, inputs |
| `--surface-2` | #f0f1ec | #232825 | Table header, hover |
| `--fg` | #1f2421 | #e4e7e2 | Text |
| `--muted` | #5b625d | #9aa39c | Labels, captions, units |
| `--line` | #dcdfd8 | #333a35 | Hairlines and borders |
| `--accent` | #2f6f4a | #6fbf8e | The main action and the current item |
| `--accent-2` | #8a5a00 | #e0b04f | Notes and highlights, used sparingly |
| `--ok` / `--warn` / `--bad` | | | Status, always with a word |

## Type
- Display: IBM Plex Sans Condensed 600-700 for headings, tight (line-height 1.15).
- Body: IBM Plex Sans 400, 15px at line-height 1.55.
- Mono: IBM Plex Mono for numbers, codes, timestamps and small uppercase labels (letter-spacing 0.06em, `--text-sm`, `--muted`).
- Numbers in tables use `font-variant-numeric: tabular-nums` and align right.

## Spacing and shape
- Spacing steps: 4, 8, 12, 20, 32, 56 px. Tighter than most systems: this is for scanning.
- Radius 3px at most. No shadows: separate things with 1px `--line` borders.
- Optional grid: `background-image` of 1px `--grid` lines every 24px on `--bg`.

## Components
- **Primary button:** `--accent` fill, `--accent-ink` text, 500 weight, 8px by 14px, radius 3px.
- **Secondary button:** `--surface` with a 1px `--line` border.
- **Tables:** full-width, 1px `--line` row borders, `--surface-2` header in mono uppercase labels.
- **Labels and tags:** mono, uppercase, 1px `--line` border, radius 2px, no fill.
- **Inputs:** `--surface`, 1px `--line` border, 2px `--focus` outline on `:focus-visible`.
- **Callouts:** a left rule is fine here only without rounded corners (radius 0).

## Do and don't
- Do show real units and sources next to numbers.
- Do use mono labels above values ("UPDATED", "P95") rather than icons.
- Don't use more than one accent colour per screen.
- Don't use rounded cards, gradients or illustrations.
