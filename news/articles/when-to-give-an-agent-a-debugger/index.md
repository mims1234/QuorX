---
title: When to give an agent a debugger
date: 2026-10-20
summary: QuorX's agent can now set breakpoints and read variables in nine languages on Windows. It only gets that debugger after plain debugging has failed. Here is why, how the debug tool works, and how much of it is proven on a real PC.
tags: platforms, research, tests
---

A debugger seems like an obvious tool to give a coding agent. A person stuck on a bug sets a breakpoint, looks at the variables, and sees what the program actually does instead of guessing. An agent can do the same: QuorX's `debug` tool starts a program paused, sets breakpoints, steps, and reads the stack and the local variables.

But QuorX doesn't hand the agent that tool at the start of a reply. By default, the agent first has to try the plain way, and the debugger opens only after that has failed. This article explains that choice, what the debugger covers now, and what we have and haven't proven.

## The evidence is mixed

The research we based this on is public. In **debug-gym** ([arXiv 2503.21557](https://arxiv.org/pdf/2503.21557)), a benchmark where agents fix bugs in Python programs, a strong model in that study solved more tasks with Python's debugger available: 37.2% without it, 48.4% with it from the start, and 52.1% when it was unlocked only after five failed attempts to fix the code. Weaker models in the same study did somewhat worse when they were given the debugger from the start.

Two readings follow from that, and QuorX acts on both:

1. **A debugger helps most when the cheap approach has failed.** Reading the error, opening the file at the line it names and adding a print statement solves most bugs faster and with fewer steps. A debugger session costs many tool calls: start, break, continue, read the state, step, read again.
2. **A debugger can distract a weaker model.** Given the tool from the start, a model can spend its steps driving the debugger instead of reading the code. QuorX is built to run on cheap models, so this risk matters more here than for a harness that always uses the strongest model.

We have not measured either effect inside QuorX. The gate below is a reasonable reading of outside research, and it is a setting you can change.

## The gate

When the agent asks to start or attach the debugger, QuorX checks whether it has "earned" it in this reply. It has when any of these is true:

- two tool calls in this reply came back with an error;
- QuorX's compiler checks sent the work back to be fixed;
- the reviewer sent the build back;
- or you set the debugger to **Always** in ⚙ Settings → Safety & commands.

Otherwise the tool answers: *"Not yet: reproduce the bug, read the error's file and line, and add a print or log line to test your guess first. The debugger opens after a couple of failed tries (the user can turn it on for every reply)."*

The setting has three values: **After failed tries** (the default), **Always** and **Off**. Our gate is looser than debug-gym's "after five failed attempts": two errors are enough. That threshold is a judgment call; we have not measured which number works best.

## How the debug tool works

```flow
{
  "nodes": [
    { "id": "ask", "title": "The agent asks to debug", "sub": "debug start src/main.rs", "cap": "The source file picks the language. For compiled languages the agent can also name the built program." },
    { "id": "gate", "title": "Has it earned it?", "sub": "2 errors · a check or review sent back", "new": true, "cap": "If not, the tool says what to try first. The setting can make the debugger always available, or turn it off." },
    { "id": "card", "title": "The real command is judged", "sub": "approval card", "cap": "The command the debug session runs (cargo build, dlv dap, the venv's python) goes through the same rules as any shell command. If it needs your approval, you see it." },
    { "id": "job", "title": "The adapter runs as a job", "sub": "Running tab · Stop ends it", "cap": "The debugger and the program run as one of the agent's background jobs, inside a Windows Job Object (a process group on macOS and Linux). Stop ends both." },
    { "id": "paused", "title": "Paused before the first line", "sub": "Debug Adapter Protocol", "new": true, "cap": "QuorX speaks the Debug Adapter Protocol to whatever adapter the language's pack starts: initialize, launch or attach, then wait." },
    { "id": "break", "title": "Breakpoints, then continue", "sub": "break file:line · continue", "cap": "Breakpoints go in before the program starts. Continue runs to the next one; if the program is waiting for a click, it waits for the breakpoint." },
    { "id": "state", "title": "Read where it stopped", "sub": "state · eval", "cap": "The stack, the local variables of the top frame, and any program output since the last look. eval runs an expression in that frame." },
    { "id": "stop", "title": "Stop", "sub": "everything ends", "cap": "The session, the adapter and the program end together, and the Running tab drops the row." }
  ],
  "loops": [{ "from": "state", "to": "break", "label": "step, or set the next breakpoint" }]
}
```

Two details matter for safety and for your attention:

- **The debugger is not a back door.** Starting a session runs a real command: a build, an adapter, the program. That command is judged by the same rule engine as everything else, and the card shows it. When Delve is missing, for example, the agent can offer `go install …dlv@latest`, which installs into your Go folder for every project, so it asks you.
- **Debugging stops by itself where a program fails.** Delve stops on an unrecovered panic, LLDB on a crash, and Rust programs on every panic. A crash shows where it happened, even with no breakpoint there.

## What it covers now

When PR #3 merged on 20 October, the debug tool knew two languages: Node, through V8's inspector, and Python, through debugpy. PR #3 had just rebuilt the Debug Adapter Protocol client so any adapter can plug in. Five pull requests added seven more languages on Windows and Linux, and a sixth added Swift and Objective-C for Macs.

```chart
{ "src": "debuggers.json", "path": "chart" }
```

Counted from `debugLanguages()` in `server/debugger.js` at commit 0174105 (the PR #3 merge) and today. Linux has the same nine as Windows; a Mac adds Swift and Objective-C.

Some of these needed more than plugging in:

- **Java and Kotlin** had no adapter that is easy to install. Microsoft's Java debugger runs only as a plugin inside an Eclipse language server. QuorX ships a small adapter of its own, written against the JDK's debugger interface, which the JDK runs straight from its source file. If you have a JDK, you have the debugger.
- **Dart** only speaks the protocol over its own input and output. QuorX runs it behind a small bridge that listens on the session's port, as part of the same job, so Stop still ends it. The same bridge works for `lldb-dap` in that mode.
- **Electron** is attached to: the agent starts the app with `--inspect` as a background job and attaches to its main process. Stopping the session then only disconnects; the app keeps running until you or the agent stop it.

## What is proven, and what isn't

Not every debugger has run against a real toolchain on the Windows PC these tests ran on. Here is where each one stands, from each PR's "tested here" section:

```matrix
{ "src": "debuggers.json", "path": "matrix" }
```

"Logic tested" means QuorX's side ran for real against a stand-in adapter or recorded output: the launch command, the breakpoints, continue, reading variables, and Stop. It does not prove that the real adapter, at the version you have, behaves the same way. If you have one of those toolchains, `npm run test:packs` runs that pack's self-test on your computer without a key, and the **Pack test report** issue template takes the result.

## Known limits

- **MSVC builds on Windows.** A program built by MSVC keeps its debug information in a `.pdb` file. LLDB reads it, so breakpoints, the stack and plain variables work, but C++ library containers and Rust's `String` and `Vec` can show raw fields.
- **A paused window can't answer.** While a GUI program is stopped at a breakpoint, its window can't respond to clicks or screenshots. The desktop tool now says "paused at a breakpoint" instead of waiting 20 seconds.
- **The settings label is behind.** In ⚙ Settings → Safety & commands the row is still called "Debugger for Node and Python". The setting applies to every language above.

```callout
{ "tone": "info", "title": "If you want the debugger every time", "text": "Set ⚙ Settings → Safety & commands → Debugger to Always. That makes sense with a strong model on a hard bug. With a cheap model, try the default first: the research suggests it can do worse with the debugger from the start, and every debugger step is a model call you pay for." }
```

## The general point

Giving an agent a tool is not free. Each tool adds to what the model has to choose between, and a powerful tool used too early can cost more steps than it saves. For a debugger, the outside evidence says "late, and for the stronger models". QuorX makes "late" the default, tells the agent what to try first, and leaves the switch with you.
