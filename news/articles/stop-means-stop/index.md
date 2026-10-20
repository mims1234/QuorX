---
title: Stop means stop
date: 2026-10-20
summary: When Stop is pressed, everything the agent's command started should end, including programs that slipped away from their parent. How QuorX does that with Windows Job Objects and process groups, what the tripwire adds, and where the Running tab fits.
tags: safety, platforms, tests
---

A coding agent with a real shell starts real programs. `cargo build` starts `rustc`. `npm run dev` starts a server and a file watcher. An installer starts another installer. Some of those programs start more programs and then exit, leaving their children running with no parent.

When someone presses Stop, they mean all of it. This article is about how QuorX keeps that promise, where it can't, and how to see what is still running.

## The problem with process trees

QuorX's first Stop worked the usual way: abort the command, then run `taskkill /pid <id> /T /F`, which ends a process and its tree of children. Windows builds that tree from parent links. If a program starts a child and then exits, the child's parent link points at a process that no longer exists, so the child is no longer in anyone's tree. `taskkill /T` can't find it.

That is not a rare case. `start /b`, many installers, Gradle's daemon, `dotnet build` with node reuse, and dev servers with watchers all leave processes behind on purpose. And the old Stop never checked: it sent the kill and said "stopped".

## Windows Job Objects

Windows has a better tool for this: a **Job Object**. A job is a container for processes. Once a process is in a job, every process it starts is in that job too, however it is started and whether or not its parent is still alive. A job can be ended as a whole, and it can be asked how many processes are still in it.

QuorX runs one long-lived helper (`server/jobhost.ps1`), a PowerShell process that loads a small C# class. It holds a job for every command and server the agent starts. The order of events matters, because a command must not start anything before it is in its job:

```flow
{
  "nodes": [
    { "id": "gate", "title": "Start a gate", "sub": "jobgate.cjs, waiting", "new": true, "cap": "Each command starts as a tiny gate process that waits on its input before running anything." },
    { "id": "adopt", "title": "Put it in a fresh job", "sub": "AssignProcessToJobObject", "new": true, "cap": "The helper creates a job with KILL_ON_JOB_CLOSE and puts the gate in it." },
    { "id": "go", "title": "Tell it to go", "sub": "now the command runs", "cap": "Only now does the gate start the real command. Everything it starts from here on is inside the job." },
    { "id": "stop", "title": "Stop", "sub": "TerminateJobObject", "cap": "Pressing Stop, a time limit, or the tripwire ends the whole job at once." },
    { "id": "count", "title": "Count what is left", "sub": "every 100 ms, up to 5 s", "new": true, "cap": "QuorX asks the job how many processes are still active, until the answer is 0." },
    { "id": "report", "title": "Say what happened", "sub": "\"0 processes left\"", "cap": "The row shows \"■ stopped · 0 processes left\", or names the processes that would not stop." }
  ]
}
```

Two more things come with jobs:

- **Leftovers are ended too.** When a command finishes normally but something it started is still running (a `start /b` child, a daemon), QuorX ends it and names it in the result, so the agent knows.
- **If QuorX dies, everything dies with it.** The jobs are created with `KILL_ON_JOB_CLOSE`. If QuorX or its helper crashes, Windows closes their handles and ends every job, so no orphaned agent process keeps running on the PC.

If the helper can't start (a policy that blocks loading the C# class, for example), commands still run, and Stop falls back to the process tree. ⚙ Settings → Safety & commands says which mode is on: "Job Objects: every process, confirmed" or basic mode.

## Process groups on macOS and Linux

macOS and Linux have no Job Objects. PR #12 kept the same promise there with **process groups**: each command starts in a new session and process group of its own, so everything it starts joins that group. Stop sends `SIGTERM` to the whole group, waits up to 1.5 seconds for programs to close their files, sends `SIGKILL` to what is left, and then looks again.

A process can leave its group on purpose (a daemon calls `setsid`). QuorX follows those too: a child of anything in the job is in the job, and a process seen in the job once stays in it, checked by name so a reused process id is never touched. The one case this misses is a program that leaves the group between two looks. And if QuorX is killed, each command's gate notices its parent is gone and ends its own group.

Here is what each method catches:

```matrix
{ "src": "methods.json" }
```

"Logic tested" is honest about where this was built: on Windows. `scripts/test-posix.mjs` runs the process-group logic on Windows against simulated process lists (SIGTERM, the grace time, a daemon that left, a reused pid), and 10 of its tests need a real Mac or Linux machine to run. On one of those, `npm test` runs them.

## A stopped command, step by step

QuorX's test suite stops a command that hides a detached child, the case process trees miss. The command is `start /b ping -n 600 127.0.0.1 >nul & ping -n 600 127.0.0.1 >nul`: one `ping` started detached, one in the foreground, both set to run for about ten minutes.

```timeline
{
  "items": [
    { "when": "0 s", "title": "The gate starts", "text": "cmd is not running yet. The gate waits while the helper creates a job and puts the gate in it.", "tag": "job" },
    { "when": "0 s", "title": "The command runs", "text": "cmd starts a ping with start /b, which detaches it, and a second ping in the foreground. Both are in the job.", "tag": "command" },
    { "when": "1.5 s", "title": "Stop", "text": "The test aborts the command, the same path as pressing ■ Stop or Stop in the reply.", "tag": "stop" },
    { "when": "1.5 s +", "title": "The whole job ends", "text": "TerminateJobObject ends cmd, the foreground ping and the detached one together.", "tag": "job" },
    { "when": "then", "title": "Counted", "text": "The job reports 0 active processes. The result says mode 'jobs', 0 left, and its output contains \"0 processes left\".", "tag": "checked" },
    { "when": "after", "title": "Checked from outside", "text": "The test counts PING.EXE processes on the whole PC and expects the same number as before it started.", "tag": "checked" }
  ]
}
```

That last check has a flaw we found the hard way: it counts every `ping` on the computer. When several copies of QuorX's test suite ran on the same PC at the same time, their pings got counted together, and this test failed now and then for reasons that had nothing to do with Stop. The job's own count, "0 left", always passed. The fix is for the test to count only its own job; until then, it is run alone when it fails.

## The tripwire

Stop handles what the user can see. The tripwire handles damage that might not be noticed in time. The rule engine judges commands before they run, but it can't see what a project's own code does: a build script that deletes the wrong folder, or a bug in the program the agent just wrote.

While an agent command runs, QuorX watches the places a runaway delete would hurt most: the user profile (without busy folders like AppData), the folder around the project, and the project's `.git`. If 25 files vanish there within 3 seconds, it stops that command's job and shows what it saw, with a pointer to the Recycle Bin and Previous Versions. Both numbers are in ⚙ Settings → Safety & commands.

It fired once for the wrong reason, and that taught us something. On 20 October at 00:55 IST, during a UI test, the agent ran `rustup target add x86_64-pc-windows-gnu`. rustup unpacked the new target into a temp folder in the user profile and deleted 25 files there within 3 seconds, which tripped the wire. Those files were rustup's own, made seconds earlier. The tripwire now ignores files a command created after the watch started. A folder that already existed, moved and then deleted, still trips it, because a move keeps the folder's creation time.

```callout
{ "tone": "warn", "title": "What the tripwire is not", "text": "It reacts after the fact, to what the system's change notifications report. It stops a mass delete after about 25 files instead of letting it run to the end. It does not block a single deleted file, and on Linux it watches the home folder only one level deep, because each folder there needs a watch of its own." }
```

## The Running tab

All of this is only useful if the user can see what is running. PR #2 added a **Running** tab next to Files. It lists, grouped:

- commands that moved to the background;
- commands running now;
- the agent's own terminals (prompts, menus, interactive programs);
- dev servers;
- the user's own terminal tabs.

Each row says who started it (the agent, from which chat, or the user), how long it has run, and its last lines of output. Each has **■ Stop**, which ends it and everything it started, through the same job. **■ Stop all** asks first, then stops everything except the user's terminal tabs. If the user stops something the agent started while its reply is still working, the agent is told before its next step and carries on without it.

The same PR changed what happens at the time limit. A command that outlives the wait now moves to the background instead of being killed, so a long build or install isn't thrown away halfway. It keeps its job and its tripwire, and it shows up in the Running tab, where it can be stopped.

## What to expect from Stop

On Windows with the job helper running, Stop ends every process the command started and says how many are left, normally 0. If something refuses to end in 5 seconds, the row names it. On macOS and Linux the same promise holds through process groups, built and checked by logic on Windows and waiting for testers on real machines. In basic mode, the row says that detached processes may survive, so there is a reason to check.
