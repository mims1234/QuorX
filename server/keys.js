// OpenRouter keys: the one in .env plus any the user adds in ⚙ Settings. Keys live only in
// data/keys.json on this computer; the page only ever sees them masked, and agent processes never get them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.OH_HOME ? path.resolve(process.env.OH_HOME) : ROOT; // see openrouter.js
const DATA = path.join(HOME, 'data');
const FILE = path.join(DATA, 'keys.json');
const USAGE = path.join(DATA, 'key-usage.json');
// Files the agent's file tools and the /ws file server must never read, whatever folder a project points at.
export const SECRET_FILES = [path.join(ROOT, '.env'), path.join(HOME, '.env'), FILE, USAGE, path.join(DATA, 'app-key'), path.join(DATA, 'access.json')];
const BASE = 'https://openrouter.ai';

// The data folder (keys, the app key, chats) and .env belong to this account only. On a second drive Windows lets
// every signed-in user change new folders, and elsewhere the default lets others read them.
export function lockDown() {
  const targets = [DATA, path.join(HOME, '.env'), path.join(ROOT, '.env')].filter((p, i, a) => a.indexOf(p) === i && fs.existsSync(p));
  for (const p of targets) {
    try {
      if (process.platform === 'win32') {
        const who = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME || ''}`;
        if (!process.env.USERNAME) continue;
        // The folder only: files inside inherit its two entries. (/T rewrote each file with folder-only flags, which
        // left files with no entries at all.)
        const dir = fs.statSync(p).isDirectory();
        spawnSync('icacls', [p, '/inheritance:r', '/grant:r', `${who}:${dir ? '(OI)(CI)F' : 'F'}`, '/grant:r', `SYSTEM:${dir ? '(OI)(CI)F' : 'F'}`, '/Q'], { windowsHide: true, timeout: 20000 });
      } else fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o700 : 0o600);
    } catch { /* best effort: QuorX still runs */ }
  }
}
const envKey = () => process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_BOT || '';
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { active: null, keys: [] }; }
}
function save(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}
// Every key, .env first (it can be switched away from, not removed).
function all() {
  const s = load();
  const list = s.keys.map((k) => ({ ...k, source: 'added' }));
  if (envKey()) list.unshift({ id: 'env', label: s.envLabel || 'From .env', key: envKey(), source: 'env', added: 0 });
  return { s, list };
}
const mask = (k) => `${k.slice(0, 9)}••••••••${k.slice(-4)}`;

export function activeKey() {
  const { s, list } = all();
  return (list.find((k) => k.id === s.active) || list[0])?.key || '';
}
export function listKeys() {
  const { s, list } = all();
  const active = (list.find((k) => k.id === s.active) || list[0])?.id;
  return list.map((k) => ({ id: k.id, label: k.label, masked: mask(k.key), source: k.source, added: k.added, active: k.id === active }));
}
const keyById = (id) => all().list.find((k) => k.id === id);

// OpenRouter's own numbers for one key.
export async function fetchKeyInfo(key) {
  const r = await fetch(`${BASE}/api/v1/key`, { headers: { Authorization: `Bearer ${key}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `OpenRouter said HTTP ${r.status}`);
  const d = j.data || {};
  return { orLabel: d.label || null, limit: d.limit ?? null, remaining: d.limit_remaining ?? null, usage: d.usage ?? null,
    today: d.usage_daily ?? null, week: d.usage_weekly ?? null, month: d.usage_monthly ?? null, freeTier: !!d.is_free_tier };
}

export async function addKey(key, label) {
  key = String(key || '').trim();
  if (!/^sk-or-[A-Za-z0-9_-]{10,}$/.test(key)) throw new Error('That does not look like an OpenRouter key (it starts with sk-or-).');
  if (all().list.some((k) => k.key === key)) throw new Error('This key is already added.');
  const info = await fetchKeyInfo(key).catch((e) => { throw new Error(`OpenRouter did not accept this key (${e.message})`); });
  const s = load();
  const id = `k${crypto.randomBytes(5).toString('hex')}`;
  s.keys.push({ id, label: String(String(label || '').trim() || info.orLabel || `Key ${s.keys.length + 1}`).slice(0, 60), key, added: Date.now() });
  if (!s.active && !envKey()) s.active = id;
  save(s);
  sample(id, info.usage);
  return { id, info };
}
export function removeKey(id) {
  if (id === 'env') throw new Error('The .env key is removed by editing .env.');
  const s = load();
  s.keys = s.keys.filter((k) => k.id !== id);
  if (s.active === id) s.active = null;
  save(s);
  const u = loadUsage(); delete u[id]; saveUsage(u);
}
export function setActive(id) {
  if (!keyById(id)) throw new Error('no such key');
  const s = load(); s.active = id; save(s);
}
// Any key can be named, the .env one too (its name is kept here; the key itself stays in .env).
export function renameKey(id, label) {
  const name = String(label || '').trim().slice(0, 60);
  if (!name) throw new Error('Give the key a name.');
  const s = load();
  if (id === 'env') { if (!envKey()) throw new Error('no .env key'); s.envLabel = name; return save(s); }
  const k = s.keys.find((x) => x.id === id);
  if (!k) throw new Error('no such key');
  k.label = name; save(s);
}

// ---------- usage over time ----------
// OpenRouter reports a key's total, today, this week and this month. For rolling windows
// (1 h, 3 h, 24 h, 3 d, 7 d) the harness samples each key's running total and takes differences.
// A window longer than the samples we have is marked partial, with the time it starts from.
function loadUsage() { try { return JSON.parse(fs.readFileSync(USAGE, 'utf8')); } catch { return {}; } }
function saveUsage(u) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(USAGE, JSON.stringify(u)); }
function sample(id, usage) {
  if (usage == null) return;
  const u = loadUsage(), list = (u[id] ||= []), now = Date.now(), last = list.at(-1);
  if (last && now - last[0] < 4 * 60e3 && last[1] === usage) return;
  list.push([now, usage]);
  u[id] = list.filter(([t]) => now - t < 8 * 864e5);
  saveUsage(u);
}
const WINDOWS = { h1: 3600e3, h3: 3 * 3600e3, d1: 864e5, d3: 3 * 864e5, d7: 7 * 864e5 };
function windows(id, usage) {
  const list = loadUsage()[id] || [], now = Date.now(), out = {};
  for (const [k, ms] of Object.entries(WINDOWS)) {
    const from = now - ms;
    const before = [...list].reverse().find(([t]) => t <= from);
    const base = before || list[0];
    out[k] = base ? { value: Math.max(0, usage - base[1]), partial: !before, since: base[0] } : null;
  }
  return out;
}
export async function keyUsage(id) {
  const k = keyById(id);
  if (!k) throw new Error('no such key');
  const info = await fetchKeyInfo(k.key);
  sample(id, info.usage);
  return { ...info, windows: info.usage == null ? {} : windows(id, info.usage), checked: Date.now() };
}
export async function activeUsage() {
  const keys = listKeys(), a = keys.find((k) => k.active);
  if (!a) throw new Error('no key');
  return { id: a.id, label: a.label, ...(await keyUsage(a.id)) };
}
// Account-wide credits (all keys on the account), when OpenRouter allows this key to read them.
export async function accountCredits() {
  const key = activeKey();
  if (!key) throw new Error('no key');
  const r = await fetch(`${BASE}/api/v1/credits`, { headers: { Authorization: `Bearer ${key}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `OpenRouter said HTTP ${r.status}`);
  return { total: j.data?.total_credits ?? null, used: j.data?.total_usage ?? null, checked: Date.now() };
}
// While the harness runs, sample every key every 10 minutes so the short windows have data.
export function startSampling() {
  const tick = () => { for (const k of listKeys()) keyUsage(k.id).catch(() => {}); };
  setTimeout(tick, 5e3);
  setInterval(tick, 10 * 60e3).unref();
}
