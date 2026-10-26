// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Known-answer benchmark: does letting a small model ask the deciders make it stronger?
//
//   node scripts/bench.mjs --setups A,C,E --limit 10
//   node scripts/bench.mjs --setups A,C,D,E --concurrency 6 --only sally_sisters,bat_ball
//   node scripts/bench.mjs --tasks bench/tasks-hard.json --setups A,C,D,E
//   node scripts/bench.mjs --setups A,D,D2 --d2-fallback strong
//   options: --small <model> --frontier <model> --repeat <n> --cat trap,trick --d2-fallback C|strong|none --strong <model>
//   node scripts/bench.mjs --set build --limit 2   (build tasks scored by a judge; options in scripts/bench-build.mjs)
//
// Every setup runs through the real harness (server/agent.js) with media off. D is the harness's
// generate-then-pick setup: the small model writes 3 drafts in parallel and the deciders pick one. Every reply must end with "ANSWER: …", which is graded against the
// task's accept/reject patterns. If that line is missing, a decider judges the reply instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, DEFAULTS } from '../server/agent.js';
import { ensemble } from '../server/decisions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
// --set build: real builds in throwaway project folders, scored by a judge model (scripts/bench-build.mjs).
if (arg('set', 'qa') === 'build') {
  const { runBuildBench } = await import('./bench-build.mjs');
  try { await runBuildBench(arg); process.exit(0); } catch (e) { console.error(`\n${e.stack || e.message}`); process.exit(1); }
}
const SETUPS = arg('setups', 'A,C,E').split(',').map((s) => s.trim().toUpperCase());
const LIMIT = Number(arg('limit', 0)) || Infinity;
const CONC = Number(arg('concurrency', 6));
const REPEAT = Number(arg('repeat', 1));
const ONLY = arg('only', '') ? new Set(arg('only').split(',')) : null;
const CATS = arg('cat', '') ? new Set(arg('cat').split(',')) : null;
const SMALL = arg('small', DEFAULTS.setups.A.model);
const FRONTIER = arg('frontier', DEFAULTS.setups.E.model);
const VOTERS = DEFAULTS.voters;

const FORMAT = '\n\n(Reply normally, then end with a final line exactly like "ANSWER: <short answer>": a letter, a number, or a few words.)';
const TASKS = arg('tasks', 'bench/tasks.json');
const tasks = JSON.parse(fs.readFileSync(path.resolve(ROOT, TASKS), 'utf8')).tasks
  .filter((t) => (!ONLY || ONLY.has(t.id)) && (!CATS || CATS.has(t.cat))).slice(0, LIMIT);

const SETUP = {
  A: { ...DEFAULTS.setups.A, model: SMALL },
  C: { ...DEFAULTS.setups.C, model: SMALL },
  D: { ...DEFAULTS.setups.D, model: SMALL },
  D2: { ...DEFAULTS.setups.D2, model: SMALL, fallback: arg('d2-fallback', DEFAULTS.setups.D2.fallback), strong: arg('strong', DEFAULTS.setups.D2.strong) },
  E: { ...DEFAULTS.setups.E, model: FRONTIER },
};

// ---------- grading ----------
const answerLine = (reply) => {
  const m = [...String(reply || '').matchAll(/ANSWER:\s*(.+)/gi)].pop();
  return m ? m[1].replace(/[*_`"]/g, '').trim() : null;
};
const norm = (s) => s.toLowerCase().replace(/^[\s(\[]*(the answer is|answer is)\s*/, '').replace(/\s+/g, ' ').trim();
function gradeLine(task, line) {
  const a = norm(line);
  const hit = (list) => (list || []).some((re) => new RegExp(re, 'i').test(a));
  return hit(task.accept) && !hit(task.reject);
}
async function grade(task, reply) {
  const line = answerLine(reply);
  if (line != null) return { correct: gradeLine(task, line), answer: line, by: 'pattern', cost: 0 };
  // No answer line: one decider judges whether the reply's conclusion matches the expected answer.
  let cost = 0;
  const d = await ensemble({ voters: [VOTERS[0]], state: { question: task.prompt, expected_answer: task.expected, reply: String(reply).slice(0, 3000) },
    questions: [{ id: 'match', type: 'noul', ask: 'The reply\'s final answer to the question is the same as the expected answer.' }], account: (u) => { cost += u.cost || 0; } });
  return { correct: d.results.match.dist.yes >= 0.5, answer: `(no ANSWER line) P(match)=${d.results.match.dist.yes.toFixed(2)}`, by: 'decider', cost };
}

// ---------- runners ----------
async function runHarness(key, task) {
  const ev = { reply: '', stats: null, decides: [], error: null };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180e3);
  try {
    await runAgent({ bench: true, runId: `bench-${key}-${task.id}`, setup: SETUP[key], text: task.prompt + FORMAT, settings: { mediaEnabled: false, voters: VOTERS, approval: 'yolo', yoloCheck: false } }, (e) => {
      if (e.t === 'done') { ev.reply = e.reply; ev.stats = e.stats; }
      if (e.t === 'decide_start') ev.decides.push({ questions: e.questions, results: null });
      if (e.t === 'decide_done') ev.decides.at(-1).results = e.results;
      if (e.t === 'drafts') ev.drafts = e.drafts;
      if (e.t === 'pick') ev.pick = e;
      if (e.t === 'error') ev.error = e.msg;
    }, ac.signal);
  } catch (e) { ev.error = e.message; }
  finally { clearTimeout(timer); }
  const s = ev.stats || { cost: 0, ms: 0, decide: {} };
  return { reply: ev.reply, cost: s.cost, ms: s.ms, decide: s.decide, decides: ev.decides, drafts: ev.drafts, pick: ev.pick, error: ev.error };
}

// ---------- main ----------
async function pool(items, n, fn) {
  const out = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const jobs = [];
for (let r = 0; r < REPEAT; r++) for (const t of tasks) for (const k of SETUPS) jobs.push({ key: k, task: t, rep: r });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG = path.join(ROOT, 'logs', `bench-${stamp}.jsonl`);
fs.mkdirSync(path.dirname(LOG), { recursive: true });
console.log(`${TASKS} · ${tasks.length} tasks × ${SETUPS.join(',')} × ${REPEAT} = ${jobs.length} runs · small ${SMALL} · frontier ${FRONTIER} · deciders ${VOTERS.map((v) => v.split('/').pop()).join(', ')}`);

let done = 0;
const results = await pool(jobs, CONC, async ({ key, task, rep }) => {
  const r = await runHarness(key, task);
  const g = r.reply ? await grade(task, r.reply) : { correct: false, answer: '(no reply)', by: 'none', cost: 0 };
  const rec = { ts: new Date().toISOString(), setup: key, model: SETUP[key].model, task: task.id, cat: task.cat, rep, expected: task.expected, taskFile: TASKS,
    answer: g.answer, correct: g.correct, gradedBy: g.by, cost: r.cost, gradeCost: g.cost, ms: r.ms, decide: r.decide, decides: r.decides, drafts: r.drafts, pick: r.pick, error: r.error, reply: r.reply };
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
  done++;
  process.stdout.write(`\r${done}/${jobs.length} ${key} ${task.id.padEnd(24)} ${g.correct ? '✓' : '✗'}      `);
  return rec;
});
process.stdout.write('\n\n');

// ---------- report ----------
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const money = (c) => `$${c.toFixed(4)}`;
const of = (k) => results.filter((r) => r.setup === k);

console.log('ACCURACY, COST AND SPEED');
console.log(`${pad('setup', 44)}${lpad('correct', 10)}${lpad('acc', 7)}${lpad('total $', 10)}${lpad('$/task', 10)}${lpad('avg s', 7)}`);
for (const k of SETUPS) {
  const rs = of(k), ok = rs.filter((r) => r.correct).length, cost = rs.reduce((s, r) => s + r.cost, 0), ms = rs.reduce((s, r) => s + r.ms, 0);
  console.log(`${pad(`${SETUP[k].label} (${SETUP[k].model.split('/').pop()})`, 44)}${lpad(`${ok}/${rs.length}`, 10)}${lpad(`${Math.round((ok / rs.length) * 100)}%`, 7)}${lpad(money(cost), 10)}${lpad(money(cost / rs.length), 10)}${lpad((ms / rs.length / 1000).toFixed(1), 7)}`);
}

const cats = [...new Set(tasks.map((t) => t.cat))];
console.log(`\nBY CATEGORY (correct / runs)\n${pad('category', 10)}${SETUPS.map((k) => lpad(k, 8)).join('')}`);
for (const c of cats) console.log(`${pad(c, 10)}${SETUPS.map((k) => { const rs = of(k).filter((r) => r.cat === c); return lpad(`${rs.filter((r) => r.correct).length}/${rs.length}`, 8); }).join('')}`);

if (SETUPS.includes('C')) {
  const q = of('C').reduce((a, r) => { for (const b of ['questions', 'theater', 'confirmed', 'flipped', 'unclear', 'unmatched', 'skipped']) a[b] += r.decide?.[b] || 0; return a; }, { questions: 0, theater: 0, confirmed: 0, flipped: 0, unclear: 0, unmatched: 0, skipped: 0 });
  console.log(`\nSETUP C: WHAT ASKING DID (${q.questions} decider questions)`);
  console.log(`  already knew ${q.theater} · confirmed ${q.confirmed} · changed answer ${q.flipped} · deciders unsure ${q.unclear} · guess unclear ${q.unmatched}`);
  console.log(`  runs that refused to ask even when sent back: ${q.skipped} of ${of('C').length}`);
  const flippedTasks = of('C').filter((r) => (r.decide?.flipped || 0) > 0);
  console.log(`  tasks where a decider changed an answer: ${flippedTasks.length} → final reply correct in ${flippedTasks.filter((r) => r.correct).length}`);
}
for (const k of ['C', 'D', 'D2']) {
  if (!SETUPS.includes(k) || !SETUPS.includes('A')) continue;
  let helped = 0, hurt = 0, bothRight = 0, bothWrong = 0;
  const helpedIds = [], hurtIds = [];
  for (const r of of(k)) {
    const a = of('A').find((x) => x.task === r.task && x.rep === r.rep);
    if (!a) continue;
    if (r.correct && !a.correct) { helped++; helpedIds.push(r.task); }
    else if (!r.correct && a.correct) { hurt++; hurtIds.push(r.task); }
    else if (r.correct) bothRight++; else bothWrong++;
  }
  console.log(`\nVALUE OF ASKING: ${k} vs A (same small model)`);
  console.log(`  helped ${helped}${helpedIds.length ? ` (${helpedIds.join(', ')})` : ''} · hurt ${hurt}${hurtIds.length ? ` (${hurtIds.join(', ')})` : ''} · both right ${bothRight} · both wrong ${bothWrong}`);
}
for (const k of ['D', 'D2'].filter((x) => SETUPS.includes(x))) {
  // Drafts "disagreed" when their ANSWER lines differ: only then can the pick matter.
  const ds = of(k).filter((r) => r.drafts?.length);
  const split = ds.filter((r) => new Set(r.drafts.map((d) => norm(answerLine(d) || ''))).size > 1);
  const anyRight = split.filter((r) => r.correct || r.drafts.some((d) => { const a = answerLine(d); return a != null && gradeLine(tasks.find((t) => t.id === r.task), a); }));
  console.log(`
SETUP ${k}: drafts disagreed on ${split.length} task run(s); a correct draft existed in ${anyRight.length}, and the final reply was correct in ${split.filter((r) => r.correct).length}`);
  if (k === 'D2') {
    const rules = {};
    for (const r of ds) { const rule = r.pick?.rule || 'single draft'; (rules[rule] ??= { n: 0, ok: 0 }).n++; if (r.correct) rules[rule].ok++; }
    for (const [rule, v] of Object.entries(rules)) console.log(`  ${rule}: ${v.n} run(s), ${v.ok} correct`);
  }
  const built = of(k).filter((r) => !r.drafts?.length).length;
  if (built) console.log(`  ${built} run(s) were judged "build something" and used the normal loop instead of drafts`);
}

const split = tasks.filter((t) => { const rs = results.filter((r) => r.task === t.id); return rs.some((r) => r.correct) && rs.some((r) => !r.correct); });
if (split.length) {
  console.log(`\nTASKS THAT SEPARATED THE SETUPS\n${pad('task', 26)}${SETUPS.map((k) => lpad(k, 4)).join('')}   expected`);
  for (const t of split) console.log(`${pad(t.id, 26)}${SETUPS.map((k) => lpad(results.filter((r) => r.task === t.id && r.setup === k).map((r) => (r.correct ? '✓' : '✗')).join(''), 4)).join('')}   ${t.expected}`);
}
const spend = results.reduce((s, r) => s + r.cost + (r.gradeCost || 0), 0);
console.log(`\nTotal spend ${money(spend)} · log ${path.relative(ROOT, LOG)}`);
