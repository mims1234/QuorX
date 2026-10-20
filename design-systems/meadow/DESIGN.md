---
name: Meadow
description: Soft, friendly and rounded, with a bouncy headline face, sage greens and a coral accent. For kids, learning apps, wellness, games' menus and friendly consumer products.
dark: yes
---

# Meadow

## Look
A sunny park: pale sage ground, deep green ink, big rounded shapes, a cheerful rounded headline face and a coral accent for the thing to press. Friendly and warm, never babyish: plenty of space, clear hierarchy, and only two strong colours.

## Colours
All colours live in `tokens.css`. Use `var()`; never write hex values into rules.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #f6f8f1 | #131a14 | Page background |
| `--surface` | #ffffff | #1b241c | Cards, panels, inputs |
| `--surface-2` | #ebf0e2 | #233025 | Bands, chips, hover |
| `--fg` | #1d2b20 | #e8efe4 | Text |
| `--muted` | #56685a | #a3b3a5 | Secondary text |
| `--line` | #dbe3d0 | #2f3d31 | Borders |
| `--accent` | #c8432d | #ff8a73 | Main action, "new" badges |
| `--accent-soft` | #fde4dc | #3a211b | Background behind an accent highlight |
| `--accent-2` | #2f7a4b | #7cc996 | Progress, success, the second highlight |
| `--ok` / `--warn` / `--bad` | | | Status, always with a word or icon |

## Type
- Display: Baloo 2 700-800 for headings, line-height 1.1.
- Body: Nunito Sans 400, 17px at line-height 1.65; 600-700 for emphasis.
- Buttons use Nunito Sans 700.

## Spacing and shape
- Spacing steps: 6, 10, 16, 28, 44, 76 px.
- Radius 20px for cards and big buttons, 12px for inputs and chips. Shapes may be blobby (large radius images, round avatars).
- Shadow is a flat 2px "lip" under raised things (`--shadow`), not a blur.
- Tap targets at least 44px.

## Components
- **Primary button:** coral fill, white text, 700, 14px by 26px, radius 20px, the 2px lip shadow; it moves down 2px when pressed.
- **Secondary button:** `--surface-2` fill, `--fg` text.
- **Cards:** `--surface`, 1px `--line` border, radius 20px, 24px padding, often with a simple illustration or icon in `--accent-2`.
- **Progress:** thick (10px) rounded bar in `--accent-2` on `--surface-2`.
- **Inputs:** `--surface`, 2px `--line` border, radius 12px, `--focus` border on focus plus a 2px outline.

## Do and don't
- Do use simple flat illustrations or icons with rounded line caps.
- Do write in a warm, plain voice.
- Don't use more than two strong colours on one screen.
- Don't use thin text weights or tiny type.
