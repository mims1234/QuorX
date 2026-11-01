// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Signing in to an MCP server on the web (the MCP authorization spec: OAuth 2.1 with PKCE). Servers such as Notion,
// Linear or Sentry answer 401 until you sign in. QuorX finds the server's sign-in service from its metadata,
// registers itself there as "QuorX" (dynamic client registration), and opens the service's own sign-in page in your
// browser. The service sends the browser back to /oauth/mcp/callback with a code that only this server can trade for
// a token: the code_verifier never leaves it. Tokens are kept in data/mcp-auth.json, never sent to the page, and
// renewed with their refresh token before they run out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';
import { renameSoon } from './fsretry.js';

const FILE = () => path.join(HOME, 'data', 'mcp-auth.json');
const TTL = 10 * 60e3; // a sign-in left open longer than this is dropped
const flows = new Map(); // state -> { name, url, verifier, redirect, client, as, resource, created }
const b64url = (buf) => buf.toString('base64url');
const read = () => { try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
const write = (all) => { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(all, null, 2)); renameSoon(`${FILE()}.tmp`, FILE()); };
const getJson = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
const firstJson = async (urls) => { for (const u of urls) { try { return await getJson(u); } catch { /* the next place */ } } return null; };

/** Where a server's sign-in service is, from its 401 answer (WWW-Authenticate) and its metadata. */
export async function discover(serverUrl) {
  const u = new URL(serverUrl);
  let hint = '';
  try {
    const r = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":0,"method":"ping"}', signal: AbortSignal.timeout(15000) });
    hint = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate') || '')?.[1] || '';
  } catch { /* the well-known places below */ }
  const path0 = u.pathname.replace(/\/$/, '');
  const prm = await firstJson([hint, `${u.origin}/.well-known/oauth-protected-resource${path0}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean));
  const issuer = new URL(prm?.authorization_servers?.[0] || u.origin);
  const ip = issuer.pathname.replace(/\/$/, '');
  const as = await firstJson([`${issuer.origin}/.well-known/oauth-authorization-server${ip}`, `${issuer.origin}/.well-known/openid-configuration${ip}`, `${issuer.origin}${ip}/.well-known/openid-configuration`, `${issuer.origin}/.well-known/oauth-authorization-server`]);
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error('this server doesn\'t say how to sign in (no OAuth metadata). If it takes a key, add it as a header instead.');
  return { as, resource: prm?.resource || serverUrl, scopes: prm?.scopes_supported || as.scopes_supported || [] };
}

/** Starts signing in: → { url } to open in the browser. `origin`: this QuorX's address, for the way back. */
export async function startLogin(name, serverUrl, origin) {
  for (const [s, f] of flows) if (Date.now() - f.created > TTL) flows.delete(s);
  const { as, resource, scopes } = await discover(serverUrl);
  const redirect = `${String(origin).replace(/^http:\/\/quorx\.localhost/i, 'http://localhost')}/oauth/mcp/callback`;
  const saved = read()[name];
  let client = saved?.client && saved.redirect === redirect && saved.as?.token_endpoint === as.token_endpoint ? saved.client : null;
  if (!client) {
    if (!as.registration_endpoint) throw new Error('this server\'s sign-in service doesn\'t let new apps register, so QuorX can\'t sign in to it by itself.');
    const r = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ client_name: 'QuorX', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.client_id) throw new Error(`the sign-in service refused to register QuorX (${r.status}${j.error_description ? `: ${j.error_description}` : ''})`);
    client = { client_id: j.client_id, ...(j.client_secret ? { client_secret: j.client_secret } : {}) };
  }
  const verifier = b64url(crypto.randomBytes(32)), state = b64url(crypto.randomBytes(16));
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource });
  if (scopes.length) q.set('scope', scopes.join(' '));
  flows.set(state, { name, url: serverUrl, verifier, redirect, client, as: { token_endpoint: as.token_endpoint }, resource, created: Date.now() });
  return { url: `${as.authorization_endpoint}${as.authorization_endpoint.includes('?') ? '&' : '?'}${q}` };
}
async function tokenCall(endpoint, params, client) {
  const body = new URLSearchParams({ ...params, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) });
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `the sign-in service answered ${r.status}`);
  return { access_token: j.access_token, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}), expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : 0 };
}
/** The browser came back with a code: trade it for a token. → { ok, name, message }. */
export async function finishLogin({ state, code, error }) {
  const f = state && flows.get(state);
  if (!f) return { ok: false, message: 'This sign-in has run out or was already used. Start it again from QuorX.' };
  flows.delete(state);
  if (error || !code) return { ok: false, name: f.name, message: `The sign-in was not finished${error ? ` (${error})` : ''}.` };
  try {
    const token = await tokenCall(f.as.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: f.redirect, code_verifier: f.verifier, resource: f.resource }, f.client);
    const all = read();
    all[f.name] = { url: f.url, redirect: f.redirect, client: f.client, as: f.as, resource: f.resource, token, at: Date.now() };
    write(all);
    return { ok: true, name: f.name, message: `QuorX is signed in to ${f.name}.` };
  } catch (e) { return { ok: false, name: f.name, message: `The sign-in did not finish: ${e.message}.` }; }
}
/** The token to send to a server, renewed first when it is about to run out; '' when not signed in (for that address). */
// Tool calls run at once: they share one renewal per server, since a service that hands out a new refresh token with
// each renewal refuses the old one the second time.
const renewing = new Map(); // name -> the renewal under way (a promise of the token, '' when it failed)
export async function tokenFor(name, serverUrl) {
  const a = read()[name];
  if (!a?.token?.access_token || a.url !== serverUrl) return '';
  if (!(a.token.expires_at && a.token.expires_at - Date.now() < 60e3 && a.token.refresh_token)) return a.token.access_token;
  if (!renewing.has(name)) renewing.set(name, renew(name, a).finally(() => renewing.delete(name)));
  return renewing.get(name);
}
async function renew(name, a) {
  try {
    const token = { refresh_token: a.token.refresh_token, ...(await tokenCall(a.as.token_endpoint, { grant_type: 'refresh_token', refresh_token: a.token.refresh_token, resource: a.resource }, a.client)) };
    const all = read(); // read again: another server may have renewed (or you signed out) meanwhile
    if (all[name]?.url !== a.url) return '';
    all[name] = { ...all[name], token };
    write(all);
    return token.access_token;
  } catch { return ''; } // renewing failed: sign in again
}
/** Whether QuorX holds a sign-in for this server (for its address). */
export const signedIn = (name, serverUrl) => { const a = read()[name]; return !!(a?.token?.access_token && a.url === serverUrl); };
/** Forgets a server's sign-in (QuorX's side: the service may keep QuorX listed until you remove it there). */
export function signOut(name) { const all = read(); if (!all[name]) return false; delete all[name]; write(all); return true; }
/** The page shown after the browser comes back. */
export function loginPage({ ok, message, desktop = false }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>QuorX</title>
<body style="font:16px/1.5 system-ui,sans-serif;background:#0b0f0d;color:#e7edea;max-width:560px;margin:0 auto;padding:40px 20px">
<p style="font:600 12px ui-monospace,Consolas,monospace;letter-spacing:.1em;color:${ok ? '#45c486' : '#ef6b6b'}">${ok ? '✓ SIGNED IN' : '⚠ NOT SIGNED IN'}</p>
<h2 style="margin:0 0 8px">${esc(message)}</h2><p style="color:#9fb0a8;margin:0 0 20px">${ok ? (desktop ? 'Close this tab and go back to the QuorX window: its tools are ready.' : 'You can close this tab.') : 'Close this tab and try again from QuorX.'}</p>
${ok ? '<script>setTimeout(() => window.close(), 1500)</script>' : ''}</body>`;
}
