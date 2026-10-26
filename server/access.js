// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
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
// Cookies belong to a host, not a port: a cookie for localhost:5188 also goes to every dev server on localhost:3000.
// So QuorX's own pages live at a name only it uses, quorx.localhost (browsers send *.localhost to this computer by
// themselves), and its cookie is set and read only there. Dev servers and the agent's pages stay on localhost.
// Two QuorX on one computer still share that name, so each cookie name also carries the port QuorX answered on.
export const APP_HOST = 'quorx.localhost';
const portOf = (req) => req.socket?.localPort || 0;
const named = (base, req) => `${base}_${portOf(req)}`;
const hostName = (req) => { try { return new URL(`http://${req.headers.host || ''}`).hostname.toLowerCase(); } catch { return ''; } };
/** The request named QuorX's own host (quorx.localhost), the only one its cookie is good for. */
export const onAppHost = (req) => hostName(req) === APP_HOST;
/** A cookie's value: the one for this port. */
const cookieValue = (req, base) => {
  const jar = new Map(String(req.headers.cookie || '').split(/;\s*/).map((c) => { const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)]; }));
  return jar.get(named(base, req)) ?? '';
};
export const isLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');

// Names that mean this computer. IP literals are always fine: DNS rebinding needs a domain name.
const NAMES = new Set(['localhost', APP_HOST, ...[os.hostname().toLowerCase()].flatMap((h) => [h, `${h}.local`, `${h}.lan`, `${h}.home`]),
  ...String(process.env.OH_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)]);
export function hostAllowed(req) {
  const name = hostName(req);
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
// Written with a key made after the move to quorx.localhost. A key from before it went to every dev server on
// localhost along with the cookie, so a key file without this one next to it is replaced, once.
const KEY_HOST_FILE = path.join(HOME, 'data', 'app-key-host');
const KEY_COOKIE = 'qx_app';
export const appKey = (() => {
  try { const k = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (k.length >= 32 && fs.existsSync(KEY_HOST_FILE)) return k; } catch { /* first run */ }
  const k = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
    fs.writeFileSync(KEY_HOST_FILE, `${APP_HOST}\n`);
  } catch { /* lasts until restart */ }
  return k;
})();
const keyCookie = (req) => cookieValue(req, KEY_COOKIE);
/**
 * The app link. It starts at localhost, where this browser kept QuorX's settings before quorx.localhost: the page
 * there hands them over and opens QuorX at its own name, signed in (movePage).
 */
export const appLink = (port) => `http://localhost:${port}/?k=${appKey}`;
// Routes any caller may use: the version check the desktop app makes before it has the key, and nothing else.
const OPEN = new Set(['/api/config', '/api/stale']);
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const cookieFor = (req, value, age) => `${named(KEY_COOKIE, req)}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict`;
/**
 * For requests from this computer: answers /api calls without the key (true), turns ?k= into the cookie (true), or
 * lets the request through (false).
 */
export function appGate(req, res, url) {
  if (!isLoopback(req)) return false;
  const app = onAppHost(req);
  const k = url.searchParams.get('k');
  if (k != null && !url.pathname.startsWith('/api/')) {
    url.searchParams.delete('k');
    if (!same(k, appKey)) { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE }); res.end(PAGE('That app link is not valid.', 'Open the link QuorX printed when it started, or the desktop app.')); return true; }
    if (!app) return movePage(req, res, url, newHandoff());
    res.writeHead(302, { 'Set-Cookie': cookieFor(req, appKey, 31536000), Location: `${url.pathname}${url.search}`, ...NO_STORE });
    res.end();
    return true;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!app) return movePage(req, res, url, '');
    if (url.searchParams.has('moved')) return signInMoved(req, res, url);
  }
  if (!url.pathname.startsWith('/api/') || OPEN.has(url.pathname)) return false;
  // The old address hands over its settings: the handoff's id, made for the app link, is its key.
  const hm = url.pathname.match(/^\/api\/prefs\/handoff\/([\w-]{24})$/);
  if (hm && req.method === 'POST' && !app && handoffs.get(hm[1])?.items === null) return false;
  if ((app && same(keyCookie(req), appKey)) || same(req.headers['x-quorx-key'], appKey)) return false;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'This QuorX needs its app link: open the link it printed when it started (or use the desktop app), then reload.', code: 'APP_KEY' }));
  return true;
}

// ---------- moving to quorx.localhost ----------
// Settings a browser kept for QuorX belong to the address it was opened at, so the ones from localhost:<port> are
// carried over once: the app link opens a small page there (public/move.js), which sends them to a handoff made for
// that link, then opens QuorX at quorx.localhost with the handoff's id. That visit gets the cookie (signInMoved) and
// the app reads the settings back (handoffTake). A handoff lasts 5 minutes and is used once.
// The old cookie on localhost is removed on the way: it no longer opens anything, but it still went to dev servers.
const HANDOFF_TTL = 5 * 60e3;
const handoffs = new Map(); // id -> { at, items: null (waiting) | {} | false (none sent), signed }
function newHandoff() {
  for (const [id, h] of handoffs) if (Date.now() - h.at > HANDOFF_TTL) handoffs.delete(id);
  const id = crypto.randomBytes(18).toString('base64url');
  handoffs.set(id, { at: Date.now(), items: null, signed: false });
  return id;
}
const live = (id) => { const h = handoffs.get(String(id || '')); return h && Date.now() - h.at <= HANDOFF_TTL ? h : null; };
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function movePage(req, res, url, id) {
  const next = `http://${APP_HOST}:${portOf(req)}${url.pathname === '/index.html' ? '/' : url.pathname}${url.search}`;
  // Every QuorX cookie this browser still has at localhost goes, other ports' too: they all reach every dev server.
  const old = new Set([named(KEY_COOKIE, req), KEY_COOKIE, ...String(req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')[0]).filter((n) => /^qx_app(_\d{1,5})?$/.test(n))]);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE,
    'Set-Cookie': [...old].map((n) => `${n}=; Path=/; Max-Age=0${n === KEY_COOKIE ? '' : '; HttpOnly; SameSite=Strict'}`),
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; form-action 'none'" });
  res.end(PAGE('Opening QuorX…', '<span id="moveMsg">QuorX now opens at its own address.</span>')
    .replace('<title>QuorX</title>', `<title>QuorX</title><meta name="qx-move" content="${attr(id)}"><meta name="qx-next" content="${attr(next)}"><script src="/move.js" defer></script>`));
  return true;
}
function signInMoved(req, res, url) {
  const id = url.searchParams.get('moved'), h = live(id);
  url.searchParams.delete('moved');
  const head = { ...NO_STORE };
  if (h && !h.signed) {
    h.signed = true;
    head['Set-Cookie'] = cookieFor(req, appKey, 31536000);
    if (h.items) url.searchParams.set('prefs', id); else handoffs.delete(id);
  }
  res.writeHead(302, { ...head, Location: `/${url.search}` });
  res.end();
  return true;
}
/** The old address's settings for handoff `id` (string keys and values); false when it can't take them. */
export function handoffPut(id, items) {
  const h = live(id);
  if (!h || h.items !== null || h.signed || !items || typeof items !== 'object' || Array.isArray(items)) return false;
  const list = Object.entries(items).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length <= 200);
  if (list.length > 500) return false;
  h.items = list.length ? Object.fromEntries(list) : false;
  return true;
}
/** The settings handed over, once, for the page now signed in at quorx.localhost. */
export function handoffTake(id) {
  const h = live(id);
  if (!h || !h.signed || !h.items) return null;
  handoffs.delete(id);
  return h.items;
}

/** This computer's own addresses, so the agent's browser can't reach the harness through them. */
export const ownAddresses = () => new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a) => a.address.toLowerCase()));
