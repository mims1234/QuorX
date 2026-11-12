// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The chat area in the IDE shell: 🔊 read aloud asks PC voice or AI voice, the message box keeps the Quorium squares
// at every width with Strict / YOLO as one icon and the budget in the settings panel, and QuorX's own housekeeping
// (previews moved to Pages, a chat reloaded from another window) shows no notice.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readAloudPiece, readAloudCost, READ_ALOUD_MAX } from '../server/readaloud.js';

const page = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/composer.css', import.meta.url), 'utf8');
const between = (from, to) => { const i = page.indexOf(from), j = page.indexOf(to, i); assert.ok(i >= 0 && j > i, `${from} … ${to}`); return page.slice(i, j); };

test('read aloud with an AI voice: one call per piece with the Voice model and its Settings voice, priced per character', async () => {
  const calls = [];
  const deps = {
    speechModels: async () => [{ id: 'v/tts', price: [15, 0], voices: ['george', 'alice'] }],
    synthesize: async (body) => { calls.push(body); return { url: 'data:audio/mpeg;base64,AAAA', ms: 5 }; },
  };
  const r = await readAloudPiece({ text: '  Hello   there.\nSecond line.  ', model: 'v/tts', voice: 'alice' }, null, deps);
  assert.deepEqual(calls, [{ model: 'v/tts', input: 'Hello there. Second line.', voice: 'alice' }]);
  assert.equal(r.url, 'data:audio/mpeg;base64,AAAA'); assert.equal(r.voice, 'alice'); assert.equal(r.chars, 25);
  assert.equal(r.cost, (25 * 15) / 1e6);
  // A voice the model doesn't have: its first voice.
  await readAloudPiece({ text: 'Hi.', model: 'v/tts', voice: 'nobody' }, null, deps);
  assert.equal(calls.at(-1).voice, 'george');
  // Nothing paid for nothing, an unknown model or a piece that is too long.
  assert.match((await readAloudPiece({ text: '  ', model: 'v/tts' }, null, deps)).error, /nothing to read/);
  assert.match((await readAloudPiece({ text: 'Hi.', model: 'x/none' }, null, deps)).error, /not a voice model/);
  assert.match((await readAloudPiece({ text: 'Hi.', model: '' }, null, deps)).error, /no Voice model/);
  assert.match((await readAloudPiece({ text: 'a'.repeat(READ_ALOUD_MAX + 1), model: 'v/tts' }, null, deps)).error, /too long/);
  assert.equal(calls.length, 2);
  assert.equal(readAloudCost(null, 'abc'), 0);
});

test('🔊 asks PC voice or AI voice until a choice is remembered; Settings → Tools & media keeps that choice', () => {
  const src = between('const speakHow = ', '// The AI voice reads a few sentences');
  const G = { settings: { tools: {} }, byId: new Map([['v/tts', { kind: 'speech', price: [15, 0] }]]) };
  let asked = 0, read = 0;
  const api = new Function('G', 'moduleModel', 'settingsModel', 'short', 'shortPrice', 'priceOf', 'esc', 'msgIcon', 'speechSynthesis', 'document', 'speakParts', 'speakMark', 'speakOK', 'flashTip', 'uiAlert', '$', 'readAloudAI',
    `${src}; return { speakHow, speakTitle, readAloud, speakingNow, set choice(f) { speakChoice = f; } };`)(
    G, () => 'v/tts', () => 'v/tts', (s) => s, () => '$15/M chars', () => '$15 per M characters', (s) => s, () => '', { cancel() {} }, { documentElement: { classList: { toggle() {} } } },
    () => [{ text: 'Hi.' }], () => {}, () => true, () => {}, () => {}, () => null, () => { read++; });
  api.choice = () => { asked++; };
  const m = { el: null }, c = {};
  api.readAloud(m, {}, c);
  assert.equal(asked, 1, 'no remembered choice: it asks');
  assert.match(api.speakTitle(c), /this computer’s voice \(free\) or an AI voice/);
  G.settings.readAloud = 'ai';
  api.readAloud(m, {}, c);
  assert.equal(asked, 1); assert.equal(read, 1, 'remembered: the AI voice reads at once');
  assert.match(api.speakTitle(c), /AI voice \(v\/tts, \$15\/M chars · ≈ \$0\.02\d a reply\)/);
  G.settings.readAloud = 'nonsense';
  assert.equal(api.speakHow(), '');
  // ■ stops the reply being read even after it was drawn again (a new object for the same reply).
  G.speak = { m: { runId: 'r1' } };
  assert.equal(api.speakingNow({ runId: 'r1' }), true); assert.equal(api.speakingNow({ runId: 'r2' }), false); assert.equal(api.speakingNow({}), false);
  G.speak = null;
  // The choice's own window: PC voice (free) and AI voice with the model's price, and "Remember my choice".
  const pick = between('function speakChoice(', 'function readAloud(');
  assert.match(pick, /PC voice/); assert.match(pick, /free/); assert.match(pick, /AI voice/); assert.match(pick, /speakPrice\(id\)/); assert.match(pick, /Remember my choice/);
  // Settings → Tools & media: the same choice, and Reset puts "Ask each time" back.
  assert.match(page, /<select class="read-aloud"[^>]*><option value="">Ask each time<\/option><option value="pc">🖥 PC voice/);
  assert.match(page, /if \(ST\.cat === 'tools'\) \{ S\.tools = structuredClone\(d\.tools\); delete S\.readAloud; \}/);
});

test('the AI voice reads a few sentences per call, each piece lit as one', () => {
  const src = between('function speakPieces(', 'async function readAloudAI(');
  const doc = { createRange: () => ({ setStart(n, o) { this.s = [n, o]; }, setEnd(n, o) { this.e = [n, o]; } }) };
  const speakPieces = new Function('document', `${src}; return speakPieces;`)(doc);
  const part = (text, i) => ({ text, range: { startContainer: `n${i}`, startOffset: 0, endContainer: `n${i}`, endOffset: text.length } });
  const parts = ['One.', 'Two two.', 'x'.repeat(30), 'Last.'].map(part);
  const out = speakPieces(parts, 20);
  assert.deepEqual(out.map((x) => x.text), ['One. Two two.', 'x'.repeat(30), 'Last.']);
  assert.deepEqual([out[0].range.s, out[0].range.e], [['n0', 0], ['n1', 8]], 'from the first sentence\'s start to the last one\'s end');
  assert.equal(speakPieces([{ text: 'No range.', range: null }]).at(0).range, null);
});

test('the message box: Strict / YOLO is one icon that switches the mode, the budget sits in the settings panel', () => {
  const bar = between('function renderComposerBar(c) {', 'function wireQuickSettings(');
  const chips = bar.slice(bar.indexOf('chipsEl.innerHTML ='), bar.indexOf("const budChip"));
  assert.doesNotMatch(chips, /cmp-budget/, 'no 💵 chip in the message box row');
  assert.match(bar, /sec\('budget', 'Budget', '<button type="button" class="cmp-budget"/, 'the same 💵 button, in the settings panel');
  assert.match(chips, /class="cq-chip cq-safety cq-mode-ico"[^`]*aria-pressed="\$\{yolo\}"/);
  assert.doesNotMatch(chips, /cq-cl">Strict|<b>\$\{esc\(yolo \? 'YOLO'/, 'no word, only 🔒 or ⚡');
  assert.match(bar, /\$\('\.cq-mode-ico', chipsEl\)\.onclick = [^\n]*c\.approval = yolo \? 'strict' : 'yolo'/);
  assert.match(page, /chips\.querySelectorAll\('\.cq-chip:not\(\.cq-mode-ico\)'\)\) b\.onclick/, 'the icon keeps its own click');
  // No context ring by Send any more: it moved to Steps.
  assert.doesNotMatch(page, /cmp-ctx-slot/);
});

test('the Quorium squares never fold into a count at narrow widths', () => {
  assert.doesNotMatch(css, /fold\d\s+\.cmp-q-slot\s+\.qx-strip\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /fold\d\s+\.cmp-q-slot\s+\.qx-n\s*\{\s*display:\s*inline-flex/);
  assert.match(css, /\.composer-box\.fold5 \.cmp-q-slot \.qx-sq \{ width: 20px; height: 20px;/, 'at the narrowest they only get smaller');
});

test('QuorX\'s own housekeeping is silent: no "moved to Pages" banner, no "reloaded the latest" tip', () => {
  const pn = between('function pagesNotice(', '// A pages address');
  assert.doesNotMatch(pn, /insertAdjacentHTML|moved to Pages<\/b>/);
  assert.match(pn, /\.pages-notice', c\.el\.root\)\?\.remove\(\)/, 'one left on screen from before goes');
  assert.doesNotMatch(page, /reloaded the latest/);
  // Real warnings stay: the budget and a missing project folder.
  assert.match(page, /This chat has used its \$\$\{b\.budget\.toFixed\(2\)\} budget\./);
  assert.match(page, /The folder of “\$\{esc\(p\.name\)\}” is missing\./);
});

test('Steps: the cost block folds like the context block, both remembered and both in Settings; /context posts a card', () => {
  const cost = between('function traceCostHTML(', '// ---------- zoom');
  assert.match(cost, /const folded = !uiOf\(G\.settings\)\.stepsCost;/);
  assert.match(cost, /class="tc-sec tc-cost-sec\$\{folded \? ' folded' : ''\}" data-fold="cost"/);
  assert.match(cost, /<button type="button" class="tc-head tc-fold" aria-expanded="\$\{!folded\}"[^>]*><span><i class="tc-caret"[^`]*<b>\$\{money\(/, 'folded, the header keeps the reply\'s cost');
  assert.match(page, /usageBtn: true, stepsCtx: true, stepsCost: true,/, 'both open by default');
  assert.match(page, /stSwitch\('ui\.stepsCtx', U\.stepsCtx\)/); assert.match(page, /stSwitch\('ui\.stepsCost', U\.stepsCost\)/);
  // /context: in the command list, drawn like /usage (a usage-role card, so never part of the agent's history).
  assert.match(page, /\['context', 'How much of each model[^\n]*\(c\) => postContext\(c\)\],/);
  assert.match(page, /if \(m\.role === 'usage' && m\.kind === 'context'\) \{/);
  assert.match(page, /const m = \{ role: 'usage', kind: 'context', at: Date\.now\(\), ctx: \{ rows: contextModels\(c\) \} \};/);
  // The command palette's Compact opens that card (the old ring button by Send is gone).
  assert.match(page, /compact: \{ run: qfCmd\('context'\)/);
  assert.doesNotMatch(page, /cmp-ctx-btn', qfChat/);
});
