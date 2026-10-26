// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Hooks: commands the user chooses that the harness runs around the agent's tool calls ("after every file write,
// run npm run lint"; "before a command, run X"). The model never decides to run them and can't change them.
// They live in QuorX's data folder, keyed by the project's real folder like its command rules
// (server/cmdpolicy.js), so a folder you open can't bring hooks of its own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';
import { realish } from './workspace.js';

// before_command: after the agent's command is approved, before it runs (a failure can stop it).
// after_command: after the agent's command ran. after_write: after write_file, edit_file or append_file.
export const HOOK_EVENTS = ['before_command', 'after_command', 'after_write'];
export const HOOK_MAX = 20, TIMEOUT_DEFAULT = 60, TIMEOUT_MAX = 600;

const hooksFile = (root) => path.join(HOME, 'data', 'project-hooks', `${crypto.createHash('sha256').update(realish(path.resolve(root)).toLowerCase()).digest('hex').slice(0, 32)}.json`);

export function cleanHook(h = {}) {
  const event = HOOK_EVENTS.includes(h.event) ? h.event : 'after_write';
  const t = Math.round(Number(h.timeout));
  return {
    id: /^[\w-]{1,40}$/.test(String(h.id || '')) ? String(h.id) : `h${crypto.randomBytes(4).toString('hex')}`,
    event,
    command: String(h.command || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500),
    // after_write: file patterns (comma-separated; empty = every file). Commands: a command pattern (empty = every command).
    match: String(h.match || '').trim().slice(0, 200),
    timeout: Number.isFinite(t) && t > 0 ? Math.min(TIMEOUT_MAX, t) : TIMEOUT_DEFAULT,
    // after_*: tell the agent when it fails. before_command: a failure stops the agent's command.
    feedback: h.feedback !== false,
    on: h.on !== false,
  };
}
export function loadHooks(root) {
  if (!root) return [];
  try { const j = JSON.parse(fs.readFileSync(hooksFile(root), 'utf8')); return (Array.isArray(j.hooks) ? j.hooks : []).map(cleanHook).filter((h) => h.command); } catch { return []; }
}
/** Replaces a project's hooks; their order is the order they run in. */
export function saveHooks(root, hooks) {
  const list = (Array.isArray(hooks) ? hooks : []).map(cleanHook).filter((h) => h.command);
  if (list.length > HOOK_MAX) throw new Error(`at most ${HOOK_MAX} hooks per project`);
  const f = hooksFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ version: 1, hooks: list }, null, 2));
  return list;
}

// A file pattern: * is anything but /, ** is anything; a pattern without / matches the file name in any folder.
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replaceAll('\u0000', '.*')}$`, 'i');
export function fileMatches(pattern, rel) {
  const pats = String(pattern || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!pats.length) return true;
  const p = String(rel || '').replaceAll('\\', '/').replace(/^\.\//, '');
  return pats.some((g) => (g.includes('/') ? globRe(g.replace(/^\.\//, '')).test(p) : globRe(g).test(p.split('/').pop())));
}
// A command pattern, like a command rule: "npm *" or "git commit*" (* is anything); empty = every command.
export function commandMatches(pattern, line) {
  const pats = String(pattern || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!pats.length) return true;
  const l = String(line || '').trim().replace(/\s+/g, ' ');
  return pats.some((g) => new RegExp(`^${g.replace(/\s+/g, ' ').replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(l));
}
/** The hooks that run for one event, in the user's order. */
export function matchHooks(hooks, event, { file, command } = {}) {
  return (hooks || []).filter((h) => h.on && h.event === event && (event === 'after_write' ? fileMatches(h.match, file) : commandMatches(h.match, command)));
}
// The agent chooses file names, so {file} is filled in only with a plain path: letters, digits, spaces and . / _ @ + , = -,
// no part starting with "-". Anything else (; & | $ ` quotes brackets…) could change what the hook's command line does, so
// the hook is skipped instead of quoting it for each shell.
export const safeHookFile = (rel) => { const f = String(rel || '').replaceAll('\\', '/'); return /^[\w./ @+,=-]+$/.test(f) && !f.split('/').some((p) => p.startsWith('-')); };
// {file} in a hook's command is the written file's path (quoted when it has spaces).
export function hookLine(h, { file } = {}) {
  const f = String(file || '').replaceAll('\\', '/');
  return h.command.replaceAll('{file}', /\s/.test(f) ? `"${f}"` : f);
}
