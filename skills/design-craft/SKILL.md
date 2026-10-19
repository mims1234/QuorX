---
name: design-craft
description: Make a page, site or app look designed by a person, not generated - pick a direction, then type, colour, layout, states and accessibility.
---

# Design craft

Use this for anything with a visible interface: landing pages, tools, dashboards, games' menus and HUDs. The harness's design lint points out the worst patterns after each write; this skill is how to avoid them in the first place. (Adapted from OpenDesign's craft rules, Apache-2.0, and refero_skill, MIT.)

## 1. Commit to one direction first
- **Decide the visual direction yourself.** Don't ask the user to pick a style, palette or font, and don't offer "which of these feels right?" lists. Choosing is part of the job.
- Order of sources: what the user said > the project's existing styles (read its CSS or `DESIGN.md` if there is one) > your own choice from the subject, audience and tone.
- Write the direction in one line in your plan's spec (for example "warm paper background, serif headings, one rust accent, dense editorial layout"), then build against it. Say it in your reply too, so the user can ask for another.
- One direction that is a real bet beats a safe mix. Don't hedge with "or we could…" alternatives.

## 2. Tokens before rules
- Put the palette in `:root` custom properties: `--bg`, `--surface`, `--fg`, `--muted`, `--line`, `--accent`, plus semantic `--ok`, `--warn`, `--bad` when needed. Every rule uses `var()`. Keep it to about 12 colours.
- Pick neutrals with a slight tint toward the accent; pure grey looks unconsidered.
- Support dark mode by redefining the tokens under `prefers-color-scheme`, never by styling components twice.

## 3. Typography
- Two families at most: a display face with character for headings, a readable body face. Inter, Roboto and system-ui are fine for body text but generic for headings.
- Set a type scale (for example 14 / 16 / 20 / 28 / 40) and stick to it. Body 16px, line-height about 1.5, lines about 65 characters wide.
- Headings get `text-wrap: balance`. Uppercase labels get `letter-spacing: 0.06em` or more.
- Numbers that line up in columns get `font-variant-numeric: tabular-nums`.

## 4. Colour
- One accent, used for the main action and at most one or two other places per screen. If everything is accented, nothing is.
- Avoid the stock AI looks: Tailwind indigo/violet (`#6366f1`, `#4f46e5`, `#7c3aed`…), a purple-to-blue hero gradient, and neon on near-black. Use them only if the user asks.
- Text contrast at least 4.5:1 (3:1 for large text). Never rely on colour alone for state: add an icon or a word.

## 5. Layout
- Use grid or flex with `gap` for spacing, not margins on every element.
- Vary the page. "Hero, three feature cards, pricing, FAQ, CTA" with nothing else is the template skeleton: give at least one section its own shape (a full-width quote, a comparison table, a small live demo).
- Cards only where something is a separate object. Not every block needs a border, radius and shadow. Skip the rounded card with a coloured left border.
- Mobile first: works at 390px with a 16px gutter and no sideways scroll.

## 6. Content
- Real words for this subject. No lorem ipsum, "Feature one", "Your tagline here".
- No invented numbers ("10x faster", "99.9% uptime", "50,000+ customers"). Use figures the user gave you, or label them as examples.
- Icons: simple line SVG in `currentColor` (stroke about 1.75px), not emoji, unless the user wants emoji.
- Pictures: no placeholder image sites (Unsplash, picsum, placehold.co). Use a CSS or SVG placeholder, or make a picture if the user wants one.

## 7. States and accessibility
- Design the empty, loading and error states, not only the full one. An error says what went wrong and how to fix it.
- Every input has a `<label>`, every image has `alt` (`alt=""` for decoration), buttons are `<button>`.
- Keep a visible focus style: if you remove `outline`, add a `:focus-visible` style. Check that Tab reaches every control in order.
- Respect `prefers-reduced-motion`. Motion should explain a change, not decorate.
- Tap targets at least 40px on phones.

## 8. Check
- After building, `look` at 1280px and 390px with checks like "The page has one clear main action", "Headings and body text use different, deliberate type", "Nothing is cut off or overlapping".
- Read the design lint notes in your tool results and fix the "fix" ones unless the user asked for that pattern.
