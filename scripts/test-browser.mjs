// The page operations (server/pageops.js) in a real headless tab, on local pages that copy what made the agent
// fail on real sites: a "Loading…" shell that fills in late, a virtual feed that removes posts as you scroll,
// controls covered by a dialog, and refs that go stale when the page changes.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openTab, closeBrowser, browserPath, noteRequest, slimNetworkEvent } from '../server/browser.js';

void tempDir;
const noBrowser = !browserPath() && 'no Chromium browser installed';

const PAGES = {
  '/late': `<!doctype html><meta charset="utf-8"><title>Late</title><div id="app">Loading…</div><script>
    setTimeout(() => { document.getElementById('app').innerHTML = '<h1>Home</h1>' + Array.from({ length: 5 }, (_, i) => '<article><a href="/p/' + i + '"><time>1h</time></a> Post number ' + i + ' with enough words to count</article>').join(''); }, 1200);</script>`,
  '/feed': `<!doctype html><meta charset="utf-8"><title>Feed</title><style>body{margin:0} article{height:120px}</style><main id="m" style="position:absolute;top:0;width:100%"></main><div id="pad"></div><script>
    const total = 60, H = 120, m = document.getElementById('m'); document.getElementById('pad').style.height = (total * H) + 'px';
    const draw = () => { const first = Math.max(0, Math.floor(scrollY / H) - 2), last = Math.min(total, first + 10); m.style.top = (first * H) + 'px'; m.innerHTML = ''; for (let i = first; i < last; i++) { const a = document.createElement('article'); a.innerHTML = '<a href="/status/' + i + '"><time>' + i + 'm</time></a> Feed post ' + i + ' says something worth reading'; m.append(a); } };
    addEventListener('scroll', draw); draw();</script>`,
  '/form': `<!doctype html><meta charset="utf-8"><title>Form</title><form role="search"><input id="q" placeholder="Search people"></form><label>Note <input id="note"></label>
    <button id="go" disabled>Go</button><button id="b">Toggle</button><ul>${Array.from({ length: 30 }, (_, i) => `<li role="listitem">Row ${i} with some text in it</li>`).join('')}</ul>
    <script>document.getElementById('b').onclick = () => { document.querySelector('ul').innerHTML = '<li>new</li>'; };</script>`,
};
let srv, base, tab;
test.before(async () => {
  if (noBrowser) return;
  srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(PAGES[q.url] || 'nope'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${srv.address().port}`;
  tab = await openTab({ own: true });
});
test.after(async () => { await tab?.close().catch(() => {}); srv?.close(); closeBrowser(); });

test('ready waits for a "Loading…" shell to fill in, and reports a page that never goes quiet', { skip: noBrowser }, async () => {
  await tab.open(`${base}/late`, { width: 1000, height: 700 });
  // Local pages don't wait for a thin page (the agent's own work), so wait as for an outside site.
  const r = await tab.ready({ quiet: 500, cap: 8000, thinMs: 2000 });
  assert.equal(r.quiet, true);
  assert.match((await tab.summary()).text, /Post number 4/);
  const busy = await tab.eval(`(() => { setInterval(() => { document.body.append(document.createElement('i')); }, 100); return 1; })()`);
  assert.equal(busy, 1);
  const r2 = await tab.ready({ quiet: 500, cap: 1200 });
  assert.equal(r2.quiet, false);
});

test('collect-style reading of a virtual feed gets every post, though the page keeps only ten at a time', { skip: noBrowser }, async () => {
  await tab.open(`${base}/feed`, { width: 1000, height: 700 });
  const seen = new Map();
  for (let i = 0; i < 20; i++) {
    const c = await tab.collectStep({});
    for (const it of c.items) seen.set(it.key, it);
    await tab.scrollItems({});
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(seen.size, 60);
  assert.match([...seen.values()][0].link, /\/status\/0$/);
});

test('snapshot refs: a click by ref works, a disabled button is refused with why, a stale ref fails instead of hitting something else, and long lists collapse', { skip: noBrowser }, async () => {
  await tab.open(`${base}/form`, { width: 1000, height: 700 });
  const s1 = await tab.snapshot();
  assert.match(s1.text, /textbox "Search people"/);
  assert.match(s1.text, /button "Go" \[disabled\]/);
  assert.match(s1.text, /… \d+ more listitems/);
  const go = /(e\d+) button "Go"/.exec(s1.text)[1];
  await assert.rejects(tab.click({ ref: `s${s1.n}:${go}` }), /can't click button "Go": it is disabled/);
  const toggle = /(e\d+) button "Toggle"/.exec(s1.text)[1];
  assert.match(await tab.click({ ref: `s${s1.n}:${toggle}` }), /clicked button "Toggle"/);
  const row = /(e\d+) listitem "Row 0/.exec(s1.text)[1];
  await assert.rejects(tab.click({ ref: `s${s1.n}:${row}` }), /no longer on the page/);
  await assert.rejects(tab.click({ ref: 's999:e1' }), /too old/);
  const f = await tab.find('search people');
  assert.match(f.lines[0], /textbox "Search people" · on screen · in search/);
  // A new page carries on the numbering: a ref from the page before can't land on something here.
  await tab.open(`${base}/feed`, { width: 1000, height: 700 });
  await assert.rejects(tab.click({ ref: `s${s1.n}:${toggle}` }), /too old/);
  assert.ok((await tab.snapshot()).n > f.n);
});

test('network events: only data requests are kept, with no headers, from full or slimmed events', () => {
  const list = [];
  noteRequest(list, 'Network.requestWillBeSent', { requestId: '1', type: 'Image', request: { url: 'https://x/a.png', method: 'GET' } });
  noteRequest(list, 'Network.requestWillBeSent', { requestId: '2', type: 'Fetch', request: { url: 'https://x/api', method: 'GET', headers: { Cookie: 'secret' } } });
  const slim = slimNetworkEvent('Network.responseReceived', { requestId: '2', type: 'Fetch', response: { status: 200, mimeType: 'application/json', headers: { 'set-cookie': 'secret' } } });
  assert.deepEqual(slim, { requestId: '2', type: 'Fetch', status: 200, mimeType: 'application/json' });
  noteRequest(list, 'Network.responseReceived', slim);
  noteRequest(list, 'Network.loadingFinished', { requestId: '2', encodedDataLength: 1234 });
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], at: 0 }, { id: '2', ref: 'n1', method: 'GET', url: 'https://x/api', type: 'Fetch', at: 0, status: 200, mime: 'application/json', size: 1234, done: true, failed: '' });
  assert.equal(slimNetworkEvent('Network.requestWillBeSent', { requestId: '3', type: 'Script', request: { url: 'https://x/s.js' } }), null);
});
