// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
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
    <button id="go" disabled>Go</button><button id="b">Toggle</button><button aria-label="Delete">🗑</button><ul>${Array.from({ length: 30 }, (_, i) => `<li role="listitem">Row ${i} with some text in it</li>`).join('')}</ul>
    <script>document.getElementById('b').onclick = () => { document.querySelector('ul').innerHTML = '<li>new</li>'; };</script>`,
  '/compose': '<!doctype html><meta charset="utf-8"><title>Compose</title><input id="q" aria-label="Ask" value="hi"><div id="box" contenteditable="true" role="textbox" aria-label="Message">hello there</div>',
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
  // (A slow machine runs a background tab's timers about once a second: a quiet window longer than that still sees
  // the page change, so it can't pass for quiet.)
  const r2 = await tab.ready({ quiet: 1500, cap: 3000 });
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

test('type replaces what a field holds and reads it back (an input and a chat box); append adds to it', { skip: noBrowser }, async () => {
  await tab.open(`${base}/compose`, { width: 1000, height: 700 });
  const s1 = await tab.snapshot();
  const ask = `s${s1.n}:${/(e\d+) textbox "Ask"/.exec(s1.text)[1]}`, box = `s${s1.n}:${/(e\d+) textbox "Message"/.exec(s1.text)[1]}`;
  assert.match(await tab.type({ ref: ask, text: 'hi' }), /held "hi" before, replaced\); the field now holds "hi"$/, 'not "hihi"');
  assert.equal(await tab.eval('document.getElementById("q").value'), 'hi');
  assert.match(await tab.type({ ref: box, text: 'new words' }), /the field now holds "new words"$/);
  assert.equal(await tab.eval('document.getElementById("box").innerText.trim()'), 'new words');
  assert.match(await tab.type({ ref: ask, text: ' there', append: true }), /the field now holds "hi there"$/);
});

test('the risk check, summary and the agent’s mark are page operations too: a click by ref on Delete is caught', { skip: noBrowser }, async () => {
  await tab.open(`${base}/form`, { width: 1000, height: 700 });
  const s = await tab.snapshot();
  const del = /(e\d+) button "Delete"/.exec(s.text)[1], toggle = /(e\d+) button "Toggle"/.exec(s.text)[1];
  assert.equal(await tab.riskOf({ action: 'click', ref: `s${s.n}:${del}` }), 'click "🗑 · Delete"');
  assert.equal(await tab.riskOf({ action: 'click', ref: `s${s.n}:${toggle}` }), null);
  const sum = await tab.summary();
  assert.equal(sum.title, 'Form'); assert.equal(sum.screen, true);
  assert.ok(sum.controls.some((c) => /button#b "Toggle"/.test(c)));
  await tab.mark(true);
  assert.equal(await tab.eval('!!document.getElementById("quorx-agent-mark")'), true);
  await tab.mark(false);
  assert.equal(await tab.eval('!!document.getElementById("quorx-agent-mark")'), false);
});

test('the extension runs the same page operations: extension/pageops.js is generated from server/pageops.js', async () => {
  const fs = await import('node:fs');
  const { extensionPageops } = await import('./sync-extension.mjs');
  const onDisk = fs.readFileSync(new URL('../extension/pageops.js', import.meta.url), 'utf8');
  assert.equal(onDisk, extensionPageops(), 'run: node scripts/sync-extension.mjs');
});

test('your own skills: one for every project and one for a project, edited, renamed and moved to the trash', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { listSkills, saveSkill, getSkill, deleteSkill } = await import('../server/skills.js');
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-skills-'));
  const mine = (dir) => listSkills(dir).filter((k) => k.source !== 'built-in').map((k) => `${k.name}:${k.source}`);
  assert.equal(saveSkill(proj, { name: 'Release Notes', description: 'From the git log', instructions: '1. Read the log' }, { where: 'mine', by: 'written by you' }), 'release-notes');
  saveSkill(proj, { name: 'deploy', description: 'Ship it', instructions: 'npm run deploy' }, { where: 'project', by: 'written by you' });
  assert.deepEqual(mine(proj), ['deploy:project', 'release-notes:mine']);
  assert.deepEqual(mine(null), ['release-notes:mine'], 'your skills show in every project; a project skill only in its own');
  const k = getSkill(proj, 'release-notes', 'mine');
  assert.equal(k.description, 'From the git log'); assert.equal(k.instructions, '1. Read the log');
  assert.throws(() => saveSkill(proj, { name: 'deploy', instructions: 'x' }, { where: 'project', was: { name: 'release-notes', where: 'mine' } }), /already a skill named deploy/);
  saveSkill(proj, { name: 'changelog', description: 'From the git log', instructions: '2. Group by feature' }, { where: 'project', was: { name: 'release-notes', where: 'mine' } });
  assert.deepEqual(mine(proj), ['changelog:project', 'deploy:project'], 'renamed and moved: the old one is gone');
  assert.throws(() => deleteSkill(proj, 'web-app', 'built-in'), /can only be switched off/);
  deleteSkill(proj, 'deploy', 'project');
  assert.deepEqual(mine(proj), ['changelog:project']);
  assert.throws(() => saveSkill(null, { name: 'x', instructions: 'y' }), /needs a project/);
});

test('a routine recorded in Chrome becomes a skill of named steps, with typed text kept only for search boxes', async () => {
  const { routineSkill } = await import('../server/skills.js');
  const k = routineSkill('Open bat-cave', [
    { kind: 'go', url: 'https://discord.com/channels/@me' },
    { kind: 'click', role: 'treeitem', name: 'Meow' },
    { kind: 'click', role: 'link', name: 'bat-cave' },
    { kind: 'type', role: 'search box', field: 'Search', value: 'cats' },
    { kind: 'type', role: 'text box', field: 'Message #bat-cave', value: '' },
    { kind: 'press', key: 'Enter', field: 'Message #bat-cave' },
  ], new Date('2026-10-23T08:00:00Z'));
  assert.equal(k.name, 'Open bat-cave'); assert.equal(k.steps, 6);
  assert.match(k.description, /6 steps on discord\.com/);
  assert.match(k.instructions, /1\. Open https:\/\/discord\.com\/channels\/@me\n2\. Click the treeitem "Meow"\n3\. Click the link "bat-cave"\n4\. Type into the search box "Search": "cats"\n5\. Type into the text box "Message #bat-cave": \(your text: not recorded/);
  assert.throws(() => routineSkill('x', [{ kind: 'go', url: 'https://a.example' }]), /nothing was recorded/);
});

test('every run’s events reach a watcher (the extension’s status), with null when the run ends', async () => {
  const { startRun, onRunEvent } = await import('../server/runs.js');
  const seen = [];
  const stop = onRunEvent((r, e) => { if (r.id.startsWith('rtestwatch')) seen.push(e ? e.t : null); });
  const runId = `rtestwatch${Date.now().toString(36)}`;
  await new Promise((done) => startRun({ runId, chatId: 'c1', onEnd: done }, async (emit) => { emit({ t: 'tool', name: 'browser' }); emit({ t: 'approval', id: 'a1', mode: 'strict' }); }));
  stop();
  assert.deepEqual(seen, ['run', 'tool', 'approval', null].filter((x) => x !== 'run'));
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

test('Browser tabs belong to a project: a chat never shows another project’s tabs, and the agent’s tab stays with its chat', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const cut = (from, to) => { const i = page.indexOf(from), j = page.indexOf(to, i); assert.ok(i >= 0 && j > i, from); return page.slice(i, j); };
  const src = cut('// Your tabs belong to a project', 'function renderBrowser(c)') + cut('function openInBrowser(c, url)', '\n}\n') + '\n}\n';
  const G = { open: new Map(), chats: [], view: { id: null }, bActive: null, agentTab: {} };
  let shown = null;
  const ui = new Function('G', 'location', 'focused', 'aimArea', 'syncLayout', 'renderPane', `${src}; return { browserTabs, activeBTab, newBTab, openInBrowser, findBTab, bTabProject };`)(
    G, { href: 'http://localhost:5199/' }, () => shown, () => {}, () => {}, () => {});
  const a1 = { id: 'a1', projectId: 'A' }, a2 = { id: 'a2', projectId: 'A' }, b1 = { id: 'b1', projectId: 'B' };
  const sids = (c) => ui.browserTabs(c).map((t) => t.url || t.sid);
  // Both projects start a dev server at once.
  shown = a1; ui.openInBrowser(a1, 'http://localhost:3001/');
  shown = b1; ui.openInBrowser(b1, 'http://localhost:3002/');
  assert.deepEqual(sids(a1), ['http://localhost:3001/']);
  assert.deepEqual(sids(b1), ['http://localhost:3002/']);
  // A new chat in A sees A's tabs; the tab in use in B never shows in A.
  assert.deepEqual(sids(a2), ['http://localhost:3001/']);
  assert.equal(ui.activeBTab(a2).url, 'http://localhost:3001/');
  // A restart reuses the project's tab for the same address, not the other project's.
  shown = a1; ui.openInBrowser(a1, 'http://localhost:3001/again');
  assert.deepEqual(sids(a1), ['http://localhost:3001/again']);
  assert.deepEqual(sids(b1), ['http://localhost:3002/']);
  // The same address in two projects is two tabs.
  shown = b1; ui.openInBrowser(b1, 'http://localhost:3001/');
  assert.equal(sids(b1).length, 2); assert.equal(sids(a1).length, 1);
  // The agent's own tab is per chat: only its chat shows it.
  G.agentTab.a1 = { url: 'https://example.com/' };
  assert.deepEqual(sids(a1), ['https://example.com/', 'http://localhost:3001/again']);
  assert.deepEqual(sids(a2), ['http://localhost:3001/again']);
  // Tabs are found (desktop events, closing) across projects, each in its own.
  const tb = ui.browserTabs(b1)[0];
  assert.equal(ui.findBTab(tb.sid), tb); assert.equal(ui.bTabProject(tb.sid), 'B');
  // Coming back to a project shows the tab last used there.
  G.bLastBy = { A: ui.browserTabs(a2)[0].sid }; G.bActive = tb.sid;
  assert.equal(ui.activeBTab(a2).url, 'http://localhost:3001/again');
});
