// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Settings tab's map: its three scopes, the pages of each and the groups they sit in, the old page names that
// still open the right page, what a row's default is (for the dot and ↺ on a changed row), and the read-only
// settings file. Every function here is pure, so it can be tested without a page; app.js draws the pages.

// ---------- scopes ----------
// App: every project. Project: the project picked (it replaced the project settings window and its three windows).
// This chat: what the chat on screen has set in its message box, read only, each with "Change in chat".
export const SCOPES = [['app', 'App'], ['project', 'Project'], ['chat', 'This chat']];
export const isScope = (s) => SCOPES.some(([k]) => k === s);

// ---------- the App pages, in groups ----------
// [group, [[id, icon, label, only]]]: only 'desk' shows a page in the desktop app alone (its rows come from there).
// MCP servers, Skills and Usage & costs stay here until their places in the shell take them over.
export const SETTINGS_NAV = [
  ['General', [['setup', '🧪', 'Setup check'], ['appearance', '🎨', 'Appearance'], ['privacy', '🕶', 'Privacy & display'], ['window', '🪟', 'Window & layout']]],
  ['Models', [['providers', '🔌', 'Providers & keys'], ['limits', '🛟', 'Fallbacks & limits']]],
  ['Agent', [['newchats', '✨', 'New chats'], ['loop', '🔁', 'Agent loop'], ['deciders', '⚖️', 'Deciders'], ['tools', '🧰', 'Tools & media'], ['video', '🎬', 'Video'], ['memory', '📌', 'Memory'], ['skills', '🧩', 'Skills'], ['mcp', '🧲', 'MCP servers']]],
  ['Safety', [['safety', '🛡', 'Approvals & safety'], ['perms', '🔐', 'Permissions'], ['letthrough', '⚡', 'Let through in YOLO'], ['budget', '💵', 'Budget']]],
  ['Workspace', [['projects', '📁', 'Projects'], ['servers', '🖥', 'Servers & pages'], ['terminal', '⌨', 'Terminal'], ['browser', '🌐', 'Browser'], ['docs', '📎', 'Documents'], ['design', '🖌', 'Design system']]],
  ['Keyboard', [['shortcuts', '⌨️', 'Shortcuts']]],
  ['Data', [['storage', '🧹', 'Storage'], ['backup', '🗄', 'Backup'], ['usage', '📊', 'Usage & costs'], ['updates', '⬆', 'Updates', 'desk'], ['about', 'ℹ️', 'About']]],
];
/** The groups with only the pages this copy has (desk: running in the desktop app). */
export const navFor = (desk) => SETTINGS_NAV.map(([g, items]) => [g, items.filter((it) => it[3] !== 'desk' || desk)]).filter(([, items]) => items.length);
/** Every page, in order: [{ id, icon, label, group }]. */
export const pagesFor = (desk) => navFor(desk).flatMap(([group, items]) => items.map(([id, icon, label]) => ({ id, icon, label, group })));

// Old page names (links, history entries, other parts of QuorX) land on the page that holds those rows now.
export const PAGE_ALIAS = { keys: 'providers', sources: 'providers', models: 'providers', data: 'backup', code: 'browser', general: 'appearance' };
/** The page to open for a name: itself, its new home, or the first page. */
export function resolvePage(id, desk = false) {
  const pages = pagesFor(desk), want = PAGE_ALIAS[id] || id;
  return pages.some((p) => p.id === want) ? want : (want === 'updates' ? 'about' : pages[0].id);
}

// ---------- the Project pages ----------
// Overview: name, colour, pin, folder, GitHub, the agent folder, what each chat cost, archive and delete.
export const PROJECT_PAGES = [['overview', '📁', 'Overview'], ['design', '🖌', 'Design system'], ['hooks', '⚡', 'Hooks'], ['perms', '🔐', 'Permissions']];
export const resolveProjectPage = (id) => (PROJECT_PAGES.some(([k]) => k === id) ? id : 'overview');

// ---------- a row's default: the dot on a changed row, and its ↺ ----------
/**
 * The value a row has when nobody changed it, or undefined when QuorX can't say (that row gets no dot and no ↺).
 * bind is the row's data-bind path ("maxSteps", "ui.density", "safety.timeout"); ui.* comes from the page's own UI
 * defaults, everything else from the server's defaults.
 */
export function rowDefault(bind, defaults = {}, uiDefaults = {}) {
  if (!bind || typeof bind !== 'string') return undefined;
  const at = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
  const v = bind.startsWith('ui.') ? at(uiDefaults, bind.slice(3)) : at(defaults, bind);
  return v === null || typeof v === 'object' ? undefined : v;
}
/** Whether a value differs from its default (an unset value is the default; "5" and 5 are the same). */
export function isModified(value, def) {
  if (def === undefined || value === undefined || value === null || value === '') return false;
  if (typeof def === 'boolean') return Boolean(value) !== def;
  if (typeof def === 'number') return Number(value) !== def;
  return String(value) !== String(def);
}

// ---------- search ----------
/** Words of a search, lower case; a row matches when it has every word. */
export const searchWords = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
export const rowMatches = (text, words) => { const t = String(text || '').toLowerCase(); return words.every((w) => t.includes(w)); };

// ---------- the settings file ----------
// What QuorX › Open settings file shows: the settings as JSON, read only. Anything that looks like a key, token,
// secret or password is left out (keys live with the server anyway), and so is what the page keeps for itself.
// (A setting like inlineDocTokens counts tokens; it is no secret and stays.)
const SECRET = /(api.?key|secret|passw(or)?d|credential|(access|auth|refresh|bearer|session|api|github|gh).?token)/i;
export const isSecretKey = (k) => SECRET.test(k) || /^(key|token|pat)$/i.test(k);
export function settingsFile(settings, theme = null) {
  const clean = (v) => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !isSecretKey(k)).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return JSON.stringify({ theme: theme || 'system', ...clean(settings || {}) }, null, 2);
}
