// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The guards around running work: the delete tripwire, budgets, background jobs, loops, the terminal, packages,
// debugging, folders outside the project and chat notes.
import './test-home.mjs';
import { WIN, tmp, reply, agentRun, of, toolOut } from './safety-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLine } from '../server/workspace.js';
import { decide, saveRules, loadRules, ruleMatches, ruleProblem, addRule, updateRule, removeRule } from '../server/cmdpolicy.js';
import { approvalJudge } from '../server/approvals.js';
import { SAFETY_DEFAULTS, safetySettings, yoloOf } from '../server/safety.js';
import { answerApproval, raiseCap, answerQuestion } from '../server/agent.js';
import { startTripwire } from '../server/tripwire.js';
import { termStop } from '../server/agentterm.js';
import { saveProject, forgetProject } from '../server/store.js';
import { packagesOf, checkPackages } from '../server/pkgguard.js';
import { readAudit } from '../server/audit.js';
import { parseHierarchy, hierarchyText } from '../server/android.js';

// ---------- the rule engine ----------
const proj = tmp('policy');
fs.writeFileSync(path.join(proj, 'a.txt'), 'x');
fs.mkdirSync(path.join(proj, 'dist'));
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(proj, 'dist', `f${i}.js`), '');
const RULES = [{ effect: 'allow', match: 'cargo build*', by: 'button', scope: 'project' }];
const ctx = (over = {}) => ({ shell: 'powershell', root: proj, rules: RULES, mode: 'strict', yolo: {}, ...over });

// ⚡ YOLO (⚙ Approvals & safety): what runs on its own, what the deciders vote on, what pauses for you, what never runs.
// decide() only: none of these commands runs.
const YOLO = { checkAll: yoloOf(safetySettings({ yoloLevel: 'careful' })), checkBuilds: yoloOf(safetySettings({ yoloLevel: 'balanced' })), defaults: yoloOf(safetySettings({})) };

// ---------- commands hidden in scripts ----------
// The real case: the agent wrote a Node script that runs whatever it is given, then ran a toolchain install through it.
const WRAPPER = "import { spawn } from 'node:child_process';\nconst [cmd, ...args] = process.argv.slice(2);\nspawn(cmd, args, { stdio: 'inherit', shell: true }).on('exit', (c) => process.exit(c ?? 1));\n";
const REAL = 'node .quorx/scratch/run.mjs rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal';
const scripts = tmp('scripts');
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(scripts, rel)), { recursive: true }); fs.writeFileSync(path.join(scripts, rel), text); };
put('.quorx/scratch/run.mjs', WRAPPER);
put('app.js', "const name = process.argv[2] || 'world';\nconsole.log(`hello ${name}`);\n");
put('wrap.py', 'import subprocess, sys\nsys.exit(subprocess.call(sys.argv[1:]))\n');
put('open.ps1', "Write-Host 'opening'\nStart-Process notepad.exe\n");
put('setup.ps1', "Write-Host 'setting up'\nwinget install --id Rustlang.Rustup -e\n");
put('tools/main.mjs', "import { run } from './helper.mjs';\nrun(process.argv.slice(2));\n");
put('tools/helper.mjs', "import { execFileSync } from 'child_process';\nexport const run = ([c, ...a]) => execFileSync(c, a);\n");
const sctx = (over = {}) => ({ shell: 'powershell', root: scripts, rules: [], mode: 'strict', yolo: {}, ...over });

// The real case from a video run: the agent's render script runs ffmpeg and ffprobe, named in plain text.
put('.quorx/scratch/render.mjs', [
  "import { execFileSync, spawnSync as probe } from 'node:child_process';",
  "const SHOTS = [{ src: 'assets/a.png', dur: 3 }];",
  "for (const s of SHOTS) execFileSync('ffmpeg', ['-y', '-loop', '1', '-i', s.src, '-t', String(s.dur), `clips/${s.dur}.mp4`], { stdio: 'inherit' });",
  "probe('ffprobe', ['-v', 'error', 'out.mp4']);",
].join('\n'));
put('.quorx/scratch/req.cjs', "const cp = require('child_process');\ncp.execFileSync('ffmpeg', ['-version']);\n");
put('.quorx/scratch/push.mjs', "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['push', '--force']);\n");
const OPAQUE_SHAPES = {
  'from a variable': "import { execFileSync } from 'node:child_process';\nconst p = process.argv[2];\nexecFileSync(p, []);\n",
  'shell mode': "import { spawn } from 'node:child_process';\nspawn('ffmpeg', ['-i', 'a.png'], { shell: true });\n",
  'an interpreter': "import { execFileSync } from 'node:child_process';\nexecFileSync('cmd', ['/c', 'del', 'x']);\n",
  'computed arguments for git': "import { execFileSync } from 'node:child_process';\nconst a = ['status'];\nexecFileSync('git', a);\n",
  'the function passed around': "import { execFileSync } from 'node:child_process';\nconst run = execFileSync;\nrun('ffmpeg', []);\n",
  'exec with a shell line': "import { execSync } from 'node:child_process';\nexecSync('ffmpeg -version');\n",
  'a dynamic import': "const cp = await import('node:child_process');\ncp.execFileSync('ffmpeg', []);\n",
};
for (const [k, v] of Object.entries(OPAQUE_SHAPES)) put(`.quorx/scratch/shape-${k.replace(/\W+/g, '-')}.mjs`, v);

// package.json scripts: npm run x runs a command line the agent can write.
put('web/package.json', JSON.stringify({ scripts: {
  setup: 'rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal', build: 'tsc', prestart: 'node tools/main.mjs', start: 'node app.js',
  wrap: 'node ../.quorx/scratch/run.mjs', dev: 'concurrently "tsc -w" "npm:setup"', env: 'cross-env NODE_ENV=production winget install Git.Git',
  postinstall: 'choco install nodejs', a: 'npm run b', b: 'npm run a' } }));
put('web/tools/main.mjs', "import { execFileSync } from 'node:child_process';\nexecFileSync(process.env.GIT || 'git', ['--version']);\n");
put('web/app.js', "console.log('up')\n");

// ---------- the hardened deciders ----------
// A fake Decisions endpoint: each model answers P(yes) per question from `table`, or fails.
async function withDeciders(table, fn) {
  const real = globalThis.fetch, bodies = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/decisions')) return real(url, init);
    const b = JSON.parse(init.body); bodies.push(b);
    const row = table[b.model];
    if (!row) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(b.questions).map((k) => [k, { noul: row[k] }])), usage: { cost: 0.0001 } }));
  };
  try { return await fn(bodies); } finally { globalThis.fetch = real; }
}
const judge = (over = {}) => approvalJudge({ kind: 'command', userMessages: ['build my rust app'], facts: { command: 'cargo build' }, voters: ['a', 'b', 'c'], chatModel: 'chat', sf: SAFETY_DEFAULTS, ...over });

// ⚡ YOLO with a wait: a vote the deciders can't settle shows you the card for a few seconds, then carries on.
const voteAll = (v) => Object.fromEntries(['typesafe/jev-1.14', 'liquid/d1-ultra', 'openai/gpt-6-luna-decisions'].map((m) => [m, v]));

// ⚖️ Deciders off in a chat: no command goes to a vote. What they'd check first waits for you (or runs, if set);
// what they'd approve in your place always waits for you. No answer in time skips it.
const buildJs = (d) => fs.writeFileSync(path.join(d, 'build.js'), "console.log('built')");

// ---------- tripwire ----------
test('tripwire: files vanishing next to the project trip it, a moved-then-deleted folder too, and an agent command is stopped part-way', { skip: !WIN }, async () => {
  { // tripwire: many files vanishing next to the project trips it
    const parent = tmp('tw');
    const project = path.join(parent, 'proj'); fs.mkdirSync(project);
    const other = path.join(parent, 'other'); fs.mkdirSync(other);
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(other, `f${i}.txt`), 'x');
    let tripped = null;
    const stop = startTripwire({ root: project, files: 25, seconds: 3, onTrip: (t) => { tripped = t; } });
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 40; i++) fs.rmSync(path.join(other, `f${i}.txt`));
    await new Promise((r) => setTimeout(r, 800));
    stop();
    assert.ok(tripped, 'the tripwire fired');
    assert.ok(tripped.count >= 25);
    assert.ok(tripped.sample.every((p) => p.includes('other')));
  }
  { // tripwire: moving a folder that was already there and then deleting it still trips it
    const parent = tmp('tw4');
    const project = path.join(parent, 'proj'); fs.mkdirSync(project);
    const docs = path.join(parent, 'docs'); fs.mkdirSync(docs);
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(docs, `f${i}.txt`), 'x');
    await new Promise((r) => setTimeout(r, 400)); // the folder is older than the watch
    let tripped = null;
    const stop = startTripwire({ root: project, files: 25, seconds: 3, onTrip: (t) => { tripped = t; } });
    await new Promise((r) => setTimeout(r, 300));
    const moved = path.join(parent, 'moved'); fs.renameSync(docs, moved);
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 40; i++) fs.rmSync(path.join(moved, `f${i}.txt`));
    await new Promise((r) => setTimeout(r, 800));
    stop();
    assert.ok(tripped, 'the tripwire fired');
  }
  { // tripwire: an agent command deleting next to the project is stopped part-way
    let sibling;
    const { bodies, events } = await agentRun((b, i) => [reply('', [['shell', { command: 'node del.js' }]]), reply('Stopped.')][i], {
      prep: (d) => {
        sibling = path.join(path.dirname(d), `${path.basename(d)}-sibling`); fs.mkdirSync(sibling);
        for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(sibling, `f${i}.txt`), 'x');
        fs.writeFileSync(path.join(d, 'del.js'), `const fs=require('fs'),p=require('path'),dir=${JSON.stringify(sibling)};let i=0;const t=setInterval(()=>{if(i>=200){clearInterval(t);return;}fs.rmSync(p.join(dir,'f'+(i++)+'.txt'))},15);`);
        fs.mkdirSync(path.join(d, '.quorx'), { recursive: true });
        saveRules('project', [{ effect: 'allow', match: 'node del.js*', by: 'user' }], d);
      },
    });
    assert.match(toolOut(bodies, 1), /tripwire STOPPED this command/);
    assert.ok(events.some((e) => e.t === 'tripwire'));
    const left = fs.readdirSync(sibling).length;
    assert.ok(left > 50, `most files survive (${left} of 200 left)`);
  }
});

test('tripwire: deletes inside the project, and files a command makes and then removes, do not trip it', { skip: !WIN }, async () => {
  { // tripwire: deletes inside the project do not trip it
    // Its own parent folder: other test files clean up their temp folders in %TEMP% at the same time.
    const project = path.join(tmp('tw2'), 'proj'); fs.mkdirSync(project);
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(project, `f${i}.txt`), 'x');
    let tripped = null;
    const stop = startTripwire({ root: project, files: 25, seconds: 3, onTrip: (t) => { tripped = t; } });
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 40; i++) fs.rmSync(path.join(project, `f${i}.txt`));
    await new Promise((r) => setTimeout(r, 800));
    stop();
    assert.equal(tripped, null);
  }
  { // tripwire: files a command makes and then removes (installer temp folders) do not trip it
    const parent = tmp('tw3');
    const project = path.join(parent, 'proj'); fs.mkdirSync(project);
    let tripped = null;
    const stop = startTripwire({ root: project, files: 25, seconds: 3, onTrip: (t) => { tripped = t; } });
    await new Promise((r) => setTimeout(r, 300));
    // Unpack-then-clean, the way rustup and other installers work: a temp folder full of files, slowly and all at once.
    const unpack = path.join(parent, 'tmp-unpack'); fs.mkdirSync(unpack);
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(unpack, `f${i}.txt`), 'x');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(unpack, { recursive: true });
    // And loose files made and removed at once, before the watcher's notices are handled.
    for (let i = 0; i < 40; i++) { const f = path.join(parent, `t${i}.tmp`); fs.writeFileSync(f, 'x'); fs.rmSync(f); }
    await new Promise((r) => setTimeout(r, 800));
    stop();
    assert.equal(tripped, null);
  }
});

// ---------- budgets ----------
const costly = (calls) => ({ ...reply('', calls), usage: { cost: 0.4 } });

test('budget: in YOLO a reply stops at its cap, counting every call; in Strict the cap asks and raising it carries on', async () => {
  { // budget: in YOLO a reply stops at its cap, counting every call
    const { events } = await agentRun(() => costly([['list_files', {}]]), { settings: { approval: 'yolo', replyBudget: 1 } });
    const done = events.find((e) => e.t === 'done');
    assert.match(done.reply, /reached its \$1\.00 cap/);
    assert.ok(events.filter((e) => e.t === 'llm_done' || e.t === 'tool').length < 20, 'it stopped early');
  }
  { // budget: in Strict the cap asks; raising it lets the reply carry on
    let asked = 0;
    const { events } = await agentRun((b, i) => (i < 4 ? costly([['list_files', {}]]) : reply('Done.')), {
      settings: { approval: 'strict', replyBudget: 1 },
      onEvent: (e, id) => { if (e.t === 'budget_ask' && e.kind === 'reply') { asked++; setTimeout(() => raiseCap(id, e.id, 5), 10); } },
    });
    assert.equal(asked, 1);
    assert.equal(events.find((e) => e.t === 'done').reply, 'Done.');
    assert.ok(events.some((e) => e.t === 'budget_done' && e.raised && e.budget === 5));
  }
});

// ---------- background jobs (P1) ----------
test('jobs: a long build moves to the background instead of being killed, and job_output follows it', { skip: !WIN }, async () => {
  const { bodies } = await agentRun((b, i) => [
    reply('', [['shell', { command: 'node slow.js' }]]),
    reply('', [['job_output', { job: toolOut([b], 0)?.match(/job (bg\d+)/)?.[1] || 'bg1', wait_s: 10 }]]),
    reply('Done.'),
  ][i], {
    settings: { safety: { timeout: 5 } },
    prep: (d) => {
      fs.writeFileSync(path.join(d, 'slow.js'), "console.log('start'); setTimeout(() => console.log('finished'), 7000)");
      fs.mkdirSync(path.join(d, '.quorx'), { recursive: true });
      saveRules('project', [{ effect: 'allow', match: 'node slow.js*', by: 'user' }], d);
    },
  });
  assert.match(toolOut(bodies, 1), /continues in the background as job bg\d+/);
  assert.match(toolOut(bodies, 2), /ended, exit code 0[\s\S]*finished/);
});

test('jobs: background: true returns at once and job_stop ends it', { skip: !WIN }, async () => {
  const { bodies } = await agentRun((b, i) => [
    reply('', [['shell', { command: 'node forever.js', background: true }]]),
    reply('', [['job_stop', { job: toolOut(b ? [b] : [], 0)?.match(/job (bg\d+)/)?.[1] || 'bg2' }]]),
    reply('Done.'),
  ][i], {
    prep: (d) => {
      fs.writeFileSync(path.join(d, 'forever.js'), "console.log('up'); setInterval(() => {}, 1000)");
      fs.mkdirSync(path.join(d, '.quorx'), { recursive: true });
      saveRules('project', [{ effect: 'allow', match: 'node forever.js*', by: 'user' }], d);
    },
  });
  assert.match(toolOut(bodies, 1), /Started in the background as job (bg\d+)[\s\S]*up/);
  assert.match(toolOut(bodies, 2), /0 processes left|already/);
});

test('jobs: installs never move to the background, even hidden in a wrapper script', { skip: !WIN }, async () => {
  { // jobs: installs never move to the background, and say so before any card
    let cards = 0;
    const { bodies } = await agentRun((b, i) => [reply('', [['shell', { command: 'npm install left-pad', background: true }]]), reply('OK.')][i], { settings: { approval: 'strict' },
      onEvent: (e, id) => { if (e.t === 'approval' && e.mode === 'strict') { cards++; setTimeout(() => answerApproval(id, e.id, { approve: true }), 10); } } });
    assert.match(toolOut(bodies, 1), /installs can’t run in the background/);
    assert.equal(cards, 0, 'no card for a command that would be refused anyway');
  }
  { // jobs: an install hidden in a wrapper script never runs in the background
    let card = null;
    // The wrapper only prints what it was given, so nothing is installed even if this check ever failed.
    const echo = "import { spawn } from 'node:child_process';\nconsole.log('would run', process.argv.slice(2).join(' '));\n";
    const { bodies, events } = await agentRun((b, i) => [reply('', [['shell', { command: REAL, background: true }]]), reply('OK.')][i], {
      prep: (d) => { fs.mkdirSync(path.join(d, '.quorx', 'scratch'), { recursive: true }); fs.writeFileSync(path.join(d, '.quorx', 'scratch', 'run.mjs'), echo); },
      onEvent: (e, id) => { if (e.t === 'approval' && e.mode === 'strict') { card = e; setTimeout(() => answerApproval(id, e.id, { approve: true }), 10); } },
    });
    assert.equal(card, null, 'refused before any card');
    assert.match(toolOut(bodies, 1), /installs can’t run in the background/);
    assert.ok(!events.some((e) => e.t === 'command'), 'nothing ran');
  }
});

// ---------- the Running tab ----------
test('running: a background job is listed with its chat; stopping it there ends it and tells the agent', { skip: !WIN }, async () => {
  const { runningIn, stopRunning } = await import('../server/running.js');
  let projectId = null, listed = null, stopped = null;
  const { bodies } = await agentRun(async (b, i) => {
    // Between the agent's steps, the user looks at the Running tab and stops the job.
    if (i === 1) {
      listed = runningIn(projectId).items.find((x) => x.kind === 'background');
      stopped = listed ? await stopRunning(projectId, listed.id) : null;
      return reply('', [['job_output', { job: listed?.bg || 'bg0', wait_s: 5 }]]);
    }
    return [reply('', [['shell', { command: 'node forever.js', background: true }]]), null, reply('Done.')][i];
  }, {
    chatId: 'chat-run-1',
    prep: (d) => {
      fs.writeFileSync(path.join(d, 'forever.js'), "console.log('serving'); setInterval(() => {}, 1000)");
      fs.mkdirSync(path.join(d, '.quorx'), { recursive: true });
      saveRules('project', [{ effect: 'allow', match: 'node forever.js*', by: 'user' }], d);
    },
    onEvent: (e, id) => { projectId = id; },
  });
  assert.ok(listed, 'listed in the Running tab');
  assert.equal(listed.chatId, 'chat-run-1');
  assert.equal(listed.source, 'agent');
  assert.match(listed.label, /node forever\.js/);
  assert.ok(stopped && !stopped.left, 'stopped with nothing left');
  assert.match(toolOut(bodies, 2), /stopped/);
  assert.ok(bodies[2].messages.some((m) => m.role === 'user' && /The user stopped bg\d+ \(node forever\.js\) from the Running tab/.test(m.content)), 'the agent was told');
});

test('running: any command that outlives the time limit moves to the background, not only builds', { skip: !WIN }, async () => {
  const { bodies } = await agentRun((b, i) => [reply('', [['shell', { command: 'ping -n 8 127.0.0.1' }]]), reply('Done.')][i], {
    settings: { safety: { timeout: 5 } },
    prep: (d) => {
      fs.mkdirSync(path.join(d, '.quorx'), { recursive: true });
      saveRules('project', [{ effect: 'allow', match: 'ping*', by: 'user' }], d);
    },
  });
  assert.match(toolOut(bodies, 1), /continues in the background as job bg\d+ instead of being stopped/);
  assert.match(toolOut(bodies, 1), /Running tab/);
});

// ---------- loop detection (P1) ----------
test('loops: the same failing call is nudged once, then wraps up in YOLO; in Strict the user can say keep going', async () => {
  { // loops: the same failing call is nudged once, then the reply wraps up in YOLO
    const { bodies, events } = await agentRun((b, i) => (i < 12 ? reply('', [['read_file', { path: 'missing.txt' }]]) : reply('Stuck: missing.txt does not exist.')), { settings: { approval: 'yolo' } });
    const nudged = bodies.some((b) => b.messages.some((m) => m.role === 'tool' && /Doing it again won't change the result/.test(m.content)));
    assert.ok(nudged, 'told to change approach');
    assert.equal(events.filter((e) => e.t === 'loop').length, 2);
    assert.ok(bodies.length <= 9, `wrapped up early (${bodies.length} calls)`);
  }
  { // loops: in Strict the user can say keep going, and it is not checked again
    let asked = 0;
    const { events, bodies } = await agentRun((b, i) => (i < 12 ? reply('', [['read_file', { path: 'missing.txt' }]]) : reply('Done.')), {
      settings: { approval: 'strict' },
      onEvent: (e, id) => { if (e.t === 'question' && /seems stuck/.test(e.question)) { asked++; setTimeout(() => answerQuestion(id, e.id, { choice: 0 }), 10); } },
    });
    assert.equal(asked, 1);
    assert.equal(events.filter((e) => e.t === 'loop').length, 2);
    assert.equal(bodies.length, 13, 'it ran to the end');
  }
});

test('loops: repeats by nature (desktop screenshots, the browser, look) are only a loop on the same failing call twice', async () => {
  { // loops: the same desktop screenshot after each step is not a loop; the same failing desktop call twice is
    const shots = Array.from({ length: 6 }, () => reply('', [['desktop', { action: 'windows', job: 'bg97' }]]));
    const { events } = await agentRun((b, i) => (i < 6 ? shots[i] : reply('Done.')), { settings: { approval: 'yolo' } });
    const loops = events.filter((e) => e.t === 'loop');
    assert.ok(loops.length >= 1 && loops.every((e) => /same failing desktop call twice/.test(e.what)), JSON.stringify(loops));
    const { events: ok } = await agentRun((b, i) => [reply('', [['plan', { items: [{ text: 'a', status: 'doing' }] }]]), ...Array.from({ length: 5 }, () => reply('', [['plan', { items: [{ text: 'a', status: 'doing' }] }]])), reply('Done.')][i], { settings: { approval: 'yolo' } });
    assert.equal(ok.filter((e) => e.t === 'loop').length, 0, 'calls that succeed repeat freely');
  }
  { // loops: a tool that repeats by nature (the browser, look) is caught on the same failing call twice in a row
    const { bodies, events } = await agentRun((b, i) => (i < 6 ? reply('', [['look', { target: 'desktop:bg99' }]]) : reply('Stuck.')), { settings: { approval: 'yolo' } });
    assert.match(toolOut(bodies, 2), /made the same failing look call twice in a row/, toolOut(bodies, 2));
    assert.ok(events.some((e) => e.t === 'loop'));
  }
});

// ---------- the agent's terminal and desktop apps (P1) ----------
const allow = (d, match) => { fs.mkdirSync(path.join(d, '.quorx'), { recursive: true }); saveRules('project', [{ effect: 'allow', match, by: 'user' }], d); };

test('terminal: the agent answers a program’s prompts and reads its screen; a bare interpreter asks', { skip: !WIN }, async () => {
  { // terminal: the agent answers a program’s prompts and reads its screen
    const { bodies } = await agentRun((b, i) => [
      reply('', [['terminal', { action: 'start', command: 'py -3 ask.py', cols: 60, rows: 10 }]]),
      // Python can take a moment to start on a busy machine: look again (as the agent would) before typing.
      reply('', [['terminal', { action: 'read', id: 't1', wait_s: 5 }]]),
      reply('', [['terminal', { action: 'send', id: 't1', text: 'Ada', keys: ['Enter'] }]]),
      reply('', [['terminal', { action: 'stop', id: 't1' }]]),
      reply('Done.'),
    ][i], { prep: (d) => { fs.writeFileSync(path.join(d, 'ask.py'), 'name = input("Name? ")\nprint("Hello,", name)\ninput("Enter to quit")\n'); allow(d, 'py -3 ask.py*'); } });
    assert.match(toolOut(bodies, 1), /Terminal t\d+ started/);
    assert.match(`${toolOut(bodies, 1)}\n${toolOut(bodies, 2)}`, /Name\?/);
    assert.match(toolOut(bodies, 3), /Hello, Ada/);
    assert.match(toolOut(bodies, 4), /0 processes left|already ended/);
  }
  { // terminal: a bare interpreter is a prompt QuorX can’t check, so it asks
    const d = await decide('python', ctx());
    assert.equal(d.verdict, 'ask');
    assert.equal(d.who, 'user');
    assert.equal((await decide('node', ctx({ mode: 'yolo' }))).who, 'user', 'even in YOLO');
    assert.equal((await decide('python app.py', ctx({ mode: 'yolo' }))).who, 'deciders', 'a script is a normal build');
  }
});

test('start_server: a plain dev-server start runs as before; a package fetched and run, an install or a URL is judged like any command', { skip: !WIN }, async () => {
  const root = tmp('server');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'node server.js' } }));
  fs.writeFileSync(path.join(root, 'server.js'), 'console.log(1);\n');
  const v = async (line, mode = 'strict', yolo = {}) => { const d = await decide(line, { shell: 'cmd', root, rules: [], mode, yolo, server: true }); return d.verdict === 'ask' ? `ask:${d.who}` : d.verdict; };
  for (const line of ['npm run dev', 'npm start', 'node server.js', 'python -m http.server 8000', 'uv run app.py']) {
    assert.equal(await v(line), 'allow', `strict: ${line}`);
    assert.equal(await v(line, 'yolo'), 'allow', `yolo, checking builds: ${line}`);
  }
  for (const line of ['npx -y somepkg', 'npm exec somepkg', 'npm create vite', 'pnpm dlx somepkg', 'bun x somepkg', 'uv run --with rich app.py', 'deno run https://example.com/a.ts', 'node -e 1', 'pip install somepkg']) {
    assert.equal(await v(line), 'ask:user', `strict: ${line}`);
  }
  assert.equal(await v('npx -y somepkg', 'yolo'), 'ask:deciders', 'YOLO checking builds: the deciders, as for shell');
  assert.equal(await v('npx -y somepkg', 'yolo', YOLO.defaults), (await decide('npx -y somepkg', { shell: 'cmd', root, rules: [], mode: 'yolo', yolo: YOLO.defaults })).verdict, 'YOLO defaults: the shell’s verdict');
  assert.equal((await decide('npm run dev', { shell: 'cmd', root, rules: [{ effect: 'ask', match: 'npm run*', by: 'user' }], mode: 'strict', server: true })).who, 'user', 'your rules still apply');
  assert.equal((await decide('npm run dev', { shell: 'cmd', root, rules: [], mode: 'strict' })).verdict, 'ask', 'only start_server lifts the plain start');
});

async function withRegistry(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://registry.npmjs.org/')) {
      const name = decodeURIComponent(u.slice(27));
      if (name === 'left-pad') return new Response(JSON.stringify({ time: { created: '2014-03-14T00:00:00Z' } }));
      if (name === 'brand-new-pkg') return new Response(JSON.stringify({ time: { created: new Date(Date.now() - 3 * 864e5).toISOString() } }));
      return new Response('{}', { status: 404 });
    }
    if (u.startsWith('https://api.npmjs.org/downloads/')) return new Response(JSON.stringify({ downloads: u.includes('left-pad') ? 2000000 : 12 }));
    return real(url, init);
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('packages: names are read from install commands, not their flags or versions', () => {
  const names = (l) => packagesOf(l).map((p) => `${p.eco}:${p.name}`);
  assert.deepEqual(names('npm install express lodash@4 @types/node@20 -D'), ['npm:express', 'npm:lodash', 'npm:@types/node']);
  assert.deepEqual(names('pip install "requests[socks]==2.31" flask'), ['pypi:requests', 'pypi:flask']);
  assert.deepEqual(names('cargo add serde@1 --features derive'), ['crates:serde']);
  assert.deepEqual(names('pip install -r requirements.txt'), []);
  assert.deepEqual(names('dotnet add package Newtonsoft.Json --version 13.0.1'), ['nuget:Newtonsoft.Json']);
});

test('packages: a made-up package is blocked, a brand-new one asks you even in YOLO', { skip: !WIN }, async () => {
  await withRegistry(async () => {
    const r = await checkPackages([{ eco: 'npm', name: 'left-pad' }, { eco: 'npm', name: 'no-such-pkg-xyz' }, { eco: 'npm', name: 'brand-new-pkg' }]);
    assert.deepEqual(r.map((x) => x.verdict), ['ok', 'missing', 'new']);
    const yes = { needed: 0.99, other: 0.01 };
    const table = Object.fromEntries(['typesafe/jev-1.14', 'liquid/d1-ultra', 'openai/gpt-6-luna-decisions'].map((m) => [m, yes]));
    const blocked = await agentRun((b, i) => [reply('', [['shell', { command: 'npm install no-such-pkg-xyz' }]]), reply('OK.')][i], { settings: { approval: 'yolo' } });
    assert.match(toolOut(blocked.bodies, 1), /Blocked by QuorX: “no-such-pkg-xyz” does not exist on npm/);
    let asked = 0;
    await withDeciders(table, () => agentRun((b, i) => [reply('', [['shell', { command: 'npm install brand-new-pkg' }]]), reply('OK.')][i], {
      settings: { approval: 'yolo' }, onEvent: (e, id) => { if (e.t === 'approval' && e.mode === 'strict') { asked++; setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } }));
    assert.equal(asked, 1, 'a 3-day-old package goes to the user, not the deciders');
  });
});

test('tests: deleting assertions to make a build pass is sent back', { skip: !WIN }, async () => {
  const body = 'def test_add():\n    assert add(1, 2) == 3\n    assert add(0, 0) == 0\n    assert add(-1, 1) == 0\n';
  const { events, bodies } = await agentRun((b, i) => [
    reply('', [['edit_file', { path: 'tests/test_math.py', find: '    assert add(0, 0) == 0\n    assert add(-1, 1) == 0\n', replace: '' }]]),
    reply('All tests pass now.'),
    reply('Restored them.'),
  ][i], { settings: { verify: true, verifyRounds: 1 }, prep: (d) => { fs.mkdirSync(path.join(d, 'tests')); fs.writeFileSync(path.join(d, 'tests', 'test_math.py'), body); } });
  assert.ok(events.some((e) => e.t === 'note' && /Tests weakened\? tests\/test_math\.py has 2 fewer assertions/.test(e.msg)));
  assert.ok(bodies.some((b) => b.messages.some((m) => /Don't make tests pass by removing or skipping them/.test(String(m.content)))), 'sent back to the agent');
});

test('audit: every command, block and rule is logged with who allowed it', { skip: !WIN }, async () => {
  const { id } = await agentRun((b, i) => [reply('', [['shell', { command: 'Set-Content a.txt "x"' }]]), reply('', [['shell', { command: 'Remove-Item ~ -Recurse' }]]), reply('OK.')][i]);
  const rows = readAudit({ project: id });
  assert.ok(rows.some((r) => r.kind === 'ran' && /Set-Content a\.txt/.test(r.command) && r.by === 'class:write' && r.changed === 1));
  assert.ok(rows.some((r) => r.kind === 'blocked' && /Remove-Item ~/.test(r.command)));
});

test('android: a uiautomator dump becomes numbered controls with positions', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
    <node index="0" text="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]">
      <node index="0" text="Count: 0" resource-id="com.qx:id/count" class="android.widget.TextView" clickable="false" bounds="[100,200][500,260]" />
      <node index="1" text="Add one" resource-id="com.qx:id/add" class="android.widget.Button" clickable="true" enabled="true" bounds="[100,300][500,400]" />
      <node index="2" text="" content-desc="Dark mode" class="android.widget.Switch" checkable="true" checked="true" clickable="true" bounds="[100,450][300,520]" />
      <node index="3" text="" class="android.widget.EditText" clickable="true" bounds="[100,600][900,700]" />
    </node></hierarchy>`;
  const nodes = parseHierarchy(xml);
  assert.equal(nodes.length, 4);
  const text = hierarchyText(nodes);
  assert.match(text, /^ {4}TextView "Count: 0" #count @300,230$/m);
  assert.match(text, /^\[1\] Button "Add one" #add @300,350$/m);
  assert.match(text, /^\[2\] Switch "Dark mode" checked @200,485$/m);
  assert.match(text, /^\[3\] EditText @500,650$/m);
});

test('debug: the debugger opens only after failed tries, then finds the bug', { skip: !WIN }, async () => {
  const app = "function total(items) {\n  let sum = 0;\n  for (const it of items) {\n    sum += it.price * it.qty;\n  }\n  return sum;\n}\nconsole.log(total([{ price: 2, qty: 3 }, { price: 5, qty: '2' }]));\n";
  const early = await agentRun((b, i) => [reply('', [['debug', { action: 'start', file: 'app.js' }]]), reply('OK.')][i], { prep: (d) => { fs.writeFileSync(path.join(d, 'app.js'), app); allow(d, 'node app.js*'); } });
  assert.match(toolOut(early.bodies, 1), /Not yet: reproduce the bug/);
  let sid = null;
  const { bodies } = await agentRun((b, i) => {
    if (i === 0) return reply('', [['debug', { action: 'start', file: 'app.js' }]]);
    if (i === 1) { sid = toolOut([b], 0).match(/session (d\d+)/)[1]; return reply('', [['debug', { action: 'break', id: sid, file: 'app.js', line: 4 }]]); }
    if (i === 2) return reply('', [['debug', { action: 'continue', id: sid }]]);
    if (i === 3) return reply('', [['debug', { action: 'continue', id: sid }]]);
    if (i === 4) return reply('', [['debug', { action: 'eval', id: sid, expr: 'typeof it.qty' }]]);
    if (i === 5) return reply('', [['debug', { action: 'stop', id: sid }]]);
    return reply('Found it: qty is a string.');
  }, { settings: { debugger: 'always' }, prep: (d) => { fs.writeFileSync(path.join(d, 'app.js'), app); allow(d, 'node app.js*'); } });
  assert.match(toolOut(bodies, 1), /Debug session d\d+ \(node\) started/);
  assert.match(toolOut(bodies, 3), /Paused \(other\) at app\.js:4[\s\S]*sum = 0/);
  assert.match(toolOut(bodies, 4), /sum = 6/);
  assert.match(toolOut(bodies, 5), /"string"/);
  assert.match(toolOut(bodies, 6), /0 processes left|already ended/);
});

// ---------- native debuggers, end to end (last: it starts background jobs, and tests above count job ids) ----------
// A stand-in debug adapter (the way lldb-dap, CodeLLDB and Delve listen: --connection, --port, dap --listen), so the
// launch request each pack sends and the answers coming back are tested without the real debuggers.
const MOCK_DAP = `import net from 'node:net'; import fs from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--help')) { console.log('USAGE: lldb-dap [options]\\n  --connection <uri>'); process.exit(0); }
const port = Number((a.join(' ').match(/(?:listen:\\/\\/127\\.0\\.0\\.1:|--port |--listen=127\\.0\\.0\\.1:)(\\d+)/) || [])[1]);
net.createServer((sock) => {
  let buf = Buffer.alloc(0), n = 0;
  const send = (m) => { const b = JSON.stringify({ seq: ++n, ...m }); sock.write('Content-Length: ' + Buffer.byteLength(b) + '\\r\\n\\r\\n' + b); };
  const ok = (r, body = {}) => send({ type: 'response', request_seq: r.seq, command: r.command, success: true, body });
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const h = buf.indexOf('\\r\\n\\r\\n'); if (h < 0) return;
      const len = Number(/Content-Length: (\\d+)/.exec(buf.slice(0, h).toString())[1]); if (buf.length < h + 4 + len) return;
      const r = JSON.parse(buf.slice(h + 4, h + 4 + len).toString()); buf = buf.slice(h + 4 + len);
      if (r.command === 'launch') {
        fs.writeFileSync(process.env.QX_MOCK_LOG, JSON.stringify({ argv: a, launch: r.arguments }));
        if (/fail/.test(r.arguments.program)) { send({ type: 'response', request_seq: r.seq, command: 'launch', success: false, message: 'could not find the program' }); continue; }
        ok(r); send({ type: 'event', event: 'initialized' });
      } else if (r.command === 'setBreakpoints') ok(r, { breakpoints: r.arguments.breakpoints.map(() => ({ verified: true })) });
      else if (r.command === 'configurationDone') { ok(r); send({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 7 } }); }
      else if (r.command === 'stackTrace') ok(r, { stackFrames: [{ id: 1, name: 'main', line: 3, source: { path: 'main.src' } }] });
      else if (r.command === 'scopes') ok(r, { scopes: [{ name: 'Locals', variablesReference: 5 }] });
      else if (r.command === 'variables') ok(r, { variables: [{ name: 'n', value: '3' }] });
      else if (r.command === 'evaluate') ok(r, { result: r.arguments.context + ':' + r.arguments.expression });
      else ok(r);
    }
  });
}).listen(port, '127.0.0.1');
`;

test('packs: Go, C/C++ and Rust debug sessions launch through their adapter and read the stop', async () => {
  const { debugStart, debugBreak, debugMove, debugEval, debugStop } = await import('../server/debugger.js');
  const dir = tmp('native-dap');
  fs.writeFileSync(path.join(dir, 'mock.mjs'), MOCK_DAP);
  const exe = path.join(dir, WIN ? 'mock-adapter.cmd' : 'mock-adapter');
  fs.writeFileSync(exe, WIN ? `@"${process.execPath}" "%~dp0mock.mjs" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/mock.mjs" "$@"\n`);
  if (!WIN) fs.chmodSync(exe, 0o755);
  for (const f of ['go.mod', 'main.go', 'main.cpp', 'Cargo.toml', 'src/main.rs', 'app.exe', 'fail.exe']) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), ''); }
  const log = path.join(dir, 'launch.json');
  const env = { QX_DLV: exe, QX_LLDB_DAP: exe, QX_CODELLDB: exe, QX_MOCK_LOG: log };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    for (const [file, program, want] of [
      ['main.go', undefined, (l) => { assert.match(l.argv.join(' '), /^dap --listen=127\.0\.0\.1:\d+$/); assert.deepEqual([l.launch.mode, l.launch.program], ['debug', dir]); }],
      ['main.cpp', 'app.exe', (l) => { assert.match(l.argv.join(' '), /^--connection listen:\/\/127\.0\.0\.1:\d+$/); assert.equal(l.launch.program, path.join(dir, 'app.exe')); assert.equal(l.launch.stopOnEntry, false); }],
      ['src/main.rs', 'app.exe', (l) => { assert.match(l.argv.join(' '), /^--port \d+$/, 'CodeLLDB first for Rust'); assert.deepEqual(l.launch.sourceLanguages, ['rust']); assert.deepEqual(l.launch.preRunCommands, ['breakpoint set -n rust_panic']); }],
    ]) {
      const s = await debugStart({ projectId: 'native-test', cwd: dir, file, args: ['x'], program });
      try {
        want(JSON.parse(fs.readFileSync(log, 'utf8')));
        assert.match(await debugBreak(s.id, file, 3), /breakpoint at/);
        const st = await debugMove(s.id, 'continue', 8000);
        assert.equal(st.state, 'paused', file);
        assert.deepEqual(st.locals, ['n = 3']);
        assert.equal(await debugEval(s.id, 'n * 2'), file.endsWith('.go') ? 'repl:n * 2' : 'watch:n * 2', 'lldb gets expressions, not lldb commands');
      } finally { await debugStop(s.id).catch(() => {}); }
    }
    await assert.rejects(debugStart({ projectId: 'native-test', cwd: dir, file: 'main.cpp', program: 'fail.exe' }), /could not start the program: could not find the program/);
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

// ---------- 0.2.3: read-only .NET calls and the agent's scratch scripts ----------
test('rules: how lines are read: PowerShell string methods are reads, scratch scripts are marked, cmd /c and -Command are judged by what they run', { skip: !WIN }, async () => {
  { // rules: string methods in PowerShell count as reads, file and process calls do not
    const cls = async (line) => { const d = await decide(line, ctx()); return d.segments.map((s) => s.cls); };
    assert.ok(!(await cls('Get-ChildItem -Recurse | ForEach-Object { $_.FullName.Replace("C:\\x\\", "") }')).includes('opaque'), 'FullName.Replace is a read');
    assert.ok(!(await cls("$c = Get-Content index.html -Raw; $i = $c.IndexOf('<table'); $c.Substring($i, 400)")).includes('opaque'), 'IndexOf and Substring are reads');
    assert.ok((await cls("Get-ChildItem | ForEach-Object { $_.Replace('a', 'b') }")).includes('opaque'), 'Replace on a file object stays opaque');
    assert.ok((await cls("[IO.File]::WriteAllText('x.txt', 'y')")).includes('opaque'), 'a static file write stays opaque');
  }
  { // rules: the agent’s scratch scripts are marked in any language; other scripts are not
    put('.quorx/scratch/calc.ps1', 'Get-ChildItem .\n');
    put('.quorx/scratch/b.bat', '@echo off\r\necho hi\r\n');
    put('tools/x.ps1', 'Get-ChildItem .\n');
    const ps = await decide('powershell -NoProfile -ExecutionPolicy Bypass -File .quorx\\scratch\\calc.ps1', sctx());
    assert.ok(ps.segments.some((s) => s.scratch === '.quorx/scratch/calc.ps1'), JSON.stringify(ps.segments.map((s) => [s.text, s.scratch])));
    const bat = await decide('cmd /c .quorx\\scratch\\b.bat', sctx({ shell: 'cmd' }));
    assert.ok(bat.segments.some((s) => s.scratch === '.quorx/scratch/b.bat'), JSON.stringify(bat.segments.map((s) => [s.text, s.scratch])));
    assert.ok(!(await decide('powershell -File tools\\x.ps1', sctx())).segments.some((s) => s.scratch));
  }
  { // rules: cmd /c, powershell -Command and bash -c are judged by the command inside them
    for (const shell of ['powershell', 'cmd']) {
      const out = await decide('cmd /c copy /Y a.txt D:\\elsewhere\\b.txt', sctx({ shell, mode: 'yolo' }));
      assert.deepEqual([out.verdict, out.who], ['ask', 'user'], shell);
      assert.match(out.why, /writes outside the project/, `${shell}: the same card as Copy-Item gets, not “can't read”`);
      assert.equal(out.segments[0].wrap, 'cmd /c');
    }
    assert.equal((await decide('cmd /c dir', sctx())).verdict, 'allow');
    assert.equal((await decide('powershell -NoProfile -Command "Get-ChildItem ."', sctx())).verdict, 'allow');
    assert.equal((await decide('powershell -Command "$x = 1; Remove-Item $x"', sctx())).segments[0].cls, 'opaque', 'text with variables stays unread');
    assert.equal((await decide('powershell -EncodedCommand ZABpAHIA', sctx())).segments[0].cls, 'opaque');
    const robo = await decide('robocopy src out *.txt /R:3 /LOG:log.txt', sctx());
    assert.deepEqual(robo.segments[0].paths.map((p) => p.raw), ['src', 'out'], 'switches and file patterns are not folders');
    put('.quorx/scratch/out.ps1', 'Copy-Item a.txt D:\\elsewhere\\c.txt\n');
    const sc = await decide('powershell -NoProfile -File .quorx\\scratch\\out.ps1', sctx({ mode: 'yolo' }));
    assert.deepEqual([sc.verdict, sc.who], ['ask', 'user'], 'a script that writes outside the project shows that write');
    assert.ok(sc.segments.some((s) => s.via === '.quorx/scratch/out.ps1' && s.paths.some((p) => p.zone === 'outside')));
  }
});

test('deciders: the agent\'s own scratch script is judged on harm only', async () => {
  const notAsked = { needed: 0.05, other: 0.03 };
  const r = await withDeciders({ a: notAsked, b: notAsked, c: notAsked }, (sent) => judge({ harmOnly: true, facts: { command: 'node .quorx/scratch/ids.mjs' } }).then((x) => ({ x, sent })));
  assert.equal(r.x.approve, true);
  assert.ok(r.sent.every((b) => Object.keys(b.questions).join() === 'other'), 'only the harm question is asked');
  const harmful = { needed: 0.9, other: 0.9 };
  assert.equal((await withDeciders({ a: harmful, b: harmful, c: harmful }, () => judge({ harmOnly: true }))).approve, false);
});

// ---------- approvals that do what they say (from a computer-use chat with 21 approval cards) ----------
test('rules: every "Always allow" suggestion matches the command it came from; rules that never match are named', { skip: !WIN }, async () => {
  put('.quorx/scratch/calc.ps1', 'Get-ChildItem .\n');
  for (const line of ['powershell -NoProfile -ExecutionPolicy Bypass -File .quorx\\scratch\\calc.ps1', 'git -C sub status', 'code --new-window D:\\x', 'node build.js --watch']) {
    const d = await decide(line, sctx());
    for (const s of d.segments) for (const k of ['exact', 'prefix', 'program']) assert.ok(ruleMatches(s.suggest[k], s.ruleText), `${line}: ${k} “${s.suggest[k]}” vs “${s.ruleText}”`);
  }
  const ps = (await decide('powershell -NoProfile -ExecutionPolicy Bypass -File .quorx\\scratch\\calc.ps1', sctx())).segments.find((s) => s.program === 'powershell');
  assert.equal(ps.suggest.prefix, 'powershell -NoProfile -ExecutionPolicy Bypass -File .quorx\\scratch\\*', 'the script’s folder, not “powershell Bypass*”');
  assert.match(ruleProblem('powershell Bypass*'), /option's value/);
  assert.match(ruleProblem('ffmpeg -i a.mp4 b.mp4; ffmpeg -i c.mp4 d.mp4'), /several commands/);
  assert.equal(ruleProblem('npm test*'), '');
});

test('shell: a rule that would not match its command is not saved, and you are told', { skip: !WIN }, async () => {
  const { events, dir } = await agentRun((b, i) => [reply('', [['shell', { command: 'node build.js' }]]), reply('Done.')][i], {
    prep: buildJs, onEvent: (e, id) => { if (e.t === 'approval' && e.mode === 'strict') setTimeout(() => answerApproval(id, e.id, { approve: true, rule: { match: 'node Bypass*', scope: 'project' } }), 10); } });
  assert.ok(of(events, 'note').some((e) => /wasn't saved: it doesn't match this command/.test(e.msg)));
  assert.equal(loadRules(dir).filter((r) => r.scope === 'project').length, 0);
  assert.ok(!events.some((e) => e.t === 'cmd_rule'));
});

test('shell: in YOLO nobody answering never runs a read outside the project, however harmless', { skip: !WIN }, async () => {
  const outside = path.join(tmp('outside'), 'notes.txt');
  fs.writeFileSync(outside, 'secret-ish');
  await withDeciders(voteAll({ needed: 0.5, other: 0.03 }), async () => {
    const { events, bodies } = await agentRun((b, i) => [reply('', [['shell', { command: `Get-Content "${outside}"` }]]), reply('OK.')][i], {
      settings: { approval: 'yolo', yoloWaitSecs: 1, safety: { yoloLevel: 'careful' } } });
    const card = of(events, 'approval').find((e) => e.mode === 'strict');
    assert.equal(card?.wait?.then, 'skip', 'the card says it will be skipped');
    const done = of(events, 'approval_done').at(-1);
    assert.deepEqual([done.by, done.approve], ['timeout', false]);
    assert.match(done.reason, /only runs on your yes/);
    assert.doesNotMatch(toolOut(bodies, 1), /secret-ish/);
  });
});

test('shell: a command that ran because nobody answered asks again; a repeat of one you approved says so', { skip: !WIN }, async () => {
  { // shell: a command that ran only because nobody answered asks again the next time
    await withDeciders(voteAll({ needed: 0.5, other: 0.03 }), async () => {
      const { events } = await agentRun((b, i) => [reply('', [['shell', { command: 'node build.js' }]]), reply('', [['shell', { command: 'node build.js' }]]), reply('Done.')][i], {
        settings: { approval: 'yolo', yoloWaitSecs: 1, safety: { yoloLevel: 'careful' } }, prep: buildJs });
      assert.equal(of(events, 'approval').filter((e) => e.mode === 'strict').length, 2, 'two cards, not one and a silent repeat');
    });
  }
  { // shell: a repeat of a command you approved says so in the chat
    const { events } = await agentRun((b, i) => [reply('', [['shell', { command: 'node build.js' }]]), reply('', [['shell', { command: 'node build.js' }]]), reply('Done.')][i], {
      prep: buildJs, onEvent: (e, id) => { if (e.t === 'approval' && e.mode === 'strict') setTimeout(() => answerApproval(id, e.id, { approve: true }), 10); } });
    assert.equal(of(events, 'approval').filter((e) => e.mode === 'strict').length, 1);
    assert.ok(of(events, 'note').some((e) => /Ran without asking again: “node build\.js” was approved earlier/.test(e.msg)));
  }
});

test('fresh eyes: a page written in parts with append_file is not “the same problem twice”', async () => {
  const { events } = await agentRun((b, i) => [
    reply('', [['write_file', { path: 'page.html', content: '<!doctype html>\n<html><head><title>x</title></head>\n<body>\n' }]]),
    reply('', [['append_file', { path: 'page.html', content: '<main><p>one</p></main>\n' }]]),
    reply('', [['append_file', { path: 'page.html', content: '<footer>two</footer>\n' }]]),
    reply('', [['append_file', { path: 'page.html', content: '</body>\n</html>\n' }]]),
    reply('Done.'),
  ][i], { settings: { freshEyes: true } });
  assert.ok(!events.some((e) => e.t === 'fresh_eyes_start'), 'no helper while the page is still being written');
});

test('launch entries: the user’s entry is never overwritten by name; replacing it asks', { skip: !WIN }, async () => {
  const mine = { version: 1, configurations: [{ name: 'site', command: 'node', args: ['.quorx/serve.mjs', 'index.html'] }] };
  let cards = 0;
  const { bodies, dir } = await agentRun((b, i) => [
    reply('', [['launch_config', { action: 'save', name: 'site', command: 'node', args: ['.quorx/serve.mjs', 'other.html'] }]]),
    reply('', [['launch_config', { action: 'save', name: 'site', old_name: 'site', command: 'node', args: ['.quorx/serve.mjs', 'other.html'] }]]),
    reply('', [['launch_config', { action: 'save', name: 'mine-too', command: 'node', args: ['a.js'] }]]),
    reply('', [['launch_config', { action: 'save', name: 'mine-too', command: 'node', args: ['b.js'] }]]),
    reply('Done.'),
  ][i], { prep: (d) => { fs.mkdirSync(path.join(d, '.quorx'), { recursive: true }); fs.writeFileSync(path.join(d, '.quorx', 'launch.json'), JSON.stringify(mine)); },
    onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'launch_config') { cards++; setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
  assert.match(toolOut(bodies, 1), /^Error: a launch config named "site" already exists/);
  assert.equal(cards, 1, 'replacing on purpose asks you');
  assert.match(toolOut(bodies, 2), /kept their launch entry "site"/);
  assert.match(toolOut(bodies, 4), /Saved:\n- mine-too: node b\.js/, 'an entry made in this reply can change freely');
  const file = JSON.parse(fs.readFileSync(path.join(dir, '.quorx', 'launch.json'), 'utf8'));
  assert.deepEqual(file.configurations.find((c) => c.name === 'site').args, ['.quorx/serve.mjs', 'index.html']);
});

// ---------- last, because it starts a job and a terminal (earlier tests expect to get bg1 and t1) ----------
// A command you approved may run in the background (a tunnel, a server), and moving it to the terminal tool in the
// same reply doesn't ask again. wait.js only waits: nothing here changes the computer.
test('shell: an approved command runs in the background, and the terminal tool doesn’t ask for it again', { skip: !WIN }, async () => {
  let cards = 0;
  const { events, bodies } = await agentRun((b, i) => [
    reply('', [['shell', { command: 'node wait.js', background: true }]]),
    reply('', [['terminal', { action: 'start', command: 'node wait.js' }]]),
    reply('Done.'),
  ][i], { settings: { approval: 'strict' }, prep: (d) => fs.writeFileSync(path.join(d, 'wait.js'), 'setTimeout(() => {}, 3000);\n'),
    onEvent: (e, id) => { if (e.t === 'approval' && e.mode === 'strict') { cards++; setTimeout(() => answerApproval(id, e.id, { approve: true }), 10); } } });
  assert.equal(cards, 1, 'one card for the line, not one per tool');
  assert.doesNotMatch(toolOut(bodies, 1), /only commands that build/);
  assert.match(toolOut(bodies, 1), /background|job/i);
  assert.match(toolOut(bodies, 2), /Terminal \S+ started/);
  assert.ok(of(events, 'approval_done').every((e) => e.approve));
});

// From a real YOLO chat: harmless PowerShell the agent wrote to read its own scratch files asked the user 13 times.
test('YOLO: safe .NET calls, GETs with plain headers and the line’s own functions run; risky look-alikes still pause', { skip: !WIN }, async () => {
  const root = tmp('yolo-ps');
  fs.mkdirSync(path.join(root, '.quorx', 'scratch'), { recursive: true });
  const { safetySettings, yoloOf } = await import('../server/safety.js');
  const y = yoloOf(safetySettings({}));
  const verdict = async (line) => { const d = await decide(line, { mode: 'yolo', yolo: y, root, shell: 'powershell' }); return d.verdict === 'allow' ? 'allow' : `${d.verdict}:${d.who}`; };
  assert.equal(await verdict('$c = Get-Content ".quorx/scratch/r.md"; $s = 3; $c[($s-1)..([Math]::Min($s+90,$c.Count-1))]'), 'allow', '[Math]::Min alone');
  assert.equal(await verdict('$h = Get-Content "index.html" -Raw; [regex]::Matches($h, \'id="x"\').Count'), 'allow', '[regex]::Matches');
  assert.equal(await verdict('$r = Invoke-RestMethod -Uri "https://api.github.com/repos/a/b" -Headers @{ \'User-Agent\'=\'QuorX\' }; $r.size'), 'allow', 'a GET with literal headers');
  assert.equal(await verdict('$a = Get-Content ".quorx/scratch/a.json" -Raw | ConvertFrom-Json\nfunction Cat($n) { if ($n -match \'x\') { \'X\' } else { \'Y\' } }\n$a | Group-Object { Cat $_.name }'), 'allow', 'a function called Cat is not Get-Content');
  assert.notEqual(await verdict('Invoke-RestMethod -Uri "https://api.example.com/x" -Headers @{ Authorization = "Bearer $env:TOKEN" }'), 'allow', 'a token header');
  assert.notEqual(await verdict('Invoke-RestMethod -Uri "https://api.example.com/x" -Method Post -Body \'{}\''), 'allow', 'a POST');
  assert.notEqual(await verdict('[IO.File]::Delete("C:/x.txt")'), 'allow', 'a .NET delete');
  assert.notEqual(await verdict('function cat($p) { Remove-Item -Recurse $p }; cat C:/Users'), 'allow', 'what a script function runs is still judged');
});

// After the terminal tests above, which expect to get t1. A read-only command (git log, git diff, man) can't open a
// pager or editor that takes commands of its own: not as a command, and not in the agent's terminal.
test('commands and the agent’s terminal start with no pager, editor or git prompt', { skip: !WIN }, async () => {
  const { termStart, termRead } = await import('../server/agentterm.js');
  const root = tmp('nopager');
  const keys = ['PAGER', 'GIT_PAGER', 'MANPAGER', 'LESSSECURE', 'GIT_EDITOR', 'EDITOR', 'VISUAL', 'GIT_TERMINAL_PROMPT'];
  fs.writeFileSync(path.join(root, 'env.js'), `console.log('ENV=' + ${JSON.stringify(keys)}.map((k) => process.env[k]).join(','));\n`);
  const want = 'ENV=cat,cat,cat,1,true,true,true,0';
  const r = await runLine(root, 'node env.js', { shell: 'cmd', env: { PAGER: 'less' } });
  assert.match(r.out, new RegExp(want));
  const s = await termStart({ projectId: 'nopager', cwd: root, line: 'node env.js', shell: 'cmd', env: { GIT_PAGER: 'less' } });
  try {
    let screen = '';
    for (let k = 0; k < 20 && !screen.includes('ENV='); k++) screen = (await termRead(s.id, 1000)).screen;
    assert.match(screen.replace(/\s+/g, ''), new RegExp(want));
  } finally { await termStop(s.id).catch(() => {}); }
});

// ---------- each chat's own agent notes, and chats kept off the project ----------
test('chat notes: a chat keeps its own notes and reads AGENT.md and the log in the project; off the project, or asked to ignore it, it reads none', async () => {
  { // chat notes: a chat reads and writes its own notes; in the project it reads AGENT.md and the log too
    const chatId = 'cnotesin1';
    const { bodies, dir } = await agentRun((b, i) => [reply('', [['append_file', { path: `.quorx/chats/${chatId}.md`, content: '- VRoid: right-drag turns the camera\n' }]]), reply('Done.')][i], {
      chatId, prep: (d) => { fs.writeFileSync(path.join(d, 'AGENT.md'), '# Proj\nShared project fact ZEBRA.\n'); fs.mkdirSync(path.join(d, '.quorx', 'chats'), { recursive: true }); fs.writeFileSync(path.join(d, '.quorx', 'chats', `${chatId}.md`), 'Chat fact OTTER.\n'); } });
    const sys = JSON.stringify(bodies[0].messages);
    assert.match(sys, /\[Project notes: AGENT\.md\][^]*ZEBRA/);
    assert.match(sys, /\[This chat's own notes: \.quorx\/chats\/cnotesin1\.md\][^]*OTTER/);
    assert.match(toolOut(bodies, 1), /^(Appended|Added|Wrote)/i, toolOut(bodies, 1));
    assert.match(fs.readFileSync(path.join(dir, '.quorx', 'chats', `${chatId}.md`), 'utf8'), /right-drag turns the camera/);
  }
  { // chat notes: a chat off the project skips its notes, design and log, and can't change AGENT.md; another chat's notes stay off limits
    const chatId = 'cnotesoff1';
    const { bodies, dir } = await agentRun((b, i) => [
      reply('', [['edit_file', { path: 'AGENT.md', find: 'ZEBRA', replace: 'LION' }]]),
      reply('', [['write_file', { path: '.quorx/chats/otherchat1.md', content: 'x' }]]),
      reply('', [['write_file', { path: 'notes.txt', content: 'hi' }]]),
      reply('Done.'),
    ][i], { chatId, more: { offProject: true }, prep: (d) => { fs.writeFileSync(path.join(d, 'AGENT.md'), '# Proj\nShared project fact ZEBRA.\n'); fs.writeFileSync(path.join(d, 'DESIGN.md'), '# Look\nCORAL accents.\n'); } });
    const sys = JSON.stringify(bodies[0].messages);
    assert.doesNotMatch(sys, /ZEBRA|CORAL/, 'the project notes and design are not loaded');
    assert.match(sys, /\[This chat is off the project\]/);
    assert.match(toolOut(bodies, 1), /^Refused: this chat is off the project, so AGENT\.md/);
    assert.match(toolOut(bodies, 2), /^Refused: QuorX’s own files/);
    assert.match(fs.readFileSync(path.join(dir, 'AGENT.md'), 'utf8'), /ZEBRA/);
    assert.ok(!fs.existsSync(path.join(dir, '.quorx', 'log.md')) || !/notes\.txt/.test(fs.readFileSync(path.join(dir, '.quorx', 'log.md'), 'utf8')), 'nothing in the work log');
  }
  { // chat notes: "ignore the context of this project" in the user's words makes it an Own chat
    const prep = (d) => fs.writeFileSync(path.join(d, 'AGENT.md'), '# Proj\nShared project fact ZEBRA.\n');
    const off = await agentRun((b, i) => [reply('OK.')][i], { chatId: 'offwords1', prep, more: { text: 'ignroe the context of quorx in this project for this activity ok. Open VS Code.' } });
    assert.doesNotMatch(JSON.stringify(off.bodies[0].messages), /ZEBRA/);
    assert.ok(off.events.some((e) => e.t === 'chat_off_project'), 'the page hears it and keeps it');
    const off2 = await agentRun((b, i) => [reply('OK.')][i], { chatId: 'offwords3', prep, more: { text: 'ignore this project context and work on this but save in this project' } });
    assert.ok(off2.events.some((e) => e.t === 'chat_off_project'), '"this project context" too');
    const on = await agentRun((b, i) => [reply('OK.')][i], { chatId: 'offwords2', prep, more: { text: 'Fix the bug in this project, and read the folder outside the project too.' } });
    assert.match(JSON.stringify(on.bodies[0].messages), /ZEBRA/);
    assert.ok(!on.events.some((e) => e.t === 'chat_off_project'));
  }
});

test('named in the user\'s message: a folder is read with no card; in YOLO an app is raised with no card (only the user\'s words count)', async () => {
  const outside = tmp('named-folder');
  fs.mkdirSync(path.join(outside, 'site'));
  fs.writeFileSync(path.join(outside, 'site', 'index.html'), '<h1>NAMED PAGE</h1>');
  let cards = 0;
  const named = await agentRun((b, i) => [reply('', [['read_file', { path: path.join(outside, 'site', 'index.html') }]]), reply('OK.')][i], {
    chatId: 'named-folder1', more: { text: `Open the folder ${path.join(outside, 'site')} and tell me what the page says.` },
    onEvent: (e, id) => { if (e.t === 'approval') { cards++; setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
  assert.match(toolOut(named.bodies, 1), /NAMED PAGE/);
  assert.equal(cards, 0, 'no card for a folder the user named');
  const unnamed = await agentRun((b, i) => [reply('', [['read_file', { path: path.join(outside, 'site', 'index.html') }]]), reply('OK.')][i], {
    chatId: 'named-folder2', onEvent: (e, id) => { if (e.t === 'approval') { cards++; setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
  assert.match(toolOut(unnamed.bodies, 1), /didn't add/);
  assert.equal(cards, 1, 'a folder the user didn\'t name still asks');
  const apps = [{ name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode', level: 'click' }];
  const raised = await agentRun((b, i) => [reply('', [['desktop', { action: 'keys', app: 'Visual Studio Code', keys: 'x' }]]), reply('OK.')][i], {
    chatId: 'named-app1', settings: { approval: 'yolo', appsAccess: true }, more: { apps, text: 'Open VS Code and ask Cline to build a page.' } });
  assert.doesNotMatch(toolOut(raised.bodies, 1), /isn't allowed/, toolOut(raised.bodies, 1));
  assert.ok(raised.events.some((e) => e.t === 'app_allowed' && e.app.level === 'full'));
});

test('a long text typed into the user\'s app is checked against their words first; the same text again goes through', async () => {
  const seen = [];
  const ensemble = async ({ questions, state }) => { seen.push({ ask: questions[0].ask, state: String(state) }); return { results: Object.fromEntries(questions.map((q) => [q.id, { pick: 'no', dist: { yes: 0.2, no: 0.8 }, confidence: 0.8, agree: 3, n: 3, verdict: 'settled' }])), votes: [] }; };
  const brief = `Build a page about Rem built in VRoid Studio with Blender, and delete the old page. ${'More detail. '.repeat(20)}`;
  const apps = [{ name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode', level: 'full' }];
  const { bodies } = await agentRun((b, i) => [
    reply('', [['desktop', { action: 'type', app: 'Visual Studio Code', ref: 1, text: brief }]]),
    reply('', [['desktop', { action: 'type', app: 'Visual Studio Code', ref: 1, text: brief }]]),
    reply('OK.'),
  ][i], { chatId: 'brief-check1', settings: { appsAccess: true }, more: { apps, text: 'Ask Cline to build a page about the Rem I made in VRoid Studio.' }, ensemble });
  assert.match(toolOut(bodies, 1), /^Not typed yet: the deciders think this text adds things the user didn't say/);
  assert.doesNotMatch(toolOut(bodies, 2), /^Not typed yet/, 'asked once per text');
  assert.equal(seen.filter((s) => /comes from the user's request/.test(s.ask)).length, 1);
  assert.match(seen[0].state, /the Rem I made in VRoid Studio[^]*with Blender/, 'they see the user\'s words and the text');
});

// Last (it starts a background job): the agent's own WinForms program, driven with the new actions in one call.
// ---------- folders outside the project, added to a chat ----------
test('folders: a write outside the project asks once to add its folder; one not added stays out of reach; read-only asks before writing; served at /wsf/', async () => {
  { // folders: a write outside the project asks once to add its folder, then works there directly
    const other = tmp('added'), file = path.join(other, 'index.html');
    let cards = 0;
    const { events, bodies } = await agentRun((b, i) => [
      reply('', [['write_file', { path: file, content: '<!doctype html><html><body>hi</body></html>' }]]),
      reply('', [['edit_file', { path: file, find: 'hi', replace: 'hello' }]]),
      reply('', [['read_file', { path: file }]]),
      reply('Done.'),
    ][i], { chatId: 'folders-ok', onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'folder') { cards++; assert.match(e.what, /^Read and write files in /); setTimeout(() => answerApproval(id, e.id, { approve: true }), 10); } } });
    assert.equal(cards, 1, 'one card for the folder, none for the next changes');
    assert.match(toolOut(bodies, 1), /Wrote .*index\.html .*\n\(Outside the project, in .*: Undo doesn't cover this change\.\)/);
    assert.match(toolOut(bodies, 2), /Edited .*index\.html \(1 replacement\)/);
    assert.match(toolOut(bodies, 3), /hello/);
    assert.equal(fs.readFileSync(file, 'utf8'), '<!doctype html><html><body>hello</body></html>');
    assert.deepEqual(of(events, 'folder_added').map((e) => e.folder), [{ path: other, access: 'write' }]);
  }
  { // folders: a folder the user doesn’t add stays out of reach; blocked places never get a card
    const other = tmp('declined');
    let cards = 0;
    const { bodies } = await agentRun((b, i) => [
      reply('', [['write_file', { path: path.join(other, 'a.txt'), content: 'x' }]]),
      reply('', [['write_file', { path: path.join(os.homedir(), 'qx-should-not-exist.txt'), content: 'x' }]]),
      reply('', [['delete_file', { path: path.join(other, 'a.txt') }]]),
      reply('OK.'),
    ][i], { chatId: 'folders-no', onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'folder') { cards++; setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
    assert.match(toolOut(bodies, 1), /didn't add .* to this chat/);
    assert.equal(fs.existsSync(path.join(other, 'a.txt')), false);
    assert.match(toolOut(bodies, 2), /^Refused: .* can't be added to this chat: your profile folder/);
    assert.match(toolOut(bodies, 3), /^Refused: delete_file works in the project only/);
    assert.equal(cards, 1, 'the profile folder never got a card');
  }
  { // folders: a read-only folder reads without a card and asks again before writing
    const other = tmp('readonly');
    fs.writeFileSync(path.join(other, 'notes.txt'), 'kept');
    let cards = [];
    const { bodies } = await agentRun((b, i) => [
      reply('', [['read_file', { path: path.join(other, 'notes.txt') }]]),
      reply('', [['write_file', { path: path.join(other, 'notes.txt'), content: 'changed' }]]),
      reply('OK.'),
    ][i], { chatId: 'folders-ro', more: { folders: [{ path: other, access: 'read' }] }, onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'folder') { cards.push(e.what); setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
    assert.match(toolOut(bodies, 1), /kept/);
    assert.deepEqual(cards.map((w) => w.split(' files')[0]), ['Read and write']);
    assert.equal(fs.readFileSync(path.join(other, 'notes.txt'), 'utf8'), 'kept');
    assert.match(JSON.stringify(bodies[0].messages.at(-1).content), /Folders outside the project added to this chat .*\(read only\)/);
  }
  { // folders: a chat's added folders are served at /wsf/<chat>/<n>/
    const { registerFolders, chatFolder, folderIndex } = await import('../server/workspace.js');
    const a = tmp('wsf-a'), b = tmp('wsf-b');
    registerFolders('chat-x', [{ path: a, access: 'read' }, { path: b, access: 'write' }]);
    assert.equal(chatFolder('chat-x', 1), b);
    assert.deepEqual(folderIndex('chat-x', path.join(b, 'site', 'index.html')), { i: 1, rel: 'site/index.html' });
    assert.equal(folderIndex('chat-x', path.join(tmp('wsf-c'), 'x.html')), null);
    assert.equal(chatFolder('other-chat', 0), null);
  }
});

test('folders: commands treat a read-and-write folder like the project', { skip: !WIN }, async () => {
  const other = tmp('cmdfolder');
  const outside = await decide(`Set-Content "${path.join(other, 'a.txt')}" hi`, { shell: 'powershell', root: scripts, rules: [], mode: 'strict', yolo: {} });
  assert.match(outside.why, /writes outside the project/);
  const added = await decide(`Set-Content "${path.join(other, 'a.txt')}" hi`, { shell: 'powershell', root: scripts, rules: [], mode: 'strict', yolo: {}, added: [other] });
  assert.equal(added.verdict, 'allow');
  const git = await decide(`Set-Content "${path.join(other, '.git', 'config')}" x`, { shell: 'powershell', root: scripts, rules: [], mode: 'strict', yolo: {}, added: [other] });
  assert.equal(git.verdict, 'deny', 'its .git stays protected');
});

// ---------- rules: on/off, ids and use counts ----------
test('rules: a rule turned off is kept but not used, and each command a rule lets through counts one use', { skip: !WIN }, async () => {
  { // rules: a rule turned off is kept but not used; ids stay put; adding it again turns it back on
    const root = tmp('rules-onoff');
    fs.writeFileSync(path.join(root, 'build.js'), '');
    saveRules('project', [{ effect: 'allow', match: 'node build.js*', by: 'user' }], root);
    const [r] = loadRules(root).filter((x) => x.scope === 'project');
    assert.ok(r.id && r.on === true && r.hits === 0);
    assert.equal(loadRules(root).find((x) => x.scope === 'project').id, r.id, 'the same id on every read');
    const run = (rules) => decide('node build.js', { shell: 'powershell', root, rules, mode: 'strict', yolo: {} });
    assert.equal((await run(loadRules(root))).verdict, 'allow');
    updateRule('project', r.id, { on: false }, root);
    assert.equal(loadRules(root).find((x) => x.scope === 'project').on, false);
    assert.notEqual((await run(loadRules(root))).verdict, 'allow', 'an off rule lets nothing through');
    addRule('project', { effect: 'allow', match: 'node build.js*', by: 'button' }, root);
    const back = loadRules(root).filter((x) => x.scope === 'project');
    assert.deepEqual([back.length, back[0].on, back[0].id], [1, true, r.id]);
    assert.ok(removeRule('project', r.id, root));
    assert.equal(loadRules(root).filter((x) => x.scope === 'project').length, 0);
    assert.equal(updateRule('project', 'nope', { on: true }, root), null);
  }
  { // rules: each command a rule lets through counts one use; a chat rule's use goes to the page
    const { events, dir } = await agentRun((b, i) => [reply('', [['shell', { command: 'node build.js' }]]), reply('', [['shell', { command: 'node build.js --x' }]]), reply('Done.')][i], {
      prep: (d) => { buildJs(d); saveRules('project', [{ effect: 'allow', match: 'node build.js*', by: 'user' }], d); } });
    const r = loadRules(dir).find((x) => x.scope === 'project');
    assert.equal(r.hits, 2);
    assert.ok(r.lastUsed > Date.now() - 60e3);
    assert.equal(of(events, 'rule_used').length, 0, 'saved rules count in their file');
    const chat = await agentRun((b, i) => [reply('', [['shell', { command: 'node build.js' }]]), reply('Done.')][i], {
      prep: buildJs, more: { cmdRules: [{ id: 'c1', effect: 'allow', match: 'node build.js*', by: 'button' }, { id: 'c2', effect: 'allow', match: 'node other*', by: 'button', on: false }] } });
    assert.deepEqual(of(chat.events, 'rule_used').map((e) => e.id), ['c1']);
  }
});

test('helpers: an answer that isn\'t JSON fails its call at once, and UTF-8 characters split between chunks arrive whole', async () => {
  const { lineHost } = await import('../server/jobhost.js');
  const { spawn } = await import('node:child_process');
  // A stand-in helper: ready, then for each request an answer with a control byte in it (what "•" became), or a good
  // one whose "•" arrives split across two writes.
  const src = `process.stdout.write('{"ready":true}\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.op === 'bad') process.stdout.write('{"id":' + m.id + ',"ok":true,"text":"a \\u0007 b"}\\n'.replace('\\\\u0007', String.fromCharCode(7)));
  else { const b = Buffer.from(JSON.stringify({ id: m.id, ok: true, text: 'x • y' }) + '\\n'); const i = b.indexOf(0xe2) + 1; process.stdout.write(b.subarray(0, i)); setTimeout(() => process.stdout.write(b.subarray(i)), 50); }
});`;
  const h = lineHost(() => spawn(process.execPath, ['-e', src], { stdio: ['pipe', 'pipe', 'pipe'] }), { label: 'test helper' });
  const t0 = Date.now();
  await assert.rejects(h.call('bad', {}, 20000), /test helper's answer couldn't be read/);
  assert.ok(Date.now() - t0 < 5000, 'not after the 20 s timeout');
  assert.equal((await h.call('good', {}, 5000)).text, 'x • y');
});

test('Chrome off with no extension connected: no card, and the agent is told not to ask the user to tick it and retry', async () => {
  let cards = 0;
  const { bodies } = await agentRun((b, i) => [reply('', [['browser', { action: 'open', target: 'chrome:https://x.com/home' }]]), reply('OK.')][i], { chatId: 'chrome-off',
    onEvent: (e) => { if (e.t === 'approval' && e.tool === 'chrome') cards++; } });
  assert.equal(cards, 0);
  assert.match(toolOut(bodies, 1), /^Error: Chrome is off in this chat and the QuorX extension isn't connected to Chrome\..*Don't ask them to tick it and retry/);
});

test('shell: a declined program start points to desktop open; a declined OCR script to read_text', { skip: !WIN }, async () => {
  const { bodies } = await agentRun((b, i) => [
    reply('', [['shell', { command: 'Start-Process -FilePath "C:\\Windows\\System32\\notepad.exe"' }]]),
    reply('', [['shell', { command: 'powershell -File .quorx/scratch/ocr.ps1 shot.png' }]]),
    reply('OK.'),
  ][i], { chatId: 'shell-desk-way', onEvent: (e, id) => { if (e.t === 'approval' && e.mode === 'strict') setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } });
  assert.match(toolOut(bodies, 1), /use desktop open with app: "C:\\Windows\\System32\\notepad\.exe"/, toolOut(bodies, 1));
  assert.match(toolOut(bodies, 2), /read_text reads the words/, toolOut(bodies, 2));
});

test('plan first: a shell line that only reads runs before the plan; a change waits', { skip: !WIN }, async () => {
  const { bodies } = await agentRun((b, i) => [
    reply('', [['shell', { command: 'Get-ChildItem' }]]),
    reply('', [['shell', { command: 'Set-Content a.txt hi' }]]),
    reply('OK.'),
  ][i], { settings: { planFirst: 'always' } });
  assert.match(toolOut(bodies, 1), /Exit code 0/);
  assert.match(toolOut(bodies, 2), /^Refused: plan first.*Commands that only read/);
});

test('commands: unknown cmdlets with a reading verb are reads (Get-NetTCPConnection, Measure-Object); Get-Credential isn\'t', async () => {
  for (const line of ['Get-NetTCPConnection -LocalPort 5188', 'Get-Process | Measure-Object', 'Get-AppxPackage *calc*']) {
    const d = await decide(line, ctx({ shell: 'powershell' }));
    assert.equal(d.verdict, 'allow', line);
    assert.ok(d.segments.every((s) => s.cls === 'read'), line);
  }
  assert.notEqual((await decide('Get-Credential', ctx({ shell: 'powershell' }))).segments[0].cls, 'read');
});

// The sidebar's Running list: what runs in every project, each row with the project it belongs to; a project where
// nothing runs adds nothing.
test('running: the list for every project names each row’s project', { skip: !WIN }, async () => {
  const { runningAll } = await import('../server/running.js');
  const { termStart } = await import('../server/agentterm.js');
  const root = tmp('rlall');
  fs.writeFileSync(path.join(root, 'wait.js'), 'setTimeout(() => {}, 60000);\n');
  saveProject({ id: 'rlall', name: 'running list', path: root });
  const s = await termStart({ projectId: 'rlall', chatId: 'c1', cwd: root, line: 'node wait.js', shell: 'cmd' });
  try {
    const rows = runningAll(['rlquiet', 'rlall']);
    const row = rows.find((x) => x.id === `aterm:${s.id}`);
    assert.ok(row, JSON.stringify(rows));
    assert.equal(row.projectId, 'rlall');
    assert.equal(row.kind, 'agent-term');
    assert.equal(row.chatId, 'c1');
    assert.ok(!rows.some((x) => x.projectId === 'rlquiet'));
  } finally { await termStop(s.id).catch(() => {}); forgetProject('rlall'); }
});
