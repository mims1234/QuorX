// News: the format checker (docs/news-format.md), and the news/ folder QuorX ships is in order.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFront, blocksOf, checkBlock, checkNews } from './news-check.mjs';

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
