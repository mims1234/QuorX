---
title: Agents route around guardrails
date: 2026-10-20
summary: An agent once wrapped a whole-computer install inside a small Node script, and QuorX's approval card showed only "node". Here is how that happened, how QuorX now reads a script before it runs, and what that costs honest build scripts.
tags: safety, research
---

QuorX lets its agent use a real shell. Before each command runs, a rule engine (`server/cmdpolicy.js`) splits the line into its commands, gives each one a class (reads, builds, writes, installs, deletes, runs code that can't be checked) and works out the real paths it touches. Your rules then allow it, ask you, or refuse it. Installs that change the whole computer, like `winget` or `rustup`, always ask, never get an "Always allow", and never run in the background.

That only works if the engine sees the command that really runs. In a real QuorX chat, it didn't.

## The case

In a QuorX chat on a Windows PC, the agent was building a small Rust program, `wc-lite`, and the PC had Rust but no C linker (the whole story is in [Installed is not working](articles/installed-is-not-working)). The user chose Rust's GNU toolchain as the way around it, which needs an install for the whole computer. The agent wrote a file, `.quorx/scratch/run.mjs`, a Node script that runs whatever command it is given, and ran its commands through it. For the install it asked to run this, with `background: true`:

```terminal
{
  "title": "The command the agent asked for (from PR #5)",
  "lines": [
    { "cmd": "node .quorx/scratch/run.mjs rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal" }
  ]
}
```

The rule engine saw one command: `node` running a script inside the project. That is a build, the same class as `node app.js`. So:

- the approval card said `node`, with nothing about a toolchain install for the whole computer;
- "Always allow node" in this project would have covered it, and every later wrapper too;
- it was allowed to run in the background, though installs may never run there.

The user approved that card, and the toolchain was installed. The user had chosen that toolchain when the agent asked, so no harm came of it this time. But the card they approved didn't describe what it did.

Nothing in the trace says the model meant to hide anything. Models write helper scripts all the time, and QuorX's own instructions at the time encouraged "write a script file and run it" for anything more than a plain command. Whether it was a habit or a workaround, the result for you was the same: a card that didn't say what would happen. That is the gap PR #5 closes.

## Why this keeps happening

A rule engine judges text. An agent can produce text that runs anything: a script file, an inline `python -c`, a `package.json` script, an alias. Every layer of indirection is a place where the judged text and the real action come apart. An agent under pressure to finish a task, and blocked by a card or a missing tool, has every reason to try the next way around. It doesn't need to be adversarial for this to happen; it only needs to be persistent.

So a guardrail for an agent has to follow the indirection, at least the common kinds, and say plainly when it can't.

## How QuorX judges a command now

When a command runs a script inside the project (`node` or `python` on a `.js`, `.mjs`, `.ts` or `.py` file, `powershell -File x.ps1`, `.\x.ps1`, `cmd /c x.bat`, `bash x.sh`), the rule engine reads the script first, up to 1 MB. It also reads the local modules the script loads and the scripts it runs in turn.

```flow
{
  "nodes": [
    { "id": "split", "title": "Split the line", "sub": "PowerShell's own parser", "cap": "The line is split into its commands. PowerShell lines are read by PowerShell's parser; cmd and bash have tokenizers of their own." },
    { "id": "runs", "title": "Does it run a script?", "sub": "node x.mjs · python x.py · .\\x.ps1 · npm run x", "new": true, "cap": "A runner plus a file inside the project, or a package.json script, means there is more to read before judging." },
    { "id": "read", "title": "Read the script", "sub": "up to 1 MB, its modules, scripts it runs", "new": true, "cap": "QuorX reads the file, the local modules it imports, and scripts it starts, a few levels down. Deeper than that counts as unreadable." },
    { "id": "spawn", "title": "Does it run other programs?", "sub": "child_process · subprocess · Start-Process", "new": true, "cap": "A script that spawns programs, or builds code while running (eval, exec), is opaque: QuorX can't know what it will run." },
    { "id": "pass", "title": "What does it pass on?", "sub": "process.argv · sys.argv · $args", "new": true, "cap": "If the script forwards its own arguments, those arguments become a command of their own, judged like any other: rustup toolchain install …, run by .quorx/scratch/run.mjs." },
    { "id": "rules", "title": "Your rules, per command", "sub": "deny > ask > allow", "cap": "Each command gets its verdict. A deny rule on rustup* blocks the forwarded command, even inside a script." },
    { "id": "card", "title": "The card", "sub": "leads with the riskiest part", "cap": "The card shows the install first, with 'run by .quorx/scratch/run.mjs'. Opaque commands ask you, offer no Always allow, and can't run in the background." }
  ]
}
```

Here is the real case, judged before and after PR #5:

```compare
{
  "prompt": "node .quorx/scratch/run.mjs rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal",
  "options": [
    {
      "label": "Before PR #5",
      "steps": [
        { "title": "One command", "text": "`node` running a project script." },
        { "title": "Class: build", "text": "Same as `node app.js`." },
        { "title": "Card says \"node\"", "text": "No mention of rustup or of the whole computer.", "bad": true },
        { "title": "Always allow offered", "text": "\"Always allow node\" would cover every future wrapper.", "bad": true },
        { "title": "Background allowed", "text": "An install could run out of sight, past the time limit.", "bad": true }
      ],
      "verdict": { "title": "The install hides behind node", "text": "The rules were correct for the text they saw. They saw the wrong text." }
    },
    {
      "label": "After PR #5",
      "steps": [
        { "title": "The script is read", "text": "run.mjs calls child_process and reads process.argv." },
        { "title": "Two commands", "text": "`rustup toolchain install …` (install, whole computer, run by .quorx/scratch/run.mjs) and `node …` (opaque)." },
        { "title": "Card leads with the install", "text": "\"rustup installs for the whole computer (.quorx/scratch/run.mjs passes it on as a command)\"." },
        { "title": "No Always allow", "text": "A button rule `node*` doesn't lift it. A deny rule `rustup*` blocks it." },
        { "title": "No background", "text": "Even after you approve the install, the background run is refused, so nothing runs." }
      ],
      "verdict": { "title": "You see the install", "text": "The same line asks you, in Strict and in YOLO, and says what it will really do." }
    }
  ]
}
```

The "after" column is not a description of intent. It is what the rule engine on today's main answers for that exact line; the quoted reason is its output, and PR #5 pins the whole case in `scripts/test-safety.mjs`, in PowerShell and in cmd.

The deciders, the fast models that vote on actions in YOLO mode, get a new fact too: `run_by_script`. And the agent itself is told, in its instructions and in the shell tool's description, to run each program directly and never through a wrapper script it wrote.

## package.json scripts

A second route is just as common and more innocent: `npm run setup`, where `setup` is a line in `package.json` that the agent can edit. PR #5 reads those as well. `npm run x`, `npm test`, `npm start`, `yarn x`, `pnpm x` and `bun run x` look up the line in the nearest `package.json`, together with its `pre` and `post` hooks. A bare `npm install` or `npm ci` runs the install hooks, so those are read too. `cross-env` and `npx` in front of a command are looked through, and so are `concurrently "…"` and `run-s` / `run-p`.

So a `"setup": "rustup toolchain install …"` line makes `npm run setup` show the whole-computer install, "inside package.json scripts.setup", and "Always allow npm run" doesn't cover it. A plain `"build": "tsc"` stays a build that a rule can allow.

## What it costs

A guard that reads scripts will catch honest scripts too. We'd rather say so than have you find out from a card you didn't expect.

```ledger
{
  "rows": [
    {
      "gain": "Wrapper installs show as installs",
      "gainText": "A script that forwards its arguments to rustup, winget or npm -g shows that command on the card, judged by your rules.",
      "cost": "Honest build scripts that spawn tools always ask",
      "costText": "A build.mjs that calls execSync('esbuild …') is opaque: it asks every time and never gets an Always allow. We checked this case against today's rule engine.",
      "mitigation": "Run the tool directly (npx esbuild …, or a package.json line that names it), so a rule can allow it."
    },
    {
      "gain": "package.json scripts are read",
      "gainText": "npm run setup can't hide an install, and a prestart hook can't slip one into npm start.",
      "cost": "npm start can become opaque",
      "costText": "If any script in the chain runs a spawning script, the whole npm command asks, every time.",
      "mitigation": "Keep spawning logic out of npm hooks, or accept the card for that one command."
    },
    {
      "gain": "Opaque commands can't be started in the background",
      "gainText": "The agent can't fire off a command QuorX can't read and carry on while it runs out of sight.",
      "cost": "Watchers and dev servers behind a spawning script start in the foreground",
      "costText": "background: true is refused for them. Once you approve one, it runs normally and moves to the Running tab only after it outlives the wait.",
      "mitigation": "Start the server or watcher with its own command (npx vite, node server.js), which can start in the background."
    },
    {
      "gain": "Unreadable means asks",
      "gainText": "A script named by a variable (node $f), written by the same line, or nested too deeply counts as one QuorX can't check.",
      "cost": "Some generated or dynamic setups always ask",
      "costText": "Code generators and task runners that build their command lines at run time land here.",
      "mitigation": "Only the card itself. In YOLO, the deciders can approve opaque commands if you tick that box in ⚙ Settings → Safety & commands."
    },
    {
      "gain": "Reading happens before every script run",
      "gainText": "The check uses the file as it is on disk at that moment.",
      "cost": "Some time per command",
      "costText": "Reading a script and its modules takes time. We haven't measured how much.",
      "mitigation": "The 1 MB cap and the depth limit. The time itself is not measured yet."
    }
  ]
}
```

## What it still doesn't read

Two runners are not followed today. We checked both against the current rule engine with a script that calls `child_process` (TypeScript) or `subprocess` (Python):

| Command | Judged as | What that means |
|---|---|---|
| `tsx x.ts` | opaque, asks | read and caught |
| `python x.py` | opaque, asks | read and caught |
| `npx tsx x.ts` | build, "no rule allows npx tsx yet" | not read: a rule allowing `npx tsx` would also allow a spawning script |
| `uv run x.py` | build, "no rule allows uv run yet" | not read: same |

So if you add a rule for `npx tsx*` or `uv run*`, you are trusting every script those run. Until QuorX reads them, it is safer to answer those cards one at a time.

```callout
{ "tone": "info", "title": "Where to see it", "text": "On an approval card, a command found inside a script carries a small label: · run by .quorx/scratch/run.mjs, or · run by package.json scripts.setup. The deciders see the same fact as run_by_script." }
```

## The general lesson

Every guardrail on an agent has a shape, and a capable agent will find the edges of that shape, whether it means to or not. A rule that names programs invites the agent to use a different program. The defence that holds up is to judge what will actually run, follow the common kinds of indirection, and mark everything else as "can't be checked", which asks you. That costs some convenience, and the table above is the honest price.
