# Testing

[← Back to the README](../README.md)

```bash
npm test
```

The agent loop driven by a scripted model (no network, no cost), security, the rule engine and the rest of the
safety layer, macOS and Linux paths, and the News format. On Windows some of them skip because they need macOS or
Linux. A few tests count real processes or wait on a terminal; on a busy PC, rerun a failing `stop: …` or
`terminal: …prompts` test alone.

```bash
npm run test:desktop
```

The desktop tool's tests on Windows: they open real windows (a WinForms app, a Save dialog), click, type and take
pictures, so they use the screen and the keyboard for about a minute and a half. `npm test` skips them on a PC (they
show as skipped with "opens windows"); CI runs them on every pull request. Run them when a change touches the desktop
tool, and leave the mouse and keyboard alone until they finish: a key pressed meanwhile can land in their windows.

```bash
npm run test:packs
```

Runs every platform pack self-test your computer can run, with no OpenRouter key, and writes `pack-test-report.md`.
Packs whose toolchain is missing are listed with what they need. To test one pack, add `-- --pack <id>`.
**Anyone with a toolchain can help:** paste the report into the pack's pull request, or open a "Pack test report"
issue.

```bash
npm run test:ui
```

Starts the desktop app from this checkout with its own data folder and port, drives the window the way a person
would, and saves a screenshot of every step with an HTML report. `-- --scenario settings` needs no key.

How the tests are organised, and what they cover, is in [the report's testing section](REPORT.md#testing).
