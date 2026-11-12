// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ---------- pages: what the agent shows you, apart from what runs the project ----------
// Two kinds of server. PROJECT servers live in .quorx/launch.json: only what runs the project itself (the dev server,
// the API, the game), started and stopped from 🖥. PAGES are plans, mockups, design previews and quick static
// previews: QuorX's own pages address serves them (/ws/<project>/<file>), always on, so there is no process to start
// and they never go in the launch file. preview_site adds one here; "Keep as project server" moves one to the launch
// file when the static site is the project itself.
//
// The list is kept in <project>/.quorx/pages.json (git-ignored with the rest of .quorx). Older versions saved every
// preview to the launch file as `node .quorx/serve.mjs <page>`; those entries move here once, with a notice and Undo.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceDir, safePath, saveLaunchConfig, launchConfigs, ensureAgentDir, forgetServer } from './workspace.js';

const FILE = '.quorx/pages.json';
const LAUNCH = '.quorx/launch.json';
const MAX = 200;
const SERVE = /^\.?[/\\]?\.quorx[/\\]serve\.mjs$/i;

const fwd = (p) => String(p || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
// A page is a file inside the project (no .. or outside paths), written with forward slashes.
const inside = (root, p) => {
  const e = fwd(p);
  if (!e || /(^|\/)\.\.(\/|$)/.test(e)) throw new Error('that page is outside the project folder');
  safePath(root, e);
  return e;
};
/** Whether a launch entry is one of the old static previews (it runs QuorX's own .quorx/serve.mjs). */
export const isPreviewEntry = (c) => !!c && /^node(\.exe)?$/i.test(String(c.command || '').trim()) && SERVE.test(String(c.args?.[0] || '').trim());
/** The address of a page on the pages server (the app puts the pages port in front). */
export const pagePath = (projectId, entry) => `/ws/${projectId}/${fwd(entry).split('/').map(encodeURIComponent).join('/')}`;

/** QuorX's small static server, copied into the project's .quorx (refreshed each time) for a project server that runs it. */
export function ensureServeScript(root) {
  ensureAgentDir(root);
  fs.copyFileSync(new URL('./serve-static.mjs', import.meta.url), path.join(root, '.quorx', 'serve.mjs'));
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function load(root) {
  const j = readJson(path.join(root, FILE));
  return { version: 1, migrated: !!j?.migrated, pages: Array.isArray(j?.pages) ? j.pages.filter((p) => p?.entry) : [], moved: j?.moved || null };
}
function save(root, st) {
  ensureAgentDir(root);
  fs.writeFileSync(path.join(root, FILE), JSON.stringify({ version: 1, migrated: st.migrated, pages: st.pages.slice(-MAX), ...(st.moved ? { moved: st.moved } : {}) }, null, 2));
}

/**
 * Moves the old preview entries (node .quorx/serve.mjs …) out of the launch file into the pages list, once per project.
 * Real servers are left exactly as they were. An unreadable launch file is not touched (and tried again next time).
 * Returns how many moved this time (0 when it already ran).
 */
export function migratePreviews(root, { stop } = {}) {
  const st = load(root);
  if (st.migrated) return 0;
  const lf = path.join(root, LAUNCH);
  let raw = null;
  // A folder QuorX never wrote to gets nothing from a look at its servers: no .quorx just for the mark. (Every save of
  // a launch entry makes .quorx first and marks the move done before it writes.)
  if (!fs.existsSync(path.dirname(lf))) return 0;
  if (fs.existsSync(lf)) {
    try { raw = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch { return 0; }
    if (!raw || typeof raw !== 'object' || (raw.configurations != null && !Array.isArray(raw.configurations))) return 0;
  }
  const list = raw?.configurations || [];
  const moved = [];
  list.forEach((c, index) => { if (isPreviewEntry(c)) moved.push({ index, config: c }); });
  st.migrated = true;
  if (moved.length) {
    const at = Date.now();
    for (const { config } of moved) {
      const entry = fwd(config.args?.[1] || 'index.html');
      if (st.pages.some((p) => p.entry === entry)) continue;
      st.pages.push({ entry, title: String(config.name || entry), at, from: 'moved' });
    }
    st.moved = { at, configs: moved, dismissed: false };
    fs.writeFileSync(lf, JSON.stringify({ ...raw, version: raw.version ?? 1, configurations: list.filter((c) => !isPreviewEntry(c)) }, null, 2));
    // A preview still running from the old entry has nothing to restart it now: the pages address serves it.
    for (const { config } of moved) stop?.(String(config.name || ''));
  }
  save(root, st);
  return moved.length;
}

const rootOf = (projectId) => workspaceDir(projectId);
const stopper = (projectId) => (name) => { if (name) forgetServer(projectId, name, 'you').catch(() => {}); };
/** The move above for a project, before anything reads or writes its launch file (a reply, the 🖥 list, a save): so an
 *  entry saved on purpose later (the static site is the project) is never taken for an old preview. */
export function migrateProject(projectId, { create = false } = {}) {
  try {
    const root = rootOf(projectId);
    if (create) ensureAgentDir(root);
    return migratePreviews(root, { stop: stopper(projectId) });
  } catch { return 0; }
}

/** The project's pages (newest first) and the "moved to Pages" notice while it can still be undone. */
export function listPages(projectId) {
  const root = rootOf(projectId);
  migratePreviews(root, { stop: stopper(projectId) });
  const st = load(root);
  const pages = st.pages.map((p) => ({ entry: p.entry, title: p.title || p.entry, at: p.at || 0, from: p.from || 'preview', url: pagePath(projectId, p.entry), missing: !fs.existsSync(path.join(root, p.entry)) }))
    .sort((a, b) => b.at - a.at);
  const notice = st.moved && !st.moved.dismissed && st.moved.configs?.length ? { count: st.moved.configs.length, at: st.moved.at, names: st.moved.configs.map((x) => String(x.config?.name || '')) } : null;
  return { pages, notice };
}

/** Adds a page (or brings an existing one to the top with its new title). */
export function addPage(projectId, { entry, title }) {
  const root = rootOf(projectId);
  ensureAgentDir(root);
  migratePreviews(root, { stop: stopper(projectId) });
  const st = load(root), e = inside(root, entry || 'index.html');
  const old = st.pages.find((p) => p.entry === e);
  st.pages = st.pages.filter((p) => p.entry !== e);
  st.pages.push({ entry: e, title: String(title || old?.title || e).slice(0, 120), at: Date.now(), from: old?.from === 'moved' ? 'moved' : 'preview' });
  save(root, st);
  return { entry: e, url: pagePath(projectId, e) };
}

export function removePage(projectId, entry) {
  const root = rootOf(projectId), st = load(root), e = fwd(entry);
  const n = st.pages.length;
  st.pages = st.pages.filter((p) => p.entry !== e);
  if (st.pages.length === n) return false;
  save(root, st);
  return true;
}

/** Undo for the move: the old entries go back into the launch file where they were; their pages leave the list. */
export function undoMove(projectId) {
  const root = rootOf(projectId), st = load(root);
  if (!st.moved?.configs?.length || st.moved.dismissed) return 0;
  const lf = path.join(root, LAUNCH);
  let raw = {};
  if (fs.existsSync(lf)) { try { raw = JSON.parse(fs.readFileSync(lf, 'utf8')) || {}; } catch { throw new Error('.quorx/launch.json is not valid JSON, so nothing was put back'); } }
  const list = Array.isArray(raw.configurations) ? [...raw.configurations] : [];
  const taken = (n) => list.some((c) => String(c?.name || '').toLowerCase() === String(n || '').toLowerCase());
  let back = 0;
  for (const { index, config } of [...st.moved.configs].sort((a, b) => a.index - b.index)) {
    if (taken(config.name)) continue;
    list.splice(Math.min(index, list.length), 0, config); back++;
  }
  ensureAgentDir(root);
  fs.writeFileSync(lf, JSON.stringify({ ...raw, version: raw.version ?? 1, configurations: list }, null, 2));
  const entries = new Set(st.moved.configs.map((x) => fwd(x.config?.args?.[1] || 'index.html')));
  st.pages = st.pages.filter((p) => !(p.from === 'moved' && entries.has(p.entry)));
  st.moved = null;
  save(root, st);
  return back;
}

/** The notice was read: it goes, and Undo with it. */
export function dismissMove(projectId) {
  const root = rootOf(projectId), st = load(root);
  if (!st.moved) return false;
  st.moved.dismissed = true;
  save(root, st);
  return true;
}

/**
 * "Keep as project server": the static site is the project itself, so it gets a launch entry (QuorX's small static
 * server, .quorx/serve.mjs) and leaves the pages list. The name is the one given, else "site", else site-<page>.
 */
export function keepAsServer(projectId, entry, name) {
  const root = rootOf(projectId), e = inside(root, entry || 'index.html');
  ensureAgentDir(root);
  migratePreviews(root, { stop: stopper(projectId) });
  if (!fs.existsSync(path.join(root, e))) throw new Error(`${e} is not in the project folder any more`);
  const taken = new Set(launchConfigs(projectId).map((c) => c.name.toLowerCase()));
  const same = launchConfigs(projectId).find((c) => isPreviewEntry(c) && fwd(c.args?.[1]) === e);
  let nm = String(name || '').trim();
  if (nm && taken.has(nm.toLowerCase()) && !(same && same.name.toLowerCase() === nm.toLowerCase())) throw new Error(`a project server named "${nm}" already exists`);
  if (!nm) {
    const base = e.replace(/\/?index\.html?$/i, '').replace(/\.html?$/i, '');
    const stem = base ? `site-${base.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page'}` : 'site';
    nm = same?.name || [stem, ...Array.from({ length: 20 }, (_, i) => `${stem}-${i + 2}`)].find((n) => !taken.has(n)) || `${stem}-${Date.now().toString(36)}`;
  }
  ensureServeScript(root);
  const config = saveLaunchConfig(projectId, { name: nm, command: 'node', args: ['.quorx/serve.mjs', e] });
  removePage(projectId, e);
  return config;
}
