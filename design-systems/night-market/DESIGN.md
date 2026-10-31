---
name: Night Market
description: Warm, lively dark look with a chunky display face, saffron and teal. For events, food, music, nightlife and anything that should feel like an evening out.
dark: only
family: neon
---

# Night Market

## Look
Stalls lit up after dark: a warm near-black ground (plum, not blue), cream text, big chunky headlines, saffron for the main action and teal for the second thing that needs to pop. Loud in the headline, calm everywhere else. Dark only.

## Colours
All colours live in `tokens.css`. Use `var()`; never write hex values into rules.

| Token | Value | Use |
|---|---|---|
| `--bg` | #141014 | Page background |
| `--surface` | #1e181d | Cards and panels |
| `--surface-2` | #2a2128 | Hover, bands |
| `--fg` | #f5ece3 | Text |
| `--muted` | #b8aba0 | Secondary text, dates, captions |
| `--line` | #3a2e36 | Borders |
| `--accent` | #f2a516 | Main action, the date or price that matters |
| `--accent-ink` | #1a1206 | Text on saffron |
| `--accent-2` | #2ec4b6 | One secondary highlight (a "today" tag, a map pin) |
| `--ok` / `--warn` / `--bad` | | Status, always with a word |

## Type
- Display: Bricolage Grotesque 800 for h1, 600 for h2, letter-spacing -0.02em. Headlines can be huge (`--text-3xl`, 68px) on desktop.
- Body: Work Sans 400-500 at 17px, line-height 1.6.
- Dates, times and prices: Work Sans 600, `tabular-nums`.

## Spacing and shape
- Spacing steps: 4, 8, 16, 28, 48, 88 px. Let sections breathe.
- Radius 14px for cards, pill shape (`--radius-sm`) for tags and small buttons.
- One deep shadow (`--shadow`) for raised cards; no glow effects.

## Components
- **Primary button:** saffron fill, `--accent-ink` text, 600 weight, pill or 14px radius, 14px by 24px.
- **Secondary button:** 1px `--line` border, `--fg` text; teal only for one special action.
- **Event or menu card:** `--surface`, a picture on top (real photos, or a flat colour block with the name), date in saffron, title in the display face.
- **Tags:** pill, `--surface-2` fill, `--fg` text; the "today"/"live" tag in teal with `--accent-2-ink` text.
- **Inputs:** `--surface`, 1px `--line` border, 2px teal focus ring.

## Do and don't
- Do pair one big headline with a lot of calm space.
- Do use real photos of food, crowds and places when there are any.
- Don't add neon glows, purple gradients or more than two accent colours.
- Don't put long text in the display face.
