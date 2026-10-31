---
name: Harbor
description: Calm coastal look with a serif headline and one signal-orange accent. For local services, clinics, studios and small businesses that want to look trustworthy.
dark: yes
family: corporate
---

# Harbor

## Look
Clear morning light on a harbour: cool off-white grounds, deep navy ink, generous space, and one signal-orange accent that marks the action. Headlines are a soft modern serif; everything else is a plain, readable sans. It should feel calm and dependable, never corporate.

## Colours
All colours live in `tokens.css` as custom properties. Use `var()`; never write hex values into rules.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #f3f6f7 | #0b1a24 | Page background |
| `--surface` | #ffffff | #12263a | Cards, panels, inputs |
| `--surface-2` | #e8eef1 | #183047 | Bands, hover, table stripes |
| `--fg` | #102a3c | #e6eef2 | Body text and headings |
| `--muted` | #4f6676 | #9db1bd | Secondary text, captions |
| `--line` | #d3dde3 | #24405a | Borders and dividers |
| `--accent` | #c2410c | #ff8a4c | The main action only, plus at most one highlight per screen |
| `--accent-ink` | #ffffff | #1a0b03 | Text on the accent |
| `--accent-2` | #1d6f8a | #5fb6d1 | Links and secondary emphasis |
| `--ok` / `--warn` / `--bad` | | | Status, always with a word or icon |
| `--focus` | #1d6f8a | #5fb6d1 | Focus ring |

## Type
- Display: Fraunces 500-700 for h1-h2 (`--font-display`), letter-spacing -0.01em, `text-wrap: balance`.
- Body: Source Sans 3 400, 600 for emphasis (`--font-body`), 1rem at line-height 1.6, lines about 65 characters.
- Scale: `--text-sm` 14 · `--text-base` 16 · `--text-lg` 20 · `--text-xl` 26 · `--text-2xl` 36 · `--text-3xl` 52.
- h3 and below use the body font at 600, not the serif.

## Spacing and shape
- Spacing steps: 4, 8, 16, 24, 40, 72 px (`--space-1` to `--space-6`). Sections are separated by `--space-6`.
- Radius 10px for cards and buttons, 6px for inputs and tags. One soft shadow (`--shadow`) for raised cards only.
- Content width up to 1120px (`--max`), 16px side gutter on phones.

## Components
- **Primary button:** accent fill, accent-ink text, 600 weight, 12px by 20px padding, radius 10px. One per section.
- **Secondary button:** transparent with a 1px `--fg` border at 30% (or `--line` on dark), text in `--fg`.
- **Links:** `--accent-2`, underlined on hover.
- **Cards:** `--surface`, 1px `--line` border, radius 10px, padding 24px. No coloured side borders.
- **Inputs:** `--surface`, 1px `--line` border, radius 6px, a visible `--focus` ring (2px) on `:focus-visible`.
- **Header:** plain bar on `--bg`, wordmark in the display font, nav links in `--fg`, the one action button on the right.

## Do and don't
- Do use photos or simple line illustrations of the real place or work. Captions in `--muted`.
- Do keep the accent rare: if three things are orange, nothing stands out.
- Don't add gradients, glows or glassy cards.
- Don't set body text in the serif.
