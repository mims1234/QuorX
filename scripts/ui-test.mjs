// QuorX UI test: starts the QuorX desktop app from this checkout, with its own data folder and port, drives its
// window the way a person would, and saves a screenshot of every step with an HTML report.
//
//   npm run test:ui                         both scenarios
//   npm run test:ui -- --scenario settings  only the checks that need no key
//   npm run test:ui -- --scenario cli       the agent builds a Rust command-line program
//   npm run test:ui -- --scenario running   the Running tab: what runs, who started it, Stop and Stop all
//   npm run test:ui -- --scenario news      News: the dot, What's new, the sample article, Play on a flow, a compare
//   add --keep to leave the app open afterwards
//
// The test copy keeps its own chats, projects and keys in .uitest/home (git ignores it), and runs on port 5197, so
// your own QuorX and its data are never touched. The cli scenario needs an OpenRouter key in that copy: set
// OPENROUTER_API_KEY when you start the test, or add one in the window when it asks (⚙ Settings → API keys; it
// waits up to 10 minutes). Screenshots and report.html go to .uitest/runs/<time>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectToolchains } from '../server/toolchains.js';

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
  const env = { ...process.env, OH_USER_DATA: USERDATA, OH_HOME: HOME, AGENT_PORT: String(PORT) };
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
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(`http://localhost:${PORT}`)); } catch { /* starting */ }
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
async function testProject(label) {
  const dir = path.join(os.tmpdir(), 'quorx-uitest', `${label}-${STAMP}`);
  fs.mkdirSync(dir, { recursive: true });
  const id = `uitest-${label}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const p = await api('/api/projects', { id, path: dir });
  if (p.error) throw new Error(p.error);
  await js('location.reload(); return true;').catch(() => {});
  await sleep(1500);
  await waitFor(`document.querySelector('.sb-project[data-p=${q(p.id)}]')`, 20000, 'the project in the sidebar');
  return { ...p, dir };
}

async function settingsScenario() {
  let proj = null;
  await step('QuorX opens', async () => { await waitFor(`document.querySelector('#settingsBtn') && document.querySelector('#projectList')`, 30000, 'the app'); return `Loaded ${await js('return location.href')}`; });
  await step('A project of the test’s own for the rule checks', async () => { proj = await testProject('rules'); return `${proj.name} at ${proj.dir}`; });
  await step('Settings → Safety & commands', async () => {
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
    await moment('Waiting for a key: add one in ⚙ Settings → API keys', 'The test copy has no key. Add one in the window (a separate key with a small spending limit is best).');
    log('>>> The test copy has no OpenRouter key. Add one in the QuorX window that opened (⚙ Settings → API keys). Waiting up to 10 minutes…');
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
  await step('The Running tab lists everything, with who started it', async () => {
    await click('#paneTabs [data-tab="run"]');
    await waitFor(`document.querySelectorAll('#runPane .run-row').length >= 2`, 15000, 'the rows');
    await sleep(3500); // one poll, so the times and the tab's count are fresh
    const rows = await js(`return [...document.querySelectorAll('#runPane .run-row')].map((r) => ({ kind: r.dataset.kind, text: r.innerText.replace(/\\s+/g, ' ').slice(0, 160) }));`);
    const kinds = rows.map((r) => r.kind);
    for (const k of ['background', 'server']) if (!kinds.includes(k)) throw new Error(`no ${k} row; rows: ${JSON.stringify(rows)}`);
    const bg = rows.find((r) => r.kind === 'background');
    if (!/agent/.test(bg.text) || !/ticker/.test(bg.text)) throw new Error(`the background row doesn't say the agent started ticker.js: ${bg.text}`);
    const count = await textOf('#paneTabs [data-tab="run"] .pt-n');
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
    if (on < 1 || !/\d\/\d/.test(cap)) throw new Error(`not walking: step ${on}, caption "${cap}" (the window is ${seen})`);
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
  await step('Close News: back to Home', async () => {
    await click('#newsView .nw-close');
    await waitFor(`document.querySelector('#newsView').hidden && !document.querySelector('.work').classList.contains('news-on')`, 5000, 'News to close');
    return `Home is ${await js("return document.querySelector('#homeBtn').classList.contains('active') ? 'lit' : 'not lit'")}`;
  });
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
} catch (e) {
  failed = true;
  steps.push({ title: 'The test could not run', ok: false, note: e.message, img: null, ms: 0 });
  log(`✗ ${e.message}`);
} finally {
  const r = report();
  log(`${r.passed} of ${r.total} steps passed. Report: ${r.file}`);
  try { ws?.close(); } catch { /* closed */ }
  quit();
  process.exit(failed || r.passed < r.total ? 1 : 0);
}
