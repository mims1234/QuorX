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
// before_write: before one of those changes a file (a failure can stop it: "never touch migrations/").
// before_tool / after_tool: around any other tool, matched by its name (browser, fetch_url, an MCP tool…).
// reply_start: once when a reply starts; what it prints goes to the agent ("git status" every time).
// reply_end: when the agent gives its final reply; a failure sends the reply back to fix it ("npm test").
export const HOOK_EVENTS = ['before_write', 'after_write', 'before_command', 'after_command', 'before_tool', 'after_tool', 'reply_start', 'reply_end'];
// How the page and the agent name each event, and what a failing hook does there.
export const HOOK_WHEN = {
  before_write: 'before a file is written', after_write: 'after a file is written', before_command: 'before a command', after_command: 'after a command',
  before_tool: 'before a tool', after_tool: 'after a tool', reply_start: 'when a reply starts', reply_end: 'when a reply ends',
};
export const HOOK_BLOCKS = new Set(['before_write', 'before_command', 'before_tool']); // a failure stops what comes next
const FILE_EVENTS = new Set(['before_write', 'after_write']), TOOL_EVENTS = new Set(['before_tool', 'after_tool']), REPLY_EVENTS = new Set(['reply_start', 'reply_end']);
export const HOOK_MAX = 20, TIMEOUT_DEFAULT = 60, TIMEOUT_MAX = 600;

const hooksFile = (root) => path.join(HOME, 'data', 'project-hooks', `${crypto.createHash('sha256').update(realish(path.resolve(root)).toLowerCase()).digest('hex').slice(0, 32)}.json`);

export function cleanHook(h = {}) {
  const event = HOOK_EVENTS.includes(h.event) ? h.event : 'after_write';
  const t = Math.round(Number(h.timeout));
  return {
    id: /^[\w-]{1,40}$/.test(String(h.id || '')) ? String(h.id) : `h${crypto.randomBytes(4).toString('hex')}`,
    event,
    command: String(h.command || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500),
    // Writes: file patterns (comma-separated; empty = every file). Commands: a command pattern (empty = every command).
    // Tools: tool names, * allowed ("browser, mcp__*"; empty = every tool). Replies: not used.
    match: String(h.match || '').trim().slice(0, 200),
    timeout: Number.isFinite(t) && t > 0 ? Math.min(TIMEOUT_MAX, t) : TIMEOUT_DEFAULT,
    // after_*: tell the agent when it fails. before_*: a failure stops what comes next. reply_end: a failure sends the reply back.
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
// A tool pattern: names with * for anything ("browser, mcp__github__*"); empty = every tool.
export function toolMatches(pattern, name) {
  const pats = String(pattern || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!pats.length) return true;
  return pats.some((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(String(name || '')));
}
/** The hooks that run for one event, in the user's order. */
export function matchHooks(hooks, event, { file, command, tool } = {}) {
  return (hooks || []).filter((h) => h.on && h.event === event && (FILE_EVENTS.has(event) ? fileMatches(h.match, file) : TOOL_EVENTS.has(event) ? toolMatches(h.match, tool) : REPLY_EVENTS.has(event) ? true : commandMatches(h.match, command)));
}
// The agent chooses file names, so {file} is filled in only with a plain path: letters, digits, spaces and . / _ @ + , = -,
// no part starting with "-". Anything else (; & | $ ` quotes brackets…) could change what the hook's command line does, so
// the hook is skipped instead of quoting it for each shell.
export const safeHookFile = (rel) => { const f = String(rel || '').replaceAll('\\', '/'); return /^[\w./ @+,=-]+$/.test(f) && !f.split('/').some((p) => p.startsWith('-')); };
// {file} in a hook's command is the written file's path (quoted when it has spaces); {tool} the tool's name (letters,
// digits and _ only, or nothing).
export function hookLine(h, { file, tool } = {}) {
  const f = String(file || '').replaceAll('\\', '/');
  return h.command.replaceAll('{file}', /\s/.test(f) ? `"${f}"` : f).replaceAll('{tool}', /^\w+$/.test(String(tool || '')) ? String(tool) : '');
}
