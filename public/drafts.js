// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Unsent drafts: what you typed in a chat's message box (and Home's) and did not send yet, kept in this browser's
// storage so a restart, a crash or opening another chat never loses it. One entry per chat: the text and the
// attachments that can come back as they were (chats, files and projects added with @, and attached files that were
// already read). Pictures and screenshot comments are left out: they are large, and they stay while the page is open.
// No page code here (app.js stores and draws them), so the rules below are tested on their own.

export const DRAFTS_KEY = 'qx.drafts';
export const DRAFT_MAX = 200; // chats with a draft; past it the oldest go
export const DRAFT_DAYS = 30; // a draft not touched for this long goes (a chat deleted elsewhere leaves one behind)
const TEXT_MAX = 100000;

const keepCtx = (x) => x && typeof x === 'object' && ['chat', 'file', 'project'].includes(x.type) && typeof x.title === 'string';
// An attached file comes back only once it was read (it has its id on the server); one still being read does not.
const keepDoc = (d) => d && typeof d === 'object' && d.id && !d.busy;
const slimDoc = (d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => !k.startsWith('_') && k !== 'busy' && v !== undefined && typeof v !== 'function'));

/** What is worth keeping of a message box: { text, ctx, docs } → the same, cleaned, or null when there is nothing. */
export function cleanDraft(d) {
  if (!d || typeof d !== 'object') return null;
  const text = typeof d.text === 'string' ? d.text.slice(0, TEXT_MAX) : '';
  const ctx = (Array.isArray(d.ctx) ? d.ctx : []).filter(keepCtx).map((x) => ({ ...x }));
  const docs = (Array.isArray(d.docs) ? d.docs : []).filter(keepDoc).map(slimDoc);
  if (!text.trim() && !ctx.length && !docs.length) return null;
  return { text, ...(ctx.length ? { ctx } : {}), ...(docs.length ? { docs } : {}) };
}

/** The drafts with one chat's changed: a new draft is stamped with `now`; an empty one removes the chat's entry.
 *  Past DRAFT_MAX the oldest go. Returns a new object (the one passed in is left as it was). */
export function putDraft(all, id, d, now = Date.now()) {
  const out = { ...(all || {}) };
  const clean = cleanDraft(d);
  if (clean) out[id] = { ...clean, at: now }; else delete out[id];
  const ids = Object.keys(out);
  if (ids.length > DRAFT_MAX) for (const k of ids.sort((a, b) => (out[a].at || 0) - (out[b].at || 0)).slice(0, ids.length - DRAFT_MAX)) delete out[k];
  return out;
}

/** Drafts read back from storage: only well-formed ones, none older than DRAFT_DAYS. */
export function liveDrafts(all, now = Date.now()) {
  const out = {};
  if (!all || typeof all !== 'object') return out;
  for (const [id, d] of Object.entries(all)) {
    const clean = cleanDraft(d);
    if (clean && now - (Number(d.at) || 0) < DRAFT_DAYS * 864e5) out[id] = { ...clean, at: Number(d.at) };
  }
  return out;
}

/** The same draft as the message box holds now? (Saves nothing when only the stamp would change.) */
export const sameDraft = (a, b) => JSON.stringify(cleanDraft(a)) === JSON.stringify(cleanDraft(b));

/** A short line of a draft for lists: its first words, else what is attached. */
export function draftLine(d, max = 60) {
  const t = String(d?.text || '').replace(/\s+/g, ' ').trim();
  if (t) return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  const n = (d?.ctx?.length || 0) + (d?.docs?.length || 0);
  return n ? `${n} attachment${n === 1 ? '' : 's'}` : '';
}
