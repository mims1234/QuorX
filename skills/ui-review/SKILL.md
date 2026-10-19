---
name: ui-review
description: Check a page, site or app like a careful reviewer before telling the user it's done.
---

# UI review

Open the thing in the browser (`artifact:<id>`, `site:<path>` or `app:<name>`), then:

1. **Console:** zero errors. A favicon 404 is fine; anything else gets fixed.
2. **Main flow:** click the primary action and type into any input. The page must respond visibly.
3. **`look` at 1280px**, with these checks (guess first):
   - "The page has a clear title or heading"
   - "The main action is clearly visible"
   - "No text is cut off, overlapping or unreadably small"
   - "Colours have enough contrast to read comfortably"
4. **`look` at 390px** (`width: 390`):
   - "Nothing overflows the screen sideways"
   - "Buttons are big enough to tap"
5. **Empty and error states:** what does it show with no data, or a wrong input?
6. **Fix what fails,** then look again. After 3 rounds on the same issue, stop and tell the user what's left.

Report in two lines: what you checked, and anything still not perfect.
