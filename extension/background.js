// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// QuorX in your everyday Chrome. It keeps one WebSocket to the QuorX on this computer and does only this:
// a tab you give to a chat (from the popup, a right-click, or by dragging it into a chat's tab group) can be used by
// that chat's agent, and only while the agent works. Chrome shows its own "started debugging" bar while the debugger
// is attached; once you let the extension read pages (the popup), reading goes through page scripts and the bar shows
// only while the agent clicks, types or reads network data. Cancel on the bar takes the tab back.
// It never touches a tab you didn't give, and forgets a tab when you take it back or close it.
const VERSION = chrome.runtime.getManifest().version;
const FORWARD = new Set(['Page.loadEventFired', 'Page.frameNavigated', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);
// A page's data requests (XHR, fetch) go to QuorX with only their id, method, address, status, type and size:
// never headers, cookies or bodies (a body is read only when the agent asks for one request).
const DATA_REQ = new Set(['XHR', 'Fetch', 'EventSource']);
function slimNet(method, p) {
  if (method === 'Network.requestWillBeSent') return DATA_REQ.has(p.type) ? { requestId: p.requestId, type: p.type, method: p.request && p.request.method, url: String((p.request && p.request.url) || '').slice(0, 2000) } : null;
  if (method === 'Network.responseReceived') return DATA_REQ.has(p.type) ? { requestId: p.requestId, type: p.type, status: p.response && p.response.status, mimeType: p.response && p.response.mimeType } : null;
  if (method === 'Network.loadingFinished') return { requestId: p.requestId, encodedDataLength: p.encodedDataLength };
  if (method === 'Network.loadingFailed') return { requestId: p.requestId, errorText: p.errorText };
  return undefined;
}
// What passes on: the page events as they are, network events slimmed (or dropped: a picture, a script).
const passOn = (method, params) => (FORWARD.has(method) ? params : method.startsWith('Network.') ? slimNet(method, params) : undefined);
const WIN_SIZE = { width: 1400, height: 900 }; // the QuorX window the agent's tabs open in
const IDLE_DETACH_MS = 20000; // reading through page scripts: the debugger lets go this long after its last command
const ALL_SITES = { origins: ['<all_urls>'] };
let ws = null, state = 'off', lastError = '', pingTimer = null, seq = 0;
let pairCode = ''; // while waiting for Allow: the code QuorX shows too, so you can tell this request is yours
const waiting = new Map(); // request id → resolve/reject
const attached = new Set(); // tab ids the debugger is attached to right now
const idle = new Map(); // tab id → timer that detaches the debugger
const netOn = new Set(); // tabs whose network log the agent turned on: the debugger stays until the tab is released

const settings = async () => ({ address: 'http://127.0.0.1:5188', key: '', ...(await chrome.storage.local.get(['address', 'key'])) });
const lentTabs = async () => (await chrome.storage.session.get('lent')).lent || {}; // tab id → { chatId, own }
const setLent = (lent) => chrome.storage.session.set({ lent });
const groups = async () => (await chrome.storage.session.get('groups')).groups || {}; // chat id → tab group id
const status = async () => (await chrome.storage.session.get('status')).status || {}; // chat id → { state, what, at }
const opened = async () => (await chrome.storage.session.get('opened')).opened || {}; // tab id → chat id, for tabs the agent opened
// Reading through page scripts needs access to the sites; you grant it once in the popup.
const canScript = () => chrome.permissions.contains(ALL_SITES).catch(() => false);
const caps = async () => ({ script: await canScript() });

// Which browser this is, for QuorX's "… wants to connect" notice.
const browserName = () => (navigator.brave ? 'Brave' : (navigator.userAgentData?.brands || []).map((b) => b.brand).find((b) => !/chromium|not.?a.?brand/i.test(b))?.replace('Google ', '').replace('Microsoft ', '') || 'Chrome');
// pair: connect without a key, and QuorX asks you to Allow it (the key comes back from QuorX).
async function connect(pair = false) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { address, key } = await settings();
  if (!key && !pair) { state = 'unpaired'; return; }
  let u; try { u = new URL('/api/ext/socket', address); } catch { state = 'error'; lastError = 'That QuorX address is not valid.'; return; }
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  state = 'connecting';
  const sock = new WebSocket(u.href);
  ws = sock;
  sock.onopen = async () => sock.send(JSON.stringify(key ? { t: 'hello', key, version: VERSION, caps: await caps() } : { t: 'hello', pair: true, browser: browserName(), version: VERSION }));
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null; clearInterval(pingTimer);
    if (state !== 'denied') { state = 'off'; lastError = lastError || 'QuorX is not running (or not at that address).'; }
    for (const [, w] of waiting) w.no(new Error('disconnected'));
    waiting.clear();
    for (const tab of attached) chrome.debugger.detach({ tabId: tab }).catch(() => {});
    attached.clear(); netOn.clear();
    setLent({}); chrome.storage.session.set({ status: {} }); badgeAll();
  };
}
const send = (o) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
function req(what, args = {}) {
  if (state !== 'on') return Promise.reject(new Error('not connected to QuorX'));
  const id = `r${++seq}`;
  return new Promise((ok, no) => { waiting.set(id, { ok, no }); send({ t: 'req', id, what, args }); setTimeout(() => { if (waiting.delete(id)) no(new Error('QuorX did not answer')); }, 15000); });
}
async function onMessage(sock, data) {
  let m; try { m = JSON.parse(data); } catch { return; }
  if (m.t === 'welcome') {
    state = 'on'; lastError = '';
    // An active WebSocket keeps this worker awake (Chrome 116+); a message every 20 s keeps it active.
    clearInterval(pingTimer); pingTimer = setInterval(() => send({ t: 'ping' }), 20000);
    const lent = {};
    for (const x of await req('lent').catch(() => [])) lent[x.tab] = { chatId: x.chatId };
    await setLent(lent); badgeAll();
    send({ t: 'caps', caps: await caps() });
    refreshMenus();
    return;
  }
  if (m.t === 'denied') { state = 'denied'; pairCode = ''; lastError = m.why || 'QuorX refused the key.'; return; }
  if (m.t === 'pairing') { state = 'pairing'; pairCode = String(m.code || '').slice(0, 8); lastError = ''; return; }
  if (m.t === 'paired') { await chrome.storage.local.set({ key: String(m.key || '') }); return; }
  // QuorX is newer than this extension: reload from its folder (a loaded-unpacked extension reads its files again).
  if (m.t === 'reload') { setTimeout(() => chrome.runtime.reload(), 300); return; }
  if (m.t === 'res') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.no(new Error(m.error)) : w.ok(m.result); } return; }
  if (m.t === 'push') { onPush(m); return; }
  if (m.t === 'call') {
    try { send({ t: 'reply', id: m.id, result: await call(m.cmd, m.args || {}) }); }
    catch (e) { send({ t: 'reply', id: m.id, error: String(e?.message || e) }); }
  }
}

// ---------- what QuorX may ask, and only for a tab you gave ----------
async function call(cmd, { tab, method, params, locked, url, chatId, chatTitle, name, args }) {
  const lent = await lentTabs();
  // A chat with 🧩 Chrome on opens its own tab, in one QuorX window, unless you turned that off in this popup.
  if (cmd === 'tab.open') {
    if ((await chrome.storage.local.get('allowOpen')).allowOpen === false) throw new Error('opening tabs is turned off in the QuorX extension (its popup)');
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('only web pages (http or https) can be opened');
    const { win } = await chrome.storage.session.get('win');
    let t;
    try { t = win ? await chrome.tabs.create({ windowId: win, url, active: true }) : null; } catch { t = null; }
    // The agent sees one screen at a time, so its window is roomy (1400×900; Chrome fits it to a smaller screen),
    // not maximised: on a big monitor that makes screenshots huge and their text tiny for the vision models.
    if (!t) { const w = await chrome.windows.create({ url, focused: false, state: 'normal', ...WIN_SIZE }); await chrome.storage.session.set({ win: w.id }); t = w.tabs[0]; }
    else {
      // A window that was made smaller (or minimised) since is put back to that size; a bigger one you chose stays.
      const w = await chrome.windows.get(t.windowId).catch(() => null);
      if (w && (w.state === 'minimized' || w.width < WIN_SIZE.width - 120 || w.height < WIN_SIZE.height - 120)) await chrome.windows.update(w.id, { state: 'normal', ...WIN_SIZE }).catch(() => {});
    }
    await intoGroup(t.id, chatId, chatTitle);
    const o = await opened(); o[t.id] = chatId; await chrome.storage.session.set({ opened: o });
    lent[t.id] = { chatId, own: true }; await setLent(lent); badge(t.id);
    return { id: t.id, title: t.title || '' };
  }
  // The chat's tabs in its group (the agent can switch between them), and taking one of them back into use.
  if (cmd === 'tab.list') {
    const gid = (await groups())[chatId];
    if (gid == null) return [];
    return (await chrome.tabs.query({ groupId: gid }).catch(() => [])).map((x) => ({ id: x.id, title: x.title || '', url: x.url || '', active: !!x.active, lent: !!lent[x.id] }));
  }
  // The reply ended: close the tabs its agent opened (only those; a tab you gave or dragged in stays open).
  if (cmd === 'tab.closeOwn') {
    const o = await opened(), mine = Object.keys(o).filter((id) => o[id] === chatId).map(Number);
    for (const id of mine) { netOn.delete(id); await detach(id); delete lent[id]; delete o[id]; }
    await setLent(lent); await chrome.storage.session.set({ opened: o });
    await chrome.tabs.remove(mine).catch(() => {});
    const g = await groups(); delete g[chatId]; await chrome.storage.session.set({ groups: g });
    return { closed: mine.length };
  }
  if (cmd === 'tab.adopt') {
    const gid = (await groups())[chatId];
    const x = await chrome.tabs.get(tab).catch(() => null);
    if (!x || gid == null || x.groupId !== gid) throw new Error("that tab isn't in this chat's tab group");
    await chrome.tabs.update(tab, { active: true }).catch(() => {});
    lent[tab] = { chatId, own: true }; await setLent(lent); badge(tab);
    return { id: tab, title: x.title || '', url: x.url || '' };
  }
  if (!lent[tab]) throw new Error('that tab was not given to QuorX');
  if (cmd === 'tab.cdp') {
    await attach(tab);
    if (method === 'Network.enable') netOn.add(tab);
    const r = await chrome.debugger.sendCommand({ tabId: tab }, method, params || {});
    idleDetach(tab);
    return r;
  }
  // Reading through page scripts (no debugger): the page operations QuorX also runs over the debugger.
  if (cmd === 'tab.op') return pageOp(tab, name, args);
  // Going to an address with Chrome's own navigation (no debugger), until the page has loaded (15 s at most).
  if (cmd === 'tab.go') {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('only web pages (http or https) can be opened');
    await new Promise((ok) => {
      const done = () => { chrome.tabs.onUpdated.removeListener(l); clearTimeout(timer); ok(); };
      const l = (id, ch) => { if (id === tab && ch.status === 'complete') done(); };
      const timer = setTimeout(done, 15000);
      chrome.tabs.onUpdated.addListener(l);
      chrome.tabs.update(tab, { url }).catch(done);
    });
    const x = await chrome.tabs.get(tab); return { href: x.url || '', title: x.title || '' };
  }
  if (cmd === 'tab.where') { const x = await chrome.tabs.get(tab); return { href: x.url || '', title: x.title || '', readyState: x.status === 'complete' ? 'complete' : 'loading' }; }
  if (cmd === 'tab.shot') return shot(tab);
  if (cmd === 'tab.lock') {
    if (!locked) { await detach(tab); return true; }
    // Reading without the debugger: attach only when a click, a key or the network needs it.
    if (!(await canScript())) await attach(tab);
    return true;
  }
  if (cmd === 'tab.release') { netOn.delete(tab); await detach(tab); await pageOp(tab, 'mark', { on: false }).catch(() => {}); await glow(tab, false); delete lent[tab]; await setLent(lent); badge(tab); return true; }
  throw new Error(`unknown command ${cmd}`);
}
async function attach(tab) {
  if (attached.has(tab)) return;
  await chrome.debugger.attach({ tabId: tab }, '1.3');
  attached.add(tab);
}
async function detach(tab) {
  clearTimeout(idle.get(tab)); idle.delete(tab);
  if (!attached.has(tab)) return;
  attached.delete(tab);
  await chrome.debugger.detach({ tabId: tab }).catch(() => {});
  send({ t: 'event', tab, method: 'Extension.detached', params: {} });
}
// With page scripts allowed, the debugger (and Chrome's bar) goes away after a quiet spell, unless the agent turned
// the network log on for this tab.
async function idleDetach(tab) {
  clearTimeout(idle.get(tab));
  if (netOn.has(tab) || !(await canScript())) return;
  idle.set(tab, setTimeout(() => { idle.delete(tab); detach(tab); }, IDLE_DETACH_MS));
}
async function pageOp(tab, name, args) {
  if (!(await canScript())) throw new Error('reading through page scripts is not allowed yet (QuorX extension popup)');
  await chrome.scripting.executeScript({ target: { tabId: tab }, files: ['pageops.js'] });
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab }, func: (n, a) => window[Symbol.for('quorx.ops')][n](a), args: [String(name), args || {}] });
  return r ? r.result : null;
}
// A screenshot with Chrome's own capture (no debugger). It shows the active tab of a window, so a tab that isn't the
// active one in its window gets null, and QuorX falls back to the debugger.
async function shot(tab) {
  const x = await chrome.tabs.get(tab);
  if (!x.active) return { image: null };
  const w = await chrome.windows.get(x.windowId).catch(() => null);
  if (!w || w.state === 'minimized') return { image: null };
  const image = await chrome.tabs.captureVisibleTab(x.windowId, { format: 'jpeg', quality: 72 }).catch(() => null);
  return { image };
}
chrome.debugger.onEvent.addListener((src, method, params) => { if (!attached.has(src.tabId)) return; const p = passOn(method, params); if (p) send({ t: 'event', tab: src.tabId, method, params: p }); });
// Cancel on Chrome's "started debugging this browser" bar: you took the tab back.
chrome.debugger.onDetach.addListener(async (src, reason) => {
  attached.delete(src.tabId);
  if (reason === 'canceled_by_user') takeBack(src.tabId);
  else send({ t: 'event', tab: src.tabId, method: 'Extension.detached', params: {} });
});
chrome.tabs.onRemoved.addListener(async (tab) => { if ((await lentTabs())[tab]) takeBack(tab); });
async function takeBack(tab) {
  const lent = await lentTabs();
  delete lent[tab]; await setLent(lent); badge(tab);
  netOn.delete(tab);
  glow(tab, false);
  await detach(tab);
  await req('takeBack', { tab }).catch(() => {});
}
async function give(tab, chatId, extra = {}) {
  const t = await chrome.tabs.get(tab);
  if (!/^https?:/i.test(t.url || '')) throw new Error('Only web pages (http or https) can be given.');
  await req('give', { tab, chatId, url: t.url, title: t.title, ...extra });
  const lent = await lentTabs();
  lent[tab] = { chatId }; await setLent(lent); badge(tab);
}

// ---------- a chat's tabs in one named group ----------
async function intoGroup(tab, chatId, chatTitle) {
  if (!chatId || !chrome.tabGroups) return;
  const g = await groups();
  let gid = g[chatId];
  try {
    if (gid != null && await chrome.tabGroups.get(gid).catch(() => null)) await chrome.tabs.group({ groupId: gid, tabIds: [tab] });
    else {
      gid = await chrome.tabs.group({ tabIds: [tab] });
      await chrome.tabGroups.update(gid, { title: `QuorX · ${String(chatTitle || 'chat').slice(0, 30)}`, color: 'cyan' });
      g[chatId] = gid; await chrome.storage.session.set({ groups: g });
    }
  } catch { /* a group can't be made here (a pop-up window): the tab works ungrouped */ }
}
// Dragging one of your tabs into a chat's group gives it to that chat.
chrome.tabs.onUpdated.addListener(async (tab, change, info) => {
  if (change.groupId == null || change.groupId < 0) return;
  const g = await groups();
  const chatId = Object.keys(g).find((c) => g[c] === change.groupId);
  if (!chatId || (await lentTabs())[tab] || !/^https?:/i.test(info.url || '')) return;
  give(tab, chatId).catch(() => {});
});
chrome.tabGroups?.onRemoved.addListener(async (grp) => { const g = await groups(); for (const c of Object.keys(g)) if (g[c] === grp.id) delete g[c]; await chrome.storage.session.set({ groups: g }); });

// ---------- the agent's status on the toolbar button ----------
const STATE = { working: ['run', '#1a9aa3'], needs: ['you', '#d44a35'], done: ['done', '#2f8f43'] };
async function badge(tab) {
  const lent = (await lentTabs())[tab];
  const st = lent ? (await status())[lent.chatId] : null;
  const [text, color] = lent ? STATE[st?.state] || ['AI', '#a78bfa'] : ['', '#a78bfa'];
  chrome.action.setBadgeText({ tabId: tab, text }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ tabId: tab, color }).catch(() => {});
}
async function badgeAll() { for (const t of await chrome.tabs.query({})) badge(t.id); }
async function onPush(m) {
  if (m.kind === 'status' && m.chatId) {
    const s = await status();
    s[m.chatId] = { state: m.state, what: String(m.what || '').slice(0, 200), at: Date.now() };
    await chrome.storage.session.set({ status: s });
    badgeAll();
    const lent = await lentTabs();
    for (const t of Object.keys(lent).filter((id) => lent[id].chatId === m.chatId).map(Number)) glow(t, m.state === 'working') // while it waits for you, or is done, the tab is yours;
  }
}

// ---------- the glow: an edge and a Stop button on a tab while its chat's agent works there (glow.js) ----------
// Needs leave to run page scripts (the popup's "read pages" button); without it the tab keeps QuorX's thin mark.
async function glow(tab, on) {
  if (!(await canScript())) return;
  const run = (func, args = []) => chrome.scripting.executeScript({ target: { tabId: tab }, func, args }).catch(() => null);
  if (!on) { await run(() => window[Symbol.for('quorx.glow')]?.off()); return; }
  await chrome.scripting.executeScript({ target: { tabId: tab }, files: ['glow.js'] }).catch(() => null);
  await run((text) => window[Symbol.for('quorx.glow')]?.on(text), ['QuorX is working in this tab · Stop']);
}
const working = async (tab) => { const l = (await lentTabs())[tab]; return !!l && (await status())[l.chatId]?.state === 'working'; };
// A page that loads afresh loses the glow: it goes back on while the agent is still working there.
chrome.tabs.onUpdated.addListener(async (tab, change) => { if (change.status === 'complete' && await working(tab)) glow(tab, true); });
// The keyboard shortcut (Alt+Shift+Q by default; chrome://extensions/shortcuts) stops every reply using your Chrome.
chrome.commands?.onCommand.addListener((c) => { if (c === 'stop-agent') req('stopAll').catch(() => {}); });

// ---------- right-click: give this tab (with the selection or link) to a chat ----------
let menuChats = [];
async function refreshMenus() {
  if (!chrome.contextMenus) return;
  menuChats = state === 'on' ? (await req('chats').catch(() => [])).slice(0, 8) : [];
  await chrome.contextMenus.removeAll();
  const contexts = ['page', 'selection', 'link', 'image'];
  const make = (o) => new Promise((ok) => chrome.contextMenus.create(o, () => { void chrome.runtime.lastError; ok(); }));
  // The tab strip's own menu (Chrome 150+); older versions refuse the "tab" context, so it is tried separately.
  await make({ id: 'qx', title: 'Give to a QuorX chat', contexts });
  await make({ id: 'qx-tab', title: 'Give this tab to a QuorX chat', contexts: ['tab'] });
  for (const c of menuChats) {
    await make({ id: `qx:${c.id}`, parentId: 'qx', title: `${c.title}${c.project ? ` · ${c.project}` : ''}`.slice(0, 60), contexts });
    await make({ id: `qxt:${c.id}`, parentId: 'qx-tab', title: `${c.title}${c.project ? ` · ${c.project}` : ''}`.slice(0, 60), contexts: ['tab'] });
  }
  if (!menuChats.length) await make({ id: 'qx-none', parentId: 'qx', title: state === 'on' ? 'No chats yet: start one in QuorX' : 'QuorX is not connected', enabled: false, contexts });
}
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  const m = /^qxt?:(.+)$/.exec(String(info.menuItemId));
  if (!m || !tab) return;
  const extra = { selection: String(info.selectionText || '').slice(0, 4000), link: info.linkUrl || '', image: info.srcUrl || '' };
  give(tab.id, m[1], extra).then(() => req('focus', { chatId: m[1] }).catch(() => {}), () => {});
});

// ---------- teach by showing: record a routine in one tab ----------
const rec = async () => (await chrome.storage.session.get('rec')).rec || null; // { tab, steps, started }
async function recInject(tab) { await chrome.scripting.executeScript({ target: { tabId: tab }, files: ['recorder.js'] }).catch(() => {}); }
chrome.tabs.onUpdated.addListener(async (tab, change, info) => {
  const r = await rec();
  if (!r || r.tab !== tab) return;
  if (change.url && /^https?:/i.test(change.url) && r.steps.at(-1)?.url !== change.url) { r.steps.push({ kind: 'go', url: change.url, title: info.title || '' }); await chrome.storage.session.set({ rec: r }); }
  if (change.status === 'complete') recInject(tab);
});
async function recStep(step, sender) {
  const r = await rec();
  if (!r || sender.tab?.id !== r.tab) return;
  const last = r.steps.at(-1);
  if (step.kind === 'type' && last?.kind === 'type' && last.field === step.field) r.steps[r.steps.length - 1] = step; else r.steps.push(step);
  r.steps = r.steps.slice(-120);
  await chrome.storage.session.set({ rec: r });
}

// ---------- the popup asks here ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.q === 'rec-step') { recStep(msg.step, sender); return false; }
  (async () => {
    if (msg.q === 'state') {
      await connect(); const s = await settings();
      return { state, error: lastError, code: state === 'pairing' ? pairCode : '', address: s.address, paired: !!s.key, lent: await lentTabs(), status: await status(), allowOpen: (await chrome.storage.local.get('allowOpen')).allowOpen !== false, script: await canScript(), rec: await rec() };
    }
    if (msg.q === 'allowOpen') { await chrome.storage.local.set({ allowOpen: !!msg.on }); return true; }
    if (msg.q === 'save') {
      await chrome.storage.local.set({ address: String(msg.address || '').trim() || 'http://127.0.0.1:5188', key: String(msg.key || '').trim() });
      state = 'off'; lastError = ''; ws?.close(); ws = null; await connect();
      for (let i = 0; i < 20 && state === 'connecting'; i++) await new Promise((r) => setTimeout(r, 150));
      return { state, error: lastError };
    }
    if (msg.q === 'pair') {
      await chrome.storage.local.set({ address: String(msg.address || '').trim() || 'http://127.0.0.1:5188', key: '' });
      state = 'off'; lastError = ''; ws?.close(); ws = null; await connect(true);
      for (let i = 0; i < 20 && state === 'connecting'; i++) await new Promise((r) => setTimeout(r, 150));
      return { state, error: lastError };
    }
    if (msg.q === 'chats') { refreshMenus(); return req('chats'); }
    if (msg.q === 'give') { await give(msg.tab, msg.chatId); return true; }
    if (msg.q === 'takeBack') { await takeBack(msg.tab); return true; }
    if (msg.q === 'stop') return req('stop', { chatId: msg.chatId });
    // Stop on a tab's glow: the chat working in that tab.
    if (msg.q === 'stopTab') { const l = sender.tab && (await lentTabs())[sender.tab.id]; if (!l) return { stopped: 0 }; glow(sender.tab.id, false); return req('stop', { chatId: l.chatId }); }
    if (msg.q === 'open') return req('focus', { chatId: msg.chatId });
    // The permission request itself runs in the popup (Chrome needs your click there); this only tells QuorX.
    if (msg.q === 'caps') { send({ t: 'caps', caps: await caps() }); return caps(); }
    if (msg.q === 'rec-start') {
      if (!(await canScript())) throw new Error('Let QuorX read pages first (the button above): recording needs it.');
      const t = await chrome.tabs.get(msg.tab);
      if (!/^https?:/i.test(t.url || '')) throw new Error('Recording works on web pages (http or https).');
      await chrome.storage.session.set({ rec: { tab: t.id, started: Date.now(), steps: [{ kind: 'go', url: t.url, title: t.title || '' }] } });
      await recInject(t.id);
      return true;
    }
    if (msg.q === 'rec-stop') {
      const r = await rec();
      await chrome.storage.session.remove('rec');
      if (!r || msg.discard) return true;
      return req('saveRoutine', { chatId: msg.chatId, name: msg.name, steps: r.steps });
    }
    throw new Error('unknown');
  })().then((r) => reply({ ok: true, r }), (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});
chrome.permissions.onAdded?.addListener(async () => send({ t: 'caps', caps: await caps() }));
chrome.permissions.onRemoved?.addListener(async () => send({ t: 'caps', caps: await caps() }));
// Back on when Chrome starts, and every half minute if the link dropped (QuorX restarted, the computer slept).
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { connect(); refreshMenus(); });
chrome.alarms.create('quorx-link', { periodInMinutes: 0.5 });
chrome.alarms.create('quorx-menus', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'quorx-link') connect(); if (a.name === 'quorx-menus') refreshMenus(); });
connect();
