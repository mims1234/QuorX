// The QuorX Chrome extension (extension/): your everyday Chrome, linked to this harness, so a tab you give to a chat
// can be used by the agent with your own sign-ins. The link is one WebSocket (Chrome keeps an extension's service
// worker awake while one is active). Only a Chrome extension may connect (its Origin), and only with the key you
// paste into it from ⚙ Settings; the extension itself only ever touches tabs you gave.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './openrouter.js';

const KEY_FILE = path.join(HOME, 'data', 'extension-key');
export function extKey(renew = false) {
  try { if (!renew) { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (/^[a-f0-9]{48}$/.test(k)) return k; } } catch { /* none yet */ }
  const k = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
  if (renew) link?.close(4001, 'new key');
  return k;
}

let link = null; // { send(obj), close(code, why), at, version }
const waiting = new Map(), subs = new Map(); // call id → { ok, no, timer }; tab → Set(fn)
let handlers = {}; // what the extension asks of the harness: give, takeBack, closed, chats
export const extReady = () => !!link;
export const extInfo = () => (link ? { connected: true, since: link.at, version: link.version } : { connected: false });
export function onExtRequest(h) { handlers = h; }

/** A command for the extension (tab.cdp, tab.lock, tab.release); resolves with its answer. */
export function extCall(cmd, args = {}, ms = 30000) {
  if (!link) return Promise.reject(new Error('the QuorX extension in Chrome is not connected'));
  const id = crypto.randomUUID();
  return new Promise((ok, no) => {
    const timer = setTimeout(() => { waiting.delete(id); no(new Error(`Chrome did not answer ${cmd} in ${ms / 1000} s`)); }, ms);
    waiting.set(id, { ok, no, timer });
    link.send({ t: 'call', id, cmd, args });
  });
}
/** Page events (CDP) from a Chrome tab the agent is using. */
export function onExtTabEvents(tab, fn) {
  const k = String(tab); if (!subs.has(k)) subs.set(k, new Set());
  subs.get(k).add(fn);
  return () => subs.get(k)?.delete(fn);
}

// ---- the WebSocket itself (RFC 6455, text frames only) ----
export function extUpgrade(req, socket) {
  const origin = String(req.headers.origin || '');
  const wsKey = req.headers['sec-websocket-key'];
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || !wsKey || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0), frags = [], hello = false;
  const frame = (op, data) => {
    const p = Buffer.from(data), n = p.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    if (!socket.destroyed) socket.write(Buffer.concat([head, p]));
  };
  const me = { at: Date.now(), version: '', send: (o) => frame(1, JSON.stringify(o)), close: (code = 1000) => { const b = Buffer.alloc(2); b.writeUInt16BE(code); frame(8, b); socket.end(); } };
  // No hello with the right key within 10 s: not ours.
  const helloTimer = setTimeout(() => { if (!hello) socket.destroy(); }, 10000);
  const onText = (text) => {
    let m; try { m = JSON.parse(text); } catch { return; }
    if (!hello) {
      const want = Buffer.from(extKey()), got = Buffer.from(String(m.key || ''));
      if (m.t !== 'hello' || got.length !== want.length || !crypto.timingSafeEqual(got, want)) { me.send({ t: 'denied', why: 'wrong key: copy it again from QuorX ⚙ Settings → Chrome extension' }); me.close(4003); return; }
      hello = true; clearTimeout(helloTimer);
      if (link && link !== me) link.close(4000);
      me.version = String(m.version || '').slice(0, 20);
      link = me; me.send({ t: 'welcome' });
      return;
    }
    if (m.t === 'ping') return me.send({ t: 'pong' });
    if (m.t === 'reply') { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); clearTimeout(w.timer); return m.error ? w.no(new Error(m.error)) : w.ok(m.result); }
    if (m.t === 'event') { for (const fn of subs.get(String(m.tab)) || []) fn(m.method, m.params); return; }
    if (m.t === 'req') {
      const h = handlers[m.what];
      Promise.resolve(h ? h(m.args || {}) : Promise.reject(new Error(`unknown request ${m.what}`)))
        .then((result) => me.send({ t: 'res', id: m.id, result }), (e) => me.send({ t: 'res', id: m.id, error: e.message }));
    }
  };
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let n = buf[1] & 0x7f, at = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; } else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (n > 32e6) { socket.destroy(); return; }
      if (buf.length < at + (masked ? 4 : 0) + n) return;
      const mask = masked ? buf.subarray(at, at + 4) : null; at += masked ? 4 : 0;
      const p = Buffer.from(buf.subarray(at, at + n)); buf = buf.subarray(at + n);
      if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      if (op === 8) { socket.end(); return; }
      if (op === 9) { frame(10, p); continue; }
      if (op === 10) continue;
      frags.push(p);
      if (fin) { const text = Buffer.concat(frags).toString('utf8'); frags = []; onText(text); }
    }
  });
  const gone = () => {
    clearTimeout(helloTimer);
    if (link !== me) return;
    link = null;
    for (const [id, w] of waiting) { clearTimeout(w.timer); w.no(new Error('the QuorX extension disconnected')); waiting.delete(id); }
    handlers.disconnected?.();
  };
  socket.on('close', gone); socket.on('error', gone);
}

// Chrome itself (not Edge or Brave), for "Open in Chrome" in ⚙ Settings: web pages can't open chrome:// addresses,
// so QuorX starts Chrome with the extensions page, which opens in the Chrome you already have running.
const LOCAL = process.env.LOCALAPPDATA || '';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', LOCAL && path.join(LOCAL, 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].filter(Boolean);
export const chromePath = () => CHROME.find((p) => fs.existsSync(p)) || null;
