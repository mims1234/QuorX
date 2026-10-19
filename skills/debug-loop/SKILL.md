---
name: debug-loop
description: Find and fix a bug in any language or kind of app by reproducing it first, changing as little as possible, and proving the fix.
---

# Debug loop

1. **Reproduce:** do exactly what failed, with the check that fits the app:
   - a web page: open it with the browser tool and read the console errors and what's on screen;
   - a CLI, library or service: run the failing command or test with `shell` (`cargo test name`, `dotnet test --filter X`, `pytest -k x`, `go test -run X`);
   - a build error: run the build and read the first error, not the last.
   If you can't reproduce it, ask the user one precise question.
2. **Read the trace:** go to the file and line the first error names. Long output is in the log file the shell tool reports: search it with `search_files` instead of guessing.
3. **Hypothesis:** one sentence: "X happens because Y." If two causes are plausible, test the cheaper one first. Add a print or log line to check it if you're unsure.
4. **Smallest fix:** use `edit_file` with an exact find/replace. Don't rewrite whole files to fix one bug.
5. **Prove it:** repeat step 1. The error is gone, the behaviour is right, and nothing new broke (run the tests). Use `look` if it's visual.
6. **Guard:** if the bug could come back (bad input, missing file), add a check or a clear error message, and a test when the project has tests.
7. **Record:** add a one-line entry to the to-dos or decisions in `AGENT.md` if it matters later.

Never "fix" a failing test by deleting or weakening it. If a test is wrong, say why in your reply.

Common causes:
- JS/TS: module type mix-ups (`require` vs `import`), a hard-coded port instead of `process.env.PORT`, a script loaded before the DOM exists (use `defer`), a stale cached file
- Python: the wrong interpreter or virtual environment, a missing `__init__.py`, relative imports run as a script
- Rust: borrow errors (read rustc's suggestion: it is usually right), a feature flag that isn't enabled
- C#/.NET: a build that seems to hang (MSBuild node reuse; QuorX sets `MSBUILDDISABLENODEREUSE=1`), the wrong target framework
- C/C++: a stale CMake cache (delete the build folder with `delete_file`), headers vs. link errors
- Go: an unused import or variable is an error, the module path in `go.mod`
- Any language: the wrong working folder (pass `cwd`), a path with spaces not quoted, Windows `\` vs `/`
