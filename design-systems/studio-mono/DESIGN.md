---
name: Studio Mono
description: Black and white on a strict grid with one red, huge wide headlines and no decoration. For portfolios, agencies, architects, editorial pages and launches.
dark: yes
family: swiss
---

# Studio Mono

## Look
A poster from a design studio: white ground, black type, a strict 12-column grid, very large wide headlines, and one red used like a stamp. No shadows, no rounded corners, no icons for decoration. Confidence comes from scale and alignment.

## Colours
All colours live in `tokens.css`. Use `var()`; never write hex values into rules.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` / `--surface` | #ffffff | #0a0a0a | Everything |
| `--surface-2` | #f2f2f2 | #1a1a1a | Image placeholders, hover |
| `--fg` | #0a0a0a | #f4f4f4 | Text, rules, the main button |
| `--muted` | #5c5c5c | #a3a3a3 | Captions, years, credits |
| `--line` | #e2e2e2 | #2c2c2c | Hairlines |
| `--accent` | #d70a00 | #ff453a | One mark per screen: a dot, a word, an index number |
| `--ok` / `--warn` / `--bad` | | | Form states only |

## Type
- Display: Archivo at width 112-125 and weight 800-900 for h1 (`font-stretch: 118%`), set very large (`--text-3xl`, 96px) and tight (line-height 0.95, letter-spacing -0.03em).
- h2: Archivo 700 at `--text-xl`.
- Body: Public Sans 400 at 16px, line-height 1.5, max 60 characters.
- Small labels and numbers: Public Sans 500, uppercase, letter-spacing 0.08em, `--text-sm`.

## Spacing and shape
- Spacing steps: 4, 8, 16, 32, 64, 128 px. Big jumps between sections.
- Radius 0 everywhere. No shadows. Separate with space first, then 1px rules.
- Grid: 12 columns with 24px gaps; text blocks span 5-7 columns, images can bleed to the edge.

## Components
- **Primary button:** `--fg` fill, `--bg` text, 500 weight, uppercase small label, 14px by 22px, square corners.
- **Secondary button / links:** text with a 1px underline offset 4px; hover turns it `--accent`.
- **Project list:** rows with a large index number, title, year in `--muted`, a 1px rule between rows.
- **Images:** full-bleed or column-aligned, no frames; captions below in small `--muted` labels.
- **Inputs:** bottom border only (1px `--fg`), 2px `--focus` outline on `:focus-visible`.

## Do and don't
- Do align every edge to the grid; misalignment is the main way this look fails.
- Do use the red once per screen.
- Don't add cards, icons, gradients or rounded anything.
- Don't centre long text.
