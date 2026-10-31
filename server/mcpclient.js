// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// QuorX as an MCP client: the agent can use the tools of MCP servers you add, a program on this computer (stdio) or a
// server on the web (Streamable HTTP). They are kept in data/mcp.json; each chat ticks the ones it may use (the 🔌 row
// in the message box's settings). A server starts the first time a chat needs it and keeps running while QuorX does.
// Env values and headers can hold keys: the page only ever sees their names (a masked value saved back keeps the old).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME } from './openrouter.js';
import { renameSoon } from './fsretry.js';

const FILE = () => path.join(HOME, 'data', 'mcp.json');
export const MCP_MAX = 30, MASK = '••••••';
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0'; } })();
const PROTOCOL = '2025-06-18';
const OUT_CHARS = 30000;

// ---------- the saved list ----------
const text = (v, n = 2000) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);
const strMap = (o, n = 50) => Object.fromEntries(Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).slice(0, n)
  .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(k)).map(([k, v]) => [k, text(v, 4000)]));
/** One server as QuorX keeps it, or an error. `old`: the saved one, whose secret values a masked value keeps. */
export function cleanServer(s, old = null) {
  if (!s || typeof s !== 'object') throw new Error('Not a server.');
  const name = text(s.name, 40);
  if (!NAME.test(name)) throw new Error(`"${name}" can't be a server name: use letters, digits, - and _ (up to 40).`);
  const keep = (map, was) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === MASK && was?.[k] != null ? was[k] : v]));
  const base = { name, on: s.on !== false, ask: s.ask === 'always' ? 'always' : 'auto', note: text(s.note, 200) };
  if (s.url) {
    const url = text(s.url, 2000);
    let u; try { u = new URL(url); } catch { throw new Error(`${name}: "${url}" is not a web address.`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error(`${name}: the address must start with https:// (or http:// on this computer).`);
    return { ...base, type: 'http', url, headers: keep(strMap(s.headers), old?.headers) };
  }
  const command = text(s.command, 1000);
  if (!command) throw new Error(`${name}: give the command that starts it (e.g. npx) or its web address.`);
  const args = (Array.isArray(s.args) ? s.args : []).slice(0, 60).map((a) => text(a, 2000));
  return { ...base, type: 'stdio', command, args, env: keep(strMap(s.env), old?.env), cwd: text(s.cwd, 1000) };
}
function read() {
  try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(j.servers) ? j.servers.flatMap((s) => { try { return [cleanServer(s)]; } catch { return []; } }) : []; }
  catch { return []; }
}
function write(list) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify({ version: 1, servers: list }, null, 2));
  renameSoon(`${FILE()}.tmp`, FILE());
}
const masked = (map) => Object.fromEntries(Object.keys(map || {}).map((k) => [k, MASK]));
/** For the page: every server, its secret values masked, with whether it runs and its tools. */
export function listServers() {
  return read().map((s) => {
    const c = clients.get(s.name);
    return { ...s, ...(s.env ? { env: masked(s.env) } : {}), ...(s.headers ? { headers: masked(s.headers) } : {}),
      status: c?.state || 'stopped', error: c?.error || '', tools: (c?.tools || []).map((t) => ({ name: t.name, description: clipText(t.description, 300), readOnly: !!t.annotations?.readOnlyHint })) };
  });
}
/** Saves the whole list from the page (masked values keep what was there). A changed server restarts when next used. */
export function saveServers(list) {
  if (!Array.isArray(list)) throw new Error('Send a list of servers.');
  if (list.length > MCP_MAX) throw new Error(`Up to ${MCP_MAX} servers.`);
  const was = new Map(read().map((s) => [s.name, s]));
  const out = list.map((s) => cleanServer(s, was.get(String(s?.name || '').trim())));
  const names = out.map((s) => s.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`Two servers are called "${dup}".`);
  for (const s of out) { const o = was.get(s.name); if (o && JSON.stringify(o) !== JSON.stringify(s)) stopServer(s.name); }
  for (const n of was.keys()) if (!names.includes(n)) stopServer(n);
  write(out);
  return listServers();
}
/** Adds (or replaces) servers: from the agent's setup tool, or an "Add" on the page. */
export function addServers(list) {
  const cur = read(), by = new Map(cur.map((s) => [s.name, s]));
  for (const s of list) by.set(s.name, cleanServer(s, by.get(s.name)));
  return saveServers([...by.values()]);
}

// ---------- pasted setup: an mcpServers config, or a command line written for another tool ----------
const splitArgs = (line) => (String(line).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
/**
 * What a pasted setup adds, as servers: an "mcpServers" (or "servers", "mcp") JSON as Claude, Cursor, VS Code and
 * others write it, one server's JSON, or a line such as `claude mcp add name -- npx -y pkg`, `codex mcp add name -- …`
 * or `npx -y pkg`. → { servers, from } (from: the tool it was written for, when it says), or throws.
 */
export function parseSetup(input, name = '') {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a server config or the command that starts it.');
  const json = (() => { const i = raw.indexOf('{'), j = raw.lastIndexOf('}'); if (i < 0 || j <= i) return null; try { return JSON.parse(raw.slice(i, j + 1)); } catch { return null; } })();
  if (json) {
    const map = json.mcpServers || json.servers || json.mcp?.servers || json['mcp.servers'] || ((json.command || json.url) ? { [name || 'server']: json } : null);
    if (!map || typeof map !== 'object') throw new Error('That JSON has no "mcpServers" in it.');
    const servers = Object.entries(map).map(([n, v]) => cleanServer({ name: n.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40), command: v.command, args: v.args, env: v.env, cwd: v.cwd, url: v.url || v.serverUrl || v.httpUrl, headers: v.headers }));
    if (!servers.length) throw new Error('No servers in that config.');
    return { servers, from: json.mcpServers ? 'an mcpServers config' : 'a config' };
  }
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => /\bmcp\s+add\b|^(npx|uvx|node|python3?|docker|bunx|pnpm\s+dlx)\b|^https?:\/\//.test(l)) || raw;
  const add = line.match(/^(claude|codex|gemini|cursor|qwen|opencode|amp)\s+mcp\s+add\s+(.*)$/i);
  if (add) {
    const words = splitArgs(add[2]), env = {}, headers = {};
    let n = '', url = '', i = 0, transport = '';
    for (; i < words.length; i++) {
      const w = words[i];
      if (w === '--') { i++; break; }
      if (/^(-e|--env)$/.test(w)) { const [k, ...v] = String(words[++i] || '').split('='); if (k) env[k] = v.join('='); continue; }
      if (/^(-H|--header)$/.test(w)) { const [k, ...v] = String(words[++i] || '').split(':'); if (k) headers[k.trim()] = v.join(':').trim(); continue; }
      if (/^(-t|--transport)$/.test(w)) { transport = words[++i] || ''; continue; }
      if (/^(-s|--scope)$/.test(w)) { i++; continue; }
      if (w.startsWith('-')) continue;
      if (!n) { n = w; continue; }
      if (/^https?:\/\//.test(w)) { url = w; continue; }
      break;
    }
    const rest = words.slice(i);
    const server = url || /^(http|sse)$/i.test(transport) && /^https?:\/\//.test(rest[0] || '') ? { name: n || name, url: url || rest[0], headers } : { name: n || name, command: rest[0], args: rest.slice(1), env };
    return { servers: [cleanServer(server)], from: TOOL_NAME[add[1].toLowerCase()] || add[1] };
  }
  if (/^https?:\/\//.test(line)) return { servers: [cleanServer({ name: name || hostName(line), url: splitArgs(line)[0] })], from: '' };
  const words = splitArgs(line);
  const pkg = words.find((w, k) => k > 0 && !w.startsWith('-')) || words[0];
  return { servers: [cleanServer({ name: name || pkg.replace(/^@[^/]+\//, '').replace(/@.*$/, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 40) || 'server', command: words[0], args: words.slice(1) })], from: '' };
}
const TOOL_NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', qwen: 'Qwen Code', opencode: 'OpenCode', amp: 'Amp' };
const hostName = (u) => { try { return new URL(u).hostname.split('.').slice(-2, -1)[0] || 'server'; } catch { return 'server'; } };

// ---------- talking to a server ----------
const clients = new Map(); // name → { state, error, tools, call(method, params, ms), close() }
const clipText = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
// Windows starts npx, uvx and the like through their .cmd files, which need the shell; each argument is quoted for it.
const winQuote = (a) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

function stdioClient(s) {
  const env = { ...process.env, ...s.env };
  const win = process.platform === 'win32';
  const child = win ? spawn([s.command, ...s.args].map(winQuote).join(' '), [], { shell: true, env, cwd: s.cwd || HOME, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(s.command, s.args, { env, cwd: s.cwd || HOME, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0, buf = '', errTail = '', dead = null;
  const fail = (why) => { dead = why; for (const p of pending.values()) p.reject(new Error(why)); pending.clear(); };
  child.on('error', (e) => fail(`could not start ${s.command}: ${e.message}`));
  child.on('exit', (code) => fail(`the server stopped${code != null ? ` (exit ${code})` : ''}${errTail ? `: ${clipText(errTail.trim().split('\n').at(-1), 300)}` : ''}`));
  child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; } // a log line on stdout
      if (m.id != null && pending.has(m.id) && (m.result !== undefined || m.error)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message || 'error')) : p.resolve(m.result); }
      else if (m.id != null && m.method) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'QuorX does not offer that' } })}\n`); // e.g. sampling, roots
    }
  });
  const send = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch { /* exited */ } };
  return {
    call: (method, params, ms) => new Promise((resolve, reject) => {
      if (dead) return reject(new Error(dead));
      const id = ++seq, t = setTimeout(() => { pending.delete(id); reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)); }, ms);
      pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      send({ jsonrpc: '2.0', id, method, params });
    }),
    notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
    close: () => { try { child.stdin.end(); child.kill(); } catch { /* gone */ } },
    alive: () => !dead,
  };
}
function httpClient(s) {
  let session = '', seq = 0;
  const post = async (body, ms) => {
    const r = await fetch(s.url, { method: 'POST', signal: AbortSignal.timeout(ms), headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL, ...(session ? { 'Mcp-Session-Id': session } : {}), ...s.headers }, body: JSON.stringify(body) });
    session = r.headers.get('mcp-session-id') || session;
    if (r.status === 401 || r.status === 403) throw new Error(`the server refused QuorX (${r.status}): it needs a key or a sign-in in its headers`);
    if (!r.ok && r.status !== 202) throw new Error(`the server answered ${r.status}`);
    if (body.id == null) return null;
    const type = r.headers.get('content-type') || '', raw = await r.text();
    const msgs = type.includes('text/event-stream') ? raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } }).filter(Boolean) : [JSON.parse(raw)];
    const m = msgs.flat().find((x) => x?.id === body.id);
    if (!m) throw new Error('the server sent no answer');
    if (m.error) throw new Error(m.error.message || 'error');
    return m.result;
  };
  return {
    call: (method, params, ms) => post({ jsonrpc: '2.0', id: ++seq, method, params }, ms),
    notify: (method, params) => post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, 15000).catch(() => {}),
    close: () => { if (session) fetch(s.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': session, ...s.headers } }).catch(() => {}); },
    alive: () => true,
  };
}
/** The server running (started, introduced, its tools listed), or an error. Starts it the first time. */
export async function connect(name, { fresh = false } = {}) {
  const s = read().find((x) => x.name === name);
  if (!s) throw new Error(`no MCP server called "${name}"`);
  let c = clients.get(name);
  if (c && (fresh || !c.io?.alive?.())) { c.io?.close(); clients.delete(name); c = null; }
  if (c?.ready) return c.ready;
  c = { state: 'starting', error: '', tools: [] };
  clients.set(name, c);
  c.ready = (async () => {
    c.io = s.type === 'http' ? httpClient(s) : stdioClient(s);
    const init = await c.io.call('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'QuorX', version: VERSION } }, 60000);
    c.io.notify('notifications/initialized');
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await c.io.call('tools/list', cursor ? { cursor } : {}, 30000);
      tools.push(...(r?.tools || []).filter((t) => t?.name));
      if (!(cursor = r?.nextCursor)) break;
    }
    Object.assign(c, { state: 'running', tools: tools.slice(0, 200), server: init?.serverInfo || null, instructions: clipText(init?.instructions, 2000) });
    return c;
  })().catch((e) => { Object.assign(c, { state: 'error', error: clipText(e.message, 400) }); c.io?.close(); throw e; });
  return c.ready;
}
export function stopServer(name) { const c = clients.get(name); if (c) { c.io?.close(); clients.delete(name); } }
export function stopAll() { for (const n of [...clients.keys()]) stopServer(n); }
process.on('exit', stopAll);

// ---------- for the agent ----------
// A tool's name as the model sees it: mcp__<server>__<tool>, within the 64 characters providers allow.
export const toolName = (server, tool) => `mcp__${server}__${String(tool).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
/**
 * The tools of the servers a chat ticked (on, and that start): { defs (for the model), byName (name → the server and
 * tool), notes (servers that failed, for the agent and the page) }.
 */
export async function toolsFor(names = []) {
  const want = [...new Set((Array.isArray(names) ? names : []).map(String))].slice(0, MCP_MAX);
  const saved = new Map(read().map((s) => [s.name, s]));
  const defs = [], byName = new Map(), notes = [];
  await Promise.all(want.map(async (n) => {
    const s = saved.get(n);
    if (!s || !s.on) return;
    try {
      const c = await connect(n);
      for (const t of c.tools) {
        const name = toolName(n, t.name);
        if (byName.has(name)) continue;
        byName.set(name, { server: n, tool: t.name, readOnly: !!t.annotations?.readOnlyHint, ask: s.ask });
        const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
        defs.push({ type: 'function', function: { name, description: clipText(`[MCP server ${n}] ${t.description || t.title || t.name}`, 1000), parameters: { type: 'object', properties: {}, ...schema } } });
      }
    } catch (e) { notes.push(`${n}: ${clipText(e.message, 200)}`); }
  }));
  return { defs, byName, notes };
}
/** Runs one tool → the text the agent gets (an error starts with "Error:"). */
export async function callTool(server, tool, args, { ms = 180000 } = {}) {
  let c;
  try { c = await connect(server); } catch (e) { return `Error: the MCP server ${server} isn't running: ${e.message}`; }
  let r;
  try { r = await c.io.call('tools/call', { name: tool, arguments: args && typeof args === 'object' ? args : {} }, ms); }
  catch (e) { return `Error: ${server} ${tool} failed: ${e.message}`; }
  const parts = (r?.content || []).map((x) => (x?.type === 'text' ? x.text : x?.type === 'resource' ? x.resource?.text || `(a resource: ${x.resource?.uri || ''})` : x?.type === 'image' ? '(a picture, not shown)' : x?.type ? `(${x.type})` : '')).filter(Boolean);
  if (!parts.length && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
  const out = clipText(parts.join('\n\n') || '(no output)', OUT_CHARS);
  return r?.isError ? `Error: ${out}` : out;
}
