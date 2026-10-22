// QuorX in your everyday Chrome. It keeps one WebSocket to the QuorX on this computer and does only this:
// a tab you give to a chat (from the popup) can be driven by that chat's agent through Chrome's debugger, and only
// while the agent works; Chrome shows its own "started debugging" bar meanwhile, and Cancel on it takes the tab back.
// It never touches a tab you didn't give, and forgets a tab when you take it back or close it.
const VERSION = chrome.runtime.getManifest().version;
const FORWARD = new Set(['Page.loadEventFired', 'Page.frameNavigated', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);
let ws = null, state = 'off', lastError = '', pingTimer = null, seq = 0;
const waiting = new Map(); // request id → resolve/reject
const attached = new Set(); // tab ids the debugger is attached to right now

const settings = async () => ({ address: 'http://127.0.0.1:5188', key: '', ...(await chrome.storage.local.get(['address', 'key'])) });
const lentTabs = async () => (await chrome.storage.session.get('lent')).lent || {}; // tab id → { chatId, chat }
const setLent = (lent) => chrome.storage.session.set({ lent });

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { address, key } = await settings();
  if (!key) { state = 'unpaired'; return; }
  let u; try { u = new URL('/api/ext/socket', address); } catch { state = 'error'; lastError = 'That QuorX address is not valid.'; return; }
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  state = 'connecting';
  const sock = new WebSocket(u.href);
  ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', key, version: VERSION }));
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null; clearInterval(pingTimer);
    if (state !== 'denied') { state = 'off'; lastError = lastError || 'QuorX is not running (or not at that address).'; }
    for (const [, w] of waiting) w.no(new Error('disconnected'));
    waiting.clear();
    for (const tab of attached) chrome.debugger.detach({ tabId: tab }).catch(() => {});
    attached.clear();
    setLent({}); badgeAll();
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
    return;
  }
  if (m.t === 'denied') { state = 'denied'; lastError = m.why || 'QuorX refused the key.'; return; }
  if (m.t === 'res') { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.no(new Error(m.error)) : w.ok(m.result); } return; }
  if (m.t === 'call') {
    try { send({ t: 'reply', id: m.id, result: await call(m.cmd, m.args || {}) }); }
    catch (e) { send({ t: 'reply', id: m.id, error: String(e?.message || e) }); }
  }
}
// What QuorX may ask, and only for a tab you gave.
async function call(cmd, { tab, method, params, locked, url, chatId }) {
  const lent = await lentTabs();
  // A chat with 🧩 Chrome on opens its own tab, in one QuorX window, unless you turned that off in this popup.
  if (cmd === 'tab.open') {
    if ((await chrome.storage.local.get('allowOpen')).allowOpen === false) throw new Error('opening tabs is turned off in the QuorX extension (its popup)');
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('only web pages (http or https) can be opened');
    const { win } = await chrome.storage.session.get('win');
    let t;
    try { t = win ? await chrome.tabs.create({ windowId: win, url, active: true }) : null; } catch { t = null; }
    if (!t) { const w = await chrome.windows.create({ url, focused: false }); await chrome.storage.session.set({ win: w.id }); t = w.tabs[0]; }
    lent[t.id] = { chatId, own: true }; await setLent(lent); badge(t.id, true);
    return { id: t.id, title: t.title || '' };
  }
  if (!lent[tab]) throw new Error('that tab was not given to QuorX');
  if (cmd === 'tab.cdp') { await attach(tab); return chrome.debugger.sendCommand({ tabId: tab }, method, params || {}); }
  if (cmd === 'tab.lock') { if (locked) await attach(tab); else await detach(tab); return true; }
  if (cmd === 'tab.release') { await detach(tab); delete lent[tab]; await setLent(lent); badge(tab, false); return true; }
  throw new Error(`unknown command ${cmd}`);
}
async function attach(tab) {
  if (attached.has(tab)) return;
  await chrome.debugger.attach({ tabId: tab }, '1.3');
  attached.add(tab);
}
async function detach(tab) {
  if (!attached.has(tab)) return;
  attached.delete(tab);
  await chrome.debugger.detach({ tabId: tab }).catch(() => {});
}
chrome.debugger.onEvent.addListener((src, method, params) => { if (attached.has(src.tabId) && FORWARD.has(method)) send({ t: 'event', tab: src.tabId, method, params }); });
// Cancel on Chrome's "started debugging this browser" bar: you took the tab back.
chrome.debugger.onDetach.addListener(async (src, reason) => {
  attached.delete(src.tabId);
  if (reason === 'canceled_by_user') takeBack(src.tabId);
});
chrome.tabs.onRemoved.addListener(async (tab) => { if ((await lentTabs())[tab]) takeBack(tab); });
async function takeBack(tab) {
  const lent = await lentTabs();
  delete lent[tab]; await setLent(lent); badge(tab, false);
  await detach(tab);
  await req('takeBack', { tab }).catch(() => {});
}
async function give(tab, chatId) {
  const t = await chrome.tabs.get(tab);
  if (!/^https?:/i.test(t.url || '')) throw new Error('Only web pages (http or https) can be given.');
  await req('give', { tab, chatId, url: t.url, title: t.title });
  const lent = await lentTabs();
  lent[tab] = { chatId }; await setLent(lent); badge(tab, true);
}
function badge(tab, on) {
  chrome.action.setBadgeText({ tabId: tab, text: on ? 'AI' : '' }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId: tab, color: '#a78bfa' }).catch(() => {});
}
async function badgeAll() { const lent = await lentTabs(); for (const t of await chrome.tabs.query({})) badge(t.id, !!lent[t.id]); }

// The popup asks here.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.q === 'state') { await connect(); const s = await settings(); return { state, error: lastError, address: s.address, paired: !!s.key, lent: await lentTabs(), allowOpen: (await chrome.storage.local.get('allowOpen')).allowOpen !== false }; }
    if (msg.q === 'allowOpen') { await chrome.storage.local.set({ allowOpen: !!msg.on }); return true; }
    if (msg.q === 'save') {
      await chrome.storage.local.set({ address: String(msg.address || '').trim() || 'http://127.0.0.1:5188', key: String(msg.key || '').trim() });
      state = 'off'; lastError = ''; ws?.close(); ws = null; await connect();
      for (let i = 0; i < 20 && state === 'connecting'; i++) await new Promise((r) => setTimeout(r, 150));
      return { state, error: lastError };
    }
    if (msg.q === 'chats') return req('chats');
    if (msg.q === 'give') { await give(msg.tab, msg.chatId); return true; }
    if (msg.q === 'takeBack') { await takeBack(msg.tab); return true; }
    throw new Error('unknown');
  })().then((r) => reply({ ok: true, r }), (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});
// Back on when Chrome starts, and every half minute if the link dropped (QuorX restarted, the computer slept).
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('quorx-link', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'quorx-link') connect(); });
connect();
