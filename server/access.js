// Who may use the harness. Anyone who reaches it can run commands in a real shell, so:
//   - this computer (loopback) always may;
//   - other devices on the network (your phone on Wi-Fi) must be paired once: they open the pairing link shown in
//     ⚙ Settings → About on this computer, which leaves a cookie. "New link" signs every paired device out.
//     "Other devices" can also be switched off there entirely.
//   - the Host header must name this computer (localhost, an IP address, or its own name), so a web page can't
//     reach the harness through DNS rebinding;
//   - another site, or a page the agent built (served on a localhost port or sandboxed), can't call /api.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';

const FILE = path.join(HOME, 'data', 'access.json');
const COOKIE = 'oh_pair';
const newToken = () => crypto.randomBytes(18).toString('base64url');

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (typeof s.token === 'string' && s.token.length >= 16) return { token: s.token, lan: s.lan !== false };
  } catch { /* first run */ }
  return save({ token: newToken(), lan: true });
}
function save(s) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2)); } catch { /* read-only data folder: pairing lasts until restart */ }
  return s;
}
let state = load();

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
const cookieOf = (req) => String(req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1] || '';

// Wrong pairing links from one address: after 10, that address waits 10 minutes.
const fails = new Map();
const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QuorX</title><body style="font:16px/1.5 system-ui,sans-serif;background:#0b0f0d;color:#e7edea;max-width:560px;margin:0 auto;padding:32px 20px"><h2 style="margin-top:0">${title}</h2><p style="color:#9fb0a8">${body}</p></body>`;

/**
 * Lets a request through (false) or answers it (true): pairing, or a refusal for an unpaired device.
 * Call it first for every request.
 */
export function gate(req, res, url) {
  if (isLoopback(req)) return false;
  const send = (code, title, body) => {
    if (url.pathname.startsWith('/api/')) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `${title} ${body}` })); }
    else { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(PAGE(title, body)); }
    return true;
  };
  if (!state.lan) return send(403, 'Other devices are switched off.', 'On the computer running QuorX, turn on ⚙ Settings → About → Other devices.');
  const ip = req.socket.remoteAddress || '', f = fails.get(ip);
  if (f && f.until > Date.now()) return send(429, 'Too many wrong pairing links.', 'Try again in a few minutes.');
  const pair = url.searchParams.get('pair');
  if (pair != null) {
    if (same(pair, state.token)) {
      fails.delete(ip);
      url.searchParams.delete('pair');
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${state.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`, Location: `${url.pathname}${url.search}`, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const n = (f?.n || 0) + 1;
    fails.set(ip, { n, until: n >= 10 ? Date.now() + 10 * 60e3 : 0 });
    return send(401, 'That pairing link is not valid any more.', 'Open ⚙ Settings → About on the computer running QuorX and use the link shown there.');
  }
  if (same(cookieOf(req), state.token)) return false;
  return send(401, 'This device is not paired yet.', 'On the computer running QuorX, open ⚙ Settings → About → Other devices and open the pairing link on this device (copy it, or type it). You only do this once.');
}

/** The addresses other devices can use, each with the pairing link (for Settings, on this computer only). */
export function accessInfo(port) {
  const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === 'IPv4').map((a) => a.address);
  return { lan: state.lan, links: ips.map((ip) => ({ ip, url: `http://${ip}:${port}/?pair=${state.token}` })) };
}
export function setLan(on) { state = save({ ...state, lan: !!on }); return state.lan; }
/** A new pairing link: every device paired with the old one is signed out. */
export function resetToken() { state = save({ ...state, token: newToken() }); }
/** This computer's own addresses, so the agent's browser can't reach the harness through them. */
export const ownAddresses = () => new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a) => a.address.toLowerCase()));
