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
