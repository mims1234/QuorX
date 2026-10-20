---
name: design-system
description: Write or change a project's design system (DESIGN.md + tokens.css), from a reference site or screenshot, a description, or one of the starters.
---

# Design system

A project's design system is two files in its root, read by every chat in the project:
- **`DESIGN.md`**: the look in words, for people and models.
- **`tokens.css`**: the same values as CSS custom properties, for pages to link.

The user can also pick one of the starters in Project settings → Design system (Harbor, Field Notes, Ledger, Meadow, Night Market, Studio Mono). Use those as examples of the format.

## From a reference
1. `extract_design` on the reference: an https URL, `site:`/`app:` for something in the project, `attached:1` for a screenshot the user attached.
2. If it's a website, the result has measured colours, fonts, sizes, button style and radii. Pick the 4-6 colours that matter and give each a role. Ignore one-off colours from ads or embeds.
3. If it's a picture, the deciders describe it (background, accent family, type style, corners, density, feel). Choose exact values that match; if you can see the picture, use what you see.
4. Describe the look in your own words. Never copy logos, brand names, slogans or text. Name the system after the user's project.
5. If the project already has a `DESIGN.md`, write `DESIGN.draft.md` and `tokens.draft.css` and ask the user with `ask_user` whether to replace the current files.

## DESIGN.md format
```
---
name: <short name>
description: <one sentence: the look and what it suits>
dark: yes | no | only
---

# <name>

## Look
2-4 sentences: the image it should call up, the mood, what makes it distinctive.

## Colours
| Token | Light | Dark | Use |   (one row per token in tokens.css; Use says when to use it)

## Type
Display and body families with weights, the scale (sm, base, lg, xl, 2xl, 3xl), line-height, any letter-spacing rules.

## Spacing and shape
Spacing steps, radius, shadows (or none), max content width, grid.

## Components
Primary and secondary buttons, links, cards or panels, inputs (with the focus style), plus anything special for this kind of product (tables, event cards, project lists).

## Do and don't
3-5 concrete rules that keep the look from drifting.
```

## tokens.css format
- A first comment saying to link the file and use `var()`.
- Optional `@import` of the Google Fonts it needs, with real fallback stacks in the font tokens.
- One `:root` block with: `--bg --surface --surface-2 --fg --muted --line --accent --accent-ink` (plus `--accent-2`, `--ok --warn --bad`, `--focus` as needed), `--font-display --font-body --font-mono`, `--text-sm … --text-3xl`, `--leading`, `--space-1 … --space-6`, `--radius --radius-sm --shadow --max`.
- Dark mode: a `@media (prefers-color-scheme: dark)` block that redefines only the colour tokens (and shadow). A dark-only system sets `color-scheme: dark` in `:root` instead.
- Colours only as hex in token definitions; nothing else in the file.

## Checks before you finish
- Contrast: `--fg` on `--bg` at least 7:1, `--muted` on `--bg` and `--surface` at least 4.5:1, `--accent-ink` on `--accent` at least 4.5:1, `--accent` on `--bg` at least 3:1. Work it out; don't guess.
- No Tailwind default indigo or violet as the accent unless the reference really uses it.
- Build one small sample page that links `tokens.css` (a heading, a paragraph, a card, a button, an input) and `look` at it, so the user can see the system.
- Tell the user what you made and that they can edit it in Project settings → Design system.

## Using a design system that exists
Link `tokens.css` before your own styles and use `var(--…)` for every colour, font, radius and space. The design lint flags colours that aren't in `tokens.css`. If the design really needs a new colour, add it to both files rather than hard-coding it.
