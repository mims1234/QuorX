# Contributing to QuorX

Thank you for helping. Bug reports, platform pack test reports, docs fixes and code are all welcome.
By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through
[private reporting](SECURITY.md), not public issues.

## Set up

You need [Node.js](https://nodejs.org/) 20 or newer (CI uses 22) and Git.

```bash
git clone https://github.com/mims1234/QuorX.git
cd QuorX
npm ci
npm start
```

`npm start` runs QuorX in your browser. For the desktop app, run `npm run desktop:setup` once, then `npm run desktop`.
[Getting started](docs/GETTING-STARTED.md) covers signing in and where your data lives.

## Run the tests

```bash
npm test
```

The tests drive the agent with a scripted model: no OpenRouter key, no network calls to a model, no cost. They write
into a throwaway data folder, never into your own chats and projects. Some tests need macOS or Linux and skip on
Windows. [Testing](docs/TESTING.md) has the details, the UI tests (`npm run test:ui`) and the platform pack tests.

On Windows, the desktop-tool tests open real windows and send keystrokes, so `npm test` skips them on your PC. When
a change touches the desktop tool, run them on their own with `npm run test:desktop` (about a minute and a half) and
leave the mouse and keyboard alone meanwhile. CI runs them on every pull request.

Every pull request runs the same suites on Windows, and the macOS and Linux tests on Linux. A pull request merges only
when they pass.

## Pull requests

1. Fork the repository and make a branch from `main`.
2. Keep each pull request to one change. Add or update a test when you change behaviour.
3. Run `npm test` before you push.
4. Open the pull request against `main` and fill in the template, including its **What's new** line: one sentence a
   user would understand, or "none" for changes users won't notice.

`main` is protected: changes reach it only through pull requests, and each one is squash-merged into a single commit,
so the history stays linear. You don't need to tidy your branch's commits; the pull request title becomes the commit
message, so make it say what changed.

Please don't edit `news/updates.json` or the version numbers: they're written when a release is made.

## Pack test reports

Platform packs teach QuorX a toolchain (Android, .NET, Go, Rust and more). If you have a toolchain installed, you can
check its pack on your computer, with no key:

```bash
npm run test:packs
```

To test one pack, add `-- --pack <id>` (for example `npm run test:packs -- --pack rust`). It writes
`pack-test-report.md`. Open a [Pack test report](https://github.com/mims1234/QuorX/issues/new?template=pack-test-report.md)
issue and paste the report in, or paste it into the pack's pull request. Reports from failed runs help too.

## Licence

QuorX is under the [Apache License 2.0](LICENSE). Contributions are accepted under the same licence: by opening a pull
request, you agree that your change is licensed under it.
