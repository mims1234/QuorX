// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Sign in with OpenRouter (OAuth PKCE). The user approves on openrouter.ai, can set a spending limit for the new key
// there, and OpenRouter hands back a code that only this server can trade for the key: the code_verifier never leaves
// the server, and the page only gets the sign-in address, then asks how it went.
// Pages opened at localhost use a callback (/oauth/openrouter/callback). Pages opened from another device can't be
// called back, so OpenRouter shows the code and the user pastes it into the page.
import crypto from 'node:crypto';
import os from 'node:os';
import { addKey, setActive } from './keys.js';

const BASE = 'https://openrouter.ai';
const TTL = 10 * 60e3; // OpenRouter's codes last 10 minutes
const flows = new Map(); // id -> { verifier, state, created, status, error, label }
const b64url = (buf) => buf.toString('base64url');
const sweep = () => { for (const [id, f] of flows) if (Date.now() - f.created > TTL + 60e3) flows.delete(id); };

export function startSignIn(origin) {
  sweep();
  const id = b64url(crypto.randomBytes(12)), verifier = b64url(crypto.randomBytes(32)), state = b64url(crypto.randomBytes(16));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const local = /^http:\/\/(localhost|quorx\.localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(origin || ''));
  const label = `QuorX (${os.hostname()})`.slice(0, 60);
  const q = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', key_label: label });
  // Back to localhost even from quorx.localhost (server/access.js): the callback needs no sign-in, and OpenRouter
  // takes localhost addresses.
  if (local) { q.set('callback_url', `${String(origin).replace(/^http:\/\/quorx\.localhost/i, 'http://localhost')}/oauth/openrouter/callback`); q.set('state', state); }
  flows.set(id, { verifier, state, created: Date.now(), status: 'waiting', error: null, label });
  return { id, url: `${BASE}/auth?${q}`, mode: local ? 'callback' : 'code' };
}

export function signInStatus(id) {
  const f = flows.get(id);
  if (!f) return { status: 'error', error: 'This sign-in has expired. Start again.' };
  if (f.status === 'waiting' && Date.now() - f.created > TTL) { f.status = 'error'; f.error = 'The sign-in took longer than 10 minutes. Start again.'; }
  return { status: f.status, error: f.error };
}
export function cancelSignIn(id) { flows.delete(id); }

async function exchange(f, code) {
  if (f.status !== 'waiting') throw new Error(f.status === 'done' ? 'Already signed in.' : f.error || 'This sign-in has ended.');
  f.status = 'working'; // codes are single-use: never trade one twice
  try {
    const r = await fetch(`${BASE}/api/v1/auth/keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(code || '').trim(), code_verifier: f.verifier, code_challenge_method: 'S256' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.key) throw new Error(j.error?.message || j.message || `OpenRouter said HTTP ${r.status}`);
    const { id } = await addKey(j.key, f.label); // checks the key with OpenRouter too
    setActive(id);
    f.status = 'done';
  } catch (e) { f.status = 'error'; f.error = e.message; throw e; }
}

// From the callback: find the flow by its state (CSRF check), then trade the code.
export async function finishByCallback({ state, code, error }) {
  const f = [...flows.values()].find((x) => state && x.state === state);
  if (!f) return { ok: false, message: 'This sign-in link is not valid any more. Go back to QuorX and press Sign in with OpenRouter again.' };
  if (error || !code) { f.status = 'error'; f.error = 'Sign-in was cancelled on OpenRouter.'; return { ok: false, message: f.error }; }
  try { await exchange(f, code); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; }
}
// From the page, when OpenRouter showed the code instead of calling back.
export async function finishWithCode(id, code) {
  const f = flows.get(id);
  if (!f) throw new Error('This sign-in has expired. Start again.');
  if (!String(code || '').trim()) throw new Error('Paste the code OpenRouter shows.');
  await exchange(f, code);
}

// In the desktop app this tab is the user's own browser, which can't open QuorX's pages (they answer only QuorX's own
// windows): it says to go back to the QuorX window, with no link into QuorX.
export function callbackPage({ ok, message, desktop = false }) {
  const title = ok ? 'Signed in to OpenRouter' : 'Sign-in did not finish';
  const body = ok ? (desktop ? 'QuorX has its new key. Close this tab and go back to the QuorX window.' : 'QuorX has its new key and is ready. You can close this tab.')
    : desktop ? `${message} Close this tab and try again from the QuorX window.` : message;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QuorX</title>
<body style="font:16px/1.5 system-ui,sans-serif;background:#0b0f0d;color:#e7edea;max-width:560px;margin:0 auto;padding:40px 20px">
<p style="font:600 12px ui-monospace,Consolas,monospace;letter-spacing:.1em;color:${ok ? '#45c486' : '#ef6b6b'}">${ok ? '✓ DONE' : '⚠ NOT SIGNED IN'}</p>
<h2 style="margin:0 0 8px">${esc(title)}</h2><p style="color:#9fb0a8;margin:0 0 20px">${esc(body)}</p>
${desktop ? '' : '<a href="/" style="color:#4cc6d3">Back to QuorX</a>'}
${ok ? '<script>setTimeout(() => window.close(), 1500)</script>' : ''}</body>`;
}
