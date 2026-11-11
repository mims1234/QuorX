// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Pull requests panel: a project's GitHub pull requests, their checks and reviews, read through the GitHub
// command line (gh) when it is installed and signed in. Read only: nothing here merges, comments or pushes.
// Without gh (or signed out) the panel says how to set it up; nothing fails.
//
// QX_GH_FAKE (tests and isolated previews): the path of a JSON file that stands in for gh:
// { installed, signedIn, prs: [ gh pr list --json rows ], logs: { <job id>: "log text" } }.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const PR_FIELDS = 'number,title,state,isDraft,headRefName,baseRefName,author,reviewDecision,statusCheckRollup,url,updatedAt,comments';

function fake() {
  const f = process.env.QX_GH_FAKE;
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { installed: false }; }
}
// gh with these arguments → { ok, out, err, missing }.
function gh(args, { cwd, timeout = 15e3 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try { p = spawn('gh', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } }); }
    catch { return finish({ ok: false, missing: true, out: '', err: '' }); }
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish({ ok: false, out, err: 'GitHub CLI took too long to answer' }); }, timeout);
    p.stdout.on('data', (d) => { out += d; if (out.length > 8e6) p.kill(); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); finish({ ok: false, missing: e.code === 'ENOENT', out: '', err: e.message }); });
    p.on('close', (code) => { clearTimeout(t); finish({ ok: code === 0, out, err: err.trim() }); });
  });
}

// Installed and signed in, looked at once a minute: { installed, signedIn, why }.
let ghState = null;
export async function ghStatus({ fresh = false } = {}) {
  const f = fake();
  if (f) return { installed: f.installed !== false, signedIn: f.installed !== false && f.signedIn !== false, why: null };
  if (!fresh && ghState && Date.now() - ghState.at < 60e3) return ghState.value;
  let value;
  const v = await gh(['--version'], { timeout: 6000 });
  if (!v.ok) value = { installed: false, signedIn: false, why: v.missing ? null : v.err || null };
  else {
    const a = await gh(['auth', 'status', '--hostname', 'github.com'], { timeout: 8000 });
    value = { installed: true, signedIn: a.ok, why: a.ok ? null : 'not signed in' };
  }
  ghState = { at: Date.now(), value };
  return value;
}

// One check of a PR, from gh's statusCheckRollup (CheckRun or StatusContext): what the panel shows.
export function checkOf(x) {
  const isRun = x.__typename === 'CheckRun' || 'conclusion' in x || 'status' in x && !('state' in x);
  const status = String(x.status || '').toUpperCase(), concl = String(x.conclusion || x.state || '').toUpperCase();
  const state = isRun && status && status !== 'COMPLETED' ? 'pending'
    : ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(concl) ? (concl === 'SUCCESS' ? 'passed' : 'skipped')
    : ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl) ? 'failing'
    : concl === 'PENDING' || concl === 'EXPECTED' || !concl ? 'pending' : 'pending';
  const url = String(x.detailsUrl || x.targetUrl || '');
  const m = url.match(/\/actions\/runs\/(\d+)(?:\/job(?:s)?\/(\d+))?/);
  return { name: String(x.name || x.context || 'check'), workflow: String(x.workflowName || ''), state, conclusion: concl.toLowerCase() || null, url, runId: m?.[1] || null, jobId: m?.[2] || null };
}
const REVIEW = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' };
/** A gh pr list row as the panel shows it, with what blocks it first. */
export function prOf(p, branch = '') {
  const checks = (Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : []).map(checkOf);
  const count = (s) => checks.filter((c) => c.state === s).length;
  const sum = { total: checks.length, failing: count('failing'), pending: count('pending'), passed: count('passed'), skipped: count('skipped') };
  const state = String(p.state || '').toLowerCase();
  const review = REVIEW[String(p.reviewDecision || '').toUpperCase()] || null;
  const blockers = state !== 'open' ? [] : [
    ...(p.isDraft ? ['it is a draft'] : []),
    ...(sum.failing ? [`${sum.failing} check${sum.failing === 1 ? '' : 's'} failing`] : []),
    ...(review === 'changes requested' ? ['changes requested'] : review === 'review required' ? ['a review is required'] : []),
    ...(sum.pending ? [`${sum.pending} check${sum.pending === 1 ? '' : 's'} still running`] : []),
  ];
  // Failing first, then running, then the rest.
  const rank = { failing: 0, pending: 1, passed: 2, skipped: 3 };
  checks.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  return { number: p.number, title: String(p.title || ''), state, draft: !!p.isDraft, head: String(p.headRefName || ''), base: String(p.baseRefName || ''),
    url: String(p.url || ''), author: p.author?.login || null, review, comments: Array.isArray(p.comments) ? p.comments.length : Number(p.comments) || 0,
    updated: p.updatedAt || null, checks, sum, blockers, mine: !!branch && p.headRefName === branch };
}

const STATES = new Set(['open', 'merged', 'closed', 'all']);
/** The repo's pull requests: { gh, prs } or { gh, error }. `branch` marks this chat's own. */
export async function listPulls({ cwd, repo, state = 'open', branch = '' }) {
  const st = await ghStatus();
  if (!st.installed || !st.signedIn) return { gh: st, prs: [] };
  state = STATES.has(state) ? state : 'open';
  const f = fake();
  let rows;
  if (f) rows = (f.prs || []).filter((p) => state === 'all' || String(p.state || '').toLowerCase() === state);
  else {
    const r = await gh(['pr', 'list', '--repo', repo, '--state', state, '--limit', '40', '--json', PR_FIELDS], { cwd });
    if (!r.ok) return { gh: st, prs: [], error: r.err || 'GitHub CLI could not list the pull requests' };
    try { rows = JSON.parse(r.out || '[]'); } catch { return { gh: st, prs: [], error: 'GitHub CLI gave an answer QuorX could not read' }; }
  }
  const prs = rows.map((p) => prOf(p, branch)).sort((a, b) => (b.mine - a.mine) || (b.number - a.number));
  return { gh: st, prs };
}

// The end of a failing job's log, without gh's "job<TAB>step<TAB>" columns and timestamps: what "Fix in chat" sends.
export function logTail(text, lines = 80) {
  const clean = String(text || '').split(/\r?\n/).map((l) => l.replace(/^[^\t]*\t[^\t]*\t/, '').replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/\x1b\[[0-9;]*m/g, '')).filter((l) => l.trim());
  return clean.slice(-lines).join('\n').slice(-12000);
}
/** The last lines of a failing check's log ({ tail } or { error }). */
export async function checkLog({ cwd, repo, runId, jobId }) {
  if (!/^\d+$/.test(String(jobId || '')) && !/^\d+$/.test(String(runId || ''))) return { error: 'this check has no GitHub Actions log' };
  const f = fake();
  if (f) { const t = f.logs?.[jobId] ?? f.logs?.[runId]; return t ? { tail: logTail(t) } : { error: 'no log for this check' }; }
  const st = await ghStatus();
  if (!st.installed || !st.signedIn) return { error: 'GitHub CLI is not set up' };
  const args = jobId ? ['run', 'view', '--repo', repo, '--job', String(jobId), '--log-failed'] : ['run', 'view', String(runId), '--repo', repo, '--log-failed'];
  const r = await gh(args, { cwd, timeout: 30e3 });
  if (!r.ok || !r.out.trim()) return { error: r.err || 'GitHub has no failed log for this check (it may still be running, or the log expired)' };
  return { tail: logTail(r.out) };
}
