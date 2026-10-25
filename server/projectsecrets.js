// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A project's own secrets (.env, private keys): the agent knows their names, the commands and servers it starts get
// their values, and the model never sees them. read_file and search_files show .env files as names only, every tool
// result is cleaned of the values before it goes to the model, and request_secret lets the user type a missing one
// into the page (it goes straight into .env).
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_FILE, redactSecrets } from './secrets.js';

// Templates meant to be committed and read: .env.example and the like hold placeholders, not secrets.
const TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;
// Secret files made of NAME=value lines: shown as their names.
const ENV_STYLE = /(^|\/)(\.env(\.[\w.-]+)?|[^/]*secrets?\.env|\.npmrc|\.pypirc|credentials(\.[\w]+)?)$/i;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
export const MASK = '••••';

const slashes = (p) => String(p || '').replace(/\\/g, '/').replace(/[. ]+(?=\/|$)/g, ''); // Windows drops trailing dots and spaces
/** 'env' for a .env-style secret file, 'file' for any other secret file, '' for an ordinary file. */
export function secretKind(...names) {
  for (const n of names.map(slashes)) {
    if (!n || TEMPLATE.test(n) || !SECRET_FILE.test(n)) continue;
    return ENV_STYLE.test(n) ? 'env' : 'file';
  }
  return '';
}
// What a non-.env secret file holds, for the one-line note.
function holds(name) {
  const n = slashes(name).toLowerCase();
  if (/\.(pem|key|ppk|asc)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(n)) return 'a private key';
  if (/\.(p12|pfx|jks|keystore)$/.test(n)) return 'a certificate store';
  if (/\.kdbx$/.test(n)) return 'a password database';
  if (/(\.netrc|\.htpasswd|\.git-credentials)$/.test(n)) return 'saved passwords';
  return 'secrets';
}

// One NAME=value line: [name, value] (quotes removed), or null for comments, blank lines and anything else.
const LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s?(.*)$/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s?(.*)$/;
function valueOf(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\(.)/g, (x, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
  }
  if (v.startsWith("'")) { const m = v.match(/^'([^']*)'/); if (m) return m[1]; }
  return v.replace(/\s+#.*$/, '').trim();
}
/** The NAME=value pairs of a .env text (KEY=VALUE, quotes, # comments; no ${…} expansion). */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(ENV_LINE);
    if (m) out[m[1]] = valueOf(m[2]);
  }
  return out;
}

/** What the agent sees of a secret file: names only for .env-style files, a one-line note for the rest. */
export function maskSecretText(name, text, kind = secretKind(name)) {
  if (kind !== 'env') return `This file holds a secret (${holds(name)}). QuorX doesn't show its contents.`;
  return String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => {
    if (/^\s*(#|;|\[|$)/.test(line)) return line; // comments, blank lines and [sections] stay
    const m = line.match(LINE);
    if (!m) return `${MASK} (a line that isn't NAME=value)`;
    const v = valueOf(m[2]), head = line.slice(0, line.search(/[=:]/) + 1);
    return v ? `${head}${MASK} (set, ${v.length} characters)` : `${head} (empty)`;
  }).join('\n');
}

// ---------- the values, for commands and for cleaning output ----------
const cache = new Map(); // file → { mtime, size, vars }
function readEnv(file) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  if (!st.isFile() || st.size > 1e6) return null;
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.vars;
  let vars = {};
  try { vars = parseEnv(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: nothing */ }
  cache.set(file, { mtime: st.mtimeMs, size: st.size, vars });
  return vars;
}
/** The variables a project's commands get: .env, then .env.local over it. */
export function projectEnv(root) {
  if (!root) return {};
  return { ...readEnv(path.join(root, '.env')), ...readEnv(path.join(root, '.env.local')) };
}
// Every value in the project's own .env files (.env, .env.local, .env.production…; not the templates).
function secretValues(root) {
  const vals = new Set(Object.values(projectEnv(root)));
  let names = [];
  try { names = fs.readdirSync(root).filter((f) => /^\.env\.[\w.-]+$/i.test(f) && !TEMPLATE.test(f)); } catch { /* no folder */ }
  for (const f of names) for (const v of Object.values(readEnv(path.join(root, f)) || {})) vals.add(v);
  // Short values ("true", "3000") are left alone: hiding them would hide ordinary words in the output.
  return [...vals].filter((v) => v && v.length >= 6).sort((a, b) => b.length - a.length);
}
/** The text with every value from the project's .env files, and anything that looks like a key, replaced. */
export function scrubSecrets(root, text) {
  let t = String(text ?? '');
  if (root) for (const v of secretValues(root)) if (t.includes(v)) t = t.split(v).join('[secret removed]');
  return redactSecrets(t).text;
}

// ---------- request_secret: the user types a value into the page; it goes into .env ----------
const quoteValue = (v) => (/^[^\s#"'\\=]*$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`);
const IGNORES_ENV = /^\/?(\.env\*?|\*\.env)$/;
/**
 * Writes NAME=value into the project's .env (made if missing; an existing NAME line is replaced) and, in a git
 * repository, adds .env to .gitignore when nothing there covers it yet. Returns { created, replaced, gitignored }.
 */
export function setSecret(root, name, value) {
  if (!ENV_NAME.test(String(name || ''))) throw new Error('not a valid variable name');
  const file = path.join(root, '.env');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const created = !text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `${name}=${quoteValue(String(value))}`;
  const lines = text ? text.split(/\r?\n/) : [];
  const at = lines.findIndex((l) => { const m = l.match(ENV_LINE); return m && m[1] === name && !/^\s*#/.test(l); });
  if (at >= 0) lines[at] = line;
  else { if (lines.length && lines.at(-1) === '') lines.pop(); lines.push(line, ''); }
  fs.writeFileSync(file, lines.join(eol));
  let gitignored = false;
  if (fs.existsSync(path.join(root, '.git'))) {
    const gi = path.join(root, '.gitignore');
    let g = '';
    try { g = fs.readFileSync(gi, 'utf8'); } catch { /* none yet */ }
    if (!g.split(/\r?\n/).some((l) => IGNORES_ENV.test(l.trim()))) {
      fs.writeFileSync(gi, `${g}${g && !/\n$/.test(g) ? '\n' : ''}.env\n`);
      gitignored = true;
    }
  }
  cache.delete(file);
  return { created, replaced: at >= 0, gitignored };
}
