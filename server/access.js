// Who may use the harness. Anyone who reaches it can run commands in a real shell, so:
//   - only this computer (loopback): QuorX listens on 127.0.0.1, and anything else that reaches it is refused;
//   - the Host header must name this computer (localhost, an IP address, or its own name), so a web page can't
//     reach the harness through DNS rebinding;
//   - another site, or a page the agent built (served on a localhost port or sandboxed), can't call /api.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';
// Cookies belong to a host, not a port: two QuorX on one computer (the desktop app and `npm start`, or two copies on
// different ports) would overwrite each other's and keep signing each other out. So each cookie name carries the
// port QuorX answered on. The old names without it are still accepted, until 0.2.8.
const portOf = (req) => req.socket?.localPort || 0;
const named = (base, req) => `${base}_${portOf(req)}`;
/** A cookie's value: the one for this port, else the old name shared by every port. */
const cookieValue = (req, base) => {
  const jar = new Map(String(req.headers.cookie || '').split(/;\s*/).map((c) => { const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)]; }));
  return jar.get(named(base, req)) ?? jar.get(base) ?? '';
};
export const isLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');

// Names that mean this computer. IP literals are always fine: DNS rebinding needs a domain name.
const NAMES = new Set(['localhost', ...[os.hostname().toLowerCase()].flatMap((h) => [h, `${h}.local`, `${h}.lan`, `${h}.home`]),
  ...String(process.env.OH_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)]);
export function hostAllowed(req) {
  let name;
  try { name = new URL(`http://${req.headers.host || ''}`).hostname.toLowerCase(); } catch { return false; }
  if (!name) return false;
  return /^\[[0-9a-f:.]+\]$/.test(name) || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || NAMES.has(name);
}

/** A request for /api from another site or another origin on this computer (an agent's dev server, a sandboxed page). */
export function crossSiteApi(req, pathname) {
  if (!pathname.startsWith('/api/')) return false;
  const s = req.headers['sec-fetch-site'];
  return s === 'cross-site' || s === 'same-site';
}

const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QuorX</title><body style="font:16px/1.5 system-ui,sans-serif;background:#0b0f0d;color:#e7edea;max-width:560px;margin:0 auto;padding:32px 20px"><h2 style="margin-top:0">${title}</h2><p style="color:#9fb0a8">${body}</p></body>`;

/**
 * Lets a request from this computer through (false); anything else is refused (true). Call it first for every request.
 */
export function gate(req, res, url) {
  if (isLoopback(req)) return false;
  if (url.pathname.startsWith('/api/')) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'QuorX only answers the computer it runs on.' })); }
  else { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(PAGE('QuorX runs on its own computer only.', 'Open QuorX on the computer it is installed on.')); }
  return true;
}

// ---------- the app key: /api on this computer only for QuorX's own windows ----------
// Being on this computer is not enough: programs the agent runs are on it too. The page proves itself with a cookie
// it gets by opening the app link once (printed at start, opened by the desktop app itself); other programs can call
// /api only if they read the key file in data/, which the agent's commands may not read.
const KEY_FILE = path.join(HOME, 'data', 'app-key');
const KEY_COOKIE = 'qx_app';
export const appKey = (() => {
  try { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (k.length >= 32) return k; } catch { /* first run */ }
  const k = crypto.randomBytes(32).toString('base64url');
  try { fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true }); fs.writeFileSync(KEY_FILE, k, { mode: 0o600 }); } catch { /* lasts until restart */ }
  return k;
})();
const keyCookie = (req) => cookieValue(req, KEY_COOKIE);
/** The app link: opening it once leaves the cookie. */
export const appLink = (port) => `http://localhost:${port}/?k=${appKey}`;
// Routes any caller may use: the version check the desktop app makes before it has the key, and nothing else.
const OPEN = new Set(['/api/config', '/api/stale']);
/**
 * For requests from this computer: answers /api calls without the key (true), turns ?k= into the cookie (true), or
 * lets the request through (false).
 */
export function appGate(req, res, url) {
  if (!isLoopback(req)) return false;
  const k = url.searchParams.get('k');
  if (k != null && !url.pathname.startsWith('/api/')) {
    url.searchParams.delete('k');
    if (!same(k, appKey)) { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(PAGE('That app link is not valid.', 'Open the link QuorX printed when it started, or the desktop app.')); return true; }
    res.writeHead(302, { 'Set-Cookie': `${named(KEY_COOKIE, req)}=${appKey}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`, Location: `${url.pathname}${url.search}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
    return true;
  }
  if (!url.pathname.startsWith('/api/') || OPEN.has(url.pathname)) return false;
  if (same(keyCookie(req), appKey) || same(req.headers['x-quorx-key'], appKey)) return false;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'This QuorX needs its app link: open the link it printed when it started (or use the desktop app), then reload.', code: 'APP_KEY' }));
  return true;
}

/** This computer's own addresses, so the agent's browser can't reach the harness through them. */
export const ownAddresses = () => new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a) => a.address.toLowerCase()));
