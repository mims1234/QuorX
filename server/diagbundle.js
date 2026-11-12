// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ⚙ About → Report a problem: a zip of recent logs and versions, cleaned first, for a bug report. Contributors
// otherwise have to describe bugs from memory. Nothing here sends anything anywhere: the page shows what is inside,
// and the zip is written to a folder the user picks. API keys, tokens, emails, the Windows user name and local
// paths are replaced with tags like <key> or <path>, and every secret QuorX itself holds is removed by its value.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipBuffer } from './zip.js';

// How much of each log goes in: the end of it, where the problem just happened.
const TAIL_BYTES = 400 * 1024, TAIL_LINES = 3000;

// ---------- cleaning ----------
// Patterns for what must never leave the PC. Order matters: whole secrets first, then the softer shapes.
const PATTERNS = [
  ['key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['key', /\b(?:sk|pk|rk)-(?:or-|ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g],
  ['key', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|hf_[A-Za-z0-9]{20,}|r8_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,})\b/g],
  ['token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['token', /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi],
  // key=…, "apiKey": "…", password: … (the name stays, the value goes)
  ['token', /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token|authorization|cookie|sess(?:ion)?[_-]?id)["']?\s*[:=]\s*["']?)(?!<|Bearer\s|Basic\s)([^"'\s,;&}]{6,})/gi],
  // ?k=…&token=… in links (the harness prints its sign-in link once)
  ['token', /([?&](?:k|key|token|code|sig|signature|auth|access_token)=)[^&\s"'#]{6,}/gi],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  // Local paths: drive paths, network shares and home folders. Only the last part (a file name) stays.
  ['path', /\b[A-Za-z]:[\\/](?:[^\s"'<>|*?:\\/]+[\\/])*([^\s"'<>|*?:\\/]*)/g],
  ['path', /\\\\[^\s"'<>|\\]+\\[^\s"'<>|]+/g],
  ['path', /(?<![\w.])\/(?:home|Users|root|mnt|var\/folders)\/[^\s"'<>|]+/g],
  ['ip', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b(?<!\b127\.0\.0\.1)/g],
];
// The values QuorX itself keeps secret (its .env files, key store, app key, sign-ins): removed wherever they show up,
// whatever shape they have. Long enough to be a secret, not a common word.
export function secretValues(files = [], env = process.env) {
  const out = new Set();
  // Secret-shaped only (one run of key characters with letters and digits), so ordinary words, links and paths in
  // those files don't turn into <secret> all over the logs.
  const add = (v) => { v = String(v ?? '').trim(); if (v.length >= 12 && v.length <= 4096 && /^[A-Za-z0-9._~+/=:-]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/:\/\//.test(v)) out.add(v); };
  for (const [k, v] of Object.entries(env || {})) if (/key|token|secret|password|passwd|auth|cookie/i.test(k)) add(v);
  const walk = (x, depth = 0) => {
    if (depth > 6 || x == null) return;
    if (typeof x === 'string') return add(x);
    if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
    if (typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (typeof v === 'string' && /^(id|label|name|kind|type|url|created|at|provider|model)$/i.test(k)) continue; walk(v, depth + 1); }
  };
  for (const f of files) {
    let text = '';
    try { const st = fs.statSync(f); if (!st.isFile() || st.size > 2e6) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    try { walk(JSON.parse(text)); continue; } catch { /* not JSON */ }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?[A-Za-z_][\w.]*\s*=\s*(.*)$/);
      if (m) add(m[1].replace(/^["']|["']$/g, ''));
      else if (!/\s/.test(line.trim())) add(line); // a file holding just a key
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}
/**
 * Cleans one text. Returns { text, found: { key, token, email, path, user, ip, secret } } with how many of each were
 * replaced. `user` is the Windows user name (and any other names given), `secrets` the exact values to remove.
 */
export function scrub(text, { secrets = [], users = [], homes = [] } = {}) {
  let s = String(text ?? '');
  const found = { secret: 0, key: 0, token: 0, email: 0, path: 0, user: 0, ip: 0 };
  for (const v of secrets) { if (!v) continue; const parts = s.split(v); if (parts.length > 1) { found.secret += parts.length - 1; s = parts.join('<secret>'); } }
  // Folders named before the general path rule, so "the QuorX data folder" still reads as one.
  for (const [dir, tag] of homes) {
    if (!dir || dir.length < 4) continue;
    for (const form of new Set([dir, dir.replaceAll('\\', '/'), dir.replaceAll('\\', '\\\\')])) {
      const parts = s.split(form); if (parts.length > 1) { found.path += parts.length - 1; s = parts.join(tag); }
    }
  }
  for (const [kind, re] of PATTERNS) {
    s = s.replace(re, (m, a, b) => {
      if (kind === 'path') {
        if (/^<|^[A-Za-z]:[\\/]?$/.test(m)) return m;
        found.path++;
        const file = typeof a === 'string' ? a : '';
        return file && /\.[A-Za-z0-9]{1,8}$/.test(file) ? `<path>\\${file}` : '<path>';
      }
      found[kind]++;
      // Patterns with a kept prefix (key=, ?k=) keep the name and lose the value.
      if (kind === 'token' && typeof a === 'string' && (typeof b === 'string' || /[?&=:]\s*["']?$/.test(a))) return `${a}<${kind}>`;
      if (kind === 'token' && /^(Bearer|Basic|token)\s/i.test(m)) return `${m.split(/\s+/)[0]} <token>`;
      return `<${kind}>`;
    });
  }
  for (const u of users) {
    if (!u || u.length < 3) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi');
    s = s.replace(re, () => { found.user++; return '<user>'; });
  }
  return { text: s, found };
}

// ---------- what goes in ----------
function tail(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || !st.size) return null;
    const len = Math.min(st.size, TAIL_BYTES), buf = Buffer.alloc(len), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    let text = buf.toString('utf8');
    if (len < st.size) text = text.slice(text.indexOf('\n') + 1); // start on a whole line
    const lines = text.split('\n');
    if (lines.length > TAIL_LINES) text = lines.slice(-TAIL_LINES).join('\n');
    return { text, size: st.size, cut: len < st.size || lines.length > TAIL_LINES, mtime: st.mtime };
  } catch { return null; }
}
/** The log files a bundle reads, newest data folder first: [{ name in the zip, file on disk }]. */
export function logFiles({ home, desktopLog } = {}) {
  const logs = path.join(home, 'logs');
  const known = ['harness.log', 'runs.jsonl', 'checks.jsonl', 'decisions.jsonl', 'reviews.jsonl', 'approvals.jsonl', 'audit.jsonl'];
  const out = known.map((f) => ({ name: `logs/${f}`, file: path.join(logs, f) }));
  try { for (const f of fs.readdirSync(logs)) if (/\.(log|jsonl)$/i.test(f) && !known.includes(f)) out.push({ name: `logs/${f}`, file: path.join(logs, f) }); } catch { /* no logs yet */ }
  if (desktopLog) { out.push({ name: 'desktop/server.log', file: desktopLog }); out.push({ name: 'desktop/view-events.log', file: path.join(path.dirname(desktopLog), 'view-events.log') }); }
  return out;
}
/**
 * Builds the cleaned bundle in memory: { files: [{ name, size, kept, cut, found, text }], found (totals), name }.
 * `versions` is extra lines for versions.txt (QuorX, the desktop app); `secretFiles` the files whose values are removed.
 */
export function buildBundle({ home, desktopLog = '', versions = {}, secretFiles = [], env = process.env, now = new Date(), users } = {}) {
  const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  const opts = {
    secrets: secretValues(secretFiles, env),
    users: users || [user, env.USERNAME, env.USER].filter(Boolean),
    homes: [[home, '<QuorX data>'], [os.homedir(), '<home>'], [process.cwd(), '<QuorX app>']].filter(([d]) => d).sort((a, b) => b[0].length - a[0].length),
  };
  const files = [];
  const add = (name, text, meta = {}) => { const r = scrub(text, opts); files.push({ name, size: meta.size ?? Buffer.byteLength(String(text)), kept: Buffer.byteLength(r.text), cut: !!meta.cut, found: r.found, text: r.text }); };
  const info = { QuorX: versions.quorx || '?', ...(versions.desktop ? { 'Desktop app': versions.desktop } : {}), Node: process.version, ...(process.versions.electron ? { Electron: process.versions.electron } : {}),
    Windows: `${os.release()} (${os.arch()})`, Platform: process.platform, Memory: `${Math.round(os.totalmem() / 1e9)} GB, ${Math.round(os.freemem() / 1e9)} GB free`, CPUs: String(os.cpus()?.length || '?'),
    Uptime: `${Math.round(process.uptime() / 60)} min`, Made: now.toISOString(), ...(versions.extra || {}) };
  add('versions.txt', Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n');
  for (const { name, file } of logFiles({ home, desktopLog })) { const t = tail(file); if (t) add(name, t.text, t); }
  const found = {};
  for (const f of files) for (const [k, n] of Object.entries(f.found)) found[k] = (found[k] || 0) + n;
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const readme = `QuorX problem report, made ${now.toISOString()}.\n\nThe end of each log (at most ${TAIL_BYTES / 1024} KB or ${TAIL_LINES} lines), cleaned before it was saved: API keys, tokens, emails, the Windows user name and local paths are replaced with tags like <key>, <token>, <email>, <user> and <path>.\nNothing was sent anywhere. Read it before you share it.\n`;
  files.unshift({ name: 'README.txt', size: readme.length, kept: readme.length, cut: false, found: {}, text: readme });
  return { name: `quorx-report-${stamp}.zip`, files, found };
}
/** Writes the bundle as a zip into an existing folder; returns the file's full path. Never overwrites. */
export function saveBundle(bundle, folder) {
  const dir = String(folder || '').trim();
  if (!dir || !path.isAbsolute(dir)) throw new Error('Pick a folder to save the report in.');
  let st; try { st = fs.statSync(dir); } catch { throw new Error('That folder does not exist.'); }
  if (!st.isDirectory()) throw new Error('That is a file, not a folder.');
  let file = path.join(dir, bundle.name);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, bundle.name.replace(/\.zip$/, ` (${i}).zip`));
  fs.writeFileSync(file, zipBuffer(bundle.files.map((f) => ({ name: f.name, data: Buffer.from(f.text, 'utf8') }))), { flag: 'wx' });
  return file;
}
