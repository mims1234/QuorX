// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Helper roles: what a helper (the delegate tool) may do. Three come with QuorX and can be edited or reset; the user
// can add their own in ⚙ Settings → Agent loop → Helpers. Every role reads; a role may also run commands (through the
// same rule engine and approvals as the agent's own), use the browser, or write, but only in .quorx/scratch.
export const ROLE_CAN = ['read', 'commands', 'browser', 'scratch'];
export const ROLE_CONTEXT = ['fresh', 'summary']; // a clean context, or a short summary of this chat first
export const ROLE_MAX = 12;

export const HELPER_ROLES = [
  { id: 'explore', name: 'Explore', desc: 'Finds where things are and summarises files. Read-only.', can: ['read'], model: '', steps: 12, context: 'fresh', on: true, builtin: true },
  { id: 'test', name: 'Test', desc: 'Runs the tests or the app and reports what fails. Changes no files.', can: ['read', 'commands', 'browser'], model: '', steps: 16, context: 'summary', on: true, builtin: true },
  { id: 'draft', name: 'Draft', desc: 'Tries an idea in scratch files and reports what worked. Never touches project files.', can: ['read', 'commands', 'scratch'], model: '', steps: 16, context: 'summary', on: true, builtin: true },
];

const MODEL_ID = /^[\w.@:~-]+(\/[\w.@:~+-]+)+$/;
/** One role as saved: plain fields only, with read always included. */
export function cleanRole(r = {}, i = 0) {
  const base = HELPER_ROLES.find((x) => x.id === r.id);
  const id = /^[a-z][\w-]{0,23}$/.test(String(r.id || '')) ? String(r.id) : `role${i + 1}`;
  const can = [...new Set(['read', ...(Array.isArray(r.can) ? r.can : base?.can || []).filter((c) => ROLE_CAN.includes(c))])];
  const steps = Math.round(Number(r.steps));
  return {
    id,
    name: String(r.name || base?.name || id).replace(/[\r\n]+/g, ' ').trim().slice(0, 40) || id,
    desc: String(r.desc ?? base?.desc ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200),
    can,
    model: MODEL_ID.test(String(r.model || '').trim()) ? String(r.model).trim() : '',
    steps: Number.isFinite(steps) && steps > 0 ? Math.min(60, steps) : base?.steps || 12,
    context: ROLE_CONTEXT.includes(r.context) ? r.context : base?.context || 'fresh',
    on: r.on !== false,
    builtin: !!base,
  };
}
/** The roles a reply may use: the saved list (built-ins filled in when missing), only those switched on. */
export function rolesFrom(saved) {
  const list = (Array.isArray(saved) && saved.length ? saved : HELPER_ROLES).slice(0, ROLE_MAX).map(cleanRole);
  const ids = new Set();
  return list.filter((r) => !ids.has(r.id) && ids.add(r.id));
}
export const canWord = { read: 'read files', commands: 'run checked commands', browser: 'use the browser', scratch: 'write in .quorx/scratch only' };
