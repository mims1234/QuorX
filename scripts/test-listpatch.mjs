// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The sidebar while chats work: only the projects whose rows changed are drawn again (public/list-patch.js), each in
// its own element, and nothing in the page makes the browser restyle everything when the sidebar changes.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listPlan, patchList } from '../public/list-patch.js';

const page = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const between = (from, to) => { const i = page.indexOf(from), j = page.indexOf(to, i); assert.ok(i >= 0 && j > i, `${from} … ${to}`); return page.slice(i, j); };

// A small stand-in for the DOM: blocks are <div a="…">text</div>, enough for what patchList touches.
class El {
  constructor(attrs = {}, text = '') { this.attrs = new Map(Object.entries(attrs)); this.childNodes = [text]; this.replaced = 0; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  hasAttribute(n) { return this.attrs.has(n); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  removeAttribute(n) { this.attrs.delete(n); }
  replaceChildren(...nodes) { this.childNodes = nodes; this.replaced++; }
  get dataset() { const el = this; return new Proxy({}, { get: (_, k) => el.getAttribute(`data-${k}`) ?? undefined, set: (_, k, v) => { el.setAttribute(`data-${k}`, v); return true; } }); }
  get text() { return this.childNodes.join(''); }
}
const parse = (html) => [...html.matchAll(/<div([^>]*)>(.*?)<\/div>/g)].map(([, a, t]) => new El(Object.fromEntries([...a.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])), t));
class Box {
  constructor() { this.children = []; this.writes = 0; }
  set innerHTML(h) { this.children = parse(h); this.writes++; }
}
const make = (html) => parse(html)[0];
const block = (id, text, cls = '') => `<div data-p="${id}" class="sb-project ${cls}">${text}</div>`;
const draw = (box, list, tail = '') => patchList(box, { keys: list.map(([id]) => id), html: list.map(([id, t, c]) => block(id, t, c)), tail }, make);

test('the plan: draw all the first time or when the projects change, else only the blocks whose HTML changed', () => {
  const a = { keys: ['a', 'b', 'c'], html: ['A', 'B', 'C'], tail: '' };
  assert.deepEqual(listPlan(null, a), { full: true, changed: [] });
  assert.deepEqual(listPlan(a, { ...a }), { full: false, changed: [] });
  assert.deepEqual(listPlan(a, { ...a, html: ['A', 'B2', 'C'] }), { full: false, changed: [1] });
  // Order, a project more or less, or a different end of the list (Show more projects): everything again.
  assert.equal(listPlan(a, { ...a, keys: ['b', 'a', 'c'] }).full, true);
  assert.equal(listPlan(a, { keys: ['a', 'b'], html: ['A', 'B'], tail: '' }).full, true);
  assert.equal(listPlan(a, { ...a, tail: '<button>Show more</button>' }).full, true);
});

test('a chat working in one project redraws that project only, in the same element', () => {
  const box = new Box();
  const r1 = draw(box, [['a', 'idle'], ['b', 'idle'], ['c', 'idle']]);
  assert.equal(r1.full, true); assert.equal(r1.fresh.length, 3); assert.equal(box.writes, 1);
  const [ea, eb, ec] = box.children;
  // b's chat starts working: b gets new rows and its "working" class; a and c are left alone.
  const r2 = draw(box, [['a', 'idle'], ['b', 'Working…', 'working'], ['c', 'idle']]);
  assert.equal(r2.full, false); assert.equal(box.writes, 1, 'no full redraw');
  assert.deepEqual(r2.fresh, [eb]);
  assert.equal(box.children[1], eb, 'the block keeps its element (swapping it restyles every block after it)');
  assert.equal(eb.text, 'Working…'); assert.equal(eb.getAttribute('class'), 'sb-project working');
  assert.equal(eb.dataset.key, 'b');
  assert.equal(ea.replaced, 0); assert.equal(ec.replaced, 0);
  // Nothing changed: nothing is touched.
  const r3 = draw(box, [['a', 'idle'], ['b', 'Working…', 'working'], ['c', 'idle']]);
  assert.deepEqual(r3.fresh, []); assert.equal(eb.replaced, 1);
  // An attribute the new HTML no longer has goes (the key stays).
  draw(box, [['a', 'idle'], ['b', 'done'], ['c', 'idle']]);
  assert.equal(eb.getAttribute('class'), 'sb-project ');
  assert.equal(eb.dataset.key, 'b');
});

test('a box rewritten from elsewhere, or projects in a new order, is drawn again in full', () => {
  const box = new Box();
  draw(box, [['a', '1'], ['b', '2']]);
  box.children = [new El({}, 'something else')];
  assert.equal(draw(box, [['a', '1'], ['b', '2']]).full, true);
  assert.equal(draw(box, [['b', '2'], ['a', '1']]).full, true);
  assert.equal(box.children[0].dataset.key, 'b');
  assert.equal(draw(box, [['b', '2'], ['a', '1x']]).full, false);
});

test('the sidebar is drawn through patchList, with handlers on the new blocks and fresh project data when used', () => {
  const body = between('function renderSidebar() {', '\n  wsChrome(); // the chat tabs');
  assert.match(body, /patchList\(pl, \{ keys:/);
  assert.doesNotMatch(body, /\$\('#projectList'\)\.innerHTML\s*=/, 'no full rebuild on every redraw');
  assert.doesNotMatch(body, /querySelectorAll\('#projectList \.sb-(chat|project)'\)\) \{/, 'handlers only on the blocks drawn now');
  assert.match(body, /for \(const el of fresh\)/);
  assert.match(body, /const proj = \(\) => G\.projects\.find/, 'a block kept across refreshes looks its project up when used');
  assert.match(body, /SB_ALL\.find\(\(x\) => x\.id === id\)\?\.pinned/, 'Pin / Unpin reads the chat as it is now');
  // One date format for every row's tip: toLocaleString with options builds a formatter per row.
  assert.doesNotMatch(body, /toLocaleString\(\[\], \{/);
  assert.match(body, /SB_WHEN\.format\(/);
});

test('no stylesheet has a :has() with nothing before it (it makes every change restyle the whole page)', () => {
  const dir = new URL('../public/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.css'))) {
    const css = fs.readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // A :has( right after the start of a selector (start of a rule, a comma or a combinator), not after an element.
    const bad = css.match(/(?:^|[{},>+~\s])\s*:has\(/gm) || [];
    assert.deepEqual(bad, [], `${f} has a :has() with no element before it`);
  }
  assert.match(fs.readFileSync(new URL('last.css', dir), 'utf8'), /:is\(#pane, \.pane-area\):has\(> #paneTool\)/);
});
