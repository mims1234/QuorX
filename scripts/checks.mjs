// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Improving the harness checks (server/harness-checks.js) from what they did in real chats and benchmarks.
//
//   node scripts/checks.mjs report                      how each question did: fired, failed, unsure, fixed after a "no", labels
//   node scripts/checks.mjs label <shot> <kind:id> fine|broken    your verdict on one saved screenshot, for precision and recall
//   node scripts/checks.mjs retest --kind shot --id text --ask "New wording…" [--voter <model>] [--limit 60]
//                                                       try a wording (or another decider) on past screenshots, no rebuilding
//   node scripts/checks.mjs voters [--limit 40] [--models a,b,c]   which single decider agrees most with the full panel
//   node scripts/checks.mjs mine [--top 20]             the model's own look checks that keep catching problems: candidates
//   node scripts/checks.mjs reviewer [--file logs/bench-build-….jsonl]   the in-loop reviewer's verdicts against the judge's
//
// Data: logs/checks.jsonl (one line per answer), logs/check-shots/ (the screenshots), logs/check-labels.json (your labels).
import fs from 'node:fs';
import path from 'node:path';
import { CHECK_LOG, SHOT_DIR, CHECKS, LOOK_DEFAULTS } from '../server/harness-checks.js';
import { ensemble } from '../server/decisions.js';
import { DEFAULTS } from '../server/agent.js';
import { HOME } from '../server/openrouter.js';

const LABELS = path.join(HOME, 'logs', 'check-labels.json');
const argv = process.argv.slice(2);
const cmd = argv[0] || 'report';
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

const rows = () => { try { return fs.readFileSync(CHECK_LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.builder !== 'test/model'); } catch { return []; } };
const labels = () => { try { return JSON.parse(fs.readFileSync(LABELS, 'utf8')); } catch { return {}; } };
const dataUrl = (file) => { const f = path.join(SHOT_DIR, file); if (!fs.existsSync(f)) return null; return `data:image/${file.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}`; };
const stateFor = (r, images) => [r.kind === 'click' ? 'The first picture is the page before the click, the second right after. Judge only what you can see.' : 'A screenshot of a page an AI agent built. Judge only what you can see.', ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];

if (cmd === 'report') {
  const all = rows(), L = labels();
  if (!all.length) { console.log(`No checks logged yet (${CHECK_LOG}). They are written as chats and benchmarks run.`); process.exit(0); }
  const harness = all.filter((r) => r.src === 'harness');
  const outcomes = all.filter((r) => r.kind === 'outcome');
  console.log(`${all.length} answers logged · ${harness.length} from harness checks · ${all.filter((r) => r.kind === 'look').length} from the model's own look checks · ${outcomes.length} outcomes\n`);
  console.log(`${pad('check', 18)}${lpad('ver', 5)}${lpad('asked', 7)}${lpad('said no', 9)}${lpad('unsure', 8)}${lpad('escal.', 8)}${lpad('fixed', 7)}${lpad('still', 7)}${lpad('labels', 8)}${lpad('right', 7)}`);
  const keys = [...new Set(harness.map((r) => `${r.kind}:${r.id}`))].sort();
  for (const k of keys) {
    const rs = harness.filter((r) => `${r.kind}:${r.id}` === k);
    const no = rs.filter((r) => (r.kind === 'gap' ? r.p != null && r.p < 0.4 : r.fail)).length;
    const unsure = rs.filter((r) => r.verdict !== 'settled').length;
    const esc = rs.filter((r) => r.escalated).length;
    const fixed = outcomes.filter((o) => o.id === k && o.result === 'fixed').length, still = outcomes.filter((o) => o.id === k && o.result === 'still').length;
    // Labels: your verdict on a screenshot vs what the check said about it.
    let lab = 0, right = 0;
    for (const r of rs) { const v = L[r.shots?.[0]]?.[k]; if (v == null) continue; lab++; if ((v === 'fine') === !r.fail) right++; }
    const vers = [...new Set(rs.map((r) => r.v))].join(',');
    console.log(`${pad(k, 18)}${lpad(vers, 5)}${lpad(rs.length, 7)}${lpad(`${no} ${pct(no, rs.length)}`, 9)}${lpad(pct(unsure, rs.length), 8)}${lpad(esc, 8)}${lpad(fixed, 7)}${lpad(still, 7)}${lpad(lab, 8)}${lpad(pct(right, lab), 7)}`);
  }
  console.log('\nsaid no = failed (gap: the request did not say it) · unsure = not settled · escal. = sent to the rest of the panel');
  console.log('fixed = failed earlier in a reply, then passed · still = still failing when the reply ended · right = agrees with your labels');
  const asks = all.filter((r) => r.kind === 'ask');
  if (asks.length) console.log(`\nYOLO questions answered by the deciders: ${asks.length} · settled ${pct(asks.filter((r) => r.verdict === 'settled').length, asks.length)} · not settled ${asks.filter((r) => r.pick == null).length}`);
  console.log('\nRead it like this: a check that never says no can go; one with many "still" may be a false alarm (label a few and retest); one with many "fixed" earns its keep.');
}

else if (cmd === 'label') {
  const [shot, key, verdict] = argv.slice(1);
  if (!shot || !/^\w+:\w+$/.test(key || '') || !['fine', 'broken'].includes(verdict)) { console.log('Usage: node scripts/checks.mjs label <shot file> <kind:id> fine|broken'); process.exit(1); }
  if (!fs.existsSync(path.join(SHOT_DIR, shot))) { console.log(`No screenshot ${shot} in ${SHOT_DIR}`); process.exit(1); }
  const L = labels(); (L[shot] ??= {})[key] = verdict;
  fs.writeFileSync(LABELS, JSON.stringify(L, null, 2));
  console.log(`Labelled ${shot} ${key} = ${verdict}`);
}

else if (cmd === 'retest') {
  const kind = opt('kind', 'shot'), id = opt('id'), ask = opt('ask'), voter = opt('voter'), limit = Number(opt('limit', 60));
  const base = CHECKS[kind]?.find((q) => q.id === id);
  if (!ask && !voter) { console.log('Give --ask "new wording" and/or --voter <decider model>.'); process.exit(1); }
  const past = rows().filter((r) => r.src === 'harness' && r.kind === kind && (!id || r.id === id) && (kind === 'gap' ? r.request : r.shots?.length));
  const seen = new Set(), sample = [];
  for (const r of past.reverse()) { const k = `${r.id}|${kind === 'gap' ? r.request : r.shots.join(',')}`; if (seen.has(k)) continue; seen.add(k); sample.push(r); if (sample.length >= limit) break; }
  if (!sample.length) { console.log('No logged screenshots for that check yet.'); process.exit(0); }
  const L = labels(), below = DEFAULTS.checks?.shotBelow ?? 0.3, voters = voter ? [voter] : LOOK_DEFAULTS.lookVoters;
  let same = 0, flips = 0, lab = 0, rightOld = 0, rightNew = 0, cost = 0, n = 0;
  console.log(`Retesting ${sample.length} past screenshot${sample.length > 1 ? 's' : ''} · ${kind}:${id || '*'} · ${voters.join(', ')}\n${ask ? `new wording: "${ask}"` : `same wording, decider ${voter}`}\n`);
  for (const r of sample) {
    const images = kind === 'gap' ? [] : r.shots.map(dataUrl).filter(Boolean);
    if (kind !== 'gap' && images.length !== r.shots.length) continue;
    const q = { id: 'q', type: 'noul', ask: ask || r.ask };
    const state = kind === 'gap' ? `The newest message, from the user to an AI agent that builds things:\n${r.request}` : stateFor(r, images);
    const d = await ensemble({ voters, state, questions: [q], gate: DEFAULTS.gate, account: (u) => { cost += Number(u?.cost) || 0; } });
    const res = d.results.q; if (!res.n) continue;
    n++;
    const cut = kind === 'gap' ? (DEFAULTS.checks?.gapBelow ?? 0.4) : below;
    const failNew = res.dist.yes < cut, failOld = kind === 'gap' ? r.p != null && r.p < cut : !!r.fail;
    if (kind === 'gap') console.log(`  ${failOld ? 'MISSING' : 'said   '} → ${failNew ? 'MISSING' : 'said   '}  p ${r.p?.toFixed(2)} → ${res.dist.yes.toFixed(2)}  "${String(r.request).slice(0, 70)}…"`);
    if (failNew === failOld) same++; else { flips++; if (kind !== 'gap') console.log(`  changed: ${r.shots[0]} was ${failOld ? 'FAIL' : 'pass'} → now ${failNew ? 'FAIL' : 'pass'} (p=${res.dist.yes.toFixed(2)})`); }
    const v = kind === 'gap' ? null : L[r.shots[0]]?.[`${r.kind}:${r.id}`];
    if (v) { lab++; if ((v === 'fine') === !failOld) rightOld++; if ((v === 'fine') === !failNew) rightNew++; }
  }
  console.log(`\n${n} answered · same verdict ${same} · changed ${flips}${lab ? ` · on ${lab} labelled: old right ${rightOld}, new right ${rightNew}` : ' · no labels yet (label some to see which is right)'} · cost $${cost.toFixed(4)}`);
  if (base && ask) console.log(`\nIf the new wording is better, change it in ⚙ Deciders → Harness checks (or edit ${kind}:${id} in server/harness-checks.js and bump v).`);
}

else if (cmd === 'voters') {
  // Every candidate decider answers the same past checks; the full panel's average is the reference.
  const limit = Number(opt('limit', 40));
  const models = (opt('models') || [...new Set([...DEFAULTS.voters, ...LOOK_DEFAULTS.lookVoters])].join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  const past = rows().filter((r) => r.src === 'harness' && ['shot', 'click'].includes(r.kind) && r.shots?.length).reverse().slice(0, limit);
  if (!past.length) { console.log('No logged screenshot checks yet.'); process.exit(0); }
  const agree = Object.fromEntries(models.map((m) => [m, { same: 0, n: 0, ms: 0, cost: 0 }]));
  for (const r of past) {
    const images = r.shots.map(dataUrl).filter(Boolean); if (images.length !== r.shots.length) continue;
    const q = { id: 'q', type: 'noul', ask: r.ask };
    const d = await ensemble({ voters: models, state: stateFor(r, images), questions: [q], gate: DEFAULTS.gate, onVote: (v) => { if (agree[v.model] && v.ms) { agree[v.model].ms += v.ms; agree[v.model].cost += Number(v.cost) || 0; } } });
    const panel = d.results.q; if (!panel.n) continue;
    for (const v of d.votes) { if (!v?.dists?.q) continue; const a = agree[v.model]; a.n++; if ((v.dists.q.yes >= 0.5) === (panel.dist.yes >= 0.5)) a.same++; }
  }
  console.log(`${pad('decider', 36)}${lpad('agrees', 8)}${lpad('answers', 9)}${lpad('avg ms', 8)}${lpad('$ each', 10)}`);
  for (const [m, a] of Object.entries(agree).sort((x, y) => y[1].same / (y[1].n || 1) - x[1].same / (x[1].n || 1))) console.log(`${pad(m, 36)}${lpad(pct(a.same, a.n), 8)}${lpad(a.n, 9)}${lpad(a.n ? Math.round(a.ms / a.n) : '—', 8)}${lpad(a.n ? `$${(a.cost / a.n).toFixed(5)}` : '—', 10)}`);
  console.log('\nThe one that agrees most for the least is a good pick for ⚙ Deciders → Look and harness checks.');
}

else if (cmd === 'mine') {
  // The model's own look checks where the deciders said "no" while the model expected "yes": grouped by their words.
  const top = Number(opt('top', 20));
  const stop = new Set('the a an is are of to and in on with it its that this be at as by for or from not no any all visible page shows screen screenshot there'.split(' '));
  const sig = (s) => [...new Set(String(s).toLowerCase().replace(/["'“”‘’()[\].,:;!?]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !stop.has(w) && !/^\d+$/.test(w)))].sort().slice(0, 4).join(' ');
  const looks = rows().filter((r) => r.kind === 'look');
  const caught = looks.filter((r) => r.bucket === 'flipped' && String(r.guess).toLowerCase() === 'yes');
  const groups = new Map();
  for (const r of caught) { const k = sig(r.ask); const g = groups.get(k) || { n: 0, asks: [] }; g.n++; if (g.asks.length < 3) g.asks.push(r.ask); groups.set(k, g); }
  console.log(`${looks.length} look checks by models · ${caught.length} caught a problem the model did not expect\n`);
  for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, top)) console.log(`${lpad(g.n, 4)}×  [${k}]\n       e.g. ${g.asks.map((a) => `"${a.slice(0, 110)}"`).join('\n            ')}`);
  console.log('\nA pattern that keeps catching problems across different builds is a candidate for a fixed check: add it in ⚙ Deciders → Harness checks (yours), then measure it with report.');
}

else if (cmd === 'reviewer') {
  // Every harness build in the build benchmarks: the reviewer's last verdict against the judge, who sees the final build.
  const dir = path.join(HOME, 'logs');
  const files = opt('file') ? [path.resolve(opt('file'))] : fs.readdirSync(dir).filter((f) => /^bench-build-.*\.jsonl$/.test(f)).map((f) => path.join(dir, f));
  const runs = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }))
    .filter((r) => r && !r.skipped && r.scores && (r.inLoopReviews || []).length);
  if (!runs.length) { console.log('No harness builds with a review and a judge yet.'); process.exit(0); }
  const KEYS = ['function', 'craft', 'design', 'originality'];
  const m = { bothPass: 0, bothFail: 0, reviewerFailJudgePass: 0, reviewerPassJudgeFail: 0 }; let sentBack = 0, vague = 0, diff = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const r of runs) {
    const last = r.inLoopReviews.at(-1), j = r.pass;
    m[last.pass ? (j ? 'bothPass' : 'reviewerPassJudgeFail') : (j ? 'reviewerFailJudgePass' : 'bothFail')]++;
    sentBack += r.sentBack?.reviewer || 0; vague += r.inLoopReviews.reduce((a, x) => a + (x.vague || 0), 0);
    for (const k of KEYS) diff[k] += (last.scores?.[k] || 0) - r.scores[k];
  }
  const n = runs.length;
  console.log(`${n} harness builds with a review · from ${files.length} benchmark file${files.length > 1 ? 's' : ''}\n`);
  console.log(`                      judge passed   judge failed`);
  console.log(`reviewer passed      ${lpad(m.bothPass, 12)}   ${lpad(m.reviewerPassJudgeFail, 12)}`);
  console.log(`reviewer failed      ${lpad(m.reviewerFailJudgePass, 12)}   ${lpad(m.bothFail, 12)}`);
  console.log(`\nagrees with the judge ${pct(m.bothPass + m.bothFail, n)} · false alarms (failed what the judge passed) ${m.reviewerFailJudgePass} · sent back ${sentBack} time${sentBack === 1 ? '' : 's'}${vague ? ` · bugs dropped as not reproducible ${vague}` : ''}`);
  console.log(`reviewer minus judge, per score (its last verdict vs the judge on the final build): ${KEYS.map((k) => `${k} ${(diff[k] / n >= 0 ? '+' : '')}${(diff[k] / n).toFixed(2)}`).join(' · ')}`);
  console.log('\nA reviewer that fails what the judge passes costs a round of fixing for nothing; one that passes what the judge fails lets broken builds through.');
}

else console.log('Commands: report · label · retest · voters · mine · reviewer (see the top of scripts/checks.mjs)');
