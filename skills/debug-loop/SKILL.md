---
name: debug-loop
description: Find and fix a bug by reproducing it first, changing as little as possible, and proving the fix.
---

# Debug loop

1. **Reproduce:** open the page or app in the browser and do exactly what the user did. Note the console errors and what's on screen. If you can't reproduce it, ask the user one precise question.
2. **Locate:** use `search_files` for the function, element id or error text. Read only the files involved.
3. **Hypothesis:** one sentence: "X happens because Y." If two causes are plausible, test the cheaper one first.
4. **Smallest fix:** use `edit_file` with an exact find/replace. Don't rewrite whole files to fix one bug.
5. **Prove it:** repeat step 1. The error is gone and the behaviour is right. Use `look` if it's visual.
6. **Guard:** if the bug could come back (bad input, missing element), add a check or a clear error message.
7. **Record:** add a one-line entry to the to-dos or decisions in `AGENT.md` if it matters later.

Common causes:
- module type mix-ups (`require` vs `import`)
- a hard-coded port instead of `process.env.PORT`
- a script loaded before the DOM exists (use `defer`)
- the wrong path to a file
- a stale cached file (reload the preview)
