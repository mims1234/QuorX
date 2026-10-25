// The QuorX Chrome extension (extension/): your everyday Chrome, linked to this harness, so a tab you give to a chat
// can be used by the agent with your own sign-ins. The link is one WebSocket (Chrome keeps an extension's service
// worker awake while one is active). Only a Chrome extension may connect (its Origin), and only with the key you
// paste into it from ⚙ Settings or that QuorX hands it when you press Allow; the extension itself only ever touches
// tabs you gave. The key is pinned to the extension it went to (its ID, from the Origin): the same key under another
// ID is turned away. A key from before pinning has no ID yet and takes the ID of its next good connection, so an
// extension already set up keeps working without connecting again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './openrouter.js';

const KEY_FILE = path.join(HOME, 'data', 'extension-key');
export function extKey(renew = false) {
  try { if (!renew) { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (/^[a-f0-9]{48}$/.test(k)) return k; } } catch { /* none yet */ }
  const k = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
  fs.rmSync(ORIGIN_FILE, { force: true }); // a new key is not pinned yet: the first extension to use it gets it
  if (renew) link?.close(4001, 'new key');
  return k;
}
// The extension the key belongs to (chrome-extension://<id>), in its own file so an older QuorX still reads the key.
const ORIGIN_FILE = path.join(HOME, 'data', 'extension-origin');
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const keyOrigin = () => { try { const o = fs.readFileSync(ORIGIN_FILE, 'utf8').trim(); return ORIGIN.test(o) ? o : ''; } catch { return ''; } };
const pinOrigin = (o) => { fs.mkdirSync(path.dirname(ORIGIN_FILE), { recursive: true }); fs.writeFileSync(ORIGIN_FILE, o, { mode: 0o600 }); };
const PRE_HELLO_BYTES = 65536; // all a connection may send before its hello is accepted
// The code QuorX and the extension's popup both show while it waits for Allow (no 0/O or 1/I to mix up).
const pairCode = () => Array.from(crypto.randomBytes(6), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b & 31]).join('');

let link = null; // { send(obj), close(code, why), at, version }
const waiting = new Map(), subs = new Map(); // call id → { ok, no, timer }; tab → Set(fn)
let handlers = {}; // what the extension asks of the harness: give, takeBack, closed, chats
let pairing = null; // { me, origin, id, code, browser, at, finish(allow) }: an extension asking to connect, waiting for Allow in QuorX
export const extPairing = () => (pairing && Date.now() - pairing.at < 120000 ? { browser: pairing.browser, at: pairing.at, id: pairing.id, code: pairing.code } : null);
/** Allow or Deny the extension that asked to connect (⚙ Settings or the notice in QuorX). */
export function extPair(allow) { const p = pairing; pairing = null; if (!p) return false; p.finish(!!allow); return true; }
export const extReady = () => !!link;
// The extension's version this QuorX needs (what it can do); an older one is still connected but must be reloaded.
export const EXT_NEEDS = '0.2.11';
const below = (v, w) => { const a = String(v || '0').split('.').map(Number), b = String(w).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); } return false; };
const older = (v) => below(v, EXT_NEEDS);
// The version in QuorX's extension folder: an older running copy is asked to reload itself from it.
const latest = () => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'manifest.json'), 'utf8')).version; } catch { return EXT_NEEDS; } };
export const extOutdated = () => !!link && older(link.version);
export const extInfo = () => (link ? { connected: true, since: link.at, version: link.version, outdated: older(link.version), caps: link.caps || {} } : { connected: false });
/** What the connected extension may do beyond the debugger: { script } once you let it read pages (its popup). */
export const extCaps = () => link?.caps || {};
/** A message for the extension that needs no answer (the agent's status for a tab, the routine it recorded…). */
export function extPush(o) { if (link) link.send({ t: 'push', ...o }); }
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
  if (!ORIGIN.test(origin) || !wsKey || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0), frags = [], hello = false, pre = 0;
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
    if (!hello && m.t === 'hello' && m.pair && !m.key) {
      // No key yet: it waits (up to 2 minutes) until you press Allow or Deny in QuorX. One request at a time: another
      // extension asking meanwhile is turned away; the same extension asking again replaces its own request.
      if (pairing && pairing.origin !== origin) { me.send({ t: 'denied', why: 'another extension is already waiting for Allow in QuorX: try again once that is answered' }); me.close(4009); return; }
      if (pairing) pairing.finish(false);
      const p = { me, origin, id: origin.slice('chrome-extension://'.length), code: pairCode(), browser: String(m.browser || 'A browser').slice(0, 30), at: Date.now() };
      p.finish = (allow) => {
        clearTimeout(p.timer); if (pairing === p) pairing = null;
        if (!allow) { me.send({ t: 'denied', why: 'not allowed in QuorX' }); me.close(4003); return; }
        pinOrigin(origin); me.send({ t: 'paired', key: extKey() }); onText(JSON.stringify({ t: 'hello', key: extKey(), version: m.version }));
      };
      p.timer = setTimeout(() => p.finish(false), 120000);
      clearTimeout(helloTimer); pairing = p; me.send({ t: 'pairing', code: p.code });
      return;
    }
    if (!hello) {
      const want = Buffer.from(extKey()), got = Buffer.from(String(m.key || ''));
      if (m.t !== 'hello' || got.length !== want.length || !crypto.timingSafeEqual(got, want)) { me.send({ t: 'denied', why: 'wrong key: copy it again from QuorX ⚙ Settings → Chrome extension' }); me.close(4003); return; }
      // The right key under another extension ID is not the extension it was given to. A key with no ID yet gets this one.
      const pinned = keyOrigin();
      if (pinned && pinned !== origin) { me.send({ t: 'denied', why: 'this key belongs to another extension: press Connect here, then Allow in QuorX' }); me.close(4003); return; }
      if (!pinned) pinOrigin(origin);
      hello = true; clearTimeout(helloTimer);
      if (link && link !== me) link.close(4000);
      me.version = String(m.version || '').slice(0, 20);
      me.caps = m.caps && typeof m.caps === 'object' ? { script: !!m.caps.script } : {};
      link = me; me.send({ t: 'welcome' });
      if (below(me.version, latest())) me.send({ t: 'reload' });
      return;
    }
    if (m.t === 'ping') return me.send({ t: 'pong' });
    if (m.t === 'reply') { const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); clearTimeout(w.timer); return m.error ? w.no(new Error(m.error)) : w.ok(m.result); }
    if (m.t === 'event') { for (const fn of subs.get(String(m.tab)) || []) fn(m.method, m.params); return; }
    if (m.t === 'caps') { me.caps = m.caps && typeof m.caps === 'object' ? { script: !!m.caps.script } : {}; return; }
    if (m.t === 'req') {
      const h = handlers[m.what];
      Promise.resolve(h ? h(m.args || {}) : Promise.reject(new Error(`unknown request ${m.what}`)))
        .then((result) => me.send({ t: 'res', id: m.id, result }), (e) => me.send({ t: 'res', id: m.id, error: e.message }));
    }
  };
  socket.on('data', (d) => {
    // Until its hello is accepted a connection is nobody yet, so it may send only a little.
    if (!hello && (pre += d.length) > PRE_HELLO_BYTES) { socket.destroy(); return; }
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
    if (pairing?.me === me) { clearTimeout(pairing.timer); pairing = null; } // it stopped waiting: nothing left to Allow
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

// Your default browser and its extensions page (brave://extensions, edge://extensions…): the extension works in any
// Chromium browser, so "Open" in ⚙ Settings opens the one you use. Windows reads it from the registry; elsewhere Chrome.
const BROWSERS = { 'brave.exe': ['Brave', 'brave://extensions'], 'chrome.exe': ['Chrome', 'chrome://extensions'], 'msedge.exe': ['Edge', 'edge://extensions'], 'vivaldi.exe': ['Vivaldi', 'vivaldi://extensions'], 'opera.exe': ['Opera', 'opera://extensions'], 'launcher.exe': ['Opera', 'opera://extensions'], 'firefox.exe': ['Firefox', null] };
export async function defaultBrowser() {
  if (process.platform === 'win32') {
    try {
      const { execFile } = await import('node:child_process');
      const reg = (args) => new Promise((ok) => execFile('reg', args, { windowsHide: true, timeout: 4000 }, (e, out) => ok(e ? '' : String(out))));
      const prog = (await reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'])).match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1];
      const cmd = prog && (await reg(['query', `HKCR\\${prog}\\shell\\open\\command`, '/ve'])).match(/REG_SZ\s+"([^"]+\.exe)"/i)?.[1];
      const known = cmd && BROWSERS[path.basename(cmd).toLowerCase()];
      if (cmd && known) return { name: known[0], exe: cmd, page: known[1] };
    } catch { /* fall back to Chrome */ }
  }
  const exe = chromePath();
  return exe ? { name: 'Chrome', exe, page: 'chrome://extensions' } : null;
}
