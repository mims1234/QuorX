// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The agent in Chrome: a tab the user lends, the QuorX extension and its pairing, chat apps.
// The agent loop runs with a scripted model (agent-harness.mjs): no network, no money. Each test gets a throwaway
// project in the temp folder, removed afterwards.
// test-home.mjs comes first: it points QuorX at a throwaway data folder before any server module reads it.
import './test-home.mjs';
import { reply, run, toolResults } from './agent-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { answerApproval } from '../server/agent.js';

test('a tab the user lends works only through target "given", asks before Send or a password, and stops when taken back', { skip: !(await import('../server/browser.js')).browserPath() && 'no Chromium browser installed' }, async () => {
  const http = await import('node:http');
  const { userBrowse, giveTab, takeBackTab } = await import('../server/userbrowser.js');
  const page = '<!doctype html><meta charset="utf-8"><title>Inbox</title><a href="#more" id="more">Read more</a><button id="send" aria-label="Send">➤</button><form><input id="pw" type="password"></form><textarea id="msg" aria-label="Message">hi hih</textarea>';
  const srv = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(page); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const sid = `usertab${Date.now().toString(36)}`, chatId = `chat-${Date.now().toString(36)}`;
  try {
    await userBrowse(sid, 'open', { url: `http://127.0.0.1:${srv.address().port}/`, w: 900, h: 600 });
    giveTab(chatId, sid, { url: 'http://127.0.0.1/', title: 'Inbox', desktop: false });
    const asked = [];
    const { bodies, events } = await run((body, i) => {
      if (i === 5) takeBackTab(chatId);
      return [
        reply('', [['browser', { action: 'open', target: 'given' }]]),
        reply('', [['browser', { action: 'click', selector: '#msg' }]]),
        reply('', [['browser', { action: 'click', selector: '#send' }]]),
        reply('', [['browser', { action: 'type', selector: '#pw', text: 'x' }]]),
        reply('', [['browser', { action: 'scroll', dy: 100 }]]),
        reply('', [['browser', { action: 'click', text: 'Read more' }]]),
        reply('Done.'),
      ][i];
    }, { chatId, onEvent: (e, runId) => { if (e.t === 'approval' && e.tool === 'browser') { asked.push(e.what); setTimeout(() => answerApproval(runId, e.id, { approve: /password/.test(e.what) }), 5); } } });
    assert.match(String(bodies[0].messages.at(-1).content), /given you one of their own browser tabs for this chat: "Inbox"/);
    const res = toolResults(bodies.at(-1)).map(String);
    assert.match(res[0], /You are in the user's own tab \("Inbox"\)/);
    assert.match(res[1], /clicked textbox "Message"/);
    assert.match(res[2], /The user said no to that \(click "➤ · Send"\)/);
    assert.match(res[3], /typed 1 characters/);
    assert.match(res[5], /took their tab back/);
    assert.deepEqual(asked.map((w) => w.replace(/^In your tab on \S+: /, '')), ['click "➤ · Send" · the box holds "hi hih"', 'type into a password field'], 'the card shows the words that would go out');
    // Each card is closed in the page once answered (it stayed open after Allow once before).
    const shown = events.filter((e) => e.t === 'approval' && e.tool === 'browser').map((e) => e.id);
    const closed = events.filter((e) => e.t === 'approval_done').map((e) => e.id);
    assert.deepEqual(shown.filter((id) => !closed.includes(id)), []);
    assert.deepEqual(events.filter((e) => e.t === 'approval_done' && shown.includes(e.id)).map((e) => e.approve), [false, true]);
  } finally { takeBackTab(chatId); await userBrowse(sid, 'close').catch(() => {}); srv.close(); (await import('../server/browser.js')).closeBrowser(); }
});

test('a Chrome tab given through the QuorX extension: only an extension with the key connects, and the agent works in that tab with the same asks', { skip: !(await import('../server/browser.js')).browserPath() && 'no Chromium browser installed' }, async () => {
  const http = await import('node:http');
  const { extUpgrade, extKey, onExtRequest, extReady } = await import('../server/extlink.js');
  const { giveTab, takeBackTab, takeBackSid, lentChromeTabs } = await import('../server/userbrowser.js');
  const { openTab, closeBrowser } = await import('../server/browser.js');
  const page = '<!doctype html><meta charset="utf-8"><title>Mail</title><button aria-label="Delete">🗑</button><a href="#x">Open message</a>';
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(page); });
  srv.on('upgrade', (q, s) => extUpgrade(q, s)); extKey(true); // a new key, not pinned to another test's extension ID yet
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port, ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
  // The "Chrome tab": a headless tab, driven only through the extension link.
  const real = await openTab({ own: true });
  await real.open(`http://127.0.0.1:${port}/`, { width: 900, height: 600 });
  const connect = (origin, key) => new Promise((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ext/socket`, { headers: { Origin: origin } });
    const got = [];
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', key, version: 'test' }));
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data); got.push(m.t);
      if (m.t === 'call') {
        if (m.args.tab !== 7) return ws.send(JSON.stringify({ t: 'reply', id: m.id, error: 'that tab was not given to QuorX' }));
        if (m.cmd !== 'tab.cdp') return ws.send(JSON.stringify({ t: 'reply', id: m.id, result: true }));
        try { ws.send(JSON.stringify({ t: 'reply', id: m.id, result: await real.cdp(m.args.method, m.args.params) })); } catch (e) { ws.send(JSON.stringify({ t: 'reply', id: m.id, error: e.message })); }
      }
    };
    ws.onclose = ws.onerror = () => ok({ ws, got, closed: true }); // a refused handshake is an error in Node's client
    setTimeout(() => ok({ ws, got, closed: false }), 1500);
  });
  const chatId = `chat-${Date.now().toString(36)}`;
  try {
    onExtRequest({});
    // A web page can't connect (wrong Origin), and an extension with the wrong key is turned away.
    const page1 = await connect('http://evil.example', extKey());
    assert.equal(page1.closed, true); assert.deepEqual(page1.got, []);
    const wrong = await connect(ORIGIN, 'f'.repeat(48));
    assert.deepEqual(wrong.got, ['denied']);
    const ext = await connect(ORIGIN, extKey());
    assert.equal(ext.got[0], 'welcome'); assert.equal(extReady(), true); // an older copy is also asked to reload
    giveTab(chatId, 'chrome-7', { url: 'http://127.0.0.1/', title: 'Mail', ext: 7 });
    assert.deepEqual(lentChromeTabs(), [{ chatId, tab: 7, title: 'Mail' }]);
    const asked = [];
    const { bodies } = await run((body, i) => [
      reply('', [['browser', { action: 'open', target: 'given' }]]),
      reply('', [['browser', { action: 'click', text: 'Open message' }]]),
      reply('', [['browser', { action: 'click', selector: 'button' }]]),
      reply('Done.'),
    ][i], { chatId, onEvent: (e, runId) => { if (e.t === 'approval' && e.tool === 'browser') { asked.push(e.what); setTimeout(() => answerApproval(runId, e.id, { approve: false }), 5); } } });
    const res = toolResults(bodies.at(-1)).map(String);
    assert.match(res[0], /You are in the user's own tab \("Mail"\)[\s\S]*Title: Mail/);
    assert.match(res[1], /clicked link "Open message"/);
    assert.match(res[2], /The user said no to that \(click "🗑 · Delete"\)/);
    assert.equal(asked.length, 1);
    assert.equal(takeBackSid('chrome-7'), true);
    assert.deepEqual(lentChromeTabs(), []);
    ext.ws.close();
  } finally { takeBackTab(chatId); await real.close().catch(() => {}); srv.close(); closeBrowser(); }
});

test('🧩 Chrome on in a chat: the agent opens its own tab in the user’s Chrome through the extension; off, it is told to ask', { skip: !(await import('../server/browser.js')).browserPath() && 'no Chromium browser installed' }, async () => {
  const http = await import('node:http');
  const { extUpgrade, extKey } = await import('../server/extlink.js');
  const { takeBackTab, givenTab } = await import('../server/userbrowser.js');
  const { openTab, closeBrowser } = await import('../server/browser.js');
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<!doctype html><meta charset="utf-8"><title>Inbox</title><a href="#m">Open message</a>'); });
  srv.on('upgrade', (q, s) => extUpgrade(q, s)); extKey(true);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port, real = await openTab({ own: true });
  const opened = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ext/socket`, { headers: { Origin: `chrome-extension://${'b'.repeat(32)}` } });
  await new Promise((ok) => { ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') ok();
    if (m.t !== 'call') return;
    const reply = (o) => ws.send(JSON.stringify({ t: 'reply', id: m.id, ...o }));
    if (m.cmd === 'tab.open') { opened.push(m.args); await real.open(m.args.url, { width: 900, height: 600 }); return reply({ result: { id: 9, title: 'Inbox' } }); }
    if (m.cmd === 'tab.cdp') { try { return reply({ result: await real.cdp(m.args.method, m.args.params) }); } catch (e) { return reply({ error: e.message }); } }
    reply({ result: true });
  }; ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', key: extKey(), version: '0.2.11' })); });
  const chatId = `chat-${Date.now().toString(36)}`;
  try {
    // Off, with the extension connected: one card to turn it on (buttons only); kept off, the call is refused.
    const cards = [];
    const off = await run((body, i) => [reply('', [['browser', { action: 'open', target: `chrome:127.0.0.1:${port}/` }]]), reply('Done.')][i], { chatId,
      onEvent: (e, id) => { if (e.t === 'approval' && e.tool === 'chrome') { cards.push(e); setTimeout(() => answerApproval(id, e.id, { approve: false }), 10); } } });
    assert.equal(cards.length, 1); assert.equal(cards[0].buttonsOnly, true);
    assert.match(String(toolResults(off.bodies.at(-1))[0]), /Chrome is off in this chat and the user kept it off/);
    assert.equal(opened.length, 0, 'nothing opened in their Chrome');
    const on = await run((body, i) => [
      reply('', [['browser', { action: 'open', target: `chrome:http://127.0.0.1:${port}/` }]]),
      reply('', [['browser', { action: 'click', text: 'Open message' }]]),
      reply('Done.'),
    ][i], { chatId, settings: { chromeAccess: true, chromeCloseTabs: true } });
    assert.match(String(on.bodies[0].messages.at(-1).content), /use their own Chrome in this chat/);
    const res = toolResults(on.bodies.at(-1)).map(String);
    assert.equal(opened.length, 1); assert.equal(opened[0].chatId, chatId); assert.equal(opened[0].url, `http://127.0.0.1:${port}/`);
    assert.match(res[1], /clicked link "Open message"/);
    assert.equal(givenTab(chatId), null); // closing ticked: the reply ended, the tab it opened was let go and closed
  } finally { takeBackTab(chatId); ws.close(); await real.close().catch(() => {}); srv.close(); closeBrowser(); }
});

// A chat app's quirks in one page: a server list first, messages in a list that scrolls by itself (the window never
// does), older messages loaded on scrolling up, and the messages also fetched as JSON with a token in it.
const CHAT_PAGE = `<!doctype html><meta charset="utf-8"><title>bat-cave</title><style>html,body{height:100%;margin:0;overflow:hidden}nav{position:fixed;left:0;top:0;width:180px;height:100%}#list{position:absolute;left:180px;right:0;top:0;bottom:40px;overflow-y:auto;margin:0}#list li{height:56px}</style>
<nav aria-label="Servers"><div role="treeitem" aria-label="Meow">M</div><div role="treeitem" aria-label="Gen X Game, Coding family, Meow">folder</div>${'<div>channel name here</div>'.repeat(40)}</nav>
<ol id="list" role="list" aria-label="Messages in bat-cave"></ol><input aria-label="Message #bat-cave" style="position:fixed;bottom:0;left:180px"><input type="search" aria-label="Search" style="position:fixed;top:0;right:0">
<button id="send" style="position:fixed;bottom:60px;right:10px">Send</button><div role="dialog" aria-modal="true" aria-label="Quick switcher" style="position:fixed;right:0;bottom:40px;width:120px;height:80px;background:#ccc">switch</div>
<script>let n = 0; const list = document.getElementById('list');
const add = (top) => { const els = []; for (let i = 0; i < 20 && n < 100; i++) { n++; const li = document.createElement('li'); li.setAttribute('data-list-item-id', 'm' + n); li.textContent = 'Batman at 9:' + String(n).padStart(2, '0') + ' PM: message number ' + n + ' in the cave'; els.push(li); } if (top) list.prepend(...els.reverse()); else list.append(...els); };
add(); list.scrollTop = list.scrollHeight;
list.addEventListener('scroll', () => { if (list.scrollTop < 60 && n < 100) { const h = list.scrollHeight; add(true); list.scrollTop = list.scrollHeight - h; } });
fetch('/api/messages?limit=50').then((r) => r.json());</script>`;

test('browser on a chat app: the inner list scrolls, collect gathers a channel into a file, data requests are listed and read without secrets, and a failed click is not repeated', { skip: !(await import('../server/browser.js')).browserPath() && 'no Chromium browser installed' }, async () => {
  const http = await import('node:http');
  const { openTab, closeBrowser } = await import('../server/browser.js');
  const srv = http.createServer((q, r) => {
    if (q.url.startsWith('/api/')) { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ messages: [{ author: 'Batman', text: 'hello' }], access_token: 'secret-should-hide', session: { id: 'zz' } })); }
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(CHAT_PAGE);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${srv.address().port}/chat`;
  const tab = await openTab({ own: true });
  let dir = null;
  try {
    const { bodies } = await run((body, i) => [
      reply('', [['browser', { action: 'open', target: url }]]),
      reply('', [['browser', { action: 'scroll', screens: -1 }]]),
      reply('', [['browser', { action: 'find', query: 'Meow' }]]),
      reply('', [['browser', { action: 'collect', direction: 'up', count: 60 }]]),
      reply('', [['browser', { action: 'network' }]]),
      reply('', [['browser', { action: 'network', op: 'read', id: 'n1' }]]),
      reply('', [['browser', { action: 'click', text: 'Send' }]]),
      reply('', [['browser', { action: 'click', text: 'Send' }]]),
      reply('Done.'),
    ][i], { settings: { tools: { browser: { on: true } }, review: 'off', verify: false, checks: { on: false } }, openTab: async () => tab, prep: (d) => { dir = d; } });
    const res = toolResults(bodies.at(-1)).map(String);
    assert.match(res[0], /Page ready after/);
    assert.match(res[0], /Snapshot s\d+ \(/);
    assert.match(res[0], /listitem "Batman at 9:/); // the messages, not only the server list
    assert.match(res[1], /scrolled list "Messages in bat-cave" by -\d+px \(the page itself doesn't scroll here\)/);
    assert.match(res[2], /s\d+:e\d+ treeitem "Meow" · on screen/); // the exact name before the folder that contains it
    assert.ok(res[2].indexOf('treeitem "Meow"') < res[2].indexOf('Gen X Game'));
    assert.match(res[3], /Collected 60 items/);
    const file = /saved in (\.quorx\/collected\/\S+\.json)/.exec(res[3])?.[1];
    assert.ok(file, res[3]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(saved.items.length, 60);
    assert.equal(new Set(saved.items.map((x) => x.key)).size, 60);
    assert.match(res[4], /n1 GET 200 json .*\/api\/messages/);
    assert.match(res[5], /"text":"hello"/);
    assert.doesNotMatch(res[5], /secret-should-hide/);
    assert.match(res[5], /"access_token"(:"\[removed\]"|\[secret removed\])/); // removed here, and the harness's own scrubber agrees
    assert.match(res[6], /^Error: can't click button "Send": it is covered by dialog "Quick switcher"/);
    assert.match(res[6], /Snapshot s\d+/); // a failure still shows the page as it is now
    assert.match(res[7], /^You already tried exactly this \(click "Send"\) and it failed/);
  } finally { await tab.close().catch(() => {}); srv.close(); closeBrowser(); }
});

test('🧩 in the user’s tab: typing the request never asked for, or outside a search box, goes to the user; a site the request didn’t name asks', { skip: !(await import('../server/browser.js')).browserPath() && 'no Chromium browser installed' }, async () => {
  { // 🧩 in the user’s tab: a reading request asks before typing outside a search box, and a site the request didn’t name asks before it opens
    const http = await import('node:http');
    const { userBrowse, giveTab, takeBackTab } = await import('../server/userbrowser.js');
    const srv = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(CHAT_PAGE); });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const sid = `usertab${Date.now().toString(36)}r`, chatId = `chat-${Date.now().toString(36)}r`;
    try {
      await userBrowse(sid, 'open', { url: `http://127.0.0.1:${srv.address().port}/chat`, w: 900, h: 600 });
      giveTab(chatId, sid, { url: 'http://127.0.0.1/', title: 'bat-cave', desktop: false });
      const asked = [];
      const { bodies } = await run((body, i) => [
        reply('', [['browser', { action: 'open', target: 'given' }]]),
        reply('', [['browser', { action: 'type', text: 'cats', selector: 'input[type=search]' }]]),
        reply('', [['browser', { action: 'type', text: 'hi all', selector: 'input[aria-label="Message #bat-cave"]' }]]),
        reply('', [['browser', { action: 'open', target: 'https://example.com/' }]]),
        reply('Done.'),
      ][i], { chatId, text: 'check the bat-cave channel and summarise the last messages', settings: { chromeAccess: true }, onEvent: (e, runId) => { if (e.t === 'approval' && e.tool === 'browser') { asked.push(e.what); setTimeout(() => answerApproval(runId, e.id, { approve: false }), 5); } } });
      assert.match(String(bodies[0].messages.at(-1).content), /this request only reads, so typing outside a search box asks them too/);
      const res = toolResults(bodies.at(-1)).map(String);
      assert.match(res[1], /typed 4 characters/); // a search box doesn't ask
      assert.match(res[2], /The user said no to that \(type "hi all" into textbox "Message #bat-cave"\)/);
      assert.match(res[3], /The user said no to opening example\.com in their Chrome/);
      assert.deepEqual(asked.map((w) => w.replace(/^In your tab on \S+: /, '')), ['type "hi all" into textbox "Message #bat-cave"', 'Open example.com in your Chrome, signed in as you']);
      // ⚡ YOLO with "act in your tabs without asking": the same typing runs with no card, only a note.
      asked.length = 0; const notes = [];
      const yolo = await run((body, i) => [
        reply('', [['browser', { action: 'open', target: 'given' }]]),
        reply('', [['browser', { action: 'type', text: 'hi all', selector: 'input[aria-label="Message #bat-cave"]' }]]),
        reply('Done.'),
      ][i], { chatId, text: 'check the bat-cave channel and summarise the last messages', settings: { chromeAccess: true, approval: 'yolo', chromeYoloActs: true }, onEvent: (e, runId) => { if (e.t === 'note') notes.push(e.msg); if (e.t === 'approval' && e.tool === 'browser') { asked.push(e.what); setTimeout(() => answerApproval(runId, e.id, { approve: false }), 5); } } });
      assert.deepEqual(asked, []);
      assert.match(String(toolResults(yolo.bodies.at(-1))[1]), /typed 6 characters/);
      assert.ok(notes.some((m) => /YOLO: ran without asking .*type "hi all"/.test(m)), notes.join('\n'));
    } finally { takeBackTab(chatId); await userBrowse(sid, 'close').catch(() => {}); srv.close(); (await import('../server/browser.js')).closeBrowser(); }
  }
  { // 🧩 in the user’s tab: the deciders bring typing the request never asked for to the user, and a handoff gives the tab back until the user is done
    const http = await import('node:http');
    const { userBrowse, giveTab, takeBackTab } = await import('../server/userbrowser.js');
    const srv = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(CHAT_PAGE); });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const sid = `usertab${Date.now().toString(36)}d`, chatId = `chat-${Date.now().toString(36)}d`;
    const judged = [];
    // The deciders see only the request and the step: "buy" here was never asked for.
    const ensemble = async ({ voters, questions, state }) => { judged.push(String(state)); const yes = /buy crypto/.test(String(state)) ? 0.1 : 0.9; return { results: Object.fromEntries(questions.map((q) => [q.id, { pick: yes > 0.5 ? 'yes' : 'no', dist: { yes, no: 1 - yes }, confidence: 0.9, agree: voters.length, n: voters.length, verdict: 'settled' }])), votes: [], ms: 2 }; };
    try {
      await userBrowse(sid, 'open', { url: `http://127.0.0.1:${srv.address().port}/chat`, w: 900, h: 600 });
      giveTab(chatId, sid, { url: 'http://127.0.0.1/', title: 'bat-cave', desktop: false });
      const cards = [];
      const { bodies } = await run((body, i) => [
        reply('', [['browser', { action: 'open', target: 'given' }]]),
        reply('', [['browser', { action: 'type', text: 'buy crypto now', selector: 'input[aria-label="Message #bat-cave"]' }]]),
        reply('', [['browser', { action: 'type', text: 'see you at 9', selector: 'input[aria-label="Message #bat-cave"]' }]]),
        reply('', [['browser', { action: 'handoff', reason: 'sign in to the server' }]]),
        reply('Done.'),
      ][i], { chatId, text: 'reply "see you at 9" in the bat-cave channel', ensemble, settings: { checks: { on: false } }, onEvent: (e, runId) => { if (e.t === 'approval' && e.tool === 'browser') { cards.push(e); setTimeout(() => answerApproval(runId, e.id, { approve: !/buy crypto/.test(e.what) }), 5); } } });
      const res = toolResults(bodies.at(-1)).map(String);
      // A decider no asks the user (who says no here); it never refuses on its own.
      const doubt = cards.find((c) => /buy crypto/.test(c.what));
      assert.match(doubt.why, /The deciders put it at 10% that this serves your request/);
      assert.match(res[1], /The user said no to that \(type "buy crypto now"/);
      assert.match(res[2], /typed 12 characters/);
      assert.ok(!cards.some((c) => /see you at 9/.test(c.what)), 'a step the deciders pass asks nobody');
      assert.ok(!judged.some((s) => /Its next step: type "see you at 9"/.test(s)), 'text the request names word for word is not even checked');
      assert.ok(judged.some((s) => /Its next step: type "buy crypto now"/.test(s)), 'other text still is');
      assert.ok(judged.every((s) => !/Batman at 9:/.test(s)), 'the deciders never see the page');
      assert.match(res[3], /The user finished: "sign in to the server"\. You can use the tab again/);
      const hand = cards.find((c) => /Your turn/.test(c.what));
      assert.equal(hand.what, 'Your turn in your tab on 127.0.0.1: sign in to the server');
      assert.equal(hand.yes, 'I’m done'); assert.equal(hand.no, 'Stop');
    } finally { takeBackTab(chatId); await userBrowse(sid, 'close').catch(() => {}); srv.close(); (await import('../server/browser.js')).closeBrowser(); }
  }
});


test('🧩 Chrome read through page scripts: opening, reading and collecting never attach the debugger; a click does; a never-open site is refused; tabs lists the chat’s group', { skip: !(await import('../server/browser.js')).browserPath() && 'no Chromium browser installed' }, async () => {
  const http = await import('node:http');
  const { extUpgrade, extKey } = await import('../server/extlink.js');
  const { takeBackTab } = await import('../server/userbrowser.js');
  const { openTab, closeBrowser } = await import('../server/browser.js');
  const { pageOp } = await import('../server/pageops.js');
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(CHAT_PAGE); });
  srv.on('upgrade', (q, s) => extUpgrade(q, s)); extKey(true);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port, real = await openTab({ own: true });
  const cdp = [], calls = [];
  // A stand-in for the extension that may read pages: page operations run in a real tab, the debugger is counted.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ext/socket`, { headers: { Origin: `chrome-extension://${'d'.repeat(32)}` } });
  await new Promise((ok) => { ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') ok();
    if (m.t !== 'call') return;
    const reply = (o) => ws.send(JSON.stringify({ t: 'reply', id: m.id, ...o }));
    calls.push(m.cmd);
    try {
      if (m.cmd === 'tab.open') { await real.open(m.args.url, { width: 900, height: 600 }); return reply({ result: { id: 11, title: 'bat-cave' } }); }
      if (m.cmd === 'tab.op') return reply({ result: await real.eval(pageOp(m.args.name, m.args.args)) });
      if (m.cmd === 'tab.where') return reply({ result: await real.eval('({ href: location.href, readyState: document.readyState, title: document.title })') });
      if (m.cmd === 'tab.shot') return reply({ result: { image: await real.screenshot() } });
      if (m.cmd === 'tab.go') { await real.open(m.args.url, { width: 900, height: 600 }); return reply({ result: { href: m.args.url } }); }
      if (m.cmd === 'tab.list') return reply({ result: [{ id: 11, title: 'bat-cave', url: `http://127.0.0.1:${port}/chat`, active: true, lent: true }, { id: 12, title: 'Docs', url: 'https://docs.example/', active: false, lent: false }] });
      if (m.cmd === 'tab.adopt') return reply({ result: { id: m.args.tab, title: 'bat-cave', url: `http://127.0.0.1:${port}/chat` } });
      if (m.cmd === 'tab.cdp') { cdp.push(m.args.method); return reply({ result: await real.cdp(m.args.method, m.args.params) }); }
      return reply({ result: true });
    } catch (e) { return reply({ error: e.message }); }
  }; ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', key: extKey(), version: '0.3.0', caps: { script: true } })); });
  const chatId = `chat-${Date.now().toString(36)}l`;
  try {
    const { bodies } = await run((body, i) => [
      reply('', [['browser', { action: 'open', target: `chrome:http://127.0.0.1:${port}/chat` }]]),
      reply('', [['browser', { action: 'find', query: 'Meow' }]]),
      reply('', [['browser', { action: 'collect', direction: 'up', count: 30 }]]),
      reply('', [['browser', { action: 'tabs' }]]),
      reply('', [['browser', { action: 'click', text: 'Meow' }]]),
      reply('', [['browser', { action: 'open', target: 'chrome:https://mybank.example/' }]]),
      reply('Done.'),
    ][i], { chatId, text: 'summarise the bat-cave channel', settings: { chromeAccess: true, chromeCloseTabs: true, chromeSitesNever: 'mybank.example, health.example' } });
    const res = toolResults(bodies.at(-1)).map(String);
    assert.match(res[0], /You are in the user's own tab/);
    assert.match(res[0], /Snapshot s\d+/);
    assert.match(res[1], /treeitem "Meow" · on screen/);
    assert.match(res[2], /Collected 30 items/);
    assert.match(res[3], /1\. \(in use\) bat-cave · http:\/\/127\.0\.0\.1:\d+\/chat\n2\. Docs · https:\/\/docs\.example\//);
    assert.match(res[4], /clicked treeitem "Meow"/);
    assert.match(res[5], /doesn't let the agent open mybank\.example/);
    // Reading went through page scripts: the debugger only came for the click (and the page set-up just before it).
    const firstInput = cdp.indexOf('Input.dispatchMouseEvent');
    assert.ok(firstInput >= 0, cdp.join(','));
    assert.deepEqual(cdp.slice(0, firstInput).filter((x) => !/^(Page|Runtime|Log|Network|Emulation)\.(enable|setFocusEmulationEnabled)$/.test(x)), []);
    assert.ok(calls.includes('tab.op') && calls.includes('tab.shot'));
    assert.equal(calls.at(-1), 'tab.closeOwn'); // closing ticked: the reply ended, the tabs it opened close
    // Closing off (the default): the next reply carries on in the chat's open tab, not a new one, and leaves it open.
    calls.length = 0;
    const next = await run((body, i) => [reply('', [['browser', { action: 'open', target: `chrome:http://127.0.0.1:${port}/chat` }]]), reply('Done.')][i], { chatId, text: 'check the bat-cave channel again', settings: { chromeAccess: true } });
    assert.match(String(toolResults(next.bodies.at(-1))[0]), /bat-cave/);
    assert.ok(calls.includes('tab.list') && calls.includes('tab.adopt'), calls.join(','));
    assert.ok(!calls.includes('tab.open'), calls.join(','));
    assert.ok(!calls.includes('tab.closeOwn'), calls.join(','));
  } finally { takeBackTab(chatId); ws.close(); await real.close().catch(() => {}); srv.close(); closeBrowser(); }
});

test('the extension connects with one click after Allow in QuorX, shows a code to match, and its key stays with that extension', async () => {
  { // the extension connects with one click: it waits until Allow in QuorX, Deny closes it, and an older copy is asked to reload
    const http = await import('node:http');
    const { extUpgrade, extKey, extPairing, extPair, extReady } = await import('../server/extlink.js');
    const srv = http.createServer(); srv.on('upgrade', (q, s) => extUpgrade(q, s));
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const open = (version) => new Promise((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/api/ext/socket`, { headers: { Origin: `chrome-extension://${'c'.repeat(32)}` } });
      const got = []; ws.onmessage = (ev) => got.push(JSON.parse(ev.data));
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', pair: true, browser: 'Brave', version })); ok({ ws, got }); };
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const a = await open('0.2.11'); await wait(150);
      assert.deepEqual(a.got.map((m) => m.t), ['pairing']);
      assert.equal(extPairing()?.browser, 'Brave');
      assert.equal(extPair(false), true); await wait(150);
      assert.equal(a.got.at(-1).t, 'denied'); assert.equal(extPairing(), null);
      const b = await open('0.2.11'); await wait(150);
      extPair(true); await wait(150);
      assert.deepEqual(b.got.map((m) => m.t), ['pairing', 'paired', 'welcome', 'reload']);
      assert.equal(b.got[1].key, extKey()); assert.equal(extReady(), true);
      b.ws.close();
    } finally { srv.close(); }
  }
  { // extension pairing shows which extension asks and a code to match; the key stays with that extension; one request at a time; little is read before hello
    const http = await import('node:http');
    const { extUpgrade, extKey, extPairing, extPair } = await import('../server/extlink.js');
    const { HOME } = await import('../server/openrouter.js');
    const PIN = path.join(HOME, 'data', 'extension-origin');
    const srv = http.createServer(); srv.on('upgrade', (q, s) => extUpgrade(q, s));
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const id = (c) => c.repeat(32), origin = (c) => `chrome-extension://${id(c)}`;
    const open = (c, first) => new Promise((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.address().port}/api/ext/socket`, { headers: { Origin: origin(c) } });
      const x = { ws, got: [], closed: false }; ws.onmessage = (ev) => x.got.push(JSON.parse(ev.data));
      ws.onclose = ws.onerror = () => { x.closed = true; };
      ws.onopen = () => { ws.send(typeof first === 'string' ? first : JSON.stringify(first)); ok(x); };
    });
    // The extension in the repo's folder: an older version is asked to reload.
    const version = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).version;
    const pair = (c) => open(c, { t: 'hello', pair: true, browser: 'Chrome', version });
    const withKey = (c, key = extKey()) => open(c, { t: 'hello', key, version });
    try {
      extKey(true);
      // The prompt names the extension's ID and a code, and the extension gets the same code to show in its popup.
      const a = await pair('h'); await wait(150);
      assert.equal(a.got[0].t, 'pairing'); assert.match(a.got[0].code, /^[A-HJ-NP-Z2-9]{6}$/);
      assert.deepEqual({ id: extPairing().id, code: extPairing().code }, { id: id('h'), code: a.got[0].code });
      // Another extension asking meanwhile is refused and told why; the first request still waits.
      const b = await pair('i'); await wait(150);
      assert.equal(b.got.at(-1).t, 'denied'); assert.match(b.got.at(-1).why, /another extension is already waiting/); assert.equal(b.closed, true);
      assert.equal(extPairing()?.id, id('h'));
      // Allow: the key is pinned to that extension, and the same key from another ID is turned away.
      extPair(true); await wait(150);
      assert.deepEqual(a.got.map((m) => m.t), ['pairing', 'paired', 'welcome']);
      assert.equal(fs.readFileSync(PIN, 'utf8'), origin('h'));
      const thief = await withKey('j'); await wait(150);
      assert.deepEqual(thief.got.map((m) => m.t), ['denied']); assert.match(thief.got[0].why, /belongs to another extension/); assert.equal(thief.closed, true);
      // A connected extension may send more than the before-hello limit.
      a.ws.send(JSON.stringify({ t: 'ping', pad: 'x'.repeat(100000) })); await wait(150);
      assert.equal(a.got.at(-1).t, 'pong');
      a.ws.close(); await wait(100);
      // A key from before pinning (no ID stored) still connects, and its ID is pinned then.
      fs.rmSync(PIN, { force: true });
      const old = await withKey('k'); await wait(150);
      assert.deepEqual(old.got.map((m) => m.t), ['welcome']);
      assert.equal(fs.readFileSync(PIN, 'utf8'), origin('k'));
      old.ws.close(); await wait(100);
      assert.deepEqual((await withKey('h').then(async (x) => { await wait(150); x.ws.close(); return x; })).got.map((m) => m.t), ['denied']);
      // A pairing request whose extension went away no longer blocks another one.
      const gone = await pair('l'); await wait(150); gone.ws.close(); await wait(150);
      assert.equal(extPairing(), null);
      // More than 64 KB before hello: the socket is closed (it used to wait for the 10 s hello timer).
      const big = await open('m', 'x'.repeat(70000)); await wait(400);
      assert.equal(big.closed, true); assert.deepEqual(big.got, []);
    } finally { extPair(false); srv.close(); }
  }
});

