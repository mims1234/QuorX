// News: the format checker (docs/news-format.md), the news/ folder QuorX ships is in order, and the user's own numbers.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFront, blocksOf, checkBlock, checkNews } from './news-check.mjs';
import { localView } from '../server/newslocal.js';
import { saveTestResult } from './test-results.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qx-news-'));

test('news: the news/ folder that ships is in order', () => {
  assert.deepEqual(checkNews(), []);
});

test('news: front matter and blocks are read', () => {
  const { front, body } = parseFront('---\ntitle: T\ndate: 2026-10-20\nsummary: S\ntags: models, cost\n---\nText\n\n```stat\n{"items":[{"label":"a","from":1,"to":2}]}\n```\n\n```js\nnot a block\n```\n');
  assert.equal(front.title, 'T'); assert.equal(front.tags, 'models, cost');
  const b = blocksOf(body);
  assert.equal(b.length, 1); assert.equal(b[0].name, 'stat');
  assert.throws(() => parseFront('no front matter'), /front matter/);
});

test('news: each block type is checked', () => {
  assert.deepEqual(checkBlock('chart', { type: 'line', x: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] }), []);
  assert.ok(checkBlock('chart', { type: 'line', x: ['a', 'b'], series: [{ name: 's', values: [1] }] }).length, 'one value per label');
  assert.ok(checkBlock('chart', { type: 'pairs', x: ['a'], series: [{ name: 's', values: [1] }] }).length, 'pairs needs two series');
  assert.deepEqual(checkBlock('flow', { nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], loops: [{ from: 'b', to: 'a', label: 'retry' }] }), []);
  assert.ok(checkBlock('flow', { nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], loops: [{ from: 'x', to: 'a' }] }).length);
  assert.deepEqual(checkBlock('matrix', { levels: [{ id: 'proven', label: 'Proven' }], columns: ['App', 'Evidence'], rows: [{ level: 'proven', cells: ['x', 'y'] }] }), []);
  assert.ok(checkBlock('matrix', { levels: [{ id: 'proven', label: 'Proven' }], columns: ['App'], rows: [{ level: 'other', cells: ['x'] }] }).length);
  assert.deepEqual(checkBlock('lanes', { start: '04:30', end: '06:10', rows: [{ label: '#4', build: ['04:36', '04:51'], review: ['04:51', '05:03'] }] }), []);
  assert.deepEqual(checkBlock('local', { view: 'models' }), []);
  assert.ok(checkBlock('local', { view: 'secrets' }).length);
  assert.ok(checkBlock('nope', {}).length);
});

test('news: a broken article, a src file and updates.json are reported', () => {
  const news = tmp();
  fs.mkdirSync(path.join(news, 'articles', 'good'), { recursive: true });
  fs.writeFileSync(path.join(news, 'articles', 'good', 'data.json'), JSON.stringify({ chart: { type: 'bar', x: ['a'], series: [{ name: 'n', values: [3] }] } }));
  fs.writeFileSync(path.join(news, 'articles', 'good', 'index.md'), '---\ntitle: Good\ndate: 2026-10-20\nsummary: Fine.\n---\n```chart\n{"src":"data.json","path":"chart"}\n```\n');
  fs.mkdirSync(path.join(news, 'articles', 'Bad_Name'));
  fs.writeFileSync(path.join(news, 'articles', 'Bad_Name', 'index.md'), '---\ntitle: Bad\ndate: 20 Oct\nsummary: x\n---\n```stat\n{"items":[]}\n```\n');
  fs.writeFileSync(path.join(news, 'updates.json'), JSON.stringify({ versions: [{ version: '0.2.0', date: '2026-10-20', items: [{ kind: 'shiny', text: 'x' }] }] }));
  const p = checkNews(news).map((x) => `${x.where}: ${x.problem}`).join('\n');
  assert.doesNotMatch(p, /articles\/good/);
  assert.match(p, /articles\/Bad_Name: folder name/);
  assert.match(p, /articles\/Bad_Name: front matter needs date/);
  assert.match(p, /articles\/Bad_Name\/index\.md:\d+: stat block/);
  assert.match(p, /updates\.json versions\[0\]\.items\[0\]: kind/);
});

// ---------- the user's own numbers (server/newslocal.js), on fixture logs in this test's throwaway OH_HOME ----------
const LOGS = path.join(process.env.OH_HOME, 'logs');
const ago = (days, h = 0) => new Date(Date.now() - days * 864e5 - h * 36e5).toISOString();
const lines = (name, rows) => { fs.mkdirSync(LOGS, { recursive: true }); fs.writeFileSync(path.join(LOGS, name), rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'); };
const SECRET = /secret|C:\\Users|my-app/;

test('news local: every view explains itself while there are no logs', () => {
  fs.rmSync(LOGS, { recursive: true, force: true });
  for (const view of ['models', 'deciders', 'costs', 'tests']) {
    const v = localView(view, { fresh: true });
    assert.equal(v.empty, true, view); assert.ok(v.why.length > 20, view);
  }
  assert.equal(localView('secrets'), null);
});

test('news local: models and costs come from runs.jsonl, with nothing private', () => {
  lines('runs.jsonl', [
    { ts: ago(1), runId: 'r1', chatId: 'c1', project: 'secret-project', model: 'acme/small', stop: 'done', steps: 4, tools: 3, verify: { ok: true }, cost: 0.01, ms: 20000 },
    { ts: ago(1, 2), runId: 'r2', chatId: 'c1', project: 'secret-project', model: 'acme/small', stop: 'done', steps: 6, tools: 5, verify: { ok: false }, cost: 0.03, ms: 40000 },
    { ts: ago(3), runId: 'r3', project: 'my-app', model: 'acme/big', stop: 'done', steps: 2, cost: 0.2, ms: 10000 },
    { ts: ago(2), runId: 'doc-1', kind: 'docs', project: 'my-app', model: 'acme/embed', stop: 'index', cost: 0.005 },
    { ts: ago(200), runId: 'old', project: 'my-app', model: 'acme/ancient', stop: 'done', cost: 9 },
    'not json',
  ]);
  const m = localView('models', { fresh: true });
  assert.deepEqual(m.rows.map((r) => r.model), ['acme/small', 'acme/big'], 'docs rows and old rows are left out');
  const small = m.rows[0];
  assert.deepEqual([small.replies, small.passRate, small.avgCost, small.avgSteps, small.avgSeconds], [2, 0.5, 0.02, 5, 30]);
  assert.equal(m.rows[1].passRate, null, 'no checks ran: no pass rate');
  assert.match(m.since, /^\d{4}-\d{2}-\d{2}$/);

  const c = localView('costs', { fresh: true });
  assert.equal(c.days.length, 30);
  assert.ok(Math.abs(c.days.reduce((s, d) => s + d.cost, 0) - 0.245) < 1e-9, 'the spend of the last 30 days, docs included');
  assert.deepEqual(c.byModel.map((x) => x.model), ['acme/big', 'acme/small', 'acme/embed']);
  assert.doesNotMatch(JSON.stringify([m, c]), SECRET);
});

test('news local: deciders count buckets and how often each decider sided with the panel', () => {
  lines('decisions.jsonl', [
    { ts: ago(1), model: 'acme/small', voters: ['v/a', 'v/b'], ask: 'Is the secret answer 42?', bucket: 'confirmed' },
    { ts: ago(1), ask: 'secret 2', bucket: 'flipped' },
    { ts: ago(1), ask: 'secret 3', bucket: 'theater' },
    { ts: ago(1), ask: 'secret 4', bucket: 'theater' },
  ]);
  lines('checks.jsonl', [
    { ts: ago(1), kind: 'look', ask: 'The secret page shows a button', p: 0.9, bucket: 'unclear', votes: [{ m: 'v/a', p: 0.8 }, { m: 'v/b', p: 0.2 }], target: 'C:\Users\me\secret\index.html' },
    { ts: ago(1), kind: 'gap', ask: 'secret gap', p: 0.1, votes: [{ m: 'v/a', p: 0.3 }] },
    { ts: ago(1), kind: 'outcome', result: 'fixed' },
  ]);
  lines('approvals.jsonl', [
    { ts: ago(1), kind: 'command', facts: { line: 'rm -rf secret' }, voters: [{ model: 'v/a', needed: 0.9, other: 0.1, ok: true }, { model: 'v/c', needed: 0.2, other: 0.1, ok: true }, { model: 'v/d', ok: false }], pNeed: 0.8, pOther: 0.1, final: 'approved' },
  ]);
  const d = localView('deciders', { fresh: true });
  assert.deepEqual([d.questions, d.confirmed, d.flipped, d.theater, d.unclear], [5, 1, 1, 2, 1]);
  const by = Object.fromEntries(d.byModel.map((x) => [x.model, [x.votes, x.agreed]]));
  assert.deepEqual(by, { 'v/a': [4, 4], 'v/b': [1, 0], 'v/c': [2, 1] }, 'a failed voter is not counted');
  assert.equal(d.approvals, 1);
  assert.doesNotMatch(JSON.stringify(d), SECRET);
});

test('news local: test results are kept by each suite and shown, and the view is cached briefly', () => {
  const was = process.env.QX_RESULTS_HOME;
  process.env.QX_RESULTS_HOME = process.env.OH_HOME;
  try {
    saveTestResult('test', { total: 10, pass: 9, fail: 1, skipped: 0, failed: ['stop: something'] });
    saveTestResult('ui', { scenario: 'settings', passed: 9, total: 9, failed: [] });
  } finally { process.env.QX_RESULTS_HOME = was; }
  const t = localView('tests', { fresh: true });
  assert.equal(t.test.pass, 9); assert.equal(t.ui.total, 9); assert.equal(t.packs, null);
  assert.match(t.test.at, /^\d{4}-/);
  fs.rmSync(path.join(LOGS, 'test-results.json'));
  assert.equal(localView('tests').test.pass, 9, 'cached');
  assert.equal(localView('tests', { fresh: true }).empty, true);
});
