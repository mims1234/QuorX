// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Computer use: the desktop tool, app levels, the screen glow and the PowerShell helpers. The tests that open windows
// run on CI, and on a PC only through npm run test:desktop.
import './test-home.mjs';
import { WIN, UI_SKIP, FORM, formOpen, closeForm, tmp, pingsLeft, reply, agentRun, toolOut } from './safety-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runLine } from '../server/workspace.js';
import { lineHost, asciiJson } from '../server/jobhost.js';
import { glowOn, glowOff, glowRuns, glowLabel, onGlowStop, onGlowScreen, stopNow } from '../server/glow.js';
import { pickScreen } from '../server/workscreen.js';
import { spawn } from 'node:child_process';
import { saveRules } from '../server/cmdpolicy.js';
import { answerApproval, appLevel, setRunAccess } from '../server/agent.js';

test('look with no target right after desktop work looks at that window, not an empty browser tab', async () => {
  const { bodies } = await agentRun((b, i) => [
    reply('', [['desktop', { action: 'read', job: 'bg98' }]]),
    reply('', [['look', { checks: [{ ask: 'The window shows a number', my_guess: 'yes', my_confidence: 0.5 }] }]]),
    reply('OK.'),
  ][i]);
  assert.match(toolOut(bodies, 2), /bg98/, toolOut(bodies, 2));
  assert.doesNotMatch(toolOut(bodies, 2), /Nothing is open/);
});

// ---------- the agent's terminal and desktop apps (P1) ----------
const allow = (d, match) => { fs.mkdirSync(path.join(d, '.quorx'), { recursive: true }); saveRules('project', [{ effect: 'allow', match, by: 'user' }], d); };

// One window for the desktop tool's checks on the agent's own program (each test used to start its own): reading and
// driving it, keys never reaching other windows, steps, typing that replaces, a right-button drag, a "replace it?"
// Yes that asks first, and a window read until it settles.
test('desktop: the agent drives a WinForms app it started: read, click, keys, steps, typing, drag, a "replace it?" card, settling', { skip: UI_SKIP }, async () => {
  const app = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = 'QX Agent Form'; $f.Width = 540; $f.Height = 460
$l = New-Object Windows.Forms.Label; $l.Text = 'Count: 0'; $l.Top = 10; $l.Left = 10
$b = New-Object Windows.Forms.Button; $b.Text = 'Add one'; $b.Top = 40; $b.Left = 10; $b.Width = 120; $b.Height = 40
$script:n = 0; $b.Add_Click({ $script:n++; $l.Text = "Count: $script:n" })
$t = New-Object Windows.Forms.TextBox; $t.Text = 'model'; $t.Top = 90; $t.Left = 10; $t.Width = 200
$q = New-Object Windows.Forms.Label; $q.Text = 'model.vroid already exists. Do you want to replace it?'; $q.Top = 120; $q.Left = 10; $q.Width = 480
$y = New-Object Windows.Forms.Button; $y.Text = 'Yes'; $y.Top = 145; $y.Left = 10
$p = New-Object Windows.Forms.Panel; $p.Top = 180; $p.Left = 10; $p.Width = 300; $p.Height = 120; $p.BackColor = 'LightGray'
$pr = New-Object Windows.Forms.Label; $pr.Text = "Pressed $([char]0x2022) none"; $pr.Top = 305; $pr.Left = 10; $pr.Width = 300
$p.Add_MouseDown({ param($s, $e) $pr.Text = "Pressed: $($e.Button)" })
$st = New-Object Windows.Forms.Label; $st.Text = 'Idle'; $st.Top = 330; $st.Left = 10; $st.Width = 200
$ld = New-Object Windows.Forms.Button; $ld.Text = 'Load'; $ld.Top = 355; $ld.Left = 10
$tm = New-Object Windows.Forms.Timer; $tm.Interval = 1200; $tm.Add_Tick({ $st.Text = 'Loaded 42 items'; $tm.Stop() })
$ld.Add_Click({ $st.Text = 'Loading'; $tm.Start() })
$f.Controls.AddRange(@($l, $b, $t, $q, $y, $p, $pr, $st, $ld)); [void]$f.ShowDialog()`;
  let job = null, at = null, seen = null; // seen: the read after the steps, whose refs the later clicks use
  const cards = [];
  const ref = (b, label) => Number(toolOut([b], 0).match(new RegExp(`\\[(\\d+)\\] ${label}`))[1]);
  try {
    const { bodies } = await agentRun((b, i) => {
      if (i === 0) return reply('', [['shell', { command: 'powershell -NoProfile -ExecutionPolicy Bypass -File app.ps1', background: true }]]);
      if (i === 1) { job = toolOut([b], 0).match(/job (bg\d+)/)[1]; return reply('', [['desktop', { action: 'read', job }]]); }
      if (i === 2) { at = toolOut([b], 0).match(/Button "Add one" @(\d+),(\d+)/).slice(1).map(Number); return reply('', [['desktop', { action: 'click', job, ref: ref(b, 'Button "Add one"') }]]); }
      if (i === 3) return reply('', [['desktop', { action: 'keys', job, keys: 'qx' }]]);
      if (i === 4) return reply('', [['desktop', { action: 'read', job: 'bg9999' }]]);
      if (i === 5) return reply('', [['desktop', { job, steps: [{ action: 'double_click', x: at[0], y: at[1] }, { action: 'wait_for', text: 'Count: 3', seconds: 5 }, { action: 'zoom', x: 0, y: 0, width: 150, height: 80 }, { action: 'resize', width: 560, height: 480 }] }]]);
      if (i === 6) return reply('', [['desktop', { action: 'read', job }]]);
      if (i === 7) { seen = b; return reply('', [['desktop', { action: 'type', job, ref: ref(seen, 'Edit'), text: 'rem-rezero' }]]); }
      if (i === 8) return reply('', [['desktop', { action: 'click', job, ref: ref(seen, 'Button "Yes"') }]]);
      if (i === 9) return reply('', [['desktop', { action: 'drag', job, x: 60, y: 230, to_x: 200, to_y: 270, button: 'right' }]]);
      if (i === 10) return reply('', [['desktop', { action: 'click', job, ref: ref(seen, 'Button "Load"') }]]);
      if (i === 11) return reply('', [['job_stop', { job }]]);
      return reply('Done.');
    }, { prep: (d) => { fs.writeFileSync(path.join(d, 'app.ps1'), app); allow(d, 'powershell -noprofile -executionpolicy bypass -file app.ps1*'); },
      onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'desktop') { cards.push(e); setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
    assert.match(toolOut(bodies, 2), /Window \d+:[\s\S]*Text "Count: 0"[\s\S]*\[\d+\] Button "Add one"/);
    // A "•" in a window's text comes through whole (in the console's own code page it was a control byte that made the
    // helper's answer unreadable, and every read waited out its timeout).
    assert.match(toolOut(bodies, 2), /Text "Pressed • none"/);
    assert.match(toolOut(bodies, 3), /pressed[\s\S]*Count: 1/);
    // Keys go to the app's own window, or (when Windows keeps another window in front) nowhere: never to that window.
    assert.match(toolOut(bodies, 4), /sent the keys|Windows kept another window in front, so nothing was typed/);
    assert.match(toolOut(bodies, 5), /no background job bg9999/);
    const steps = toolOut(bodies, 6);
    assert.match(steps, /^Ran 4 of 4 steps:/, steps);
    assert.match(steps, /2\. wait_for "Count: 3": "Count: 3" is there/, 'the double click reached the button through the same pixels the read gave');
    assert.match(steps, /3\. zoom at 0,0: Zoomed in/);
    assert.match(steps, /4\. resize: resized it to 560x480/);
    assert.match(toolOut(bodies, 8), /^typed it \(it held "model" before\); it now holds "rem-rezero"/, toolOut(bodies, 8));
    assert.match(toolOut(bodies, 9), /^The user didn't let you click “Yes”.*Answer the dialog the safe way/, toolOut(bodies, 9));
    assert.match(cards[0]?.why || '', /already exists\. Do you want to replace it\?/);
    assert.match(toolOut(bodies, 10), /^right-dragged from 60,230 to 200,270[\s\S]*Pressed: Right/, toolOut(bodies, 10));
    assert.match(toolOut(bodies, 11), /Loaded 42 items/, 'read until it settled, not at "Loading"');
    assert.match(toolOut(bodies, 12), /0 processes left/);
  } finally { closeForm('QX Agent Form'); }
});

// ---------- apps stay open after use (last: it starts background jobs) ----------
// A program a command opened and left showing a window is what the command was for: it stays open, outside QuorX's
// job, so the agent and the user can keep using it. Windowless leftovers (a stray ping) are still ended.
test('stop: a window a command opened stays open after it; a windowless leftover is still ended', { skip: UI_SKIP }, async () => {
  const root = tmp('kept');
  fs.writeFileSync(path.join(root, 'form.ps1'), FORM('QX Kept Form'));
  try {
    const r = await runLine(root, "Start-Process powershell -ArgumentList '-NoProfile','-File','form.ps1'", { shell: 'powershell' });
    assert.ok(r.leftovers?.kept?.some((n) => /powershell/i.test(n)), JSON.stringify(r.leftovers));
    assert.match(r.out, /kept open: .*powershell\.exe/i);
    await new Promise((x) => setTimeout(x, 500));
    assert.ok(formOpen('QX Kept Form'), 'the form is still open');
    const p = await runLine(root, 'start /b ping -n 30 127.0.0.1 >nul & echo started', { shell: 'cmd' });
    assert.ok(p.leftovers?.ended?.some((n) => /ping/i.test(n)) && !p.leftovers.kept, JSON.stringify(p.leftovers));
    assert.equal(pingsLeft(), 0);
  } finally { closeForm('QX Kept Form'); }
});

test('desktop: a background job whose launcher exits keeps running while its window is open, and job_stop ends it', { skip: UI_SKIP }, async () => {
  let job = null;
  try {
    const { bodies } = await agentRun((b, i) => {
      if (i === 0) return reply('', [['shell', { command: "Start-Process powershell -ArgumentList '-NoProfile','-File','form.ps1'", background: true }]]);
      if (i === 1) { job = toolOut([b], 0).match(/job (bg\d+)/)[1]; return reply('', [['desktop', { action: 'windows', job }]]); }
      if (i === 2) return reply('', [['job_stop', { job }]]);
      return reply('Done.');
    }, { prep: (d) => { fs.writeFileSync(path.join(d, 'form.ps1'), FORM('QX Bg Form')); allow(d, 'start-process powershell*'); } });
    assert.match(toolOut(bodies, 2), /QX Bg Form/, 'the job still reaches the window after its launcher exited');
    assert.match(toolOut(bodies, 3), /0 processes left/);
    assert.equal(formOpen('QX Bg Form'), false);
  } finally { closeForm('QX Bg Form'); }
});

// desktop open needs the Start menu, which CI's Windows Server images may not have.
test('desktop open: an app the user doesn’t allow is not opened; an unknown name says so', { skip: !WIN || !!process.env.CI }, async () => {
  let card = null;
  const { bodies } = await agentRun((b, i) => [
    reply('', [['desktop', { action: 'open', app: 'No Such App Qx' }]]),
    reply('', [['desktop', { action: 'open', app: 'Calculator' }]]),
    reply('', [['desktop', { action: 'read', app: 'Calculator' }]]),
    reply('OK.'),
  ][i], { chatId: 'apps-chat', settings: { appsAccess: true }, onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'desktop') { card = e; setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
  assert.match(toolOut(bodies, 1), /no app called "No Such App Qx"/);
  assert.match(card?.what || '', /Calculator on your computer/);
  assert.match(toolOut(bodies, 2), /didn't allow Calculator/);
  assert.match(toolOut(bodies, 3), /isn't open for this chat yet/, 'a declined app stays out of reach');
});

test('computer use: each app starts at its kind’s level, an action above it asks once to raise it, and with computer use off or an app not allowed nothing is driven', async () => {
  { // computer use: each app starts at its kind’s level; some are never used
    assert.equal(appLevel('Calculator'), 'full');
    assert.equal(appLevel('Brave'), 'view', 'browsers: the browser tool acts there');
    assert.equal(appLevel('Google Chrome'), 'view');
    assert.equal(appLevel('File Explorer'), 'view', 'it can delete files');
    assert.equal(appLevel('Visual Studio Code'), 'click', 'commands go through shell');
    assert.equal(appLevel('Windows Terminal'), 'click');
    for (const n of ['Claude', 'QuorX', 'Electron', '1Password', 'Bitwarden']) assert.equal(appLevel(n), 'full', n);
    for (const n of ['Registry Editor', 'Task Manager', 'Windows PowerShell (Admin)', 'Keychain Access', 'Disk Utility', 'GParted']) assert.equal(appLevel(n), 'never', n);
  }
  { // computer use: an action above an app's level asks once to raise it; yes raises it for the chat
    const apps = [{ name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', level: 'view' }];
    const cards = [];
    const { events, bodies } = await agentRun((b, i) => [
      reply('', [['desktop', { action: 'scroll', app: 'Calculator', direction: 'down' }]]),
      reply('', [['desktop', { action: 'keys', app: 'Calculator', keys: '1' }]]),
      reply('OK.'),
    ][i], { chatId: 'apps-raise', settings: { appsAccess: true }, more: { apps },
      onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'desktop') { cards.push(e.what); setTimeout(() => answerApproval(id, e.id, { approve: /click$/.test(e.what) }), 10); } } });
    assert.deepEqual(cards, ['Let the agent click in Calculator · view → click', 'Let the agent type and use keys in Calculator · click → full']);
    assert.doesNotMatch(toolOut(bodies, 1), /isn't allowed/, 'raised to click, so the scroll went ahead');
    assert.match(toolOut(bodies, 2), /look, click, scroll and drag, not type in Calculator, so keys isn't allowed/, 'declined: the level stays');
    assert.deepEqual(events.filter((e) => e.t === 'app_allowed').map((e) => e.app.level), ['click']);
  }
  { // computer use: off in a chat, the user’s apps are out of reach; on, each app is held to its level
    let cards = 0;
    const off = await agentRun((b, i) => [reply('', [['desktop', { action: 'open', app: 'Calculator' }]]), reply('', [['desktop', { action: 'read', app: 'Calculator' }]]), reply('OK.')][i], { chatId: 'apps-off',
      onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'computer_use') { cards++; setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
    assert.match(toolOut(off.bodies, 1), /computer use is off in this chat and the user kept it off/);
    assert.match(toolOut(off.bodies, 2), /computer use is off in this chat/);
    if (WIN) assert.equal(cards, 1, 'one card per reply');
    assert.ok(!off.events.some((e) => e.t === 'control' && e.kind === 'desktop'), 'kept off: it never drives the desktop (no glow, no compact QuorX)');
    const apps = [{ name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', level: 'view' }, { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode', level: 'click' }, { name: 'Registry Editor', appId: 'regedit', level: 'full' }];
    const on = await agentRun((b, i) => [
      reply('', [['desktop', { action: 'type', app: 'Calculator', ref: 1, text: '12' }]]),
      reply('', [['desktop', { action: 'keys', app: 'Visual Studio Code', keys: '^s' }]]),
      reply('', [['desktop', { action: 'read', app: 'Registry Editor' }]]),
      reply('OK.'),
    ][i], { chatId: 'apps-on', settings: { appsAccess: true }, more: { apps }, onEvent: keepLevel });
    assert.match(toolOut(on.bodies, 1), /look at only .* in Calculator, so type isn't allowed/);
    assert.match(toolOut(on.bodies, 2), /look, click, scroll and drag, not type in Visual Studio Code, so keys isn't allowed. For a command, use shell/);
    assert.match(toolOut(on.bodies, 3), /isn't open for this chat yet/, 'a never-used app is dropped even if the page sends it');
    assert.match(JSON.stringify(on.bodies[0].messages.at(-1).content), /Computer use\)[\s\S]*Allowed so far: Calculator \(view\), Visual Studio Code \(click\)/);
  }
  { // computer use: an app the user doesn’t allow is never driven: no glow, no banner, QuorX stays as it was
    const asked = [], seen = [];
    const { events, bodies } = await agentRun((b, i) => [reply('', [['desktop', { action: 'open', app: 'Calculator' }]]), reply('OK.')][i], { chatId: 'apps-refused', settings: { appsAccess: true },
      onEvent: (e, id) => { seen.push(e); if (e.t === 'approval' && e.tool === 'desktop') { asked.push(seen.some((x) => x.t === 'control' && x.kind === 'desktop')); setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
    assert.ok(!events.some((e) => e.t === 'control' && e.kind === 'desktop'), 'not before the question, nor after the no');
    if (WIN) { assert.deepEqual(asked, [false], 'asked once, while nothing was driven'); assert.match(toolOut(bodies, 1), /The user didn't allow Calculator/); }
  }
});

// Answers "Let the agent … in <app>" (raising an app's level) with no, so a test sees the level hold.
const keepLevel = (e, id) => { if (e.t === 'approval' && e.tool === 'desktop' && /^Let the agent/.test(e.what || '')) setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); };

test('computer use: steps keep to each app’s level, stop at the first refusal and take the app from the step before; saved apps count', async () => {
  { // computer use: the new actions keep to each app’s level, and steps stop at the first refusal
    const apps = [{ name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', level: 'view' }, { name: 'Paint', appId: 'Microsoft.Paint_8wekyb3d8bbwe!App', level: 'click' }];
    const { bodies } = await agentRun((b, i) => [
      reply('', [['desktop', { action: 'path', app: 'Calculator', points: [[1, 1], [5, 5]] }]]),
      reply('', [['desktop', { action: 'clipboard', app: 'Paint' }]]),
      reply('', [['desktop', { app: 'Paint', steps: [{ action: 'hold_key', key: 'shift' }, { action: 'drag', x: 1, y: 1, to_x: 5, to_y: 5 }] }]]),
      reply('OK.'),
    ][i], { chatId: 'apps-levels', settings: { appsAccess: true }, more: { apps }, onEvent: keepLevel });
    assert.match(toolOut(bodies, 1), /look at only .* in Calculator, so path isn't allowed/, 'a freehand stroke needs the click level, like drag');
    assert.match(toolOut(bodies, 2), /in Paint, so clipboard isn't allowed/);
    assert.match(toolOut(bodies, 3), /^Ran 1 of 2 steps:\n1\. hold_key: Error: .*so hold_key isn't allowed/, 'the second step never ran');
  }
  { // computer use: steps take the app from the step before when only the first names it
    const apps = [{ name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', level: 'view' }];
    const { bodies } = await agentRun((b, i) => [
      reply('', [['desktop', { steps: [{ action: 'scroll', app: 'Calculator', direction: 'down' }] }]]),
      reply('', [['desktop', { steps: [{ action: 'keys', app: 'Calculator', keys: '1' }, { action: 'type', ref: 1, text: '2' }] }]]),
      reply('OK.'),
    ][i], { chatId: 'apps-steps-inherit', settings: { appsAccess: true }, more: { apps }, onEvent: keepLevel });
    assert.match(toolOut(bodies, 1), /in Calculator, so scroll isn't allowed/, 'a step\'s own app counts');
    assert.match(toolOut(bodies, 2), /^Ran 1 of 2 steps:\n1\. keys 1: Error: .*in Calculator, so keys isn't allowed/);
  }
  { // computer use: the chat's saved apps count even when the page sends none
    const { saveChat } = await import('../server/store.js');
    const chatId = 'cmsavedapps1';
    saveChat(chatId, { id: chatId, title: 't', projectId: 'scratch', agent: { messages: [], artifacts: {}, apps: [{ name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', level: 'view' }] } });
    const { bodies } = await agentRun((b, i) => [reply('', [['desktop', { action: 'type', app: 'Calculator', ref: 1, text: '1' }]]), reply('OK.')][i], { chatId, settings: { appsAccess: true }, more: { apps: [] }, onEvent: keepLevel });
    assert.match(toolOut(bodies, 1), /look at only .* in Calculator/, 'known from the chat file, held to its level');
  }
});

// ---------- Phase 5: white captures, text from pictures, app lifetime, remembered apps ----------
test('desktop: a flat white capture is taken again from the screen; a window\'s text is read from its picture', { skip: UI_SKIP }, async () => {
  const { windowShot, shotVia, windowText } = await import('../server/uia.js');
  const { startBackground, stopBackground } = await import('../server/bgjobs.js');
  const root = tmp('flat');
  fs.writeFileSync(path.join(root, 'white.ps1'), "Add-Type -AssemblyName System.Windows.Forms\n$f = New-Object Windows.Forms.Form; $f.Text = 'QX White Form'; $f.BackColor = 'White'; $f.Width = 420; $f.Height = 260\n[void]$f.ShowDialog()\n");
  fs.writeFileSync(path.join(root, 'words.ps1'), "Add-Type -AssemblyName System.Windows.Forms\n$f = New-Object Windows.Forms.Form; $f.Text = 'QX Words Form'; $f.BackColor = 'White'; $f.Width = 520; $f.Height = 260\n$l = New-Object Windows.Forms.Label; $l.Text = 'Hello Rem Studio'; $l.Font = New-Object Drawing.Font('Segoe UI', 20); $l.AutoSize = $true; $l.Top = 60; $l.Left = 40\n$f.Controls.Add($l); [void]$f.ShowDialog()\n");
  const jobs = [];
  try {
    for (const f of ['white.ps1', 'words.ps1']) jobs.push(startBackground({ projectId: 'flat', cwd: root, line: `powershell -NoProfile -ExecutionPolicy Bypass -File ${f}`, shell: 'powershell', label: f }));
    await new Promise((r) => setTimeout(r, 3500));
    await windowShot(jobs[0].id, null);
    assert.match(shotVia(), /flat/, `a flat picture is noticed and taken again from the screen when Windows lets it (${shotVia()})`);
    const t = await windowText(jobs[1].id, null);
    assert.match(t.text, /"Hello Rem Studio" @\d+,\d+/, t.text);
  } finally { for (const j of jobs) await stopBackground(j.id).catch(() => {}); closeForm('QX White Form'); closeForm('QX Words Form'); }
});

test('desktop: a background job\'s window survives QuorX letting go of its job (a restart)', { skip: UI_SKIP }, async () => {
  const { runLine } = await import('../server/workspace.js');
  const { closeJob } = await import('../server/jobhost.js');
  const root = tmp('keepjob');
  fs.writeFileSync(path.join(root, 'form.ps1'), FORM('QX Keep Job Form'));
  let proc = null;
  try {
    runLine(root, 'powershell -NoProfile -ExecutionPolicy Bypass -File form.ps1', { shell: 'powershell', untilEmpty: true, timeout: 60e3, onStart: (p) => { proc = p; } });
    for (let i = 0; i < 20 && !formOpen('QX Keep Job Form'); i++) await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 2500)); // the job notices the window and keeps it
    await closeJob(proc.qxJob); // what QuorX quitting does to every job
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(formOpen('QX Keep Job Form'), 'the window is still open');
  } finally { closeForm('QX Keep Job Form'); }
});

test('desktop screenshot: named by reply too, and a model that can\'t see is pointed to read_text (the user hears once)', { skip: UI_SKIP }, async () => {
  let job = null;
  try {
    const { bodies, events, id } = await agentRun((b, i) => {
      if (i === 0) return reply('', [['shell', { command: 'powershell -NoProfile -ExecutionPolicy Bypass -File form.ps1', background: true }]]);
      if (i === 1) { job = toolOut([b], 0).match(/job (bg\d+)/)[1]; return reply('', [['desktop', { action: 'screenshot', job }]]); }
      if (i === 2) return reply('', [['desktop', { action: 'screenshot', job }]]);
      return reply('Done.');
    }, { prep: (d) => { fs.writeFileSync(path.join(d, 'form.ps1'), FORM('QX Shot Name Form')); allow(d, 'powershell -noprofile -executionpolicy bypass -file form.ps1*'); } });
    const out = toolOut(bodies, 2);
    assert.match(out, new RegExp(`Saved as \\.quorx/scratch/shots/${job}-${id.slice(-5)}-1\\.png`), out);
    assert.match(out, /use read_text for the words in its picture/);
    assert.equal(events.filter((e) => e.t === 'note' && /can't see pictures/.test(e.msg)).length, 1, 'said once per reply');
  } finally { closeForm('QX Shot Name Form'); }
});

test('desktop type: a Save dialog\'s file name is replaced, not added to', { skip: UI_SKIP }, async () => {
  const app = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object Windows.Forms.SaveFileDialog; $d.Title = 'QX Save Test'; $d.FileName = 'bat.png'; $d.InitialDirectory = $env:TEMP
[void]$d.ShowDialog()`;
  let job = null;
  try {
    const { bodies } = await agentRun((b, i) => {
      if (i === 0) return reply('', [['shell', { command: 'powershell -NoProfile -ExecutionPolicy Bypass -File save.ps1', background: true }]]);
      if (i === 1) { job = toolOut([b], 0).match(/job (bg\d+)/)[1]; return reply('', [['desktop', { action: 'wait_for', job, text: 'File name', seconds: 15 }]]); }
      if (i === 2) return reply('', [['desktop', { action: 'read', job }]]);
      if (i === 3) { const ref = Number(toolOut([b], 0).match(/\[(\d+)\] (?:Edit|ComboBox) "File name:"/)?.[1]); return reply('', [['desktop', { action: 'type', job, ref, text: 'C:\\Temp\\quorx-bat.png' }]]); }
      if (i === 4) return reply('', [['job_stop', { job }]]);
      return reply('Done.');
    }, { prep: (d) => { fs.writeFileSync(path.join(d, 'save.ps1'), app); allow(d, 'powershell -noprofile -executionpolicy bypass -file save.ps1*'); } });
    assert.match(toolOut(bodies, 3), /(\[\d+\] (Edit|ComboBox) "File name:")/, 'the File name box is in the read, not cut off by the folder tree');
    assert.match(toolOut(bodies, 4), /^typed it \(it held "bat(\.png)?" before\); it now holds "C:\\Temp\\quorx-bat\.png"/, toolOut(bodies, 4));
    assert.ok(toolOut(bodies, 3).length < 9000, `the folder tree and file rows are collapsed (${toolOut(bodies, 3).length} chars)`);
  } finally { closeForm('QX Save Test'); }
});

test('app notes: learned points are kept per app across chats, without repeats, and only for apps the chat opened', async () => {
  const { readNotes, addNotes } = await import('../server/appnotes.js');
  addNotes('app', 'Paint 11.2', '- New shapes stay selected: click outside before drawing the next\nCtrl+A selects the whole canvas');
  addNotes('app', 'paint', 'Ctrl+A selects the whole canvas\n- Text tool: click the canvas, then type');
  const n = readNotes('app', 'Paint');
  assert.equal(n.split('\n').length, 3, n);
  assert.match(n, /^- New shapes stay selected/);
  const apps = [{ name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode', level: 'view' }];
  const { bodies } = await agentRun((b, i) => [
    reply('', [['desktop', { action: 'learn', app: 'Visual Studio Code', text: 'Cline opens from View > Open View > Cline' }]]),
    reply('', [['desktop', { action: 'learn', app: 'Notepad', text: 'x' }]]),
    reply('OK.'),
  ][i], { chatId: 'appnotes1', settings: { appsAccess: true }, more: { apps } });
  assert.match(toolOut(bodies, 1), /^Saved for Visual Studio Code/);
  assert.match(readNotes('app', 'Visual Studio Code'), /Open View > Cline/);
  assert.match(toolOut(bodies, 2), /^Error: give app: the name of an app this chat opened \("Notepad" isn't one\)/);
});

test('desktop open: app names match loosely (spaces, case, version numbers)', { skip: !WIN || !!process.env.CI }, async () => {
  const { findApps } = await import('../server/uia.js');
  for (const n of ['Calculator', 'calculator', 'Calcu lator', 'CALCULATOR 11.2']) assert.equal((await findApps(n))[0]?.name, 'Calculator', n);
});

test('computer use off: one card turns it on for the chat, and the desktop call goes ahead', { skip: !WIN }, async () => {
  const { events, bodies } = await agentRun((b, i) => [reply('', [['desktop', { action: 'type', app: 'Calculator', ref: 1, text: '1' }]]), reply('OK.')][i], { chatId: 'apps-ask-on',
    more: { apps: [{ name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', level: 'view' }] },
    onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'computer_use') setTimeout(() => answerApproval(id, e.id, { approve: true }), 10); keepLevel(e, id); } });
  assert.ok(events.some((e) => e.t === 'tools_on' && e.kinds.includes('apps')), 'the page hears it is on');
  assert.match(toolOut(bodies, 1), /look at only .* in Calculator/, 'past the switch, held to the app\'s level');
});

test('the card that turns on computer use takes only a click: typed words don’t answer it, and switching to YOLO doesn’t either', { skip: !WIN }, async () => {
  const tries = [];
  const { events } = await agentRun((b, i) => [reply('', [['desktop', { action: 'running' }]]), reply('OK.')][i], { chatId: 'apps-button-only',
    onEvent: (e, id) => {
      if (e.t !== 'approval' || e.tool !== 'computer_use') return;
      tries.push(e.buttonsOnly === true);
      setTimeout(() => {
        tries.push(answerApproval(id, e.id, { reply: 'ok turn it on and do it' }));
        setTimeout(() => tries.push(answerApproval(id, e.id, { approve: true })), 10);
      }, 10);
    } });
  assert.deepEqual(tries, [true, false, true], 'marked, the typed reply refused, the click taken');
  assert.ok(events.some((e) => e.t === 'tools_on' && e.kinds.includes('apps')));
});

test('computer use switched off while a reply runs: its next app action is refused, and no card asks to turn it back on', async () => {
  let cards = 0, off = false;
  const apps = [{ name: 'Calculator', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', level: 'full' }];
  const { events, bodies } = await agentRun((b, i) => [reply('', [['shell', { command: 'echo hi' }]]), reply('', [['desktop', { action: 'read', app: 'Calculator' }]]), reply('OK.')][i], {
    chatId: 'apps-off-mid', settings: { appsAccess: true }, more: { apps },
    onEvent: (e, id) => { if (e.t === 'tool' && !off) { off = true; assert.ok(setRunAccess(id, { apps: false })); } if (e.t === 'approval' && e.tool === 'computer_use') cards++; } });
  assert.match(toolOut(bodies, 2), /^Error: computer use is off in this chat and the user kept it off/);
  assert.equal(cards, 0);
  assert.ok(events.some((e) => e.t === 'access' && e.kind === 'apps' && e.on === false), 'the reply notes it');
});

test('decide: a question about the screen with no picture is refused, or takes the last desktop picture', async () => {
  const { bodies } = await agentRun((b, i) => [
    reply('', [['decide', { state: 'The window shows a red tile', questions: [{ type: 'noul', ask: 'The tile in the screenshot is red', my_guess: 'yes', my_confidence: 0.9 }] }]]),
    reply('OK.'),
  ][i]);
  assert.match(toolOut(bodies, 1), /^Error: these questions are about what is on screen, but no picture was given/);
});

test('the screen glow is on while a reply uses the desktop, makes room once per stretch, and Stop ends exactly those replies', () => {
  { // the screen glow is on while a reply uses the desktop; your Stop ends exactly those replies
    const stopped = [];
    onGlowStop((runs, how) => stopped.push([runs, how]));
    glowOn('run-a', 'Paint a bat'); glowOn('run-b', 'Discord drop'); glowOn('run-a', 'Paint a bat');
    assert.deepEqual(glowRuns(), ['run-a', 'run-b'], 'once per reply');
    assert.equal(glowLabel(), 'QuorX is using computer use', 'no app named yet');
    glowOn('run-a', 'Paint a bat', 'Paint'); glowOn('run-b', 'Discord drop', 'Discord');
    assert.equal(glowLabel(), 'QuorX is using Paint, Discord', 'the banner names the apps in use');
    assert.deepEqual(glowRuns(), ['run-a', 'run-b'], 'naming the app adds no reply');
    glowOff('run-b');
    assert.deepEqual(glowRuns(), ['run-a'], 'a reply that ends leaves it');
    glowOn('run-c', 'VS Code');
    assert.deepEqual(stopNow('keys'), ['run-a', 'run-c']);
    assert.deepEqual(stopped, [[['run-a', 'run-c'], 'keys']]);
    assert.deepEqual(glowRuns(), [], 'and the glow goes');
    assert.deepEqual(stopNow('button'), [], 'nothing left to stop');
  }
  { // the glow starts making room at once, once per stretch of desktop use, and ends it when the last reply ends
    const calls = [];
    onGlowScreen((chatId) => { calls.push(['start', chatId]); return { x: -1680, y: 32, w: 1680, h: 1050 }; }, () => calls.push(['end']));
    glowOn('run-1', 'chat-a');
    assert.deepEqual(calls, [['start', 'chat-a']], 'started in the same tick, so the first action waits for its screen');
    glowOn('run-2', 'chat-b');
    glowOff('run-1');
    assert.deepEqual(calls, [['start', 'chat-a']], 'still in use by run-2');
    glowOff('run-2');
    assert.deepEqual(calls, [['start', 'chat-a'], ['end']]);
    onGlowScreen(() => null, () => {});
  }
});

test('computer use works on one screen: one that is not the main one (the largest), else the only one', () => {
  const scr = (w, h, primary = false, x = 0) => ({ bounds: { x, y: 0, w, h }, work: { x, y: 0, w, h: h - 40 }, primary });
  const main = scr(1920, 1080, true), small = scr(1280, 720, false, -1280), big = scr(2560, 1440, false, 1920);
  assert.equal(pickScreen([main]), main, 'one screen: that one');
  assert.equal(pickScreen([main, small]), small, 'two: the other one');
  assert.equal(pickScreen([small, main, big]), big, 'several others: the largest');
  assert.equal(pickScreen([]), null);
  assert.equal(pickScreen([{ bounds: { w: 0, h: 0 } }, main]), main, 'a screen with no size is skipped');
});

test('the PowerShell helpers: plain ASCII requests, unasked messages (Stop pressed), and ending and restarting at once', async () => {
  { // a helper can say things unasked (Stop pressed), and can be ended at once and started again
    // A stand-in helper: ready, then for each request an unasked event before its answer.
    const code = "process.stdout.write(JSON.stringify({ready:true})+String.fromCharCode(10));require('readline').createInterface({input:process.stdin}).on('line',(l)=>{const m=JSON.parse(l);process.stdout.write(JSON.stringify({event:'stop',how:'button'})+String.fromCharCode(10));if(m.op!=='hang')process.stdout.write(JSON.stringify({id:m.id,ok:true,pid:process.pid})+String.fromCharCode(10));});";
    const events = [];
    const h = lineHost(() => spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }), { label: 'test helper', onEvent: (m) => events.push(m) });
    const first = await h.call('show');
    assert.equal(first.ok, true);
    assert.deepEqual(events, [{ event: 'stop', how: 'button' }]);
    const hanging = h.call('hang', {}, 20000);
    while (events.length < 2) await new Promise((r) => setTimeout(r, 20)); // it got the request and is busy with it
    assert.equal(h.kill(), true);
    await assert.rejects(hanging, /stopped/, 'what it was doing fails at once, not at its timeout');
    const again = await h.call('show');
    assert.notEqual(again.pid, first.pid, 'the next call starts a new helper');
    h.kill();
  }
  { // requests to the PowerShell helpers are plain ASCII, so quotes, accents and emoji arrive intact
    const v = { text: '“Paint” is using your computer · é 🐱', n: 1 };
    const s = asciiJson(v);
    assert.ok(/^[ -~]*$/.test(s), s);
    assert.deepEqual(JSON.parse(s), v);
  }
});

