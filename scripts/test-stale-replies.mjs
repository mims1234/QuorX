// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Buttons that carry a reply on (▶ Resume after a restart, the ⏱ out-of-steps card, ▶ Continue on a stopped reply)
// only work on the newest turn: once a newer reply carried on, or another reply is running, they switch off and say
// why, and they come back when the newer turn goes. Buttons that work on any reply (copy, remix, read aloud) stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/last.css', import.meta.url), 'utf8');
const between = (from, to) => { const i = page.indexOf(from), j = page.indexOf(to, i); assert.ok(i >= 0 && j > i, `${from} … ${to}`); return page.slice(i, j); };

// The helpers, run on a small stand-in for a reply's element.
const src = between('function newerTurn(c, m)', '// ---------- Review changes');
const make = new Function('offPage', `${src}; return { newerTurn, staleWhy, drawStale, drawStaleAll, STALE_BTNS };`);
const H = make((el) => !el || el.gone);
// A button as far as the helpers use it: its title, data-* and aria-disabled.
const btn = (cls, title) => {
  const attrs = { title };
  return { cls, dataset: {}, get title() { return attrs.title; }, set title(v) { attrs.title = v; }, get off() { return attrs['aria-disabled'] === 'true'; },
    getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: (k) => { delete attrs[k]; } };
};
const replyEl = (...buttons) => ({ buttons, querySelectorAll: (q) => { assert.equal(q, H.STALE_BTNS); return buttons; } });

test('▶ Resume switches off once a newer turn carries on, and comes back when it goes', () => {
  const resume = btn('resume-btn', 'Carry on from the last finished step');
  const cut = { role: 'assistant', runId: 'r1', resumable: true, el: replyEl(resume) };
  const c = { agent: { messages: [{ role: 'user' }, cut] }, running: null };
  H.drawStale(c, cut);
  assert.equal(resume.off, false);
  assert.equal(resume.title, 'Carry on from the last finished step');
  // You send "continue": a newer turn follows the cut-off reply (and runs).
  const newer = { role: 'assistant', runId: 'r2', live: true };
  c.agent.messages.push({ role: 'user', content: 'continue' }, newer);
  c.running = { runId: 'r2' };
  H.drawStaleAll(c);
  assert.equal(resume.off, true);
  assert.match(resume.title, /^A newer reply carried on from here/);
  // The tip moved aside while the pointer is over the button (the page's themed tips): the reason goes there.
  resume.removeAttribute('title'); resume.dataset.ohTitle = 'what was showing';
  H.drawStale(c, cut);
  assert.match(resume.dataset.ohTitle, /^A newer reply carried on from here/);
  // The pointer leaves: the tip goes back to title.
  resume.title = resume.dataset.ohTitle; delete resume.dataset.ohTitle;
  // Ended, still newer: stays off.
  c.running = null; H.drawStaleAll(c);
  assert.equal(resume.off, true);
  // Rewound (or retried away): the cut-off reply is the newest again, its button and tip come back.
  c.agent.messages.splice(2);
  H.drawStaleAll(c);
  assert.equal(resume.off, false);
  assert.equal(resume.title, 'Carry on from the last finished step');
});

test('another reply running in the chat holds the buttons too; cards and usage notes after a reply do not count', () => {
  const keep = btn('oos-more', 'Same model, same context');
  const m = { role: 'assistant', runId: 'r1', el: replyEl(keep) };
  const c = { agent: { messages: [{ role: 'user' }, m, { role: 'usage' }, { role: 'compacted' }] }, running: null };
  assert.equal(H.newerTurn(c, m), false);
  assert.equal(H.staleWhy(c, m), '');
  c.running = { runId: 'rX' };
  assert.equal(H.staleWhy(c, m), 'A reply is running in this chat');
  H.drawStale(c, m);
  assert.equal(keep.off, true);
  // The reply itself running (a resumed one keeps its element) is not held by its own run.
  c.running = { runId: 'r1' };
  assert.equal(H.staleWhy(c, m), '');
  // ✦ Fresh chat while it writes its brief is left as it is.
  const fresh = btn('oos-fresh', 'A cheap model writes…'); fresh.dataset.busy = '1';
  const m2 = { role: 'assistant', runId: 'r3', el: replyEl(fresh) };
  H.drawStale({ agent: { messages: [m2] }, running: null }, m2);
  assert.equal(fresh.off, false); assert.equal(fresh.title, 'A cheap model writes…');
  // A reply that is not on the page is skipped.
  H.drawStale(c, { role: 'assistant', el: { gone: true, querySelectorAll: () => assert.fail('drawn off the page') } });
});

test('the reply redraw, the run state and every carry-on path check the newest turn', () => {
  // Drawn at the end of each reply redraw, and for every reply when a run starts or ends.
  assert.match(between('function updateMsg(c, m', '// ---------- actions that only carry on'), /drawStale\(c, m\);\n\}/);
  assert.match(between('function syncRunState(c)', '// ---------- messages'), /drawStaleAll\(c\)/);
  // The click itself checks again (a page drawn before the newer turn).
  assert.match(page, /resume\.onclick = \(\) => \{ if \(c\.running \|\| staleWhy\(c, m\)\) return drawStale\(c, m\);/);
  const oos = between('function wireOutOfSteps(card, c, m)', 'function budgetHTML');
  assert.match(oos, /const go = [^\n]*if \(staleWhy\(c, m\)\) return fail/);
  assert.match(oos, /oos-fresh[\s\S]*if \(staleWhy\(c, m\)\) return fail/);
  assert.match(between('function continueLast(c, arg)', 'function wireOutOfSteps'), /if \(newerTurn\(c, m\)\) return uiAlert/);
  // ▶ Continue on a stopped reply: only while no newer turn follows it.
  assert.match(page, /const last = !newerTurn\(c, m\);/);
  assert.match(between('function continueReply(c, m)', 'async function retryReply'), /if \(newerTurn\(c, m\) \|\| !stoppedByYou\(m\)\)/);
  // These already only show on the newest reply while nothing runs: ↻ Retry, the usage-limit row, the Next chips.
  assert.match(between('function retryable(c, m)', 'function continueReply'), /!c\.running && [^\n]*msgs\[msgs\.length - 1\] === m/);
  assert.match(between('function limitFailOf(c, m)', 'function drawLimitFail'), /!c\.running && c\.agent\.messages\.at\(-1\) === m/);
  assert.match(between('function nextStepsHTML(c, m)', 'function wireNextSteps'), /c\.running \|\| c\.agent\.messages\.at\(-1\) !== m/);
  // Approval and question cards are drawn answerable only while their own reply is live.
  assert.match(page, /approvalHTML\(m\.approvals\[e\.id\], !!m\.live\)/);
  assert.match(page, /questionHTML\(m\.questions\[e\.id\], !!m\.live\)/);
});

test('a switched-off carry-on button is grey, not the green of a next step', () => {
  // !important, and .msg to outrank theme-v4's `.approval .primary:hover:not(:disabled)` (green, !important).
  assert.match(css, /\.msg \.foot \.resume-btn\[aria-disabled="true"\], \.msg \.oos-card \.oos-acts button\[aria-disabled="true"\] \{[^}]*background: var\(--panel\) !important[^}]*cursor: not-allowed/);
  assert.match(css, /\.oos-card:has\(\.oos-acts button\[aria-disabled="true"\]\) \{[^}]*box-shadow: none !important/);
  // Its clicks are refused: the Resume handler checks again, and the ⏱ card stops clicks on a switched-off button.
  assert.match(between('function wireOutOfSteps(card, c, m)', 'function budgetHTML'), /card\.addEventListener\('click', \(ev\) => \{ if \(ev\.target\.closest\?\.\('button\[aria-disabled="true"\]'\)\) \{ ev\.stopPropagation\(\);[^\n]*, true\);/);
});
