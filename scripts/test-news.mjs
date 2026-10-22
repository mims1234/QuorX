// News: the format checker (docs/news-format.md), the news/ folder QuorX ships, the /api/news routes, the page's
// renderer (public/news-md.js), and the user's own numbers (server/newslocal.js).
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFront, blocksOf, checkBlock, checkNews } from './news-check.mjs';
import { newsRoute, cmpVersion, lastRead } from '../server/news.js';
import * as md from '../public/news-md.js';
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

test('news: pictures must be files in the page\'s own folder', () => {
  const news = tmp(), dir = path.join(news, 'articles', 'pics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'here.png'), '');
  fs.writeFileSync(path.join(dir, 'index.md'), '---\ntitle: P\ndate: 2026-10-20\nsummary: S\n---\n![a](here.png) ![b](gone.png) ![c](../x.png) ![d](https://x.y/a.png)\n\n```md\n![in code](skipped.png)\n```\n');
  const p = checkNews(news).map((x) => x.problem).join('\n');
  assert.doesNotMatch(p, /here\.png|skipped\.png/);
  assert.match(p, /picture gone\.png is not in the folder/);
  assert.match(p, /picture \.\.\/x\.png: use/);
  assert.match(p, /picture https:\/\/x\.y\/a\.png: use/);
});

// ---------- the server's /api/news routes (server/news.js) ----------
const route = (method, pathname, q = {}, body = '', dir) => newsRoute({ method, pathname, query: new URLSearchParams(q), body }, dir);
function newsFolder() {
  const news = tmp();
  const art = (kind, slug, front, body = 'Text.\n') => {
    fs.mkdirSync(path.join(news, kind, slug), { recursive: true });
    fs.writeFileSync(path.join(news, kind, slug, 'index.md'), `---\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`);
  };
  art('articles', 'older', { title: 'Older', date: '2026-10-01', summary: 'S', tags: 'Models, cost' });
  art('articles', 'newer', { title: 'Newer', date: '2026-10-20', summary: 'S' });
  art('articles', '_draft', { title: 'Draft', date: '2026-10-21', summary: 'S' });
  art('reports', 'second', { title: 'Second', date: '2026-10-20', summary: 'S', order: 2 });
  art('reports', 'first', { title: 'First', date: '2026-10-01', summary: 'S', order: 1 });
  fs.writeFileSync(path.join(news, 'articles', 'newer', 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(news, 'articles', 'newer', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(news, 'updates.json'), JSON.stringify({ versions: [{ version: '0.1.0', date: '2026-10-01', items: [{ kind: 'new', text: 'A' }] }, { version: '0.2.0', date: '2026-10-20', items: [{ kind: 'fixed', text: 'B' }] }] }));
  fs.writeFileSync(path.join(news, 'secret.json'), '{"secret":true}');
  return news;
}

test('news routes: the index lists articles newest first and reports by order, without drafts', async () => {
  const news = newsFolder();
  const r = await route('GET', '/api/news', {}, '', news);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.articles.map((a) => a.slug), ['newer', 'older']);
  assert.deepEqual(r.body.reports.map((a) => a.slug), ['first', 'second']);
  assert.deepEqual(r.body.articles[1].tags, ['models', 'cost']);
  assert.equal(r.body.reports[0].order, 1);
  assert.deepEqual(r.body.updates.versions.map((v) => v.version), ['0.2.0', '0.1.0'], 'newest version first');
  assert.match(r.body.version, /^\d+\.\d+\.\d+/);
  // The cache notices an edit.
  fs.writeFileSync(path.join(news, 'articles', 'older', 'index.md'), '---\ntitle: Renamed\ndate: 2026-10-01\nsummary: S\n---\n');
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(news, 'articles', 'older', 'index.md'), t, t);
  assert.equal((await route('GET', '/api/news', {}, '', news)).body.articles[1].title, 'Renamed');
});

test('news routes: names are checked and nothing outside news/ is served', async () => {
  const news = newsFolder();
  assert.equal((await route('GET', '/api/news/item', { kind: 'articles', slug: 'newer' }, '', news)).body.front.title, 'Newer');
  assert.equal((await route('GET', '/api/news/item', { kind: 'articles', slug: '_draft' }, '', news)).code, 200, 'a draft opens by name');
  for (const [kind, slug] of [['articles', '../reports/first'], ['articles', '..'], ['articles', 'Newer'], ['articles', 'newer/'], ['articles', ''], ['secrets', 'newer'], ['..', 'articles'], ['articles', '%2e%2e'], ['articles', 'x'.repeat(200)]]) {
    assert.equal((await route('GET', '/api/news/item', { kind, slug }, '', news)).code, 404, `${kind}/${slug}`);
  }
  const ok = await route('GET', '/api/news/file', { kind: 'articles', slug: 'newer', name: 'data.json' }, '', news);
  assert.equal(ok.code, 200); assert.equal(ok.type, 'application/json'); assert.equal(path.basename(ok.file), 'data.json');
  const svg = await route('GET', '/api/news/file', { kind: 'articles', slug: 'newer', name: 'pic.svg' }, '', news);
  assert.match(svg.headers['Content-Security-Policy'], /sandbox/, 'pictures in SVG are sandboxed');
  for (const name of ['../../secret.json', '..\\..\\secret.json', 'index.md', '.json', '..json', 'a/data.json', 'data.json.exe', 'C:\\Windows\\win.ini', '', 'missing.json']) {
    assert.equal((await route('GET', '/api/news/file', { kind: 'articles', slug: 'newer', name }, '', news)).code, 404, name);
  }
  assert.equal((await route('GET', '/api/news/file', { kind: 'articles', slug: '..', name: 'secret.json' }, '', news)).code, 404);
  assert.equal((await route('GET', '/api/news/nope', {}, '', news)).code, 404);
  assert.equal(await route('GET', '/api/newsletter', {}, '', news), null, 'other routes are left alone');
});

test('news routes: the version read is stored with the user\'s data and never goes back', async () => {
  const news = newsFolder();
  const file = path.join(process.env.OH_HOME, 'data', 'news.json');
  fs.rmSync(file, { force: true });
  assert.equal((await route('GET', '/api/news', {}, '', news)).body.lastRead, undefined);
  assert.equal((await route('POST', '/api/news/read', {}, '{"version":"0.2.0"}', news)).body.lastRead, '0.2.0');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lastRead, '0.2.0');
  assert.equal((await route('GET', '/api/news', {}, '', news)).body.lastRead, '0.2.0');
  assert.equal((await route('POST', '/api/news/read', {}, '{"version":"0.1.0"}', news)).body.lastRead, '0.2.0', 'an older version doesn\'t undo it');
  for (const body of ['{"version":"../x"}', '{"version":"1.2"}', '{}', 'not json']) assert.equal((await route('POST', '/api/news/read', {}, body, news)).code, 400, body);
  assert.equal(lastRead(), '0.2.0');
  assert.equal(cmpVersion('0.10.0', '0.9.9'), 1); assert.equal(cmpVersion('0.2.0', '0.2.0'), 0); assert.equal(cmpVersion('nope', '0.0.1'), -1);
});

test('news routes: local blocks are empty until server/newslocal.js fills them', async () => {
  const r = await route('GET', '/api/news/local', { view: 'models' });
  assert.equal(r.code, 200);
  if (!fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'newslocal.js'))) assert.deepEqual(r.body, { empty: true });
  assert.equal((await route('GET', '/api/news/local', { view: 'secrets' })).code, 400);
});

// ---------- the page's renderer (public/news-md.js) ----------

test('news renderer: everything from the file is escaped', () => {
  const h = md.renderMarkdown('## <img src=x onerror=alert(1)>\n\n<script>alert(1)</script> & "q" \'s\n\n`<b>` **<i>**');
  assert.doesNotMatch(h, /<script|<img|<i>|<b>/);
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot; &#39;s/);
  assert.match(h, /<code>&lt;b&gt;<\/code>/);
  // Links: only the web, mail, News pages and headings; nothing that runs script or escapes an attribute.
  const l = md.renderMarkdown('[a](javascript:alert(1)) [b](https://x.y/?a=1&b="2) [c](data:text/html,x) [d](https://ok.example/p?q=1) [e](articles/my-page) [f](#numbers) [g](file:///C:/x)');
  assert.doesNotMatch(l, /href="(javascript|data|file):/i);
  assert.doesNotMatch(l, /href="[^"]*"2/);
  assert.match(l, /<a href="https:\/\/ok\.example\/p\?q=1" rel="noopener noreferrer" data-ext="1" data-cl="1">d<\/a>/);
  assert.doesNotMatch(l, /target="_blank"[^>]*data-cl/); // a web link in News opens in the Browser tab, never a new window
  assert.match(l, /data-news="articles\/my-page"/);
  assert.match(l, /data-anchor="numbers"/);
  // Pictures: a file in the article's own folder only.
  const p = md.renderMarkdown('![ok](chart.png) ![up](../../secret.png) ![web](https://x.y/a.png) ![q](a.png" onerror="x)', { kind: 'articles', slug: 'demo' });
  assert.match(p, /<img src="\/api\/news\/file\?kind=articles&amp;slug=demo&amp;name=chart\.png" alt="ok"/);
  assert.equal((p.match(/<img /g) || []).length, 1);
  assert.doesNotMatch(p, /onerror="/);
});

test('news renderer: the Markdown subset', () => {
  const h = md.renderMarkdown([
    '# Top', '### Third', 'One **bold**, *it*, _also_, ~~gone~~ and a\\', 'break.', '',
    '- a', '- b', '  - nested', '- c', '', '3. three', '4. four', '',
    '> quoted **q**', '> more', '',
    '| A | B | C |', '|:--|:-:|--:|', '| 1 | 2 | 3 |', '',
    '```js', 'const x = "<y>";', '```', '', '---', '', '```stat', '{"items":[]}', '```', '', '```chart', '{}', '```',
  ].join('\n'));
  assert.match(h, /<h2 id="nw-top">Top<\/h2>/, '# shows as h2; the title is the only h1');
  assert.match(h, /<h3 id="nw-third">Third<\/h3>/);
  assert.match(h, /<strong>bold<\/strong>, <em>it<\/em>, <em>also<\/em>, <del>gone<\/del> and a<br>break\./);
  assert.match(h, /<ul><li>a<\/li><li>b<ul><li>nested<\/li><\/ul><\/li><li>c<\/li><\/ul>/);
  assert.match(h, /<ol start="3"><li>three<\/li><li>four<\/li><\/ol>/);
  assert.match(h, /<blockquote><p>quoted <strong>q<\/strong> more<\/p><\/blockquote>/);
  assert.match(h, /<th style="text-align:left">A<\/th><th style="text-align:center">B<\/th><th style="text-align:right">C<\/th>/);
  assert.match(h, /<pre class="nw-code" data-lang="js"><code>const x = &quot;&lt;y&gt;&quot;;<\/code><\/pre>/);
  assert.match(h, /<hr>/);
  assert.match(h, /<div class="nb-slot" data-block="stat" data-n="0"><\/div><div class="nb-slot" data-block="chart" data-n="1"><\/div>/);
  assert.doesNotMatch(md.renderMarkdown('snake_case_name and 2 * 3 * 4'), /<em>/, 'no italics inside words or between spaced stars');
});

test('news renderer: every block draws at rest, escaped and to scale', () => {
  const evil = '<b onclick=x>"';
  const all = {
    stat: { items: [{ label: evil, from: 15, to: 33 }, { label: 'Cost', from: 0.12, to: 0.039, unit: '$' }] },
    chart: { type: 'bar', title: evil, x: ['a', 'b'], series: [{ name: evil, values: [10, 40] }] },
    timeline: { items: [{ when: '19 Oct', title: evil, text: 'x', tag: evil }] },
    lanes: { start: '04:30', end: '06:10', rows: [{ label: evil, build: ['04:36', '04:51'], review: ['04:51', '05:04'], back: 1, detail: 'Why.' }] },
    flow: { nodes: [{ id: 'a', title: evil, cap: 'A' }, { id: 'b', title: 'B', new: true }], loops: [{ from: 'b', to: 'a', label: evil }] },
    compare: { prompt: evil, options: [{ label: 'Before', steps: [{ title: evil, bad: true }], verdict: { title: 'V0' } }, { label: 'After', steps: [{ title: 'S' }], verdict: { title: 'V1' } }] },
    matrix: { levels: [{ id: 'proven', label: 'Proven' }, { id: 'next', label: 'Not yet' }], columns: ['App', 'Evidence'], rows: [{ level: 'proven', cells: [evil, 'e'] }, { level: 'next', cells: ['x', 'y'] }] },
    ledger: { rows: [{ gain: evil, gainText: 'g', cost: 'c', costText: 'c', mitigation: 'm' }] },
    terminal: { title: evil, lines: [{ cmd: 'echo <x>' }, { out: '<x>' }] },
    callout: { tone: 'warn', title: evil, text: 'x' },
    local: { view: 'models' },
  };
  assert.deepEqual(Object.keys(all).sort(), [...md.BLOCKS].sort(), 'the test covers every block in the contract');
  for (const [name, d] of Object.entries(all)) {
    const h = md.blockHtml(name, d, 720);
    assert.match(h, /^<(div|figure|ol|aside) class="nb /, name);
    assert.doesNotMatch(h, /<b onclick|onclick=x>/, `${name} escapes its text`);
  }
  // Bars to scale: 40 is four times as tall as 10, both from the same baseline.
  const svg = md.chartSvg(all.chart, 720);
  const bars = [...svg.matchAll(/<rect class="bar [^"]*"[^>]* y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)].map((m) => ({ y: Number(m[1]), h: Number(m[2]) }));
  assert.equal(bars.length, 2);
  assert.ok(Math.abs(bars[1].h / bars[0].h - 4) < 0.05, `heights ${bars[0].h} and ${bars[1].h}`);
  assert.ok(Math.abs((bars[0].y + bars[0].h) - (bars[1].y + bars[1].h)) < 0.2, 'one baseline');
  assert.deepEqual(md.niceTicks(129, 176, 5).ticks, [120, 130, 140, 150, 160, 170, 180]);
  assert.deepEqual(md.niceTicks(0, 1601, 5).ticks, [0, 500, 1000, 1500, 2000]);
  // A line chart, pairs, lanes and the flow at phone width.
  assert.match(md.chartSvg({ type: 'line', x: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 2, 3] }] }, 320), /<polyline class="ln s0 nb-line"/);
  assert.equal((md.chartSvg({ type: 'pairs', x: ['a', 'b'], series: [{ name: 'Before', values: [1, 2] }, { name: 'Now', values: [3, 4] }] }).match(/class="bar (before|after)/g) || []).length, 4);
  assert.equal((md.lanesSvg(all.lanes, 360).match(/class="nb-lane"/g) || []).length, 1);
  assert.match(md.lanesSvg(all.lanes, 720), /class="g-back"/);
  assert.equal((md.flowSvg(all.flow, 340).match(/<g class="node/g) || []).length, 2);
  assert.match(md.flowCap(all.flow, 0), /1\/2/);
  // At rest: compare shows its last option, the matrix every row, the terminal every line.
  assert.match(md.blockHtml('compare', all.compare), /aria-pressed="true">After</);
  assert.match(md.compareBody(all.compare, 0), /class="bad"/);
  assert.equal((md.blockHtml('matrix', all.matrix).match(/<tr data-l=/g) || []).length, 2);
  assert.match(md.termLines(all.terminal.lines), /echo &lt;x&gt;[\s\S]*&lt;x&gt;/);
  assert.match(md.laneCard(all.lanes, 0), /sent back once/);
  assert.equal(md.withUnit('0.039', '$'), '$0.039'); assert.equal(md.withUnit('40', '%'), '40%'); assert.equal(md.withUnit('176', 'tests'), '176 tests');
  // Local blocks: a friendly empty state, then the numbers.
  for (const view of ['models', 'deciders', 'costs', 'tests']) assert.match(md.localHtml(view, { empty: true }), /nothing yet[\s\S]*never leave it/, view);
  assert.match(md.localHtml('models', { rows: [{ model: 'openai/gpt-x', replies: 3, passRate: 0.67, avgCost: 0.002, avgSteps: 4, avgSeconds: 30 }] }), /gpt-x[\s\S]*67%/);
  assert.match(md.localHtml('models', { rows: [{ model: 'openai/gpt-x', replies: 3, passRate: 0.67, avgCost: 0.002, avgSteps: 4, avgSeconds: 30, looksFirst: 5.5 }] }), /Looks before writing[\s\S]*5\.5/);
  assert.match(md.localHtml('tests', { runs: [{ name: 'npm test', passed: 180, failed: 0, at: '2026-10-20' }] }), /npm test[\s\S]*180/);
  assert.match(md.blockHtml('nope', {}), /nb-error/);
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
    { ts: ago(1, 2), runId: 'r2', chatId: 'c1', project: 'secret-project', model: 'acme/small', stop: 'done', steps: 6, tools: 5, verify: { ok: false }, cost: 0.03, ms: 40000, looksFirst: 3, firstWrite: 4 },
    { ts: ago(3), runId: 'r3', project: 'my-app', model: 'acme/big', stop: 'done', steps: 2, cost: 0.2, ms: 10000 },
    { ts: ago(2), runId: 'doc-1', kind: 'docs', project: 'my-app', model: 'acme/embed', stop: 'index', cost: 0.005 },
    { ts: ago(200), runId: 'old', project: 'my-app', model: 'acme/ancient', stop: 'done', cost: 9 },
    'not json',
  ]);
  const m = localView('models', { fresh: true });
  assert.deepEqual(m.rows.map((r) => r.model), ['acme/small', 'acme/big'], 'docs rows and old rows are left out');
  const small = m.rows[0];
  assert.deepEqual([small.replies, small.passRate, small.avgCost, small.avgSteps, small.avgSeconds], [2, 0.5, 0.02, 5, 30]);
  assert.equal(small.looksFirst, 3, 'only replies that logged the slow start count'); assert.equal(m.rows[1].looksFirst, null);
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
    saveTestResult('test', { total: 10, pass: 9, fail: 1, skipped: 0, failedNames: ['stop: something'] });
    saveTestResult('ui', { scenario: 'settings', passed: 8, total: 9, failedNames: ['a step'] });
  } finally { process.env.QX_RESULTS_HOME = was; }
  const t = localView('tests', { fresh: true });
  assert.equal(t.test.pass, 9); assert.equal(t.ui.total, 9); assert.equal(t.packs, null);
  assert.deepEqual(t.runs.map((r) => [r.name, r.passed, r.failed]), [['npm test', 9, 1], ['UI test (settings)', 8, 1]]);
  assert.match(md.localHtml('tests', t), /npm test[\s\S]*9[\s\S]*UI test \(settings\)/, 'the page draws it');
  assert.match(t.test.at, /^\d{4}-/);
  fs.rmSync(path.join(LOGS, 'test-results.json'));
  assert.equal(localView('tests').test.pass, 9, 'cached');
  assert.equal(localView('tests', { fresh: true }).empty, true);
});
