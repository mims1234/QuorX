---
name: web-app
description: Build a multi-file web app or site (HTML, CSS, JS) in the project folder that looks right on desktop and phone.
---

# Web app (vanilla HTML/CSS/JS)

1. **Start from the template** if the folder is empty: `scaffold` with `static-site`. Otherwise read `AGENT.md` and the existing files first.
2. **Structure:** `index.html` (markup only), `style.css`, `script.js`. Add more files when one passes ~300 lines.
3. **Look:** load `design-craft`. Decide the visual direction yourself (don't ask the user to pick a style, palette or font), put it in one line in your plan's spec, and say it in your reply so they can ask for another.
4. **Large files:** write the first ~300 lines with `write_file`, then `append_file` the rest in ~300-line parts. One huge write can be cut off.
5. **Layout rules:**
   - Use CSS custom properties for colours (in `:root`), and support `prefers-color-scheme`.
   - Mobile-first: no fixed widths over 100%, `max-width` containers, a 16px side gutter, and no horizontal scrolling at 390px.
   - Semantic HTML (`header`, `main`, `button`, `label`), with visible focus styles.
   - Give each main section and repeated block a short `data-qx-id` (`data-qx-id="hero"`, `"pricing"`, `"tour-card"`). When the user comments on part of the page, you get its selector, and these names keep it findable after edits.
6. **Preview:** `preview_site` with `index.html`.
7. **Check it yourself:**
   - `browser open site:index.html`, then click through the main flow.
   - `look` at 1280px and again at 390px (`width: 390`). Checks: "The main action is clearly visible", "No text is cut off or overlapping", "Nothing overflows the screen sideways".
   - Fix any console errors the browser reports, and the "fix" notes from the design lint.
8. **Record:** update `AGENT.md` with what it is, how to open it, the file map and any to-dos.
