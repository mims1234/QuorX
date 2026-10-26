// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Scale check: a throwaway QuorX home with many projects and chats, one chat with a very long Steps log and one project
// folder with many files; then a real QuorX on it, timing what the page asks for. Nothing touches your own data.
//   node scripts/scale-bench.mjs [--chats 20000] [--projects 200] [--trace-mb 50] [--files 50000] [--keep DIR]
// --keep DIR builds the data into DIR once and reuses it on the next run (building 100k chats takes a while).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const CHATS = Number(arg('chats', 20000)), PROJECTS = Number(arg('projects', 200)), TRACE_MB = Number(arg('trace-mb', 50)), FILES = Number(arg('files', 50000));
const KEEP = arg('keep', '');
const home = KEEP ? path.resolve(KEEP) : fs.mkdtempSync(path.join(os.tmpdir(), 'quorx-scale-'));
const data = path.join(home, 'data'), chats = path.join(data, 'chats'), work = path.join(home, 'folders');
const DAY = 864e5, now = Date.now();
const rnd = (n) => Math.floor(Math.random() * n);
const words = 'build page test server fix layout picture chart login search video sound review deploy'.split(' ');
const phrase = (n) => Array.from({ length: n }, () => words[rnd(words.length)]).join(' ');

// One reply's steps: what a real trace holds (model calls, tools, results, decider checks).
function trace(n, at) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = ['llm_done', 'tool', 'tool_result', 'decide_start', 'verify'][i % 5];
    out.push({ t, at: at + i * 900, model: 'deepseek/deepseek-v4.1-flash-1017', cost: t === 'llm_done' ? 0.0004 : undefined, name: t === 'tool' ? 'write_file' : undefined, result: t === 'tool_result' ? phrase(40) : undefined });
  }
  return out;
}
function chat(id, projectId, replies, steps, at) {
  const messages = [];
  for (let r = 0; r < replies; r++) {
    const t = at + r * 60e3;
    messages.push({ role: 'user', content: phrase(12), at: t });
    messages.push({ role: 'assistant', content: phrase(60), at: t + 1000, doneAt: t + 30e3, runId: `r${id}${r}`, trace: trace(steps, t), stats: { cost: steps * 0.0002, byModel: { 'deepseek/deepseek-v4.1-flash-1017': { cost: steps * 0.0002 } } } });
  }
  return { id, title: `${phrase(5)} ${id}`, projectId, created: at, updated: at + replies * 60e3, rev: 'x', agent: { setup: { model: 'deepseek/deepseek-v4.1-flash-1017' }, messages, artifacts: {} } };
}

function build() {
  if (KEEP && fs.existsSync(path.join(data, 'projects.json'))) { console.log(`Reusing ${home}`); return; }
  console.log(`Building ${CHATS} chats in ${PROJECTS} projects, a ${TRACE_MB} MB Steps chat and ${FILES} files in ${home}…`);
  fs.mkdirSync(chats, { recursive: true });
  const projects = [{ id: 'scratch', name: 'Scratch', path: path.join(work, 'scratch'), created: 1 }];
  for (let p = 0; p < PROJECTS; p++) projects.push({ id: `proj${String(p).padStart(4, '0')}`, name: `project-${p}`, path: path.join(work, `project-${p}`), created: 1, budget: p % 3 ? 10 : null });
  for (const p of projects) fs.mkdirSync(p.path, { recursive: true });
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify(projects));
  for (let i = 0; i < CHATS; i++) {
    const id = `cscale${String(i).padStart(7, '0')}`, p = projects[1 + (i % PROJECTS)];
    fs.writeFileSync(path.join(chats, `${id}.json`), JSON.stringify(chat(id, p.id, 1 + rnd(4), 10 + rnd(30), now - rnd(365) * DAY)));
    if (i % 10000 === 9999) console.log(`  ${i + 1} chats`);
  }
  // One chat whose Steps reach TRACE_MB: many replies of many steps.
  const big = chat('cscalebig', projects[1].id, 1, 1, now - DAY);
  const per = 2000, reply = JSON.stringify(trace(per, now)).length;
  big.agent.messages = [];
  for (let r = 0; r * reply < TRACE_MB * 1e6; r++) { const t = now - DAY + r * 60e3; big.agent.messages.push({ role: 'user', content: phrase(10), at: t }, { role: 'assistant', content: phrase(40), at: t + 1, doneAt: t + 2, runId: `rbig${r}`, trace: trace(per, t), stats: { cost: 0.4 } }); }
  fs.writeFileSync(path.join(chats, 'cscalebig.json'), JSON.stringify(big));
  // A project folder with many files in a few levels of folders.
  const deep = projects[1].path;
  for (let f = 0; f < FILES; f++) { const d = path.join(deep, `src${f % 50}`, `mod${f % 7}`); if (f < 350) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `file${f}.js`), 'x'); }
  console.log('Built.');
}

async function quorx() {
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, OH_HOME: home, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', OPENROUTER_API_KEY: '', QX_NO_JOBHOST: '1', QUORX_NEWS_SITE: 'off' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 300e3);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`QuorX exited (${c}):\n${out}`)); });
  });
  const key = fs.readFileSync(path.join(data, 'app-key'), 'utf8').trim();
  // Plain http (fetch gives up after 5 minutes); anything slower than 10 minutes is reported as such.
  const time = (p) => new Promise((resolve) => {
    const s = performance.now();
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { 'x-quorx-key': key } }, (res) => {
      let n = 0; res.on('data', (d) => { n += d.length; });
      res.on('end', () => resolve({ ms: Math.round(performance.now() - s), kb: Math.round(n / 1024), status: res.statusCode }));
    });
    req.setTimeout(600e3, () => { req.destroy(); resolve({ ms: 600e3, kb: 0, status: 'gave up after 10 min' }); });
    req.on('error', (e) => resolve({ ms: Math.round(performance.now() - s), kb: 0, status: e.message }));
  });
  return { started: Date.now() - t0, time, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

build();
const line = (label, r) => console.log(`${label.padEnd(26)} ${String(r.ms).padStart(7)} ms${r.kb != null ? `  ${String(r.kb).padStart(8)} KB` : ''}${r.status && r.status !== 200 ? `  (${r.status})` : ''}`);
console.log(`\n${CHATS} chats · ${PROJECTS} projects · ${TRACE_MB} MB Steps · ${FILES} files\n`);
const q = await quorx();
line('QuorX start', { ms: q.started });
for (const [label, p] of [
  ['Chat list (first)', '/api/chats'], ['Chat list (again)', '/api/chats'], ['Sidebar chats', '/api/chats?view=sidebar&per=30'],
  ['Show more chats', '/api/chats/page?project=proj0001&limit=60'], ['Search chats', '/api/chats/page?q=deploy%20video&limit=200'], ['Projects', '/api/projects'],
  ['Open a normal chat', '/api/chats/cscale0000001'], ['Open the long-Steps chat', '/api/chats/cscalebig'], ['Open it again', '/api/chats/cscalebig'], ['One older reply’s steps', '/api/chats/cscalebig/trace/rbig0'],
  ['Files, big project (whole list)', `/api/files?project=proj0000`], ['Files pane, top folder', `/api/files/dir?project=proj0000`], ['Files pane, a folder', `/api/files/dir?project=proj0000&path=src1`], ['Delete estimate', '/api/chats/cscale0000002/footprint'],
]) line(label, await q.time(p));
await q.stop();
if (!KEEP) fs.rmSync(home, { recursive: true, force: true });
