// The user's own numbers for News (`local` blocks, GET /api/news/local?view=…; docs/news-format.md). Everything is
// computed from this computer's logs and only counts and model names leave this file: never a prompt, a question's
// text, a file path or a project name. Nothing here is ever written into news/.
//
//   models    per model: replies, how often the checks before the final answer passed, cost, steps, time
//             (logs/runs.jsonl, through scorecard() in runs.js)
//   deciders  what asking the deciders did: questions by bucket (logs/decisions.jsonl and the screenshot checks in
//             logs/checks.jsonl), and per decider how often its vote matched the panel's (logs/checks.jsonl,
//             logs/approvals.jsonl)
//   costs     spend per day for the last 30 days, and per model (logs/runs.jsonl)
//   tests     the last npm test, npm run test:packs and UI test results this computer kept (logs/test-results.json):
//             { runs: [{ name, passed, failed, skipped, at }], test, packs, ui }
//
// localView(view) answers synchronously; a view is cached for a few seconds. With nothing to show it answers
// { empty: true, why }. An unknown view gives null.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './openrouter.js';
import { scorecard, scoreRows } from './runs.js';

const LOGS = path.join(HOME, 'logs');
const DAYS = 90;          // models and deciders: the last 90 days
const COST_DAYS = 30;     // costs: the last 30 days, one entry per day
const CACHE_MS = 15e3;
export const VIEWS = ['models', 'deciders', 'costs', 'tests'];
export const TEST_RESULTS = path.join(LOGS, 'test-results.json');

const cache = new Map(); // view → { at, value }

/** The user's own numbers for one view (models, deciders, costs, tests). `fresh` skips the short cache. */
export function localView(view, { fresh = false } = {}) {
  if (!VIEWS.includes(view)) return null;
  const hit = cache.get(view);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value;
  try { value = { models, deciders, costs, tests }[view](); } catch (e) { value = { empty: true, why: `QuorX could not read its logs: ${e.message}` }; }
  cache.set(view, { at: Date.now(), value });
  return value;
}

const jsonl = (name, since = 0) => {
  try {
    return fs.readFileSync(path.join(LOGS, name), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && (!since || Date.parse(r.ts) >= since));
  } catch { return []; }
};
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const firstDay = (rows) => { const t = rows.map((r) => Date.parse(r.ts)).filter(Number.isFinite); return t.length ? day(Math.min(...t)) : null; };
const money = (n) => +n.toFixed(6);

function models() {
  const rows = scorecard(DAYS);
  if (!rows.length) return { empty: true, why: `No replies in the last ${DAYS} days yet. Each reply adds its model, cost, steps and time here.` };
  return {
    rows: rows.map((m) => ({ model: m.model, replies: m.replies, passRate: m.passRate, avgCost: m.avgCost, avgSteps: m.avgSteps, avgSeconds: m.avgSecs })),
    since: firstDay(scoreRows(DAYS).filter((r) => r.kind !== 'docs')),
    days: DAYS,
  };
}

// A decider's vote agrees with the panel when both fall on the same side of 0.5.
const side = (p) => (typeof p === 'number' && Number.isFinite(p) ? p >= 0.5 : null);

function deciders() {
  const since = Date.now() - DAYS * 864e5;
  const asked = jsonl('decisions.jsonl', since);
  const checks = jsonl('checks.jsonl', since);
  const approvals = jsonl('approvals.jsonl', since);
  const out = { questions: 0, confirmed: 0, flipped: 0, theater: 0, unclear: 0, unmatched: 0 };
  // Questions the agent asked (decide) and checks of its own screenshots (look) carry the agent's guess, so they
  // have a bucket: confirmed, flipped (the deciders changed the answer), theater (it already knew), unclear.
  for (const r of [...asked, ...checks.filter((c) => c.kind === 'look')]) {
    if (!(r.bucket in out)) continue;
    out.questions++; out[r.bucket]++;
  }
  const by = new Map();
  const vote = (model, agreed) => { if (!model || agreed == null) return; const m = by.get(model) || { model, votes: 0, agreed: 0 }; m.votes++; if (agreed) m.agreed++; by.set(model, m); };
  for (const c of checks) {
    const panel = side(c.p);
    for (const v of Array.isArray(c.votes) ? c.votes : []) vote(v.m, panel == null || side(v.p) == null ? null : side(v.p) === panel);
  }
  for (const a of approvals) {
    const need = side(a.pNeed), other = side(a.pOther);
    for (const v of Array.isArray(a.voters) ? a.voters : []) {
      if (!v || v.ok === false) continue;
      vote(v.model, need == null || side(v.needed) == null ? null : side(v.needed) === need);
      vote(v.model, other == null || side(v.other) == null ? null : side(v.other) === other);
    }
  }
  const byModel = [...by.values()].sort((a, b) => b.votes - a.votes);
  if (!out.questions && !byModel.length) return { empty: true, why: `The deciders haven't been asked anything in the last ${DAYS} days. When the agent asks them, or they vote on an approval, their answers are counted here.` };
  return { ...out, byModel, approvals: approvals.length, since: firstDay([...asked, ...checks, ...approvals]), days: DAYS };
}

function costs() {
  const rows = scoreRows(COST_DAYS);
  const total = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  if (!rows.length || !total) return { empty: true, why: `Nothing spent in the last ${COST_DAYS} days yet. What each reply costs is added up here, per day and per model.` };
  const perDay = new Map();
  for (let i = COST_DAYS - 1; i >= 0; i--) perDay.set(day(Date.now() - i * 864e5), 0);
  const perModel = new Map();
  for (const r of rows) {
    const c = Number(r.cost) || 0, d = day(Date.parse(r.ts));
    if (perDay.has(d)) perDay.set(d, perDay.get(d) + c);
    if (r.model) perModel.set(r.model, (perModel.get(r.model) || 0) + c);
  }
  return {
    days: [...perDay].map(([date, cost]) => ({ date, cost: money(cost) })),
    byModel: [...perModel].map(([model, cost]) => ({ model, cost: money(cost) })).filter((m) => m.cost > 0).sort((a, b) => b.cost - a.cost),
    total: money(total),
  };
}

function tests() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(TEST_RESULTS, 'utf8')); } catch { /* none kept yet */ }
  const pick = (k) => (saved && typeof saved[k] === 'object' && saved[k] ? saved[k] : null);
  const out = { test: pick('test'), packs: pick('packs'), ui: pick('ui') };
  const when = (at) => (typeof at === 'string' ? `${at.slice(0, 10)} ${at.slice(11, 16)} UTC` : '');
  const sum = (rows, k) => (Array.isArray(rows) ? rows.reduce((a, r) => a + (Number(r?.[k]) || 0), 0) : 0);
  // One row per suite, as the page's table draws it: name, passed, failed, when.
  out.runs = [
    out.test && { name: 'npm test', passed: out.test.pass ?? 0, failed: out.test.fail ?? 0, skipped: out.test.skipped ?? 0, at: when(out.test.at) },
    out.packs && { name: 'Pack self-tests', passed: sum(out.packs.rows, 'pass'), failed: sum(out.packs.rows, 'fail'), skipped: sum(out.packs.rows, 'skipped'), at: when(out.packs.at) },
    out.ui && { name: `UI test (${out.ui.scenario || 'all'})`, passed: out.ui.passed ?? 0, failed: Math.max(0, (out.ui.total ?? 0) - (out.ui.passed ?? 0)), at: when(out.ui.at) },
  ].filter(Boolean);
  if (!out.runs.length) return { empty: true, why: 'No test results kept on this computer yet. Run npm test, npm run test:packs or npm run test:ui in the QuorX folder and the last result of each shows here.' };
  return out;
}
