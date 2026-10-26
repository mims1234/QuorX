// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// News from the website (server/newsremote.js), against a small fake website on this computer: the feed is read,
// only what changed is fetched, every file is checked, a bad download keeps the copy QuorX has, and turning it off
// goes back to the news/ folder that ships with QuorX.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncNews, setRemote, remoteState, activeNewsDir, newsCacheDir } from '../server/newsremote.js';
import { newsRoute } from '../server/news.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const md = (title) => Buffer.from(`---\ntitle: ${title}\ndate: 2026-10-22\nsummary: A page from the website\ntags: research\n---\n\nHello.\n\n![a picture](pic.png)\n`);

// A fake website: serves /news/feed.json and /news/content/…, and remembers every path asked for.
async function fakeSite(files, { version = '9.9.9', feedPatch = (f) => f, serve = {} } = {}) {
  const asked = [];
  const entry = (kind, slug) => ({ slug, title: slug, date: '2026-10-22', summary: 'S', tags: ['research'], page: `/news/${kind}/${slug}/`,
    files: Object.entries(files[`${kind}/${slug}`]).map(([name, buf]) => ({ name, size: buf.length, sha256: sha(buf), url: `/news/content/${kind}/${slug}/${name}?v=${sha(buf).slice(0, 12)}` })) });
  const feed = () => feedPatch({
    format: 1, site: 'x', generated: '2026-10-22T10:00:00.000Z',
    updates: { versions: [{ version, date: '2026-10-22', items: [{ kind: 'new', text: 'From the website' }] }] },
    articles: Object.keys(files).filter((k) => k.startsWith('articles/')).map((k) => entry('articles', k.split('/')[1])),
    reports: Object.keys(files).filter((k) => k.startsWith('reports/')).map((k) => entry('reports', k.split('/')[1])),
  });
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    asked.push({ path: p, ua: req.headers['user-agent'] });
    if (p === '/news/feed.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(feed())); }
    const m = /^\/news\/content\/(articles|reports)\/([^/]+)\/([^/]+)$/.exec(p);
    const buf = m && (serve[`${m[1]}/${m[2]}/${decodeURIComponent(m[3])}`] || files[`${m[1]}/${m[2]}`]?.[decodeURIComponent(m[3])]);
    if (!buf) { res.writeHead(404); return res.end(); }
    res.writeHead(200); res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.QUORX_NEWS_SITE = `http://127.0.0.1:${server.address().port}`;
  return { asked, close: () => new Promise((r) => server.close(r)) };
}
// A shipped news/ folder with one older version
function shipped(version = '0.1.0') {
  const dir = tempDir('quorx-shipped-news-');
  fs.mkdirSync(path.join(dir, 'articles', 'old'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'articles', 'old', 'index.md'), '---\ntitle: Old\ndate: 2026-10-01\nsummary: Shipped with QuorX\n---\nOld.\n');
  fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify({ versions: [{ version, date: '2026-10-01', items: [{ kind: 'new', text: 'Shipped' }] }] }));
  return dir;
}
const reset = () => {
  fs.rmSync(path.join(process.env.OH_HOME, 'data', 'news-remote.json'), { force: true });
  fs.rmSync(newsCacheDir(), { recursive: true, force: true });
};
test.afterEach(() => { process.env.QUORX_NEWS_SITE = 'off'; });

test('news remote: the feed is downloaded and News reads the copy, laid out like news/', async () => {
  reset();
  const site = await fakeSite({ 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } });
  try {
    const st = await syncNews({ force: true });
    assert.equal(st.error, undefined, st.error);
    assert.ok(st.syncedAt, 'syncedAt is recorded');
    assert.equal(st.files, 2);
    const cache = newsCacheDir();
    assert.ok(fs.existsSync(path.join(cache, 'articles', 'hello', 'index.md')));
    assert.ok(fs.existsSync(path.join(cache, 'articles', 'hello', 'pic.png')));
    assert.ok(fs.existsSync(path.join(cache, 'updates.json')));
    const ship = shipped();
    assert.equal(activeNewsDir(ship), cache, 'the newer downloaded copy is used');
    const r = await newsRoute({ method: 'GET', pathname: '/api/news', query: new URLSearchParams() }, activeNewsDir(ship));
    assert.equal(r.body.source.from, 'website');
    assert.deepEqual(r.body.articles.map((a) => a.slug), ['hello']);
    assert.equal(r.body.updates.versions[0].version, '9.9.9');
    assert.ok(site.asked.every((a) => a.path.startsWith('/news/')), 'only the site\'s own News addresses are asked for');
    assert.match(site.asked[0].ua, /^QuorX\/\d+\.\d+\.\d+/, 'the user agent says QuorX and its version, nothing else');
  } finally { await site.close(); }
});

test('news remote: a second check fetches only the feed when nothing changed, and only the changed file after', async () => {
  reset();
  const files = { 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } };
  const site = await fakeSite(files);
  try {
    await syncNews({ force: true });
    site.asked.length = 0;
    await syncNews({ force: true });
    assert.deepEqual(site.asked.map((a) => a.path), ['/news/feed.json']);
    files['articles/hello']['index.md'] = md('Hello again');
    site.asked.length = 0;
    const st = await syncNews({ force: true });
    assert.equal(st.error, undefined, st.error);
    assert.deepEqual(site.asked.map((a) => a.path), ['/news/feed.json', '/news/content/articles/hello/index.md']);
    assert.match(fs.readFileSync(path.join(newsCacheDir(), 'articles', 'hello', 'index.md'), 'utf8'), /Hello again/);
    // Without force, a check soon after the last one doesn't ask the website again
    site.asked.length = 0;
    await syncNews();
    assert.equal(site.asked.length, 0);
  } finally { await site.close(); }
});

test('news remote: a file that doesn\'t match the feed keeps the copy QuorX already has', async () => {
  reset();
  const files = { 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } };
  const site = await fakeSite(files);
  try {
    await syncNews({ force: true });
    await site.close();
  } catch (e) { await site.close(); throw e; }
  // The website now serves a different picture than the feed says
  files['articles/hello']['index.md'] = md('Changed');
  const bad = await fakeSite(files, { serve: { 'articles/hello/index.md': Buffer.from('tampered') } });
  try {
    const st = await syncNews({ force: true });
    assert.match(st.error, /didn't match the feed/);
    assert.match(fs.readFileSync(path.join(newsCacheDir(), 'articles', 'hello', 'index.md'), 'utf8'), /title: Hello\n/, 'the old copy stays');
    assert.ok(!fs.existsSync(`${newsCacheDir()}.next`), 'the half-made copy is removed');
  } finally { await bad.close(); }
});

test('news remote: names, sizes and formats outside what News allows are refused', async () => {
  const cases = [
    ['a slug that climbs out', (f) => { f.articles[0].slug = '../../evil'; return f; }, /name News doesn't allow/],
    ['a file name with a path', (f) => { f.articles[0].files[1].name = '../x.png'; return f; }, /file name News doesn't allow/],
    ['a script file', (f) => { f.articles[0].files[1].name = 'run.js'; return f; }, /file name News doesn't allow/],
    ['no index.md', (f) => { f.articles[0].files = f.articles[0].files.filter((x) => x.name !== 'index.md'); return f; }, /no index.md/],
    ['a huge file', (f) => { f.articles[0].files[1].size = 9e9; return f; }, /too large/],
    ['an unknown format', (f) => { f.format = 2; return f; }, /format this QuorX doesn't read/],
  ];
  for (const [what, feedPatch, error] of cases) {
    reset();
    const site = await fakeSite({ 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } }, { feedPatch });
    try {
      const st = await syncNews({ force: true });
      assert.match(String(st.error), error, what);
      assert.ok(!fs.existsSync(path.join(newsCacheDir(), 'updates.json')), `${what}: nothing is kept`);
      assert.ok(site.asked.every((a) => !a.path.includes('..') && !a.path.endsWith('.js')), `${what}: nothing outside News is fetched`);
    } finally { await site.close(); }
  }
});

test('news remote: an address in the feed is never followed; files come from the site\'s own News address', async () => {
  reset();
  const site = await fakeSite({ 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } }, {
    feedPatch: (f) => { for (const x of f.articles[0].files) x.url = 'http://127.0.0.1:1/elsewhere'; return f; },
  });
  try {
    const st = await syncNews({ force: true });
    assert.equal(st.error, undefined, st.error);
    assert.deepEqual(site.asked.map((a) => a.path).sort(), ['/news/content/articles/hello/index.md', '/news/content/articles/hello/pic.png', '/news/feed.json']);
  } finally { await site.close(); }
});

test('news remote: off shows the shipped copy, removes the download and asks the website nothing', async () => {
  reset();
  const site = await fakeSite({ 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } });
  try {
    await syncNews({ force: true });
    const ship = shipped();
    assert.equal(setRemote(false).on, false);
    assert.ok(!fs.existsSync(newsCacheDir()), 'the downloaded copy is removed');
    assert.equal(activeNewsDir(ship), ship);
    site.asked.length = 0;
    await syncNews({ force: true });
    assert.equal(site.asked.length, 0, 'nothing is asked while it\'s off');
    assert.throws(() => setRemote('yes'), /true or false/);
    assert.equal(setRemote(true).on, true);
  } finally { await site.close(); }
});

test('news remote: the copy that shipped wins when it\'s newer than the download', async () => {
  reset();
  const site = await fakeSite({ 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } }, { version: '0.2.0' });
  try {
    await syncNews({ force: true });
    const ship = shipped('0.3.0');
    assert.equal(activeNewsDir(ship), ship, 'an update installed while offline shows its own News');
    assert.equal(activeNewsDir(shipped('0.1.0')), newsCacheDir(), 'an older shipped copy gives way to the download');
  } finally { await site.close(); }
});

test('news remote: the routes turn it on and off and check now', async () => {
  reset();
  const site = await fakeSite({ 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } });
  try {
    const route = (method, pathname, body = '') => newsRoute({ method, pathname, query: new URLSearchParams(), body });
    const on = await route('POST', '/api/news/remote', '{"on":true}');
    assert.equal(on.code, 200);
    assert.equal(on.body.source.on, true);
    assert.ok(fs.existsSync(path.join(newsCacheDir(), 'updates.json')), 'turning it on downloads right away');
    const now = await route('POST', '/api/news/sync');
    assert.equal(now.code, 200);
    assert.ok(now.body.source.syncedAt);
    for (const body of ['{"on":"yes"}', '{}', 'not json']) assert.equal((await route('POST', '/api/news/remote', body)).code, 400, body);
    const off = await route('POST', '/api/news/remote', '{"on":false}');
    assert.equal(off.body.source.from, 'shipped');
    assert.equal(remoteState().on, false);
  } finally { await site.close(); setRemote(true); }
});

test('news remote: a failed download whose cleanup fails too ends quietly, never with an error out of the sync', async () => {
  reset();
  const state = path.join(process.env.OH_HOME, 'data', 'news-remote.json');
  // The feed promises a file the site doesn't match, so the download fails. The state file can't be written either
  // (a folder stands in its place, as a full disk or a locked file would), so the cleanup's own save fails too.
  const wrongHash = (f) => { f.articles[0].files[0].sha256 = '0'.repeat(64); return f; };
  const site = await fakeSite({ 'articles/hello': { 'index.md': md('Hello'), 'pic.png': PNG } }, { feedPatch: wrongHash });
  fs.mkdirSync(state, { recursive: true });
  try {
    await assert.doesNotReject(syncNews({ force: true }));
  } finally { await site.close(); fs.rmSync(state, { recursive: true, force: true }); }
});
