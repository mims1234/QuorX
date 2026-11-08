// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// QuorX UI test: starts the QuorX desktop app from this checkout, with its own data folder and port, drives its
// window the way a person would, and saves a screenshot of every step with an HTML report.
//
//   npm run test:ui                         both scenarios
//   npm run test:ui -- --scenario settings  only the checks that need no key
//   npm run test:ui -- --scenario cli       the agent builds a Rust command-line program
//   npm run test:ui -- --scenario running   the Running tab: what runs, who started it, Stop and Stop all
//   npm run test:ui -- --scenario news      News: the dot, What's new, the sample article, Play on a flow, a compare
//   npm run test:ui -- --scenario perf      heavy chats one after another, with the performance readout's numbers
//                                           (only when asked: not part of "all"; --chats N, default 8; --pic-size N for picture size; --turns N adds
//                                           N earlier rounds of long replies to each chat, default 0)
//   npm run test:ui -- --scenario tabs      hidden browser tabs go to sleep and wake where they were (only when asked)
//   npm run test:ui -- --scenario preview   a 3D preview in the pane: what it costs shown, hidden and left (only when asked)
//   add --keep to leave the app open afterwards
//
// The test copy keeps its own chats, projects and keys in .uitest/home (git ignores it), and runs on port 5197, so
// your own QuorX and its data are never touched. The cli scenario needs an OpenRouter key in that copy: set
// OPENROUTER_API_KEY when you start the test, or add one in the window when it asks (⚙ Settings → Providers; it
// waits up to 10 minutes). Screenshots and report.html go to .uitest/runs/<time>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectToolchains } from '../server/toolchains.js';
import { saveTestResult } from './test-results.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const SCENARIO = arg('scenario', 'all');
const KEEP = !!arg('keep', false);
const PORT = Number(process.env.QX_UITEST_PORT || 5197);
const CDP = Number(process.env.QX_UITEST_CDP || 9357);
const BASE = path.join(ROOT, '.uitest');
const HOME = path.join(BASE, 'home');
const USERDATA = path.join(BASE, 'userdata');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(BASE, 'runs', STAMP);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
if (!fs.existsSync(path.join(BASE, '.gitignore'))) fs.writeFileSync(path.join(BASE, '.gitignore'), '*\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[ui-test ${new Date().toLocaleTimeString()}]`, ...a);

// ---------- the app ----------
let appProc = null;
async function free(port) { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); return false; } catch { return true; } }
async function launch() {
  const exe = path.join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', WIN ? 'electron.exe' : 'electron');
  if (!fs.existsSync(exe)) throw new Error('Electron is not installed here: run npm run desktop:setup first');
  if (!(await free(PORT))) throw new Error(`port ${PORT} is already in use (another test copy still open?). Close it, or set QX_UITEST_PORT`);
  const env = { ...process.env, OH_USER_DATA: USERDATA, OH_HOME: HOME, AGENT_PORT: String(PORT), ...(SCENARIO === 'tabs' && !process.env.QX_TAB_SLEEP_MS ? { QX_TAB_SLEEP_MS: '15000' } : {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  const logFile = fs.openSync(path.join(OUT, 'app.log'), 'a');
  appProc = spawn(exe, [path.join(ROOT, 'desktop'), `--remote-debugging-port=${CDP}`], { env, stdio: ['ignore', logFile, logFile], windowsHide: false });
  log(`QuorX desktop (test copy) starting on port ${PORT}, data in ${HOME}`);
}
function quit() {
  if (!appProc || KEEP) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(appProc.pid), '/T', '/F'], { windowsHide: true });
  else appProc.kill();
}

// ---------- a small DevTools client for the app's window ----------
let ws = null, seq = 0;
const waiting = new Map();
async function connect() {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === 'page' && [`http://quorx.localhost:${PORT}`, `http://localhost:${PORT}`].some((o) => t.url.startsWith(o))); } catch { /* starting */ }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('the QuorX window did not appear within a minute (see app.log)');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('could not connect to the window')); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } };
  await send('Page.enable');
  await send('Runtime.enable');
}
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (waiting.delete(id)) rej(new Error(`${method} timed out`)); }, 30000); });
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, ms = 15000, what = 'it') {
  const t0 = Date.now();
  for (;;) {
    const v = await js(`return (${expr});`).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}
const q = (s) => JSON.stringify(s);
const click = (sel) => js(`const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.scrollIntoView({ block: 'center' }); e.click(); return true;`);
const fill = (sel, text) => js(`const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ' + ${q(sel)}); e.focus(); e.value = ${q(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
const textOf = (sel) => js(`return document.querySelector(${q(sel)})?.innerText || '';`);
const api = (p, body) => js(`const r = await fetch(${q(p)}, ${body ? `{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${q(JSON.stringify(body))} }` : '{}'}); return r.json();`);

// ---------- steps, screenshots and the report ----------
const steps = [];
let shotN = 0;
async function shot(title) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${String(++shotN).padStart(2, '0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}.png`;
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  return file;
}
async function step(title, fn) {
  const t0 = Date.now();
  let ok = true, note = '';
  try { note = (await fn()) || ''; } catch (e) { ok = false; note = e.message; }
  let img = null;
  try { img = await shot(title); } catch { /* the window is gone */ }
  steps.push({ title, ok, note: String(note), img, ms: Date.now() - t0 });
  log(`${ok ? '✓' : '✗'} ${title}${note ? ` — ${String(note).split('\n')[0].slice(0, 160)}` : ''}`);
  return ok;
}
// A screenshot during a long wait, with what it shows.
async function moment(title, note = '') { const img = await shot(title).catch(() => null); steps.push({ title, ok: true, note, img, ms: 0, moment: true }); log(`· ${title}`); }

function report() {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const passed = steps.filter((s) => !s.moment && s.ok).length, total = steps.filter((s) => !s.moment).length;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QuorX UI test ${STAMP}</title>
<style>:root{color-scheme:light dark;--bg:#f7f8f7;--fg:#141a17;--muted:#5a6762;--line:#d6ddd9;--ok:#1f7a4d;--bad:#c2343a}@media (prefers-color-scheme:dark){:root{--bg:#0b0f0d;--fg:#e7edea;--muted:#8a9a93;--line:#1f2a25;--ok:#3cc47f;--bad:#f0676b}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.sum{color:var(--muted);margin:0 0 24px}
.st{border-top:1px solid var(--line);padding:16px 0}.st h2{font-size:15px;margin:0 0 4px;display:flex;gap:8px;align-items:baseline}.ok{color:var(--ok)}.bad{color:var(--bad)}.mo{color:var(--muted)}.note{white-space:pre-wrap;color:var(--muted);margin:0 0 8px;font-size:13px}
img{max-width:100%;border:1px solid var(--line);border-radius:6px}small{color:var(--muted);font-weight:400}</style></head><body><main>
<h1>QuorX UI test · ${esc(SCENARIO)}</h1><p class="sum">${STAMP.replace('T', ' ')} · ${passed} of ${total} steps passed · the desktop app (test copy) on port ${PORT}</p>
${steps.map((s) => `<section class="st"><h2><span class="${s.moment ? 'mo' : s.ok ? 'ok' : 'bad'}">${s.moment ? '·' : s.ok ? '✓' : '✗'}</span>${esc(s.title)} <small>${s.ms ? `${(s.ms / 1000).toFixed(1)} s` : ''}</small></h2>${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}${s.img ? `<img src="${s.img}" alt="${esc(s.title)}" loading="lazy">` : ''}</section>`).join('\n')}
</main></body></html>`;
  fs.writeFileSync(path.join(OUT, 'report.html'), html);
  return { passed, total, file: path.join(OUT, 'report.html') };
}

// ---------- scenario: settings (no key needed) ----------
// A project of the test's own, in a fresh folder under your Temp folder (QuorX refuses project folders inside its
// own code). Never Scratch: its folder is your real Documents\QuorX\Scratch.
// Forgotten and removed when the test ends (see the end of this file), unless --keep leaves the app open.
const made = { projects: [], paths: [] };
async function testProject(label) {
  const dir = path.join(os.tmpdir(), 'quorx-uitest', `${label}-${STAMP}`);
  fs.mkdirSync(dir, { recursive: true });
  made.paths.push(dir);
  const id = `uitest-${label}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const p = await api('/api/projects', { id, path: dir });
  if (p.error) throw new Error(p.error);
  made.projects.push(p.id);
  await js('location.reload(); return true;').catch(() => {});
  await sleep(1500);
  await waitFor(`document.querySelector('.sb-project[data-p=${q(p.id)}]')`, 20000, 'the project in the sidebar');
  return { ...p, dir };
}

async function settingsScenario() {
  let proj = null;
  await step('QuorX opens', async () => { await waitFor(`document.querySelector('#settingsBtn') && document.querySelector('#projectList')`, 30000, 'the app'); return `Loaded ${await js('return location.href')}`; });
  await step('A project of the test’s own for the rule checks', async () => { proj = await testProject('rules'); return `${proj.name} at ${proj.dir}`; });
  await step('Settings → Approvals & safety', async () => {
    await click('#settingsBtn');
    await waitFor(`document.querySelector('#settings')?.open`, 5000, 'the settings dialog');
    await click('#stNav [data-cat="safety"]');
    await waitFor(`document.querySelector('[data-pr-project]')`, 20000, 'the rules card');
    // Picking a project redraws the card: wait for the new one (the old select is marked first).
    await js(`const s = document.querySelector('[data-pr-project]'); s.dataset.old = '1'; s.value = ${q(proj.id)}; s.dispatchEvent(new Event('change')); return true;`);
    await waitFor(`(() => { const s = document.querySelector('[data-pr-project]'); return s && !s.dataset.old && s.value === ${q(proj.id)}; })()`, 15000, 'the rules card for the test project');
    const mode = await waitFor(`(() => { const t = document.querySelector('#stStopMode')?.textContent || ''; return /checking/.test(t) ? '' : t; })()`, 30000, 'the Stop mode');
    if (WIN && !/Job Objects/.test(mode)) throw new Error(`Stop mode is "${mode}", expected Job Objects`);
    return `Stop: ${mode}`;
  });
  const ruleTest = async (line, mode, expect) => {
    await js(`document.querySelector('.pr-test').scrollIntoView({ block: 'center' }); return true;`);
    await fill('[data-pr-line]', line);
    await click(`[data-pr-mode] button[data-v="${mode}"]`);
    await click('[data-pr-test]');
    const out = await waitFor(`(() => { const t = document.querySelector('.pr-result')?.innerText || ''; return /Checking/.test(t) || !t ? '' : t; })()`, 20000, 'the verdict');
    if (!expect.test(out)) throw new Error(`got: ${out.split('\n')[0]}`);
    return out.split('\n')[0];
  };
  await step('Rule test: deleting your profile is blocked', () => ruleTest('Remove-Item ~ -Recurse', 'strict', /Blocked/));
  await step('Rule test: a build asks you in Strict', () => ruleTest('cargo build --release', 'strict', /Asks you/));
  await step('Rule test: a push asks you even in YOLO', () => ruleTest('git push origin main', 'yolo', /Asks you/));
  await step('Rule test: a hidden delete inside a pipeline is caught', () => ruleTest('Get-ChildItem | ForEach-Object { Remove-Item $_ -Force }', 'yolo', /Asks you|Blocked/));
  await step('Budget: caps on every model', async () => { await click('#stNav [data-cat="budget"]'); await waitFor(`/Cap per reply/.test(document.querySelector('[data-panel="budget"]')?.innerText || '')`, 5000, 'the caps'); return 'Cap per reply and Cap per day are shown'; });
  await step('Setup check: toolchains and the sandbox row', async () => {
    await click('#stNav [data-cat="setup"]');
    const t = await waitFor(`(() => { const t = document.querySelector('#stSetup')?.innerText || ''; return /Command sandbox/.test(t) ? t : ''; })()`, 60000, 'the setup check');
    // Show the sandbox row and the toolchains under it, not the top of the list.
    await js(`const el = [...document.querySelectorAll('#stSetup *')].find((e) => e.children.length === 0 && /^Command sandbox$/.test(e.textContent.trim())); el?.scrollIntoView({ block: 'start' }); return true;`);
    await sleep(300);
    return (t.match(/(Rust \(cargo\)|\.NET SDK|Go|CMake)[^\n]*/g) || []).slice(0, 4).join(' · ');
  });
  await js(`document.querySelector('#stCancel')?.click(); return true;`);
}

// While a reply works: answer the cards like a careful person would, with a screenshot of each, until it ends.
async function workThrough(limitMs = 15 * 60e3) {
  const seen = new Set(), allowedPrograms = new Set();
  let lastMoment = Date.now();
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > limitMs) throw new Error(`the reply did not finish within ${Math.round(limitMs / 60e3)} minutes`);
    const card = await js(`const c = document.querySelector('#chats .approval[data-id]'); if (!c) return null;
      return { id: c.dataset.id, shell: c.classList.contains('shell-card'), question: c.classList.contains('question') || !!c.querySelector('.q-opts'), budget: c.classList.contains('budget-card'),
        line: c.querySelector('.sc-line')?.innerText || c.querySelector('.q-text')?.innerText || c.innerText.slice(0, 160),
        classes: [...c.querySelectorAll('.sc-cls')].map((x) => x.dataset.cls), always: !!c.querySelector('.sc-always'),
        global: [...c.querySelectorAll('.sc-cls')].some((x) => /whole computer/.test(x.textContent)) };`);
    if (card && !seen.has(card.id)) {
      seen.add(card.id);
      if (card.shell) {
        // The program the card's rule is about: the part of the line that needs asking (not "cargo --version" in
        // "cargo --version; rustc -vV"), as the card's "any … command" choice names it.
        const program = String(await js(`return document.querySelector('#chats .approval[data-id=${JSON.stringify(card.id)}] .sc-pick[data-group="match"] button:nth-child(3)')?.dataset.v || ''`) || card.line.trim().split(/\s+/)[0]).replace(/\*$/, '').toLowerCase();
        // Installs for the whole computer (rustup targets, npm -g, winget) change the PC outside the test copy: never.
        const risky = card.global || card.classes.some((k) => ['external', 'opaque', 'discard', 'delete', 'never'].includes(k));
        await moment(`Approval card: ${card.line.slice(0, 70)}`, `Classes: ${card.classes.join(', ') || '–'}${card.global ? ' (whole computer)' : ''}`);
        if (risky) {
          await fill(`#chats .approval[data-id=${q(card.id)}] textarea`, card.global ? 'No installs for the whole computer in this test. Work with what is installed, or tell me what is missing.' : 'Not in this test.');
          await click(`#chats .approval[data-id=${q(card.id)}] .no`); await moment(card.global ? 'Denied (installs for the whole computer)' : 'Denied (risky class)');
        }
        else if (card.always && !allowedPrograms.has(program)) {
          allowedPrograms.add(program);
          await click(`#chats .approval[data-id=${q(card.id)}] .sc-always`);
          await click(`#chats .approval[data-id=${q(card.id)}] .sc-pick[data-group="match"] button:nth-child(3)`);
          await click(`#chats .approval[data-id=${q(card.id)}] .sc-pick[data-group="scope"] button[data-v="project"]`);
          await moment(`Always allow any ${program} command in this project`, 'The rule the card will save, before pressing Allow and save.');
          await click(`#chats .approval[data-id=${q(card.id)}] .sc-save`);
        } else await click(`#chats .approval[data-id=${q(card.id)}] .yes`);
      } else if (card.question) {
        await moment(`The agent asks: ${card.line.slice(0, 70)}`);
        // Take the agent's recommendation, except an install for the whole computer: then the first option that
        // isn't one. A card with several questions has a radio group each and a Send answers button.
        const picked = await js(`const c = document.querySelector('#chats .approval[data-id=${JSON.stringify(card.id)}]');
          const groups = [...c.querySelectorAll('.q-opts')].filter((g) => g.querySelector('button.q-opt'));
          const out = groups.map((g) => { const opts = [...g.querySelectorAll('button.q-opt')]; const cur = g.querySelector('.q-opt.chosen, .q-opt.rec') || opts[0];
            const pick = /install/i.test(cur.textContent) ? (opts.find((o) => !/install/i.test(o.textContent)) || cur) : cur; pick.click(); return pick.textContent.trim().slice(0, 80); });
          c.querySelector('.send-all')?.click(); return out;`);
        await moment(`Answered: ${picked.join(' · ').slice(0, 140)}`);
      } else if (card.budget) {
        await moment('Budget card');
        await click(`#chats .approval[data-id=${q(card.id)}] .raise`);
      } else {
        await moment(`Approval: ${card.line.slice(0, 70)}`);
        await click(`#chats .approval[data-id=${q(card.id)}] .yes`);
      }
    }
    const running = await js(`return !document.querySelector('#chats .stopBtn')?.hidden;`);
    if (!running) break;
    if (Date.now() - lastMoment > 45000) { lastMoment = Date.now(); await moment(`Working… ${Math.round((Date.now() - t0) / 1000)} s`); }
    await sleep(1500);
  }
  return `${seen.size} card${seen.size === 1 ? '' : 's'} answered; rules saved for: ${[...allowedPrograms].join(', ') || 'none'}`;
}

// ---------- scenario: the agent builds a Rust command-line program ----------
async function cliScenario() {
  const hasKey = async () => (await api('/api/config')).hasKey;
  await step('An OpenRouter key is set in the test copy', async () => {
    if (await hasKey()) return 'A key is set.';
    await click('#settingsBtn'); await click('#stNav [data-cat="keys"]');
    await moment('Waiting for a key: add one in ⚙ Settings → Providers', 'The test copy has no key. Add one in the window (a separate key with a small spending limit is best).');
    log('>>> The test copy has no OpenRouter key. Add one in the QuorX window that opened (⚙ Settings → Providers). Waiting up to 10 minutes…');
    const t0 = Date.now();
    while (!(await hasKey())) { if (Date.now() - t0 > 600e3) throw new Error('no key was added within 10 minutes'); await sleep(2000); }
    await js(`document.querySelector('#stCancel')?.click(); return true;`);
    return 'A key was added.';
  });
  if (!(await hasKey())) return;
  let pid = null, dir = null;
  await step('A fresh project folder for the test', async () => {
    const p = await testProject('wc-lite');
    pid = p.id; dir = p.dir;
    return `Project ${p.name} at ${dir}`;
  });
  if (!pid) return;
  await step('A new chat in that project, in 🔒 Strict', async () => {
    await click(`.sb-project[data-p=${q(pid)}] .sb-new`);
    await waitFor(`document.querySelector('#chats .cmp-textarea')`, 15000, 'the message box');
    await js(`const b = document.querySelector('#chats [data-approval="strict"]'); if (b && !b.classList.contains('on')) b.click(); return true;`);
    return 'Ready to type.';
  });
  const prompt = 'Create a Rust command-line program with cargo, in a crate named wc-lite in this folder. It takes a file path as its argument and prints the number of lines, words and bytes, like `wc`. Build it, then run it on its own Cargo.toml to show it works. Keep it small: no extra crates.';
  await step('Ask the agent to build a Rust CLI', async () => {
    await fill('#chats .cmp-textarea', prompt);
    await click('#chats .sendBtn');
    await waitFor(`!document.querySelector('#chats .stopBtn')?.hidden`, 20000, 'the reply to start');
    return prompt;
  });
  await step('The agent works (cards answered as they come)', () => workThrough(15 * 60e3));
  let reply = '';
  await step('The final reply', async () => {
    // The reply's own text sits in .body of the last bot message (a usage line can come after it).
    const text = await js(`const m = [...document.querySelectorAll('#chats .msg.bot')].at(-1); if (!m) return '';
      m.querySelector('.body')?.scrollIntoView({ block: 'center' });
      return (m.querySelector('.body')?.innerText || '').trim() || (m.querySelector('.timeline')?.innerText || '').trim().slice(-600);`);
    if (!text) throw new Error('no reply text found');
    reply = text;
    return text.slice(0, 600);
  });
  await step('The trace shows each command and who allowed it', async () => {
    const opened = await js(`const b = [...document.querySelectorAll('#chats button, #chats summary')].find((x) => /steps|trace/i.test(x.textContent)); if (b) b.click(); return !!b;`);
    await sleep(800);
    return opened ? 'Opened the reply\'s steps.' : 'No steps button found; the timeline above shows the calls.';
  });
  await step('The program really works (checked outside QuorX)', async () => {
    const exe = path.join(dir, 'target', 'debug', WIN ? 'wc-lite.exe' : 'wc-lite');
    if (!fs.existsSync(exe)) {
      // A PC where Rust can't link (no C linker) can't make the program; then the pass is the agent saying so.
      const rust = (await detectToolchains()).find((t) => t.id === 'rust');
      if (rust?.found && !rust.works) {
        if (!/linker|build tools|link\.exe|visual studio/i.test(reply)) throw new Error(`this PC can't link Rust programs (${rust.problem}) and the reply doesn't say so`);
        return `Not built, as expected on this PC (${rust.problem}); the reply tells the user so.`;
      }
      throw new Error(`no ${path.relative(dir, exe)} was built`);
    }
    const sample = path.join(os.tmpdir(), `qx-wc-${STAMP}.txt`);
    made.paths.push(sample);
    fs.writeFileSync(sample, 'one two three\nfour five\n');
    const r = spawnSync(exe, [sample], { encoding: 'utf8' });
    const nums = (r.stdout.match(/\d+/g) || []).map(Number);
    if (!(nums.includes(2) && nums.includes(5) && nums.includes(24))) throw new Error(`expected 2 lines, 5 words, 24 bytes; it printed: ${r.stdout.trim() || r.stderr.trim()}`);
    return `wc-lite on a 2-line file printed: ${r.stdout.trim()}`;
  });
  await step('Settings: the audit log and the rule the card saved', async () => {
    await click('#settingsBtn'); await click('#stNav [data-cat="safety"]');
    await waitFor(`document.querySelector('[data-pr-project]')`, 20000, 'the rules card');
    await js(`const s = document.querySelector('[data-pr-project]'); s.dataset.old = '1'; s.value = ${q(pid)}; s.dispatchEvent(new Event('change')); return true;`);
    await waitFor(`(() => { const s = document.querySelector('[data-pr-project]'); return s && !s.dataset.old && s.value === ${q(pid)}; })()`, 15000, 'the rules card for the test project');
    await sleep(800);
    await js(`document.querySelector('#stAudit').scrollIntoView({ block: 'start' }); return true;`);
    const audit = await textOf('#stAudit'), rules = await textOf('#stPerms .pr-list');
    return `Rules: ${rules.split('\n').slice(0, 3).join(' ')}\nAudit: ${audit.split('\n').slice(0, 6).join(' | ')}`;
  });
  await js(`document.querySelector('#stCancel')?.click(); return true;`).catch(() => {});
}

// ---------- scenario: the Running tab ----------
// The agent starts a program that keeps running, a dev server runs, and a terminal tab is open; the Running tab lists
// all three with who started them, and Stop / Stop all end them.
async function runningScenario() {
  if (!(await api('/api/config')).hasKey) { await step('The Running tab (needs a key)', async () => { throw new Error('no OpenRouter key in the test copy: run the cli scenario first, or add one'); }); return; }
  let pid = null, dir = null;
  await step('A project with a long-running program and a server', async () => {
    const p = await testProject('running');
    pid = p.id; dir = p.dir;
    fs.writeFileSync(path.join(dir, 'ticker.js'), "let n = 0; setInterval(() => console.log(`tick ${++n}`), 2000); console.log('ticker started');\n");
    fs.writeFileSync(path.join(dir, 'server.js'), "require('http').createServer((q, s) => s.end('hello from the test server')).listen(process.env.PORT || 0, () => console.log('listening on ' + (process.env.PORT || '?')));\n");
    const s = await api('/api/servers/start', { projectId: pid, name: 'web', cmd: 'node', args: ['server.js'] });
    if (s.error) throw new Error(s.error);
    return `${p.name}: ticker.js and a server "web" at ${s.url || '(starting)'}`;
  });
  if (!pid) return;
  await step('A new chat asks the agent to start the program and leave it running', async () => {
    await click(`.sb-project[data-p=${q(pid)}] .sb-new`);
    await waitFor(`document.querySelector('#chats .cmp-textarea')`, 15000, 'the message box');
    await js(`const b = document.querySelector('#chats [data-approval="strict"]'); if (b && !b.classList.contains('on')) b.click(); return true;`);
    await fill('#chats .cmp-textarea', 'Start `node ticker.js` with the shell tool and background: true. It keeps running on purpose: do not wait for it, read it or stop it. Then reply in one short line that it is running.');
    await click('#chats .sendBtn');
    await waitFor(`!document.querySelector('#chats .stopBtn')?.hidden`, 20000, 'the reply to start');
    return 'Sent.';
  });
  await step('The agent starts it (cards answered as they come)', () => workThrough(5 * 60e3));
  await step('A terminal tab of your own is open', async () => {
    await click('#paneTabs [data-tab="term"]');
    await sleep(2500);
    return 'Opened the Terminal tab (its first tab starts a shell).';
  });
  await step('Terminal → Running lists everything, with who started it', async () => {
    await click('#appBar .tsec[data-sec="run"]');
    await waitFor(`document.querySelectorAll('#runPane .run-row').length >= 2`, 15000, 'the rows');
    await sleep(3500); // one poll, so the times and the tab's count are fresh
    const rows = await js(`return [...document.querySelectorAll('#runPane .run-row')].map((r) => ({ kind: r.dataset.kind, text: r.innerText.replace(/\\s+/g, ' ').slice(0, 160) }));`);
    const kinds = rows.map((r) => r.kind);
    for (const k of ['background', 'server']) if (!kinds.includes(k)) throw new Error(`no ${k} row; rows: ${JSON.stringify(rows)}`);
    const bg = rows.find((r) => r.kind === 'background');
    if (!/agent/.test(bg.text) || !/ticker/.test(bg.text)) throw new Error(`the background row doesn't say the agent started ticker.js: ${bg.text}`);
    const count = await textOf('#paneTabs [data-tab="term"] .pt-n');
    return `Tab count ${count}. ${rows.map((r) => `[${r.kind}] ${r.text}`).join('\n')}`;
  });
  await step('■ Stop on the background job ends it', async () => {
    await click('#runPane .run-row[data-kind="background"] .run-stop');
    await waitFor(`!document.querySelector('#runPane .run-row[data-kind="background"]')`, 20000, 'the row to go');
    const left = await js(`return [...document.querySelectorAll('#runPane .run-row')].map((r) => r.dataset.kind);`);
    return `Gone. Still running: ${left.join(', ') || 'nothing'}`;
  });
  await step('Stop all asks first, then ends the rest (your terminal stays)', async () => {
    await click('#appBar .run-stopall');
    await waitFor(`document.querySelector('.ask-dlg .ask-ok')`, 5000, 'the confirmation');
    await moment('Stop all asks first');
    await click('.ask-dlg .ask-ok');
    await waitFor(`![...document.querySelectorAll('#runPane .run-row')].some((r) => r.dataset.kind !== 'your-term')`, 20000, 'everything to stop');
    await sleep(3500);
    const left = await js(`return [...document.querySelectorAll('#runPane .run-row')].map((r) => r.dataset.kind);`);
    return `Left: ${left.join(', ') || 'nothing'}`;
  });
}

// ---------- scenario: News (no key needed) ----------
// The sidebar's News entry shows a dot for updates you haven't read, What's new lists the versions, and the sample
// article (a draft that uses every block) draws each block; Play walks its flow, and its compare switches.
async function newsScenario() {
  // A test result in the test copy's own logs, with a count unique to this run, for the Tests report's local block.
  // Written before News first asks for it (the server keeps a view's answer for a few seconds).
  const own = 100 + (Date.now() % 900);
  fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'logs', 'test-results.json'), JSON.stringify({ test: { at: new Date().toISOString(), total: own, pass: own, fail: 0, skipped: 0 } }));
  await step('QuorX opens with News unread', async () => {
    fs.rmSync(path.join(HOME, 'data', 'news.json'), { force: true }); // as if What's new was never opened
    await js('location.hash = ""; location.reload(); return true;').catch(() => {});
    await sleep(1500);
    await waitFor(`document.querySelector('#newsBtn') && !document.querySelector('#newsDot').hidden`, 30000, 'the News dot');
    await js(`document.querySelector('#settings')?.open && document.querySelector('#stCancel')?.click(); return true;`);
    await sleep(400);
    return `The News entry shows its dot: ${await js("return document.querySelector('#newsBtn').getAttribute('aria-label')")}`;
  });
  await step('Open News: What\'s new, newest version first', async () => {
    await click('#newsBtn');
    await waitFor(`document.querySelectorAll('#newsView .nw-version').length > 1`, 10000, 'the versions');
    const v = await js(`return [...document.querySelectorAll('#newsView .nw-version')].map((s) => s.dataset.version + (s.querySelector('.nw-new') ? ' (new)' : '') + ': ' + s.querySelectorAll('.nw-item').length + ' items');`);
    const tags = await js(`return [...new Set([...document.querySelectorAll('#newsView .nw-item .nw-tag')].map((t) => t.textContent))];`);
    if (!/\(new\)/.test(v[0])) throw new Error(`the newest version has no "new" mark: ${v[0]}`);
    return `${v.join('\n')}\nKinds shown: ${tags.join(', ')}`;
  });
  await step('The dot goes once What\'s new is open', async () => {
    await waitFor(`document.querySelector('#newsDot').hidden`, 8000, 'the dot to go');
    const r = await api('/api/news');
    if (r.lastRead !== r.updates.versions[0].version) throw new Error(`lastRead is ${r.lastRead}`);
    return `Read up to v${r.lastRead}; stored in ${path.join(HOME, 'data', 'news.json')}`;
  });
  await step('Reports and Articles lists', async () => {
    await click('#newsView [data-tab="articles"]');
    await waitFor(`document.querySelector('#newsView .nw-cards, #newsView .nw-empty')`, 5000, 'the list');
    const a = await js(`return [...document.querySelectorAll('#newsView .nw-card h3')].map((h) => h.textContent);`);
    await click('#newsView [data-tab="reports"]');
    await waitFor(`document.querySelector('#newsView [data-tab="reports"][aria-pressed="true"]')`, 5000, 'Reports');
    const r = await js(`return [...document.querySelectorAll('#newsView .nw-card h3')].map((h) => h.textContent);`);
    return `Articles: ${a.join(', ') || 'none yet'}\nReports: ${r.join(', ') || 'none yet'}`;
  });
  await step('Open the sample article: every block draws', async () => {
    await js('location.hash = "#news/articles/_sample"; return true;');
    await waitFor(`document.querySelector('#newsView .nb-flow') && !document.querySelector('#newsView .nb-slot')`, 10000, 'the blocks');
    const kinds = await js(`return [...document.querySelectorAll('#newsView .nb')].map((e) => e.className.split(' ')[1]);`);
    const want = ['nb-stat', 'nb-chart', 'nb-tl', 'nb-lanes', 'nb-flow', 'nb-compare', 'nb-matrix', 'nb-ledger', 'nb-term', 'nb-callout', 'nb-local'];
    const missing = want.filter((k) => !kinds.includes(k));
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
    if (kinds.includes('nb-error')) throw new Error('a block could not be shown');
    const title = await textOf('#newsView .nw-article h1');
    return `"${title}": ${kinds.length} blocks (${[...new Set(kinds)].join(', ')})`;
  });
  await step('Play on the flow walks its steps', async () => {
    // A window behind others gets no animation frames and slow timers; bring it forward so the walk runs as you'd see it.
    await send('Page.bringToFront').catch(() => {});
    await js(`document.querySelector('#newsView').style.scrollBehavior = 'auto'; document.querySelector('#newsView .nb-flow').scrollIntoView({ block: 'start' }); return true;`);
    await sleep(300);
    const seen = await js('return document.visibilityState + (document.hasFocus() ? ", focused" : "");');
    await click('#newsView .nb-flow .nb-play');
    await sleep(4200);
    const cap = await textOf('#newsView .nb-flow-cap');
    const on = await js(`return [...document.querySelectorAll('#newsView .nb-flow .node')].findIndex((n) => n.classList.contains('on'));`);
    const btn = await textOf('#newsView .nb-flow .nb-play');
    if (on < 1 || !/\d\/\d/.test(cap)) throw new Error(`not walking: step ${on}, caption "${cap}", button "${btn}" (the window is ${seen})`);
    return `Step ${on + 1} lit; caption "${cap}"; button "${btn}"`;
  });
  await step('The compare switches between versions', async () => {
    await js(`document.querySelector('#newsView .nb-compare').scrollIntoView({ block: 'center' }); return true;`);
    const before = await textOf('#newsView .nb-compare .nb-verdict b');
    await click('#newsView .nb-compare .nb-seg button[data-o="0"]');
    await sleep(700);
    const after = await textOf('#newsView .nb-compare .nb-verdict b');
    const pressed = await js(`return document.querySelector('#newsView .nb-compare .nb-seg button[data-o="0"]').getAttribute('aria-pressed');`);
    if (before === after || pressed !== 'true') throw new Error(`still "${after}"`);
    return `"${before}" → "${after}"`;
  });
  await step('The matrix filters by level, and a lane shows its detail', async () => {
    await js(`document.querySelector('#newsView .nb-matrix').scrollIntoView({ block: 'center' }); return true;`);
    await click('#newsView .nb-matrix .nb-filter button[data-f="tested"]');
    const shown = await js(`return [...document.querySelectorAll('#newsView .nb-matrix tbody tr:not(.hide)')].map((r) => r.dataset.l);`);
    if (!shown.length || shown.some((l) => l !== 'tested')) throw new Error(`rows: ${shown.join(', ')}`);
    await moment('The matrix shows only Tested rows', shown.join(', '));
    await js(`document.querySelector('#newsView .nb-lanes').scrollIntoView({ block: 'center' }); const g = document.querySelectorAll('#newsView .nb-lane')[1]; g.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
    await sleep(300);
    return `Matrix: ${shown.length} tested rows. Lane card: ${(await textOf('#newsView .nb-lane-card')).replace(/\s+/g, ' ')}`;
  });
  await step('A report draws, and its local block reads this copy\'s own logs', async () => {
    const list = await api('/api/news');
    const slugs = (list.reports || []).map((x) => x.slug);
    for (const s of ['models', 'tests', 'platforms']) if (!slugs.includes(s)) throw new Error(`the ${s} report is not listed (${slugs.join(', ')})`);
    await js('location.hash = "#news/reports/tests"; return true;');
    await waitFor(`document.querySelector('#newsView .nb-local table') && !document.querySelector('#newsView .nb-slot')`, 15000, 'the report and its local block');
    const kinds = await js(`return [...new Set([...document.querySelectorAll('#newsView .nb')].map((e) => e.className.split(' ')[1]))];`);
    if (kinds.includes('nb-error')) throw new Error('a block could not be shown');
    const shown = (await textOf('#newsView .nb-local table')).replace(/\s+/g, ' ');
    if (!shown.includes(`npm test ${own} 0`)) throw new Error(`the local block shows "${shown}", not this run's ${own} passed`);
    await js(`document.querySelector('#newsView .nb-local').scrollIntoView({ block: 'center' }); return true;`);
    return `Reports listed: ${slugs.join(', ')}. "${await textOf('#newsView .nw-article h1')}": ${kinds.join(', ')}. On this computer: ${shown}`;
  });
  await step('Close News: back to Home', async () => {
    await click('#newsView .nw-close');
    await waitFor(`document.querySelector('#newsView').hidden && !document.querySelector('.work').classList.contains('news-on')`, 5000, 'News to close');
    return `Home is ${await js("return document.querySelector('#homeBtn').classList.contains('active') ? 'lit' : 'not lit'")}`;
  });
}

// ---------- scenario: perf (heavy chats, no key needed) ----------
// Fills the test copy with chats like the ones people make (pictures, screenshots in the steps, a 3D page built as
// an artifact), opens them one after another through the sidebar, and reads the performance readout after each.
// Nothing calls a model. Numbers go to perf.json next to the report; the readout is switched on through Settings.
function pngFile(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0, o = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { const c = px(x, y); raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2]; } }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
// A page that keeps a WebGL view busy, like a 3D app the agent built.
const SCENE = `<!doctype html><meta charset="utf-8"><title>3D scene</title><style>html,body{margin:0;height:100%;background:#0b1110}canvas{width:100%;height:100%;display:block}</style><canvas id="c"></canvas><script>
const c=document.getElementById('c'),g=c.getContext('webgl');const vs='attribute vec2 p;uniform float t;void main(){float s=sin(t),k=cos(t);gl_Position=vec4(p.x*k-p.y*s,p.x*s+p.y*k,0.,1.);}',fs='precision mediump float;uniform float t;void main(){gl_FragColor=vec4(.2+.5*sin(t),.7,.8,1.);}';
const sh=(k,s)=>{const o=g.createShader(k);g.shaderSource(o,s);g.compileShader(o);return o};const pr=g.createProgram();g.attachShader(pr,sh(g.VERTEX_SHADER,vs));g.attachShader(pr,sh(g.FRAGMENT_SHADER,fs));g.linkProgram(pr);g.useProgram(pr);
g.bindBuffer(g.ARRAY_BUFFER,g.createBuffer());g.bufferData(g.ARRAY_BUFFER,new Float32Array([0,.7,-.6,-.5,.6,-.5]),g.STATIC_DRAW);const l=g.getAttribLocation(pr,'p');g.enableVertexAttribArray(l);g.vertexAttribPointer(l,2,g.FLOAT,false,0,0);const u=g.getUniformLocation(pr,'t');
(function f(ts){c.width=c.clientWidth;c.height=c.clientHeight;g.viewport(0,0,c.width,c.height);g.uniform1f(u,ts/700);g.drawArrays(g.TRIANGLES,0,3);requestAnimationFrame(f)})(0);
</script>`;

// QuorX opens (the welcome tour skipped), and the performance readout is switched on through Settings.
async function openWithReadout() {
  await step('QuorX opens', async () => {
    await waitFor(`document.querySelector('#settingsBtn') && document.querySelector('#projectList') && window.qxPerf`, 30000, 'the app');
    // A fresh test copy greets with the tour: skipped, as a person who knows QuorX would.
    await sleep(800);
    const skipped = await js(`const b = document.querySelector('[data-tr="skip"]'); if (b) b.click(); localStorage.setItem('qx-tour-seen', String(Date.now())); return !!b;`);
    return skipped ? 'Loaded; skipped the welcome tour' : 'Loaded';
  });
  await step('Settings → Appearance → Under the hood: turn on the performance readout', async () => {
    await click('#settingsBtn');
    await waitFor(`document.querySelector('#settings')?.open`, 5000, 'the settings dialog');
    await click('#stNav [data-cat="appearance"]');
    await js(`const d = document.querySelector('#appearanceAdv'); d.open = true; d.scrollIntoView({ block: 'center' }); return true;`);
    await js(`const i = document.querySelector('input[data-bind="ui.perfReadout"]'); if (!i.checked) i.click(); return true;`);
    await sleep(300);
    await moment('The switch, ticked', 'Under the hood → Performance readout');
    await click('#saveSettings');
    await waitFor(`document.querySelector('.qx-perf .qp-row')`, 8000, 'the readout box');
    return 'The readout shows in the bottom-left corner';
  });
}
// Minimises the test copy's window or brings it back ('minimized' | 'normal'). Electron's DevTools has no window
// commands, so Windows does it, on the window of the process this test started and no other. Throws when the page
// doesn't see it, so a step never measures a window that wasn't really minimised.
async function windowState(state) {
  if (!WIN || !appProc) throw new Error('minimising is only done on Windows, on the test copy');
  const ps = `$sig = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'; Add-Type -MemberDefinition $sig -Name W -Namespace QxTest; `
    + `$p = Get-Process -Id ${Number(appProc.pid)} -ErrorAction Stop; if ($p.MainWindowHandle -eq 0) { exit 2 }; [QxTest.W]::ShowWindow($p.MainWindowHandle, ${state === 'minimized' ? 6 : 9}) | Out-Null`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not ${state === 'minimized' ? 'minimise' : 'restore'} the test window (${r.status}): ${String(r.stderr).trim().slice(0, 200)}`);
  await waitFor(state === 'minimized' ? 'document.hidden' : '!document.hidden', 5000, `the page to see the window ${state === 'minimized' ? 'minimised' : 'back'}`);
}
// Runs a script in one of the desktop app's own browser tabs, or a preview frame (found by its address), through DevTools.
async function inTab(urlPart, expr, type = 'page') {
  const target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === type && t.url.includes(urlPart));
  if (!target) return undefined;
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error('could not reach the tab')); });
  const out = await new Promise((r) => { sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) r(m.result?.result?.value); }; sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); setTimeout(() => r(undefined), 5000); });
  sock.close();
  return out;
}

// A picture of one real tab, added to the report like a step's screenshot.
async function tabShot(urlPart, title, note = '') {
  const target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes(urlPart));
  if (!target) return;
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error('could not reach the tab')); });
  const data = await new Promise((r) => { sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) r(m.result?.data); }; sock.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })); setTimeout(() => r(null), 5000); });
  sock.close();
  if (!data) return;
  const file = `${String(++shotN).padStart(2, '0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}.png`;
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  steps.push({ title, ok: true, note, img: file, ms: 0, moment: true });
}

// ---------- scenario: tabs (hidden browser tabs go to sleep and come back) ----------
// The test copy runs with QX_TAB_SLEEP_MS=15000 (see launch), so a hidden tab sleeps after 15 s instead of 5 minutes.
async function tabsScenario() {
  const N = 5;
  let chat = null;
  const tabsNow = async () => { const s = await js('return await window.qxPerf.sample();'); const t = s.shell?.tabs || []; return { awake: t.filter((x) => !x.agent && !x.asleep).length, asleep: t.filter((x) => x.asleep).length, mb: s.shell?.tabsMb ?? 0, total: s.shell?.totalMb ?? 0 }; };
  const line = (x) => `${x.awake} awake · ${x.asleep} asleep · tabs ${x.mb} MB · all of QuorX ${x.total} MB`;
  await openWithReadout();
  await step('A chat with a long page and a 3D page as artifacts', async () => {
    const proj = await testProject('tabs');
    const id = `tabs${Date.now().toString(36)}`;
    const long = `<!doctype html><meta charset="utf-8"><title>Long page</title><body style="font:16px system-ui;margin:40px">${Array.from({ length: 300 }, (_, i) => `<p id="p${i}">Paragraph ${i + 1}: a long page to scroll through.</p>`).join('')}</body>`;
    const doc = { id, title: 'Tabs that sleep', projectId: proj.id, created: Date.now(), agent: { setup: {}, messages: [{ role: 'user', content: 'Show me some pages.' }, { role: 'assistant', runId: `${id}r`, content: 'Here they are, in the pane.', doneAt: Date.now() }],
      artifacts: { long: { id: 'long', kind: 'html', title: 'Long page', html: long, updated: Date.now() }, scene: { id: 'scene', kind: 'html', title: '3D viewer', html: SCENE, updated: Date.now() } } } };
    const status = await js(`const r = await fetch(${q(`/api/chats/${id}`)}, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ${q(JSON.stringify(doc))} }); return r.status;`);
    if (status !== 200) throw new Error(`saving the chat: ${status}`);
    await js('location.reload(); return true;').catch(() => {});
    await sleep(1500);
    await waitFor(`document.querySelector(${q(`.sb-chat[data-c="${id}"]`)})`, 20000, 'the chat in the sidebar');
    await click(`.sb-chat[data-c="${id}"]`);
    await waitFor(`document.querySelector('[data-tab="browser"]')`, 10000, 'the pane');
    chat = id;
    return 'Opened';
  });
  const urls = Array.from({ length: N }, (_, i) => (i === 0 ? `/art/${chat}/long` : `/art/${chat}/scene?tab=${i + 1}`));
  await step(`Browser tab: open ${N} pages, one tab each (the first is long, the rest 3D)`, async () => {
    await click('[data-tab="browser"]');
    for (const u of urls) {
      await waitFor(`document.querySelector('.btab-new')`, 10000, 'the + button');
      await click('.btab-new');
      await js(`const f = document.querySelector('#paneUrl'); f.value = location.origin + ${q(u)}; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
      await sleep(1500);
    }
    return `${await js(`return document.querySelectorAll('.btab:not(.agent)').length`)} tabs · ${line(await tabsNow())}`;
  });
  await step('Scroll the long page halfway down', async () => {
    await js(`[...document.querySelectorAll('.btab:not(.agent)')][0].click(); return true;`);
    await sleep(1500);
    await inTab(urls[0], 'scrollTo(0, 3000); 1');
    await sleep(500);
    return `scrolled to ${await inTab(urls[0], 'scrollY')} px`;
  });
  await step('Look at the last tab and wait: the hidden ones go to sleep', async () => {
    await js(`[...document.querySelectorAll('.btab:not(.agent)')].at(-1).click(); return true;`);
    const before = await tabsNow();
    const t0 = Date.now();
    let now = before;
    while (Date.now() - t0 < 60e3) { await sleep(2000); now = await tabsNow(); if (now.asleep >= N - 1) break; }
    if (now.asleep < N - 1) throw new Error(`only ${now.asleep} asleep after a minute: ${line(now)}`);
    return `before: ${line(before)} → after ${Math.round((Date.now() - t0) / 1000)} s: ${line(now)}`;
  });
  await step('Back to the long page: it wakes where it was', async () => {
    const t0 = Date.now();
    await js(`[...document.querySelectorAll('.btab:not(.agent)')][0].click(); return true;`);
    let y;
    for (let i = 0; i < 40 && !(y > 0); i++) { await sleep(250); y = await inTab(urls[0], 'document.readyState === "complete" ? scrollY : 0').catch(() => undefined); }
    await sleep(600);
    const now = await tabsNow();
    // A window screenshot can't show a real tab (it draws in a view of its own): the tab's own picture goes in too.
    await tabShot(urls[0], 'The long page, awake again (its own picture)', `scrolled to ${y} px`);
    if (!(Math.abs((y ?? 0) - 3000) < 50)) throw new Error(`the page came back at ${y} px, not 3000`);
    return `back at ${y} px in ${Date.now() - t0} ms · ${line(now)}`;
  });
  await step('Minimise the window and bring it back: the page shows again', async () => {
    await windowState('minimized');
    await sleep(3000);
    await windowState('normal');
    let shown = false;
    for (let i = 0; i < 20 && !shown; i++) { await sleep(250); shown = await js(`const s = await window.qxPerf.sample(); return !!s.shell?.tabs.some((t) => t.shown && !t.asleep);`); }
    if (!shown) throw new Error('no tab on screen after the window came back');
    return 'the long page is on screen again';
  });
}

// A heavier 3D page, closer to a real scene: a full-window shader marching rays through spheres every frame.
const HEAVY_SCENE = `<!doctype html><meta charset="utf-8"><title>3D scene (heavy)</title><style>html,body{margin:0;height:100%;background:#000}canvas{width:100%;height:100%;display:block}</style><canvas id="c"></canvas><script>
const c=document.getElementById('c'),g=c.getContext('webgl');
const vs='attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const fs='precision highp float;uniform float t;uniform vec2 r;float m(vec3 q){vec3 k=mod(q,2.)-1.;return length(k)-.4+.1*sin(q.x*3.+t);}void main(){vec2 u=(gl_FragCoord.xy-.5*r)/r.y;vec3 o=vec3(0.,0.,t),d=normalize(vec3(u,1.));float s=0.;for(int i=0;i<160;i++){float h=m(o+d*s);if(h<.001)break;s+=h;}gl_FragColor=vec4(vec3(1./(1.+s*s*.02)),1.);}';
const sh=(k,s)=>{const o=g.createShader(k);g.shaderSource(o,s);g.compileShader(o);return o};const pr=g.createProgram();g.attachShader(pr,sh(g.VERTEX_SHADER,vs));g.attachShader(pr,sh(g.FRAGMENT_SHADER,fs));g.linkProgram(pr);g.useProgram(pr);
g.bindBuffer(g.ARRAY_BUFFER,g.createBuffer());g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),g.STATIC_DRAW);const l=g.getAttribLocation(pr,'p');g.enableVertexAttribArray(l);g.vertexAttribPointer(l,2,g.FLOAT,false,0,0);
const ut=g.getUniformLocation(pr,'t'),ur=g.getUniformLocation(pr,'r');window.frames_drawn=0;
(function f(ts){c.width=c.clientWidth;c.height=c.clientHeight;g.viewport(0,0,c.width,c.height);g.uniform1f(ut,ts/1000);g.uniform2f(ur,c.width,c.height);g.drawArrays(g.TRIANGLE_STRIP,0,4);window.frames_drawn++;requestAnimationFrame(f)})(0);
</script>`;

// ---------- scenario: preview (a 3D artifact in the pane) ----------
// The processor and graphics a running 3D preview costs while it is on screen, with the pane hidden, on another pane
// tab, and with another chat open. Each reading covers 3 seconds.
async function previewScenario() {
  const ids = {};
  const rows = [];
  // Frames the preview itself drew (the heavy scene counts them): -1 when no preview frame exists.
  const drawn = async () => { const v = await inTab('/art/', 'window.frames_drawn', 'iframe').catch(() => undefined); return typeof v === 'number' ? v : -1; };
  const measure = async (label) => {
    await js('await window.ohDesktop?.perf?.(); return true;'); // starts the 3 s window for the processor numbers
    const f0 = await drawn();
    await sleep(3000);
    const f1 = await drawn();
    const s = await js('return await window.qxPerf.sample();');
    const r = { label, cpu: s.shell?.cpu, gpuCpu: s.shell?.gpuCpu, gpuMb: s.shell?.gpuMb, totalMb: s.shell?.totalMb, frames: s.page.frames, framesShown: s.page.framesShown, previewFps: f0 < 0 || f1 < 0 ? null : Math.round((f1 - f0) / 3) };
    rows.push(r);
    return `preview ${r.previewFps == null ? 'gone' : `drawing ${r.previewFps} frames/s`} · processor ${r.cpu}% · GPU ${r.gpuCpu}% busy, ${r.gpuMb} MB · all of QuorX ${r.totalMb} MB · frames ${r.frames} (${r.framesShown} on screen)`;
  };
  await openWithReadout();
  await step('Two chats: one with a 3D viewer built, one without', async () => {
    const proj = await testProject('preview');
    for (const [k, title, arts] of [['scene', 'Has a 3D viewer', { scene: { id: 'scene', kind: 'html', title: '3D viewer', html: HEAVY_SCENE, updated: Date.now() } }], ['plain', 'Just talk', {}]]) {
      const id = `pv${k}${Date.now().toString(36)}`;
      const doc = { id, title, projectId: proj.id, created: Date.now(), agent: { setup: {}, messages: [{ role: 'user', content: `Hello (${k})` }, { role: 'assistant', runId: `${id}r`, content: 'Hi.', doneAt: Date.now() }], artifacts: arts } };
      const status = await js(`const r = await fetch(${q(`/api/chats/${id}`)}, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ${q(JSON.stringify(doc))} }); return r.status;`);
      if (status !== 200) throw new Error(`saving ${title}: ${status}`);
      ids[k] = id;
    }
    await js('location.reload(); return true;').catch(() => {});
    await sleep(1500);
    await waitFor(`document.querySelector(${q(`.sb-chat[data-c="${ids.scene}"]`)})`, 20000, 'the chats in the sidebar');
    return 'Saved';
  });
  await step('Nothing open yet', () => measure('no chat'));
  await step('The 3D viewer on screen in the pane', async () => {
    await click(`.sb-chat[data-c="${ids.scene}"]`);
    await waitFor(`document.querySelector('#paneBody iframe')`, 15000, 'the preview');
    await sleep(2000);
    return measure('preview on screen');
  });
  await step('Pane hidden with ◧', async () => {
    await click('.chatpane.focus .ch-panel');
    await waitFor(`document.querySelector('.layout').classList.contains('pane-hidden')`, 5000, 'the pane to hide');
    return measure('pane hidden');
  });
  await step('Pane back, on the Steps tab', async () => {
    await click('.chatpane.focus .ch-panel');
    await click('[data-tab="trace"]');
    await sleep(800);
    return measure('steps tab');
  });
  await step('Back on the preview, then the other chat', async () => {
    await click('[data-tab="art"]');
    await sleep(1500);
    await click(`.sb-chat[data-c="${ids.plain}"]`);
    await sleep(1500);
    return measure('other chat');
  });
  await step('Window minimised', async () => {
    await windowState('minimized');
    try { return `${await measure('minimised')} · page hidden: ${await js('return document.hidden')}`; } finally { await windowState('normal'); }
  });
  fs.writeFileSync(path.join(OUT, 'preview.json'), JSON.stringify({ at: STAMP, rows }, null, 2));
}

async function perfScenario() {
  const N = Math.max(1, Math.min(16, Number(arg('chats', 8)) || 8)), PICS = 20, SHOTS = 25, PER_MSG = 5;
  const TURNS = Math.max(0, Math.min(500, Number(arg('turns', 0)) || 0));
  const PIC = Math.max(256, Math.min(4096, Number(arg('pic-size', 1024)) || 1024)); // --pic-size: the pictures' width and height in px
  // A long reply like the agent writes: a heading, a list, a code block and a table.
  const longReply = (n, k) => `## Step ${k + 1} of the build\n\nI went through the scene setup and changed how the lights are placed. Here is what changed and why, so the next renders match.\n\n`
    + `- The key light moved up and to the left\n- The fill light is softer\n- Shadows use a larger map\n\n`
    + '```js\n' + Array.from({ length: 24 }, (_, i) => `const light${i} = new DirectionalLight(0xffffff, ${(i / 24).toFixed(2)}); light${i}.position.set(${i}, ${n}, ${k});`).join('\n') + '\n```\n\n'
    + `| Light | Before | After |\n|---|---|---|\n${Array.from({ length: 6 }, (_, i) => `| light${i} | ${i * 10}% | ${i * 12}% |`).join('\n')}\n\nNext I will render the product shots.`;
  const rows = [];
  const read = async (label, extra = {}) => {
    const s = await js('return await window.qxPerf.sample();');
    const r = { label, ...extra, totalMb: s.shell?.totalMb ?? null, appMb: s.shell?.appMb ?? null, gpuMb: s.shell?.gpuMb ?? null, tabs: s.shell ? s.shell.tabs.filter((t) => !t.asleep).length : null, asleep: s.shell ? s.shell.tabs.filter((t) => t.asleep).length : null, tabsMb: s.shell?.tabsMb ?? null,
      heapMb: s.page.heapMb, chats: s.chats.open, elements: s.page.elements, images: s.page.images, imagesMb: s.page.imagesMb, frames: s.page.frames, webglLost: s.shell?.webglLost ?? null, timers: s.page.timers, longTasks: s.page.longTasks, longestMs: s.page.longestMs };
    rows.push(r);
    return `all ${r.totalMb ?? '–'} MB · window ${r.appMb ?? '–'} MB · GPU ${r.gpuMb ?? '–'} MB · ${r.tabs ?? 0} tabs awake${r.asleep ? ` (${r.asleep} asleep)` : ""} ${r.tabsMb ?? 0} MB · JS ${r.heapMb} MB · ${r.chats} chats loaded · ${r.elements} parts · ${r.images} pictures ${r.imagesMb} MB · timers ${r.timers} · stutters ${r.longTasks} (longest ${r.longestMs} ms)`;
  };
  let proj = null;
  const ids = [];
  await openWithReadout();
  await step('Baseline: QuorX with no chat open', () => read('start'));
  await step(`${N} heavy chats in a project of the test's own`, async () => {
    proj = await testProject('perf');
    const pics = path.join(proj.dir, 'pics');
    fs.mkdirSync(pics, { recursive: true });
    for (let i = 1; i <= PICS; i++) fs.writeFileSync(path.join(pics, `render-${String(i).padStart(2, '0')}.png`), pngFile(PIC, PIC, (x, y) => [(x + i * 23) & 255, (y + i * 41) & 255, ((x >> 3) ^ (y >> 3) ^ i) & 255]));
    for (let n = 1; n <= N; n++) {
      const id = `perf${Date.now().toString(36)}${n}`;
      const at = Date.now() - (N - n) * 60e3;
      const shots = Array.from({ length: SHOTS }, (_, k) => ({ t: 'screenshot', action: 'browser', target: `http://localhost:5173/#view${k}`, url: `http://localhost:5173/#view${k}`, at: at + k * 1000,
        image: `data:image/png;base64,${pngFile(1280, 720, (x, y) => [((x >> 5) * 9 + n * 30 + k) & 255, ((y >> 5) * 13 + k * 7) & 255, (n * 50) & 255]).toString('base64')}` }));
      const messages = [{ role: 'user', content: `Make me a set of product renders and a 3D viewer for them (heavy chat ${n}).` }];
      for (let k = 0; k < TURNS; k++) messages.push({ role: 'assistant', runId: `${id}h${k}`, content: longReply(n, k), doneAt: at + k }, { role: 'user', content: `Looks good, carry on with step ${k + 2}.` });
      for (let m = 0; m < PICS / PER_MSG; m++) {
        const names = Array.from({ length: PER_MSG }, (_, k) => `\`pics/render-${String(m * PER_MSG + k + 1).padStart(2, '0')}.png\``).join(', ');
        messages.push({ role: 'assistant', runId: `${id}r${m}`, content: `Here are renders ${m * PER_MSG + 1} to ${m * PER_MSG + PER_MSG}: ${names}. The 3D viewer is in the pane.`, trace: m === 0 ? shots : [], doneAt: at + 60e3 + m });
        if (m < PICS / PER_MSG - 1) messages.push({ role: 'user', content: 'Next ones, please.' });
      }
      const doc = { id, title: `Heavy chat ${n}`, projectId: proj.id, created: at, agent: { setup: {}, messages, artifacts: { scene: { id: 'scene', kind: 'html', title: '3D viewer', html: SCENE, updated: at } } } };
      // Saved by the page itself (the server only takes chats from QuorX's own page).
      const status = await js(`const r = await fetch(${q(`/api/chats/${id}`)}, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: ${q(JSON.stringify(doc))} }); return r.status;`);
      if (status !== 200) throw new Error(`saving chat ${n}: ${status}`);
      ids.push(id);
    }
    await js('location.reload(); return true;').catch(() => {});
    await sleep(1500);
    await waitFor(`document.querySelector(${q(`.sb-chat[data-c="${ids[0]}"]`)}) && window.qxPerf`, 20000, 'the chats in the sidebar');
    await js(`window.qxPerf.showReadout(true); return true;`); // after a reload the setting brings it back; this makes sure
    return `${N} chats × ${PICS} pictures (${PIC}×${PIC}), ${SHOTS} screenshots (1280×720) and a WebGL 3D viewer each`;
  });
  await step('Baseline after the reload', () => read('reloaded'));
  const switchMs = [];
  // Clicks the chat in the sidebar and times, inside the page, until its own messages are drawn (frame by frame).
  const openTimed = (id, n) => js(`const el = document.querySelector(${q(`.sb-chat[data-c="${id}"]`)}); if (!el) throw new Error('the chat is not in the sidebar');
    const shown = () => document.querySelector('.chatpane.focus .ch-name')?.value === ${q(`Heavy chat ${n}`)} && document.querySelectorAll('.chatpane.focus .msg').length >= 8;
    const frame = () => new Promise((r) => requestAnimationFrame(r)); const t0 = performance.now(); el.click();
    while (!shown()) { if (performance.now() - t0 > 20000) throw new Error('the chat did not show within 20 s'); await frame(); }
    await frame(); return Math.round(performance.now() - t0);`);
  for (let n = 1; n <= N; n++) {
    const id = ids[n - 1];
    await step(`Open heavy chat ${n} and look through it`, async () => {
      switchMs.push(await openTimed(id, n));
      // Read back up through the newest part, a screen at a time, then return to the end: pictures and steps load as
      // they would for a person (at most 30 screens, so a very long chat doesn't take minutes).
      await js(`const s = document.querySelector('.chatpane.focus .msgs'); if (!s) return false; for (let k = 0; k < 30 && s.scrollTop > 0; k++) { s.scrollTop -= s.clientHeight; await new Promise((r) => setTimeout(r, 80)); } s.scrollTop = s.scrollHeight; return true;`);
      // Only the pictures in view: ones further up load lazily, when scrolled to, and would never finish here.
      await waitFor(`(() => { const s = document.querySelector('.chatpane.focus .msgs'); if (!s) return true; const b = s.getBoundingClientRect(); return [...s.querySelectorAll('img')].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > b.top && r.top < b.bottom && !i.complete; }).length === 0; })()`, 20000, 'its pictures').catch(() => {});
      // The 3D viewer opened in a browser tab of its own, as the agent does with an app it built (desktop app only).
      await js(`if (window.ohDesktop?.open) await window.ohDesktop.open('perf-${n}', location.origin + '/art/${id}/scene'); return true;`).catch(() => {});
      await sleep(1500);
      return `opened in ${switchMs.at(-1)} ms · ${await read(`chat ${n}`, { switchMs: switchMs.at(-1) })}`;
    });
  }
  await step('Back through every chat again', async () => {
    const back = [];
    for (const [i, id] of ids.entries()) { back.push(await openTimed(id, i + 1)); await sleep(250); }
    const avg = Math.round(back.reduce((s, v) => s + v, 0) / back.length);
    return `switching back: average ${avg} ms, slowest ${Math.max(...back)} ms · ${await read('switched back', { switchMs: avg })}`;
  });
  if (TURNS) await step('Scroll all the way to the start of the last chat', async () => {
    const r = await js(`const s = document.querySelector('.chatpane.focus .msgs'); const t0 = performance.now(); let worst = 0, last = performance.now();
      while (performance.now() - t0 < 30000) { s.scrollTop = 0; await new Promise((ok) => requestAnimationFrame(ok)); const now = performance.now(); worst = Math.max(worst, now - last); last = now; if (!s.querySelector('.msgs-older') && s.scrollTop === 0) break; }
      return { ms: Math.round(performance.now() - t0), worstFrame: Math.round(worst), drawn: s.querySelectorAll('.msg').length, left: !!s.querySelector('.msgs-older') };`);
    if (r.left) throw new Error(`earlier messages still not drawn after ${r.ms} ms`);
    return `all ${r.drawn} messages drawn in ${r.ms} ms while scrolling up; slowest frame ${r.worstFrame} ms · ${await read('scrolled to the start')}`;
  });
  await step('One minute later, nothing touched', async () => { await sleep(60e3); return read('idle 1 min'); });
  // What the page really holds, against garbage not yet collected: memory read again after a full collection.
  await step('After a garbage collection', async () => {
    await send('HeapProfiler.enable').catch(() => {});
    await send('HeapProfiler.collectGarbage').catch(() => {});
    await sleep(3000);
    const dc = await send('Memory.getDOMCounters').catch(() => null);
    return `${await read('after GC')} · DOM nodes alive ${dc?.nodes ?? '–'} (in the page ${await js('return document.getElementsByTagName("*").length')}) · listeners ${dc?.jsEventListeners ?? '–'}`;
  });
  // The same, with a chat open that has only its newest messages drawn: how much of the window is the drawn chat.
  await step('Another chat open (newest messages only), then a collection', async () => {
    await openTimed(ids[0], 1);
    await sleep(1500);
    await send('HeapProfiler.collectGarbage').catch(() => {});
    await sleep(3000);
    const dc = await send('Memory.getDOMCounters').catch(() => null);
    return `${await read('other chat, after GC')} · DOM nodes alive ${dc?.nodes ?? '–'} (in the page ${await js('return document.getElementsByTagName("*").length')}) · listeners ${dc?.jsEventListeners ?? '–'}`;
  });
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify({ chats: N, turns: TURNS, pictures: PICS, screenshots: SHOTS, at: STAMP, rows }, null, 2));
  log(`perf numbers: ${path.join(OUT, 'perf.json')}`);
}

// ---------- run ----------
let failed = false;
try {
  await launch();
  await connect();
  if (SCENARIO === 'all' || SCENARIO === 'settings') await settingsScenario();
  if (SCENARIO === 'all' || SCENARIO === 'news') await newsScenario();
  if (SCENARIO === 'all' || SCENARIO === 'cli') await cliScenario();
  if (SCENARIO === 'all' || SCENARIO === 'running') await runningScenario();
  if (SCENARIO === 'perf') await perfScenario();
  if (SCENARIO === 'tabs') await tabsScenario();
  if (SCENARIO === 'preview') await previewScenario();
} catch (e) {
  failed = true;
  steps.push({ title: 'The test could not run', ok: false, note: e.message, img: null, ms: 0 });
  log(`✗ ${e.message}`);
} finally {
  const r = report();
  log(`${r.passed} of ${r.total} steps passed. Report: ${r.file}`);
  if (!KEEP) for (const id of made.projects) await js(`await fetch(${q(`/api/projects/${id}`)}, { method: 'DELETE' }); return true;`).catch(() => {});
  saveTestResult('ui', { scenario: SCENARIO, passed: r.passed, total: r.total, failedNames: steps.filter((s) => !s.moment && !s.ok).map((s) => s.title) });
  try { ws?.close(); } catch { /* closed */ }
  quit();
  if (!KEEP) {
    for (const p of made.paths) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* still locked */ } }
    try { fs.rmdirSync(path.join(os.tmpdir(), 'quorx-uitest')); } catch { /* not empty: another run's, or locked */ }
  }
  process.exit(failed || r.passed < r.total ? 1 : 0);
}
