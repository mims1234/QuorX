// Build benchmark (node scripts/bench.mjs --set build): does a harness change make real builds better?
//
//   node scripts/bench.mjs --set build --limit 2
//   node scripts/bench.mjs --set build --review off,builds --helpers on,off --reasoning off,low
//   node scripts/bench.mjs --set build --builder deepseek/deepseek-v4.1-flash,anthropic/claude-haiku-5.5 --only snake_portals,sales_dashboard
//   options: --tasks <file> --only id,id --cat game,form --limit n --repeat n --concurrency n --rounds n --bar n
//            --reviewer <model> --judge <model>|off --helper <model> --steps n --minutes n --keep
//            --decide off,auto     the deciders: off, auto (the agent chooses when to ask them) or force-first
//            --project <folder>    also copy every build into <folder>/builds/… and keep a results page at
//                                  <folder>/index.html, updated after each run (the folder becomes an QuorX project)
//            --giveup n            after n runs in a row where a builder's model calls failed (rate limits, no
//                                  provider…), skip its remaining runs (default 2) · --retries n per model call (default 2)
//            --cap <dollars>       stop starting runs once the bench has spent this much (a number in
//                                  logs/bench-cap.txt, if there is one, overrides it while the bench runs)
//            --resume <file.jsonl> carry on a stopped bench: runs already in that file are kept, not run again
//            --mode harness,direct  harness = the full QuorX agent; direct = one plain call to the model asking for
//                                  the files (no tools, no checks), the way you would use it in a plain chat;
//                                  cli:claude, cli:codex (or one from bench/clis.json) = that agent CLI builds in the
//                                  task's folder, limited to editing files there · --cli-model <id> passes a model to it
//            --checks on,off       the harness checks (gap check, screenshot and click checks) · --ask n: ask_user per reply
//                                  (in this YOLO bench the deciders answer) · default 0
//
// Each comma list in --builder, --review, --helpers and --reasoning is an axis; every combination is one setup.
// Every run gets its own throwaway project folder under the OS temp dir and goes through the real harness
// (server/agent.js with bench: 'build', so plan, verify, reviewer and helpers all work as in a chat). Afterwards
// a judge (the reviewer's own instructions, fresh context, sees only the request) plays the build in the
// headless browser and scores it, so setups with the reviewer off are scored the same way as those with it on.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, DEFAULTS, REVIEW_MODEL, REVIEW_KEYS, CORE_KEYS, REVIEW_SYSTEM, BROWSER_TOOLS, SUBMIT_REVIEW } from '../server/agent.js';
import { chatStream, chatModels, runtime } from '../server/openrouter.js';
import { saveProject, forgetProject, projectDir } from '../server/store.js';
import { safePath, listServers, stopServer } from '../server/workspace.js';
import { openTab, hostHtml, hostedHtml } from '../server/browser.js';
import { cliDefs, runCli } from '../server/clis.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const short = (m) => String(m).split('/').pop();
const list = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runBuildBench(arg) {
  const has = (name) => process.argv.includes(`--${name}`);
  const TASKS = arg('tasks', 'bench/tasks-build.json');
  const file = JSON.parse(fs.readFileSync(path.resolve(ROOT, TASKS), 'utf8'));
  const ONLY = arg('only', '') ? new Set(list(arg('only'))) : null;
  const CATS = arg('cat', '') ? new Set(list(arg('cat'))) : null;
  const tasks = file.tasks.filter((t) => (!ONLY || ONLY.has(t.id)) && (!CATS || CATS.has(t.cat))).slice(0, Number(arg('limit', 0)) || Infinity);
  const REPEAT = Math.max(1, Number(arg('repeat', 1)) || 1);
  const CONC = Math.max(1, Number(arg('concurrency', 2)) || 2);
  const REVIEWER = arg('reviewer', REVIEW_MODEL);
  const JUDGE = arg('judge', REVIEWER);
  const BAR = Math.max(1, Math.min(5, Number(arg('bar', DEFAULTS.reviewBar)) || 3));
  const ROUNDS = Math.max(0, Math.min(3, Number(arg('rounds', DEFAULTS.reviewRounds))));
  const STEPS = Math.max(10, Number(arg('steps', DEFAULTS.maxSteps)) || DEFAULTS.maxSteps);
  const MINUTES = Math.max(1, Number(arg('minutes', 15)) || 15);
  const KEEP = has('keep');
  // --models <file>: [{ "id": "...", "tier": "cheap" }, …] sets the builders (in that order) and their tiers.
  const MODELS = arg('models', '') ? JSON.parse(fs.readFileSync(path.resolve(ROOT, arg('models')), 'utf8')).models : null;
  const axes = {
    builder: MODELS ? MODELS.map((m) => m.id).filter((id) => !arg('builder', '') || list(arg('builder')).includes(id)) : list(arg('builder', 'anthropic/claude-haiku-5.5')),
    review: list(arg('review', DEFAULTS.review)),
    helpers: list(arg('helpers', DEFAULTS.helpers ? 'on' : 'off')),
    reasoning: list(arg('reasoning', 'off')),
    decide: list(arg('decide', 'off')),
    mode: list(arg('mode', 'harness')),
    checks: list(arg('checks', 'on')),
    fresh: list(arg('fresh', 'on')),
  };
  for (const f of axes.fresh) if (!['on', 'off'].includes(f)) throw new Error(`--fresh ${f}: use on or off`);
  const CLIS = cliDefs(), CLI_MODEL = arg('cli-model', '');
  for (const m of axes.mode) if (!['harness', 'direct'].includes(m) && !(m.startsWith('cli:') && CLIS.some((d) => d.id === m.slice(4)))) throw new Error(`--mode ${m}: use harness, direct or cli:<${CLIS.map((d) => d.id).join('|')}>`);
  for (const c of axes.checks) if (!['on', 'off'].includes(c)) throw new Error(`--checks ${c}: use on or off`);
  const ASK = Math.max(0, Math.min(10, Number(arg('ask', 0)) || 0));
  for (const d of axes.decide) if (!['off', 'auto', 'force-first'].includes(d)) throw new Error(`--decide ${d}: use off, auto or force-first`);
  const PROJECT = arg('project', '') ? path.resolve(arg('project')) : null;
  const GIVEUP = Math.max(1, Number(arg('giveup', 2)) || 2);
  const RETRIES = Math.max(0, Math.min(6, Number(arg('retries', 2))));
  const CAP0 = Number(arg('cap', 0)) || Infinity;
  const capFile = path.join(ROOT, 'logs', 'bench-cap.txt');
  const capNow = () => { try { return Number(fs.readFileSync(capFile, 'utf8').trim()) || CAP0; } catch { return CAP0; } };
  let CAP = capNow();
  const RESUME = arg('resume', '') ? path.resolve(ROOT, arg('resume')) : null;
  for (const r of axes.review) if (!['off', 'builds', 'always'].includes(r)) throw new Error(`--review ${r}: use off, builds or always`);
  for (const h of axes.helpers) if (!['on', 'off'].includes(h)) throw new Error(`--helpers ${h}: use on or off`);
  for (const r of axes.reasoning) if (!['off', 'low', 'medium', 'high'].includes(r)) throw new Error(`--reasoning ${r}: use off, low, medium or high`);
  if (!tasks.length) throw new Error('no build tasks match --only / --cat');

  // Every combination of the axes is one setup; its label names only the axes that vary.
  const setups = [{}];
  for (const [k, vals] of Object.entries(axes)) setups.splice(0, setups.length, ...setups.flatMap((s) => vals.map((v) => ({ ...s, [k]: v }))));
  // A direct build has no harness, so its review, helpers, decide and checks settings mean nothing: keep one of each.
  { const seen = new Set(); for (let i = setups.length - 1; i >= 0; i--) { const x = setups[i]; if (x.mode !== 'direct' && !x.mode.startsWith('cli:')) continue; const k = x.mode.startsWith('cli:') ? x.mode : `${x.builder}|${x.reasoning}`; if (seen.has(k)) setups.splice(i, 1); else seen.add(k); } }
  const varying = Object.keys(axes).filter((k) => axes[k].length > 1);
  // A model that cannot run without thinking (or should think) sets "reasoning" in the --models file.
  for (const s of setups) { const r = MODELS?.find((m) => m.id === s.builder)?.reasoning; if (r) s.reasoning = r; }
  for (const s of setups) s.label = varying.length ? varying.map((k) => (k === 'builder' ? short(s[k]) : `${k}=${s[k]}`)).join(' ') : 'default';
  // An agent CLI uses its own model (or --cli-model), not the --builder one: it is named by the CLI.
  for (const s of setups) if (s.mode.startsWith('cli:')) { const d = CLIS.find((x) => x.id === s.mode.slice(4)); s.cli = d; s.builder = `cli/${d.id}${CLI_MODEL ? `:${CLI_MODEL}` : ''}`; s.label = `${d.name}${CLI_MODEL ? ` ${short(CLI_MODEL)}` : ''}`; }
  // With a project folder: register it as an QuorX project (so it can be opened in the app) and keep the builds there.
  if (PROJECT) {
    fs.mkdirSync(path.join(PROJECT, 'builds'), { recursive: true });
    const id = path.basename(PROJECT).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'model-bench';
    try { saveProject({ id: id.length >= 3 ? id : `${id}-bench`, path: PROJECT }); } catch (e) { console.log(`(could not register ${PROJECT} as a project: ${e.message})`); }
  }

  const catalogue = await chatModels().catch(() => []);
  const modelInfo = Object.fromEntries([...new Set([...(MODELS || []).map((m) => m.id), ...axes.builder])].map((id) => { const c = catalogue.find((m) => m.id === id); return [id, { tier: MODELS?.find((m) => m.id === id)?.tier || null, name: c?.name || id, price: c?.price || null }]; }));
  for (const m of new Set([...axes.builder, REVIEWER, ...(JUDGE === 'off' ? [] : [JUDGE])])) if (catalogue.length && !catalogue.some((x) => x.id === m)) throw new Error(`model ${m} is not in the OpenRouter catalogue`);

  // The harness hosts what the agent builds at http://localhost:<runtime.port>: page artifacts at /preview/page/<token>
  // and project folders at /ws/<project>/<path>. The bench serves both itself, so it needs no running harness.
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pm = url.pathname.match(/^\/preview\/page\/([a-z0-9]+)$/i);
      if (pm) { const h = hostedHtml(pm[1]); res.writeHead(h == null ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(h ?? 'expired'); }
      const wm = url.pathname.match(/^\/ws\/([a-z0-9-]+)\/(.*)$/i);
      if (!wm || !wm[1].startsWith('bench-')) { res.writeHead(404); return res.end('not found'); }
      let f = safePath(projectDir(wm[1]), decodeURIComponent(wm[2]) || 'index.html');
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    } catch (e) { res.writeHead(500); res.end(String(e.message)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  runtime.port = server.address().port;

  // Throwaway projects, forgotten (and their folders removed unless --keep) however the bench ends. --project has
  // already copied the build out by then. A folder a stopping server still holds is tried again when the bench ends.
  const live = new Map(), locked = new Set(); // project id → folder; folders that could not be removed yet
  const remove = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); locked.delete(dir); } catch { locked.add(dir); } };
  const cleanup = (id) => {
    for (const sv of listServers(id)) { try { stopServer(sv.key); } catch { /* gone */ } }
    try { forgetProject(id); } catch { /* best effort */ }
    if (!KEEP) remove(live.get(id));
    live.delete(id);
  };
  process.once('SIGINT', () => { for (const id of [...live.keys()]) cleanup(id); process.exit(130); });
  process.on('exit', () => { for (const dir of [...locked]) remove(dir); });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const LOG = RESUME || path.join(ROOT, 'logs', `bench-build-${stamp}.jsonl`);
  const OUT = LOG.replace(/\.jsonl$/, '.json');
  // Runs already done in the file being resumed (skipped ones are tried again).
  const before = RESUME ? fs.readFileSync(RESUME, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => !r.skipped) : [];
  const doneBefore = (task, s, rep) => before.find((r) => r.builder === s.builder && r.task === task.id && (r.decide || 'off') === s.decide && (r.mode || 'harness') === s.mode && (r.checksOn || 'on') === s.checks && (r.fresh || 'on') === s.fresh && (r.rep || 0) === rep);
  if (RESUME) { fs.writeFileSync(RESUME, before.map((r) => JSON.stringify(r)).join('\n') + (before.length ? '\n' : '')); console.log(`resuming ${path.relative(ROOT, RESUME)}: ${before.length} run(s) already done`); }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const jobs = [];
  // One builder's runs together (in the order the builders were given), so a give-up or the spending cap
  // cuts whole builders rather than a slice of every one.
  for (const b of axes.builder) for (let rep = 0; rep < REPEAT; rep++) for (const task of tasks) for (const s of setups.filter((x) => x.builder === b)) jobs.push({ task, s, rep });
  console.log(`${TASKS} · ${tasks.length} build task(s) × ${setups.length} setup(s) × ${REPEAT} = ${jobs.length} runs · concurrency ${CONC}`);
  console.log(`builder ${axes.builder.map(short).join(', ')} · in-loop reviewer ${short(REVIEWER)} (bar ${BAR}, ${ROUNDS} round${ROUNDS === 1 ? '' : 's'}) · judge ${JUDGE === 'off' ? 'off (in-loop review only)' : short(JUDGE)} · ${MINUTES} min per run`);
  for (const s of setups) console.log(`  setup ${s.label}: builder ${short(s.builder)}, review ${s.review}, helpers ${s.helpers}, reasoning ${s.reasoning}, decide ${s.decide}`);
  if (PROJECT) console.log(`builds and results page: ${PROJECT}`);
  if (CAP < Infinity) console.log(`spending cap $${CAP}`);

  let done = 0, spent = 0;
  const failStreak = new Map(), gaveUp = new Map(); // builder → runs in a row whose model calls failed / why it was skipped
  // Runs in the resumed file that this bench will not run (other builders or settings) stay on the results page.
  const finished = before.filter((r) => !jobs.some(({ task, s, rep }) => doneBefore(task, s, rep) === r));
  const kept = [...finished];
  const skip = (task, s, rep, why) => ({ ts: new Date().toISOString(), set: 'build', setup: s.label, builder: s.builder, review: s.review, helpers: s.helpers, reasoning: s.reasoning, decide: s.decide, mode: s.mode, col: colOf(s, axes), task: task.id, cat: task.cat, rep,
    scores: null, total: 0, pass: false, bar: BAR, cost: 0, judgeCost: 0, calls: 0, ms: 0, sentBack: { reviewer: 0, checks: 0 }, plan: false, skipped: why, error: null });
  const results = await pool(jobs, CONC, async ({ task, s, rep }, i) => {
    const prev = doneBefore(task, s, rep);
    if (prev) { done++; spent += prev.cost + (prev.judgeCost || 0); finished.push(prev); return prev; }
    CAP = capNow();
    if (gaveUp.has(s.builder) || spent >= CAP) {
      const rec = skip(task, s, rep, gaveUp.get(s.builder) || `spending cap $${CAP} reached`);
      fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); done++; finished.push(rec);
      console.log(`${String(done).padStart(3)}/${jobs.length} ${pad(s.label, 22)} ${pad(task.id, 18)} skipped: ${rec.skipped}`);
      return rec;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `quorx-bench-${task.id.replace(/_/g, '-')}-`));
    const pid = `bench-${stamp.slice(11, 19).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 7)}-${i}`;
    saveProject({ id: pid, path: dir });
    live.set(pid, dir);
    let rec;
    try {
      const run = s.cli ? await cliBuild({ task, s, dir, suffix: file.suffix || '', minutes: MINUTES, model: CLI_MODEL })
        : s.mode === 'direct' ? await direct({ task, s, dir, suffix: file.suffix || '', minutes: MINUTES, retries: RETRIES })
        : await build({ task, s, pid, suffix: file.suffix || '', settings: { review: s.review, reviewModel: REVIEWER, reviewRounds: ROUNDS, reviewBar: BAR, helpers: s.helpers === 'on', maxSteps: STEPS, retries: RETRIES, askLimit: ASK, freshEyes: s.fresh !== 'off', ...(s.checks === 'off' ? { checks: { gap: false, shots: false, click: false } } : {}) }, minutes: MINUTES, rep });
      // The builder's model never answered (or kept failing): count it towards giving up on that model.
      const modelFailed = !!run.error && (!(run.stats.llmCalls > 0) || /rate.?limit|429|no endpoints|provider|overloaded|unavailable|timed? ?out|402|quota/i.test(run.error));
      failStreak.set(s.builder, modelFailed ? (failStreak.get(s.builder) || 0) + 1 : 0);
      if (failStreak.get(s.builder) >= GIVEUP) gaveUp.set(s.builder, `gave up on ${short(s.builder)} after ${GIVEUP} failed runs in a row (${clip(run.error, 120)})`);
      const targets = targetsFor(run.arts, dir);
      const j = JUDGE === 'off' ? fromReview(run.stats.review, BAR) : await judge({ task, targets, pid, arts: run.arts, model: JUDGE, bar: BAR, catalogue });
      const st = run.stats;
      const callsByRole = {};
      for (const m of Object.values(st.byModel || {})) callsByRole[m.role] = (callsByRole[m.role] || 0) + m.calls;
      const variant = colOf(s, axes);
      const saved = PROJECT ? keepBuild(dir, path.join(PROJECT, 'builds', task.id, `${short(s.builder).replace(/[^a-z0-9.-]+/gi, '-')}__${variant.replace(/[^a-z0-9.-]+/gi, '-')}${REPEAT > 1 ? `__${rep + 1}` : ''}`)) : null;
      rec = { ts: new Date().toISOString(), set: 'build', setup: s.label, builder: s.builder, review: s.review, helpers: s.helpers, reasoning: s.reasoning, decide: s.decide, reviewer: REVIEWER, judge: JUDGE,
        runId: `bench-build-${pid}`, fresh: s.fresh, freshLooks: run.fresh || [], mode: s.mode, checksOn: s.checks, col: variant, checkEvents: run.checks, deciderAnswers: run.deciderAnswers,
        tools: run.tools, toolCalls: Object.values(run.tools).reduce((a, b) => a + b, 0), toolErrors: run.toolErrors, helperTools: run.helperTools, deciders: { ...run.deciders, ...(st.decide || {}) }, questions: run.questions, llmRetries: run.retries, saved: saved && path.relative(PROJECT, saved).replace(/\\/g, '/'),
        task: task.id, cat: task.cat, rep, scores: j.scores, total: j.scores ? CORE_KEYS.reduce((a, k) => a + j.scores[k], 0) : 0, pass: !!j.pass, bar: BAR, bugs: j.bugs, summary: j.summary,
        judgeCost: j.cost || 0, judgeMs: j.ms || 0, cost: st.cost || 0, byRole: st.byRole || {}, calls: Object.values(callsByRole).reduce((a, b) => a + b, 0), callsByRole, builderCalls: st.llmCalls || 0,
        ms: st.ms || run.ms, steps: st.steps || 0, stop: st.stop || (run.error ? 'error' : null), sentBack: run.sentBack, plan: run.plan, planDone: st.plan || null,
        inLoopReviews: run.reviews, verify: st.verify || null, targets, files: listBuilt(dir), changed: (st.changed || []).length, error: run.error, dir: KEEP ? dir : null, reply: clip(run.reply, 1500) };
    } catch (e) {
      rec = { ts: new Date().toISOString(), set: 'build', setup: s.label, builder: s.builder, review: s.review, helpers: s.helpers, reasoning: s.reasoning, decide: s.decide, mode: s.mode, col: colOf(s, axes), task: task.id, cat: task.cat, rep,
        scores: null, total: 0, pass: false, bar: BAR, cost: 0, judgeCost: 0, calls: 0, ms: 0, sentBack: { reviewer: 0, checks: 0 }, plan: false, error: `bench: ${e.message}` };
    } finally { cleanup(pid); }
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
    done++; spent += rec.cost + (rec.judgeCost || 0); finished.push(rec);
    if (PROJECT) { try { writeResultsPage(PROJECT, { models: modelInfo, tasks, setups, bar: BAR, judge: JUDGE, results: finished, total: kept.length + jobs.length, spent: spent + kept.reduce((a, r) => a + r.cost + (r.judgeCost || 0), 0), cap: CAP, running: true }); } catch (e) { console.log(`(results page: ${e.message})`); } }
    console.log(`${String(done).padStart(3)}/${jobs.length} ${pad(s.label, 22)} ${pad(task.id, 18)} ${rec.scores ? REVIEW_KEYS.map((k) => rec.scores[k]).join('/') : '-/-/-/-'} ${rec.pass ? 'pass' : 'FAIL'}  $${(rec.cost + rec.judgeCost).toFixed(3)}  ${(rec.ms / 60000).toFixed(1)}m  tools ${rec.toolCalls ?? 0}  decide ${rec.deciders?.calls ?? 0}${rec.error ? `  ⚠ ${clip(rec.error, 80)}` : ''}  (spent $${spent.toFixed(2)})`);
    return rec;
  });
  server.close();

  const summary = report(results, setups, tasks, BAR);
  if (PROJECT) writeResultsPage(PROJECT, { models: modelInfo, tasks, setups, bar: BAR, judge: JUDGE, results: [...kept, ...results], total: kept.length + jobs.length, spent: spent + kept.reduce((a, r) => a + r.cost + (r.judgeCost || 0), 0), cap: CAP, running: false });
  fs.writeFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), tasksFile: TASKS, axes, reviewer: REVIEWER, judge: JUDGE, bar: BAR, rounds: ROUNDS, steps: STEPS, minutes: MINUTES, repeat: REPEAT, summary, results: [...kept, ...results] }, null, 2));
  const spend = results.reduce((a, r) => a + r.cost + (r.judgeCost || 0), 0);
  console.log(`\nTotal spend $${spend.toFixed(4)} · results ${path.relative(ROOT, OUT)} · per run ${path.relative(ROOT, LOG)}`);
}

// ---------- one build through the real harness ----------
async function build({ task, s, pid, suffix, settings, minutes, rep }) {
  const ev = { reply: '', stats: null, error: null, arts: new Map(), sentBack: { reviewer: 0, checks: 0 }, plan: false, reviews: [], tools: {}, toolErrors: 0, helperTools: 0, deciders: { asks: 0, looks: 0, asked: [], outcomes: {} }, questions: [], retries: 0, checks: [], deciderAnswers: [] };
  const rounds = new Map(); // decide round → { look, questions }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), minutes * 60e3);
  const t0 = Date.now();
  try {
    await runAgent({ bench: 'build', runId: `bench-build-${pid}`, projectId: pid, chatTitle: `bench ${task.id} #${rep + 1}`, setup: { model: s.builder, decide: s.decide || 'off', reasoning: s.reasoning },
      text: task.prompt + suffix, settings: { mediaEnabled: false, voters: DEFAULTS.voters, approval: 'yolo', yoloCheck: false, askLimit: 0, ...settings } }, (e) => {
      if (e.t === 'done') { ev.reply = e.reply; ev.stats = e.stats; }
      if (e.t === 'artifact') ev.arts.set(e.artifact.id, e.artifact);
      if (e.t === 'plan') ev.plan = true;
      if (e.t === 'sent_back') ev.sentBack[e.by === 'reviewer' ? 'reviewer' : 'checks']++;
      if (e.t === 'review') ev.reviews.push({ round: e.round, scores: e.scores, pass: e.pass, bugs: e.bugs?.length || 0, minor: e.minor?.length || 0, severities: e.severities || null, vague: e.vague || 0, cost: e.cost });
      if (e.t === 'error') ev.error = e.msg;
      if (e.t === 'tool' && !e.by) ev.tools[e.name] = (ev.tools[e.name] || 0) + 1;
      if (e.t === 'tool' && e.by === 'helper') ev.helperTools++;
      if (e.t === 'tool_result' && !e.by && /^\s*(error|⚠)/i.test(String(e.result || ''))) ev.toolErrors++;
      if (e.t === 'decide_start') rounds.set(e.round, { look: !!e.look, qs: e.questions || [] });
      // What each question the builder asked came to: theater (it was sure and they agreed), confirmed, flipped, unclear.
      if (e.t === 'decide_done' && rounds.get(e.round) && !rounds.get(e.round).look) {
        for (const r of e.results || []) {
          const q = rounds.get(e.round).qs.find((x) => x.id === r.id) || {};
          ev.deciders.outcomes[r.bucket] = (ev.deciders.outcomes[r.bucket] || 0) + 1;
          if (ev.questions.length < 40) ev.questions.push({ step: e.step, type: q.type, ask: clip(q.ask, 200), options: q.options, guess: q.guess, guessConf: q.guessConf, pick: r.pick, confidence: r.confidence, verdict: r.verdict, bucket: r.bucket });
        }
      }
      if (e.t === 'decide_start') { if (e.look) ev.deciders.looks++; else { ev.deciders.asks++; if (ev.deciders.asked.length < 12) ev.deciders.asked.push(...(e.questions || []).map((q) => clip(q.ask, 140)).slice(0, 12 - ev.deciders.asked.length)); } }
      if (e.t === 'llm_retry') ev.retries++;
      if (e.t === 'checks') ev.checks.push(e.kind === 'gap' ? { kind: 'gap', build: e.build, missing: e.rows.filter((r) => r.missing).map((r) => r.id) } : { kind: 'page', when: e.when, target: e.target, failed: e.rows.filter((r) => r.fail).map((r) => `${r.kind}.${r.id}`), asked: e.rows.length, clicked: e.clicked });
      if (e.t === 'answer' && e.by === 'deciders') ev.deciderAnswers.push({ text: e.text, confidence: e.confidence });
      if (e.t === 'fresh_eyes') (ev.fresh ||= []).push({ problems: e.problems, report: e.report, ok: e.ok, step: e.step });
    }, ac.signal);
  } catch (e) { ev.error = ac.signal.aborted ? `stopped after ${minutes} min` : e.message; }
  finally { clearTimeout(timer); }
  return { ...ev, stats: ev.stats || { cost: 0, byRole: {}, byModel: {} }, ms: Date.now() - t0 };
}

// The column a run belongs to on the results page: the axis values that tell setups apart.
function colOf(s, axes) {
  if (s.mode === 'direct') return 'direct';
  if (s.cli) return s.cli.name;
  const parts = [];
  if (axes.mode.length > 1) parts.push('harness');
  if (axes.checks.length > 1) parts.push(`checks ${s.checks}`);
  if (axes.fresh.length > 1) parts.push(`fresh eyes ${s.fresh}`);
  if (axes.decide.length > 1 || !parts.length) parts.push(`decide ${s.decide}`);
  return parts.join(' · ');
}

// ---------- a direct build: one plain call, the files come back as text ----------
const DIRECT_SYSTEM = `You are an expert web developer. Build exactly what the user asks, complete and working, in one reply.
Reply with every file in full and nothing else. Put each file in its own fenced code block, with the file's path alone on the line just before it, like this:

index.html
\`\`\`html
<!doctype html>
...
\`\`\`

style.css
\`\`\`css
...
\`\`\``;
async function direct({ task, s, dir, suffix, minutes, retries }) {
  const ev = { reply: '', error: null, arts: new Map(), sentBack: { reviewer: 0, checks: 0 }, plan: false, reviews: [], tools: {}, toolErrors: 0, helperTools: 0, deciders: { asks: 0, looks: 0, asked: [], outcomes: {} }, questions: [], retries: 0, checks: [], deciderAnswers: [] };
  const t0 = Date.now();
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), minutes * 60e3);
  const prompt = task.prompt + suffix.replace(/\s*When it works, open it with preview_site\.?/i, '');
  const body = { model: s.builder, messages: [{ role: 'system', content: DIRECT_SYSTEM }, { role: 'user', content: prompt }], max_tokens: 64000,
    ...(s.reasoning && s.reasoning !== 'off' ? { reasoning: { effort: s.reasoning } } : { reasoning: { enabled: false } }) };
  let r = null, cost = 0;
  try {
    for (let a = 0; ; a++) {
      try { r = await chatStream(body, ac.signal, null, null); break; }
      catch (e) { if (ac.signal.aborted || a >= retries) throw e; ev.retries++; await sleep(1500 * 2 ** a); }
    }
    cost = Number(r.usage?.cost) || 0;
    ev.reply = r.text || '';
    const files = parseFiles(ev.reply);
    if (!files.length) ev.error = 'the reply held no files';
    for (const f of files) { const out = safePath(dir, f.path); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, f.body); }
    ev.tools = { files: files.length };
  } catch (e) { ev.error = ac.signal.aborted ? `stopped after ${minutes} min` : e.message; }
  finally { clearTimeout(timer); }
  const ms = Date.now() - t0;
  return { ...ev, stats: { cost, byRole: { writer: cost }, byModel: { [s.builder]: { role: 'writer', calls: 1, cost } }, llmCalls: r ? 1 : 0, steps: 1, ms, stop: ev.error ? 'error' : 'answered', changed: [] }, ms };
}
// ---------- an agent CLI as the builder: it works in the task's folder by itself; the judge scores what is left ----------
export async function cliBuild({ task, s, dir, suffix, minutes, model }) {
  const ev = { reply: '', error: null, arts: new Map(), sentBack: { reviewer: 0, checks: 0 }, plan: false, reviews: [], tools: {}, toolErrors: 0, helperTools: 0, deciders: { asks: 0, looks: 0, asked: [], outcomes: {} }, questions: [], retries: 0, checks: [], deciderAnswers: [] };
  const prompt = `${task.prompt}${suffix.replace(/\s*When it works, open it with preview_site\.?/i, '')}\n\nBuild it as files in the current folder (index.html as the entry page). Don't ask questions: decide yourself.`;
  const r = await runCli(s.cli, { cwd: dir, prompt, model, minutes });
  ev.reply = r.reply || ''; ev.error = r.error || null;
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => !/^\.|node_modules/.test(String(f))).length;
  ev.tools = { files };
  if (!ev.error && !files) ev.error = 'the CLI left no files';
  const cost = Number(r.cost) || 0;
  return { ...ev, stats: { cost, byRole: { writer: cost }, byModel: { [s.builder]: { role: 'writer', calls: 1, cost } }, llmCalls: 1, steps: r.turns || 1, ms: r.ms, stop: ev.error ? 'error' : 'answered', changed: [] }, ms: r.ms };
}

// "path" on its own line, then a fenced block; a cut-off last block keeps what arrived.
function parseFiles(text) {
  const out = [], seen = new Set();
  const re = /(?:^|\n)[ \t]*(?:#+\s*|\*\*|`)?([\w][\w./-]*\.(?:html?|css|m?js|json|svg|txt|md))(?:\*\*|`)?:?[ \t]*\n+```[\w+-]*[ \t]*\n([\s\S]*?)(?:\n```|$(?![\s\S]))/g;
  for (const m of text.matchAll(re)) { const p = m[1].replace(/^\.?\//, ''); if (seen.has(p) || p.includes('..')) continue; seen.add(p); out.push({ path: p, body: m[2] }); }
  if (!out.length) { const m = text.match(/```html[ \t]*\n([\s\S]*?)(?:\n```|$(?![\s\S]))/); if (m) out.push({ path: 'index.html', body: m[1] }); }
  return out;
}

// Copy what was built (not .quorx or node_modules) into the bench project.
function keepBuild(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => !/[\\/](\.quorx|node_modules|\.git)([\\/]|$)/.test(src.slice(from.length)) });
  return to;
}

// The results page in the bench project: one self-contained index.html, rewritten after every run.
function writeResultsPage(dir, { models, tasks, setups, bar, judge, results, total, spent, cap, running }) {
  // Only the models this page has builds (or runs to come) for.
  const shown = new Set([...results.filter(Boolean).map((r) => r.builder), ...setups.map((x) => x.builder)]);
  models = Object.fromEntries(Object.entries(models).filter(([id]) => shown.has(id)));
  const data = { at: new Date().toISOString(), models, tasks: tasks.map((t) => ({ id: t.id, cat: t.cat, prompt: t.prompt })), setups: setups.map((s) => ({ label: s.label, builder: s.builder, decide: s.decide })),
    bar, judge, total, spent, cap: cap === Infinity ? null : cap, running, keys: REVIEW_KEYS,
    results: results.filter(Boolean).map((r) => ({ builder: r.builder, decide: r.decide, task: r.task, cat: r.cat, scores: r.scores, total: r.total, pass: r.pass, cost: r.cost, judgeCost: r.judgeCost, ms: r.ms,
      steps: r.steps, tools: r.tools, toolCalls: r.toolCalls, toolErrors: r.toolErrors, helperTools: r.helperTools, deciders: r.deciders, questions: r.questions, retries: r.llmRetries, mode: r.mode, col: r.col, checkEvents: r.checkEvents, deciderAnswers: r.deciderAnswers, saved: r.saved, error: r.error, skipped: r.skipped, bugs: r.bugs, summary: r.summary, files: (r.files || []).length })) };
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(data, null, 2));
  const tpl = fs.readFileSync(path.join(ROOT, 'bench', 'results-page.html'), 'utf8');
  // A function replacer: a string one would treat $' $& $` in the data (a model's text can hold them) as patterns.
  fs.writeFileSync(path.join(dir, 'index.html'), tpl.replace('/*DATA*/null', () => JSON.stringify(data).replace(/</g, '\\u003c')));
}

// What the judge opens: page artifacts and previewed sites, else the project's index.html (or any top-level page).
function targetsFor(arts, dir) {
  const t = [];
  for (const a of arts.values()) {
    if (a.kind === 'html' && a.html) t.push(`artifact:${a.id}`);
    if (a.kind === 'site' && a.url) t.push(`site:${a.url.replace(/^\/ws\/[^/]+\//, '')}`);
  }
  if (!t.some((x) => x.startsWith('site:'))) {
    const page = fs.existsSync(path.join(dir, 'index.html')) ? 'index.html' : fs.readdirSync(dir).find((f) => /\.html?$/i.test(f));
    if (page) t.push(`site:${page}`);
  }
  return [...new Set(t)].slice(0, 3);
}
function listBuilt(dir) {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.quorx' || e.name === 'node_modules') continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push({ path: r, bytes: fs.statSync(path.join(d, e.name)).size }); } };
  try { walk(dir, ''); } catch { /* gone */ }
  return out.slice(0, 40);
}
// --judge off: score with the in-loop reviewer's last verdict (none when the reviewer was off or skipped).
function fromReview(rv, bar) {
  if (!rv) return { scores: null, pass: false, bugs: ['no in-loop review (reviewer off or skipped) and --judge off'], summary: '', cost: 0 };
  return { scores: rv.scores, pass: CORE_KEYS.every((k) => rv.scores[k] >= bar), bugs: rv.bugs, summary: '', cost: 0 };
}

// ---------- the judge: the reviewer's instructions in a fresh context, blind to the plan and the builder's claims ----------
async function judge({ task, targets, pid, arts, model, bar, catalogue }) {
  const t0 = Date.now();
  if (!targets.length) return { scores: Object.fromEntries(REVIEW_KEYS.map((k) => [k, 1])), pass: false, bugs: ['nothing openable was built'], summary: 'No page to test.', cost: 0, ms: 0 };
  const info = catalogue.find((m) => m.id === model);
  const sees = !info || (info.in || []).includes('image');
  const base = `http://localhost:${runtime.port}`;
  const resolve = (target) => {
    const t = String(target || '').trim();
    if (t.startsWith('artifact:')) { const a = arts.get(t.slice(9)); if (!a?.html) throw new Error(`no page artifact ${t.slice(9)}`); return base + hostHtml(a.html); }
    if (t.startsWith('site:')) return `${base}/ws/${pid}/${t.slice(5).replace(/^[/\\]+/, '') || 'index.html'}`;
    throw new Error(`open one of: ${targets.join(', ')}`);
  };
  const msgs = [{ role: 'system', content: REVIEW_SYSTEM(bar, sees) }, { role: 'user', content: `The user asked:\n<request>\n${task.prompt}\n</request>\n\nTest these with the browser tool (open each one): ${targets.join(', ')}

Real-time games keep running while you think between turns, so a game can end before your next action. Judge whether a control works by the result returned right after that action, and test quick sequences (start then pause, or start then steer) as several browser calls in one turn.` }];
  let cost = 0, result = null, tab = null;
  const shots = new WeakSet();
  try {
    tab = await openTab();
    for (let i = 0; i < 14 && !result; i++) {
      const body = { model, messages: msgs, tools: [BROWSER_TOOLS[0], SUBMIT_REVIEW], tool_choice: i >= 12 ? { type: 'function', function: { name: 'submit_review' } } : 'auto', max_tokens: 4000, reasoning: { enabled: false } };
      let r;
      for (let a = 0; ; a++) { try { r = await chatStream(body, undefined, null, null); break; } catch (e) { if (a >= 2) throw e; await sleep(1000 * 2 ** a); } }
      cost += Number(r.usage?.cost) || 0;
      if (!r.toolCalls.length) { msgs.push({ role: 'assistant', content: r.text || 'I have tested it.' }, { role: 'user', content: 'Call submit_review now with your scores, bugs and summary.' }); continue; }
      msgs.push({ role: 'assistant', content: r.text || null, tool_calls: r.toolCalls });
      for (const tc of r.toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* empty args */ }
        if (tc.function.name === 'submit_review') { result = args; msgs.push({ role: 'tool', tool_call_id: tc.id, content: 'Review received.' }); continue; }
        let out;
        try { out = tc.function.name === 'browser' ? await browse(tab, args, resolve) : 'Error: only browser and submit_review are available.'; } catch (e) { out = `Error: ${e.message}`; }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: clip(out, 6000) });
      }
      if (!result && sees && tab.url !== 'about:blank') {
        for (const m of msgs) if (shots.has(m)) { m.content = '(an older screenshot, removed)'; shots.delete(m); }
        const shot = await tab.screenshot().catch(() => null);
        if (shot) { const m = { role: 'user', content: [{ type: 'text', text: 'Screenshot of the page now:' }, { type: 'image_url', image_url: { url: shot } }] }; shots.add(m); msgs.push(m); }
      }
    }
  } catch (e) {
    return { scores: null, pass: false, bugs: [], summary: `judge failed: ${e.message}`, cost, ms: Date.now() - t0, error: e.message };
  } finally { try { await tab?.close(); } catch { /* gone */ } }
  if (!result) return { scores: null, pass: false, bugs: [], summary: 'the judge never submitted a review', cost, ms: Date.now() - t0 };
  const scores = Object.fromEntries(REVIEW_KEYS.map((k) => [k, Math.max(1, Math.min(5, Math.round(Number(result.scores?.[k])) || 1))]));
  // Pass stays on the four scores earlier benchmark runs used, so pass rates remain comparable; accessibility is reported beside them.
  return { scores, pass: CORE_KEYS.every((k) => scores[k] >= bar), bugs: (Array.isArray(result.bugs) ? result.bugs : []).map((x) => clip(x, 300)).slice(0, 10), summary: clip(result.summary, 600), cost, ms: Date.now() - t0 };
}
async function browse(tab, args, resolve) {
  let did = '';
  if (args.action === 'open') { await tab.open(resolve(args.target), { width: Number(args.width) || 1280 }); did = `Opened ${args.target}.`; }
  else if (tab.url === 'about:blank') return 'Nothing is open yet: use action "open" with a target first.';
  else if (args.action === 'click') did = await tab.click(args);
  else if (args.action === 'type') did = await tab.type(args);
  else if (args.action === 'press') did = await tab.press(String(args.key || 'Enter'));
  else if (args.action === 'scroll') did = await tab.scroll(args.dy);
  const sum = await tab.summary();
  return `${did ? did + '\n' : ''}Title: ${sum.title || '(none)'} · URL: ${sum.url}\nControls: ${sum.controls.join('; ') || '(none)'}\nConsole errors: ${tab.console.length ? tab.console.slice(-8).join(' | ') : 'none'}\nVisible text:\n${sum.text || '(empty)'}`;
}

// ---------- report ----------
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function report(results, setups, tasks, bar) {
  const rows = setups.map((s) => {
    const rs = results.filter((r) => r.setup === s.label && !r.skipped), scored = rs.filter((r) => r.scores);
    const role = (k) => avg(rs.map((r) => r.byRole?.[k] || 0));
    return { setup: s.label, builder: s.builder, review: s.review, helpers: s.helpers, reasoning: s.reasoning, decide: s.decide, runs: rs.length, passed: rs.filter((r) => r.pass).length,
      toolCallsPerRun: +avg(rs.map((r) => r.toolCalls || 0)).toFixed(1), decideAsksPerRun: +avg(rs.map((r) => r.deciders?.asks || 0)).toFixed(2), skipped: rs.filter((r) => r.skipped).length,
      scores: Object.fromEntries(REVIEW_KEYS.map((k) => [k, +avg(scored.filter((r) => r.scores[k] != null).map((r) => r.scores[k])).toFixed(2)])), total: +avg(scored.map((r) => r.total)).toFixed(2),
      costPerRun: +avg(rs.map((r) => r.cost)).toFixed(5), byRolePerRun: { writer: +role('writer').toFixed(5), reviewer: +role('reviewer').toFixed(5), helper: +role('helper').toFixed(5), decider: +role('decider').toFixed(5) },
      judgeCost: +rs.reduce((a, r) => a + (r.judgeCost || 0), 0).toFixed(5), callsPerRun: +avg(rs.map((r) => r.calls)).toFixed(1), minutesPerRun: +avg(rs.map((r) => r.ms / 60000)).toFixed(2),
      sentBackPerRun: +avg(rs.map((r) => (r.sentBack?.reviewer || 0) + (r.sentBack?.checks || 0))).toFixed(2), reviewerSentBack: rs.reduce((a, r) => a + (r.sentBack?.reviewer || 0), 0),
      planned: rs.filter((r) => r.plan).length, errors: rs.filter((r) => r.error).length };
  });
  console.log(`\nBUILD RESULTS (judge scores 1-5; pass = function, craft, design and originality all ≥ ${bar}; a11y is reported only)`);
  console.log(`${pad('setup', 24)}${lpad('pass', 7)}${lpad('func', 6)}${lpad('craft', 6)}${lpad('design', 7)}${lpad('orig', 6)}${lpad('a11y', 6)}${lpad('sum', 6)}${lpad('$/run', 9)}${lpad('writer', 9)}${lpad('review', 9)}${lpad('helper', 9)}${lpad('decide', 9)}${lpad('calls', 7)}${lpad('min', 6)}${lpad('back', 6)}${lpad('plan', 6)}`);
  for (const r of rows) {
    console.log(`${pad(r.setup, 24)}${lpad(`${r.passed}/${r.runs}`, 7)}${REVIEW_KEYS.map((k, i) => lpad(r.scores[k].toFixed(1), [6, 6, 7, 6, 6][i])).join('')}${lpad(r.total.toFixed(1), 6)}${lpad(`$${r.costPerRun.toFixed(3)}`, 9)}${lpad(`$${r.byRolePerRun.writer.toFixed(3)}`, 9)}${lpad(`$${r.byRolePerRun.reviewer.toFixed(3)}`, 9)}${lpad(`$${r.byRolePerRun.helper.toFixed(3)}`, 9)}${lpad(`$${r.byRolePerRun.decider.toFixed(3)}`, 9)}${lpad(r.callsPerRun, 7)}${lpad(r.minutesPerRun.toFixed(1), 6)}${lpad(r.sentBackPerRun.toFixed(1), 6)}${lpad(`${r.planned}/${r.runs}`, 6)}`);
  }
  console.log('  $/run = builder run cost (writer + reviewer + helpers + deciders for look; the judge is extra) · calls = model calls per run · back = times sent back (reviewer + checks) · plan = runs that made a plan');
  console.log(`\nPER TASK (function/craft/design/originality/accessibility, ✓ = pass)\n${pad('task', 18)}${setups.map((s) => pad(s.label, 24)).join('')}`);
  for (const t of tasks) {
    console.log(`${pad(t.id, 18)}${setups.map((s) => pad(results.filter((r) => r.task === t.id && r.setup === s.label).map((r) => (r.scores ? `${REVIEW_KEYS.map((k) => r.scores[k] ?? '-').join('/')}${r.pass ? '✓' : '✗'}` : `—${r.error ? '⚠' : ''}`)).join(' '), 24)).join('')}`);
  }
  const errs = results.filter((r) => r.error);
  if (errs.length) { console.log('\nPROBLEMS'); for (const r of errs) console.log(`  ${r.setup} · ${r.task}: ${clip(r.error, 160)}`); }
  return rows;
}

async function pool(items, n, fn) {
  const out = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
