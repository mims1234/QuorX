// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Permissions: one window for everything QuorX lets run without asking, in three scopes (this chat, this project,
// everywhere in QuorX), reached from the chat, Project settings → Permissions and ⚙ Settings → Approvals & safety; and
// the chat's own "what applies here" list. Nothing here changes what is allowed by itself: each row shows a permission
// that already exists and lets you narrow it, turn it off or remove it. Widening one (a folder from Read to Read +
// write, a new Allow) still needs the agent's card or a rule you type.
// The page passes its helpers in once (initPerms): app.js owns chats, settings and the other windows.

let H = null;
export function initPerms(helpers) { H = helpers; }

export const SCOPE = {
  chat: { label: 'This chat', short: 'Chat', ico: '<path d="M4 5h16v11H9l-5 4z"/>' },
  project: { label: 'This project', short: 'Project', ico: '<path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
  everywhere: { label: 'Everywhere in QuorX', short: 'Everywhere', ico: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>' },
};
// A scope's marker: its icon in its colour, with or without the name.
export const scopeMark = (s, bare = false, name = '') => `<span class="pmx-scope" data-scope="${s}" title="${H.esc(SCOPE[s].label)}"><svg viewBox="0 0 24 24" aria-hidden="true">${SCOPE[s].ico}</svg>${bare ? `<span class="sr">${H.esc(SCOPE[s].label)}</span>` : H.esc(name || SCOPE[s].label)}</span>`;
const EFFECT = { allow: 'Allow', ask: 'Ask me', deny: 'Deny', auto: 'Follows the mode' };
const KIND = { rule: 'Command rule', tool: 'Tool', app: 'App', folder: 'Folder', site: 'Chrome site', mcp: 'MCP server' };
const SITE = { never: ['chromeSitesNever', 'Never open', 'deny'], always: ['chromeSitesAlways', 'Always allowed', 'allow'], read: ['chromeSitesRead', 'Read-only', 'ask'] };
const SITE_HELP = { never: 'The agent may never open it in your Chrome.', always: 'Opens without the “your request didn’t name it” ask.', read: 'Typing outside a search box always asks you.' };
const APP_LEVELS = [['view', 'View'], ['click', 'Click'], ['full', 'Full']];

// What never changes, whatever the rules say: shown read-only at the bottom of the window.
const BUILT_IN = [
  ['Deny beats Ask beats Allow', 'Whatever the scope: a Deny everywhere wins over an Allow in this chat.'],
  ['Extreme commands always pause for you', 'In warning colours, in ⚡ YOLO too. No rule or decider lets them through.'],
  ['Some commands never get an “Allow always” button', 'Pushes and deploys, commands QuorX can’t read, deletes or writes outside the project, and anything that touches your keys. A rule for them has to be typed by you.'],
  ['YOLO ignores wildcard rules on interpreters', '<code>node *</code>, <code>python *</code> and the like each allow any code, so ⚡ YOLO checks those commands anyway.'],
  ['A site your request didn’t name asks', 'Before the agent opens it in your own Chrome, unless it is on your Always allowed list.'],
  ['Turn-on cards are buttons only', 'Computer use, Chrome, MCP setup and settings changes: typed words never switch them on.'],
];

const sites = (key) => String(H.G.settings?.[key] || '').split(',').map((x) => x.trim()).filter(Boolean);
const fmtDay = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const usedText = (x) => (x.hits ? `used ${x.hits}×${x.lastUsed ? ` · last ${H.ago(x.lastUsed)}` : ''}` : x.hits === 0 ? 'never used' : '');

// ---------- gathering: every permission as one kind of row ----------
// door: { kind: 'chat', chatId } | { kind: 'project', projectId } | { kind: 'settings' }
async function gather(door) {
  const chat = door.kind === 'chat' ? await H.getChat(door.chatId) : null;
  const projectId = door.kind === 'project' ? door.projectId : chat?.projectId || null;
  const pname = (id) => H.G.projects?.find((p) => p.id === id)?.name || 'Project';
  const [glob, projs, chats, mcp] = await Promise.all([
    H.getJ(`/api/permissions${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`),
    door.kind === 'settings' ? H.getJ('/api/permissions/projects') : null,
    door.kind === 'chat' ? null : H.getJ(`/api/permissions/chats${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`),
    H.getJ('/api/mcp'),
  ]);
  if (glob?.error) throw new Error(glob.error);
  const items = [];
  const ruleItem = (r, scope, extra = {}) => items.push({ kind: 'rule', scope, id: r.id, label: r.match, effect: r.effect || 'allow', on: r.on !== false, by: r.by, at: r.at, hits: r.hits || 0, lastUsed: r.lastUsed, problem: r.problem, from: r.from, rule: r, ...extra });
  for (const r of glob.everywhere || []) ruleItem(r, 'everywhere');
  if (door.kind === 'settings') for (const p of projs?.projects || []) for (const r of p.rules) ruleItem(r, 'project', { projectId: p.id, projectName: p.name });
  else if (projectId) for (const r of glob.project || []) ruleItem(r, 'project', { projectId, projectName: pname(projectId) });
  // A chat's own list: from the chat itself in the chat's door, from the server's copy in the others.
  const chatItems = (x) => {
    const base = { scope: 'chat', chatId: x.id, chatTitle: x.title, projectId: x.projectId };
    (x.cmdRules || []).forEach((r, i) => items.push({ ...base, kind: 'rule', id: r.id || `i${i}`, label: r.match, effect: r.effect || 'allow', on: r.on !== false, by: r.by || 'button', at: r.at, hits: r.hits || 0, lastUsed: r.lastUsed, rule: r }));
    for (const t of x.allowed || []) { const m = x.allowedMeta?.[t] || {}; items.push({ ...base, kind: 'tool', id: t, label: H.TOOL_NAME[t] || t, effect: 'allow', by: 'button', at: m.at, hits: m.hits, lastUsed: m.lastUsed }); }
    for (const a of x.apps || []) items.push({ ...base, kind: 'app', id: a.appId, label: a.name, effect: 'allow', by: 'button', level: a.level || 'full' });
    for (const f of x.folders || []) items.push({ ...base, kind: 'folder', id: f.path, label: f.path, effect: 'allow', by: 'button', access: f.access === 'write' ? 'write' : 'read' });
  };
  if (chat) chatItems({ id: chat.id, title: chat.title, projectId: chat.projectId, ...chat.agent, apps: chat.tools?.apps ? chat.agent.apps : [] });
  for (const x of chats?.chats || []) chatItems(x);
  for (const [k, [key, , eff]] of Object.entries(SITE)) for (const s of sites(key)) items.push({ kind: 'site', scope: 'everywhere', id: `${k}:${s}`, label: s, effect: eff, site: k, by: 'user' });
  for (const s of (Array.isArray(mcp?.servers) ? mcp.servers : []).filter((x) => x.on !== false)) items.push({ kind: 'mcp', scope: 'everywhere', id: s.name, label: s.name, effect: s.ask === 'always' ? 'ask' : 'auto', ask: s.ask === 'always' ? 'always' : 'auto', by: 'user', server: s });
  return { items, chat, projectId, projectName: projectId ? pname(projectId) : '' };
}

// ---------- one row ----------
function rowHTML(x) {
  const { esc } = H;
  const src = x.kind === 'site' ? SITE_HELP[x.site] : x.kind === 'mcp' ? (x.ask === 'always' ? 'Every call asks you, in ⚡ YOLO too.' : 'Strict asks before tools that change things; read-only ones and YOLO don’t ask.')
    : [x.by === 'button' ? (x.from?.chat ? `from a card in “${x.from.chat}”` : x.scope === 'chat' ? 'from a card in this chat' : 'from a card') : x.by === 'user' ? 'typed by you' : '',
      fmtDay(x.at), usedText(x), x.kind === 'app' ? 'computer use' : x.kind === 'folder' ? 'outside the project' : ''].filter(Boolean).join(' · ');
  const state = [x.on === false ? 'off' : 'on', x.kind === 'rule' && !x.hits ? 'never' : '', x.problem ? 'cant' : ''].filter(Boolean).join(' ');
  const text = `${x.label} ${KIND[x.kind]} ${EFFECT[x.effect] || ''} ${src} ${x.chatTitle || ''} ${x.projectName || ''} ${x.on === false ? 'off' : ''}`.toLowerCase();
  const box = x.kind === 'rule' ? `<label class="sq-check pmx-box" title="${x.on ? 'On: click to turn it off (it is kept)' : 'Off: kept, but not used. Click to turn it on'}"><input type="checkbox" data-act="on" ${x.on ? 'checked' : ''} aria-label="${x.on ? 'On' : 'Off'}: ${esc(x.label)}"></label>` : '<span></span>';
  const seg = (act, opts, cur, label) => `<span class="pmx-seg sm" role="group" aria-label="${esc(label)}">${opts.map(([v, w]) => `<button type="button" data-act="${act}" data-v="${v}" aria-pressed="${cur === v}">${esc(w)}</button>`).join('')}</span>`;
  const acts = [
    x.kind === 'app' ? seg('level', APP_LEVELS, x.level, `How far the agent may go in ${x.label}`) : '',
    x.kind === 'folder' && x.access === 'write' ? '<button type="button" class="pmx-btn sm" data-act="readonly" title="Keep reading, stop writing. Writing again needs the agent to ask.">Read only</button>' : '',
    x.kind === 'site' ? seg('site', Object.entries(SITE).map(([k, v]) => [k, v[1]]), x.site, `What happens on ${x.label}`) : '',
    x.kind === 'mcp' ? seg('ask', [['auto', 'Auto'], ['always', 'Ask every time']], x.ask, `When ${x.label}'s tools ask you`) : '',
    x.kind === 'rule' ? '<button type="button" class="pmx-btn sm" data-act="edit" aria-label="Edit">✎ Edit</button>' : '',
    x.kind === 'mcp' ? '' : `<button type="button" class="pmx-btn sm danger" data-act="remove" title="${x.kind === 'tool' ? 'Remove: it asks again before this tool' : 'Remove'}">Remove</button>`,
  ].join('');
  return `<div class="pmx-row ${x.on === false ? 'is-off' : ''}" data-key="${esc(rowKey(x))}" data-lf-text="${esc(text)}" data-lf-seg="${x.scope}" data-kind="${x.kind}" data-eff="${x.effect}" data-state="${state}" data-src="${x.by === 'button' ? 'card' : 'typed'}">
    ${box}<div class="pmx-main"><div class="pmx-l1">${scopeMark(x.scope, true)}<span class="pmx-eff" data-eff="${x.effect}">${esc(x.kind === 'site' ? SITE[x.site][1] : x.kind === 'mcp' ? (x.ask === 'always' ? 'Asks every time' : 'Auto') : x.kind === 'app' ? `Allow · ${x.level}` : x.kind === 'folder' ? (x.access === 'write' ? 'Read + write' : 'Read') : EFFECT[x.effect])}</span><code class="pmx-pat" title="${esc(x.label)}">${esc(x.label)}</code><span class="pmx-tag">${esc(KIND[x.kind])}</span></div>
      <div class="pmx-meta">${esc(src)}</div>
      ${x.problem ? `<div class="pmx-prob">⚠ Never matches: ${esc(x.problem)}.</div>` : ''}
      ${x.kind === 'rule' && x.on && x.effect === 'allow' && /^(python3?|py|node|npx|uvx?|deno|bun|powershell|pwsh|cmd|bash|sh)\s*\*\s*$/i.test(x.label) ? '<div class="pmx-note">⚡ YOLO ignores this rule: it would allow any code.</div>' : ''}</div>
    <div class="pmx-act">${acts}</div></div>`;
}
const rowKey = (x) => `${x.scope}|${x.kind}|${x.chatId || x.projectId || ''}|${x.id}`;

// ---------- changing one ----------
// Chats change through the page (their own save merges with other windows); saved rules through the server.
async function withChat(id, fn) {
  const c = await H.getChat(id);
  if (!c) throw new Error('that chat is gone');
  fn(c.agent, c);
  H.saveChat(c, true);
  H.renderComposerBar?.(c);
}
const permJSON = (method, body) => H.postJ('/api/permissions/rule', body, method);
async function change(x, act, v) {
  if (x.scope === 'chat') {
    return withChat(x.chatId, (a) => {
      const rules = a.cmdRules || [], r = rules.find((q, i) => (q.id || `i${i}`) === x.id);
      if (act === 'on' && r) r.on = v;
      if (act === 'edit' && r) { r.match = v.match; r.effect = v.effect; } // stays a card's rule: an edit never gives it a typed rule's reach
      if (act === 'remove') {
        if (x.kind === 'rule') a.cmdRules = rules.filter((q) => q !== r);
        if (x.kind === 'tool') { a.allowed = (a.allowed || []).filter((t) => t !== x.id); if (a.allowedMeta) delete a.allowedMeta[x.id]; }
        if (x.kind === 'app') a.apps = (a.apps || []).filter((q) => q.appId !== x.id);
        if (x.kind === 'folder') a.folders = (a.folders || []).filter((f) => f.path !== x.id);
      }
      if (act === 'level') { const app = (a.apps || []).find((q) => q.appId === x.id); if (app) app.level = v; }
      if (act === 'readonly') { const f = (a.folders || []).find((q) => q.path === x.id); if (f) f.access = 'read'; }
    });
  }
  if (x.kind === 'rule') {
    const body = { scope: x.scope, projectId: x.projectId, id: x.id };
    if (act === 'remove') return check(await permJSON('DELETE', body));
    if (act === 'on') return check(await permJSON('PATCH', { ...body, on: v }));
    if (act === 'edit') {
      if (v.scope && v.scope !== x.scope) {
        // Moved: saved in the new place first, then taken out of the old one.
        const to = v.scope === 'project' ? x.projectId || v.projectId : null;
        const cur = await H.getJ(`/api/permissions${to ? `?project=${encodeURIComponent(to)}` : ''}`);
        const list = (v.scope === 'project' ? cur.project : cur.everywhere) || [];
        check(await H.postJ('/api/permissions', { scope: v.scope, projectId: to, rules: [...list.map(({ problem, scope, ...q }) => q), { ...x.rule, id: undefined, scope: undefined, problem: undefined, match: v.match, effect: v.effect }] })); // keeps who made it: a card's rule moved is still a card's rule
        return check(await permJSON('DELETE', body));
      }
      return check(await permJSON('PATCH', { ...body, match: v.match, effect: v.effect }));
    }
  }
  if (x.kind === 'site') {
    const S = H.G.settings;
    const drop = (k) => { S[SITE[k][0]] = sites(SITE[k][0]).filter((s) => s.toLowerCase() !== x.label.toLowerCase()).join(', '); };
    drop(x.site);
    if (act === 'site') S[SITE[v][0]] = [...sites(SITE[v][0]), x.label].join(', ');
    H.savePrefs();
    return;
  }
  if (x.kind === 'mcp' && act === 'ask') {
    const cur = await H.getJ('/api/mcp');
    return check(await H.postJ('/api/mcp', { servers: (cur.servers || []).map((s) => (s.name === x.id ? { ...s, ask: v } : s)) }, 'PUT'));
  }
}
function check(r) { if (r?.error) throw new Error(r.error); return r; }

// ---------- the list: groups, filters, the tester ----------
// Mounts the permissions list into el. door says where it was opened from, and so what it shows first.
export async function mountPermissions(el, door, { onCount } = {}) {
  const { esc, $ } = H;
  el.classList.add('pmx');
  // Drawn again after a change: the old list stays until the new one is ready, at the same scroll position.
  const scroller = el.closest('.pmx-body') || el.closest('.pjx-body') || el.parentElement, top = scroller?.scrollTop || 0;
  if (!el.querySelector('.pmx-list, .pmx-empty')) el.innerHTML = '<div class="pmx-wait">Loading…</div>';
  let data;
  try { data = await gather(door); } catch (e) { el.innerHTML = `<p class="pmx-err">Couldn't load them: ${esc(e.message)}</p>`; return; }
  if (!el.isConnected) return;
  const { items, chat, projectId, projectName } = data;
  const reload = () => mountPermissions(el, door, { onCount });
  onCount?.(items);
  const F = (H.G.permFilters ??= {})[door.kind] ??= { kind: 'all', eff: 'all', state: 'all', src: 'all' };
  // Groups: this chat, then the project(s) and their chats, then everywhere.
  const groups = [];
  const by = (list, keyOf, nameOf) => [...list.reduce((m, x) => m.set(keyOf(x), [...(m.get(keyOf(x)) || []), x]), new Map())].map(([k, xs]) => ({ key: k, title: nameOf(xs[0]), items: xs }));
  const sortI = (xs) => xs.slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || (b.at || 0) - (a.at || 0));
  if (door.kind === 'chat') groups.push({ scope: 'chat', title: `This chat — ${chat?.title || 'New chat'}`, items: sortI(items.filter((x) => x.scope === 'chat')), empty: '“Allow always” on a card in this chat adds it here.' });
  const projItems = items.filter((x) => x.scope === 'project');
  if (door.kind === 'settings') groups.push({ scope: 'project', title: 'Projects', subs: by(projItems, (x) => x.projectId, (x) => x.projectName).map((s) => ({ ...s, items: sortI(s.items), add: s.key })), count: projItems.length, empty: 'No project has rules of its own yet.' });
  else if (projectId) groups.push({ scope: 'project', title: `This project — ${projectName}`, items: sortI(projItems), add: projectId, empty: 'No rules for this project yet. “Allow always” → This project on a card adds one.' });
  if (door.kind !== 'chat') {
    const ch = items.filter((x) => x.scope === 'chat');
    if (ch.length) groups.push({ scope: 'chat', title: door.kind === 'project' ? 'Chats in this project' : 'Chats', note: 'each chat’s own list', subs: by(ch, (x) => x.chatId, (x) => `“${x.chatTitle}”${door.kind === 'settings' ? ` · ${H.G.projects?.find((p) => p.id === x.projectId)?.name || ''}` : ''}`).map((s) => ({ ...s, items: sortI(s.items), open: s.key })), count: ch.length });
  }
  groups.push({ scope: 'everywhere', title: 'Everywhere in QuorX', items: sortI(items.filter((x) => x.scope === 'everywhere')), add: 'everywhere', empty: 'Nothing allowed everywhere yet.' });
  const addBtn = (where) => `<button type="button" class="pmx-btn sm" data-add="${esc(where)}">＋ Add rule</button>`;
  const groupHTML = (g) => `<section class="pmx-group" data-scope="${g.scope}">
    <div class="pmx-gh">${scopeMark(g.scope, true)}<b class="pmx-gt">${esc(g.title)}</b><span class="pmx-gn">${g.count ?? g.items.length}</span>${g.note ? `<span class="pmx-gnote">${esc(g.note)}</span>` : ''}<span class="grow"></span>${g.add ? addBtn(g.add) : ''}</div>
    ${g.subs ? (g.subs.length ? g.subs.map((s) => `<div class="pmx-sub"><div class="pmx-gh sub"><b class="pmx-gt">${esc(s.title)}</b><span class="pmx-gn">${s.items.length}</span><span class="grow"></span>${s.open ? `<button type="button" class="pmx-link" data-open-chat="${esc(s.open)}">Open chat</button>` : ''}${s.add ? addBtn(s.add) : ''}</div><div class="pmx-form-slot" data-for="${esc(s.add || '')}"></div>${s.items.map(rowHTML).join('')}</div>`).join('') : `<div class="pmx-gempty">${esc(g.empty || '')}</div>`)
      : `<div class="pmx-form-slot" data-for="${esc(g.add || '')}"></div>${g.items.length ? g.items.map(rowHTML).join('') : `<div class="pmx-gempty">${esc(g.empty || '')}</div>`}`}
  </section>`;
  // Filters built from what is there: a value with no rows gets no button.
  const vals = (k) => [...new Set(items.map((x) => x[k]))];
  const filt = (name, label, opts) => (opts.length > 1 ? `<div class="pmx-fg"><span class="pmx-fl">${label}</span><span class="pmx-seg sm" role="group" aria-label="${label}"><button type="button" data-f="${name}" data-v="all" aria-pressed="${F[name] === 'all'}">All</button>${opts.map(([v, w]) => `<button type="button" data-f="${name}" data-v="${v}" aria-pressed="${F[name] === v}">${esc(w)} <small></small></button>`).join('')}</span></div>` : '');
  const states = [['on', 'On'], ['off', 'Off'], ['never', 'Never used'], ['cant', 'Can’t match']].filter(([v]) => items.some((x) => rowState(x).includes(v)));
  // A filter on a value that is gone (the last rule that couldn't match was removed) goes back to All.
  const have = { kind: vals('kind'), eff: vals('effect'), state: states.map(([v]) => v), src: items.map((x) => (x.by === 'button' ? 'card' : 'typed')) };
  for (const k of Object.keys(F)) if (F[k] !== 'all' && !have[k].includes(F[k])) F[k] = 'all';
  const extra = `<div class="pmx-filters">${filt('kind', 'Kind', vals('kind').map((k) => [k, KIND[k]]))}${filt('eff', 'Effect', vals('effect').filter((e) => EFFECT[e]).map((e) => [e, EFFECT[e]]))}${filt('state', 'State', states)}${filt('src', 'Source', [...new Set(items.map((x) => (x.by === 'button' ? 'card' : 'typed')))].map((v) => [v, v === 'card' ? 'From a card' : 'Typed']))}</div>`;
  const ctx = door.kind === 'chat' ? `Showing what applies in “${esc(chat?.title || 'this chat')}”: this chat, its project${projectName ? ` (${esc(projectName)})` : ''} and everywhere in QuorX.`
    : door.kind === 'project' ? `Showing ${esc(projectName)}: its rules, its chats’ own lists, and everywhere in QuorX.` : 'Everything QuorX lets run without asking, in every project and chat.';
  el.innerHTML = items.length ? `<div class="pmx-ctx">${ctx}</div>
    <div class="pmx-tools"><div class="pmx-lf"></div><button type="button" class="pmx-btn sm pmx-try-open" aria-expanded="false">›_ Try a command</button></div>
    <form class="pmx-try" hidden><input class="pmx-try-in" placeholder="e.g. npm run build, git push origin main" spellcheck="false" aria-label="A command to try"><span class="pmx-seg sm" role="group" aria-label="As a chat in"><button type="button" data-pm="strict" aria-pressed="true">🔒 Strict</button><button type="button" data-pm="yolo" aria-pressed="false">⚡ YOLO</button></span><button type="submit" class="pmx-btn sm">Try it</button><div class="pmx-try-out" hidden></div></form>
    <div class="pmx-list">${groups.map(groupHTML).join('')}</div>`
    : `<div class="pmx-empty"><b>Nothing is allowed without asking yet</b><p>Permissions get added when you answer the agent:</p><ol><li><b>Allow always</b> on a card saves a rule for this chat, this project or everywhere in QuorX.</li><li>An app or a folder outside the project, once allowed, stays allowed in that chat.</li><li>Rules you type, Chrome sites and MCP servers come from ⚙ Settings.</li></ol>${door.kind !== 'chat' ? `<div class="pmx-empty-acts">${projectId ? addBtn(projectId) : ''}${addBtn('everywhere')}</div><div class="pmx-form-slot" data-for="${projectId || ''}"></div><div class="pmx-form-slot" data-for="everywhere"></div>` : ''}</div>`;
  el.insertAdjacentHTML('beforeend', `<details class="pmx-builtin"><summary>🔒 Built-in rules <small>always on · can't be changed</small></summary><ul>${BUILT_IN.map(([t, d]) => `<li><b>${esc(t)}</b><small>${d}</small></li>`).join('')}</ul></details>`);
  const find = (row) => items.find((x) => rowKey(x) === row.dataset.key);
  // Filtering: words and scope (the shared helper), then kind / effect / state / source here; empty groups fold away.
  const applyMore = () => {
    for (const row of el.querySelectorAll('.pmx-row')) {
      if (row.hidden) continue;
      if ((F.kind !== 'all' && row.dataset.kind !== F.kind) || (F.eff !== 'all' && row.dataset.eff !== F.eff) || (F.state !== 'all' && !row.dataset.state.split(' ').includes(F.state)) || (F.src !== 'all' && row.dataset.src !== F.src)) row.hidden = true;
    }
    for (const s of el.querySelectorAll('.pmx-sub')) s.hidden = ![...s.querySelectorAll('.pmx-row')].some((r) => !r.hidden);
    const filtered = !!($('.lf-q', el)?.value.trim()) || Object.values(F).some((v) => v !== 'all') || (H.ST?.filters?.[`perms-${door.kind}`]?.seg || 'all') !== 'all';
    const none = $('.lf-none', el); if (none) none.hidden = !items.length || [...el.querySelectorAll('.pmx-row')].some((r) => !r.hidden);
    for (const g of el.querySelectorAll('.pmx-group')) { const any = [...g.querySelectorAll('.pmx-row')].some((r) => !r.hidden); g.hidden = filtered && !any; }
    // Each header counts what it shows: "12 of 183" while filtered.
    for (const box of el.querySelectorAll('.pmx-group, .pmx-sub')) {
      const n = $(':scope > .pmx-gh .pmx-gn', box), all = box.querySelectorAll('.pmx-row'), shown = [...all].filter((r) => !r.hidden).length;
      if (n) n.textContent = filtered && shown !== all.length ? `${shown} of ${all.length}` : String(all.length);
    }
    for (const b of el.querySelectorAll('[data-f]')) if (b.dataset.v !== 'all') { const n = [...el.querySelectorAll('.pmx-row')].filter((r) => { const k = { kind: 'kind', eff: 'eff', src: 'src' }[b.dataset.f]; return k ? r.dataset[k] === b.dataset.v : r.dataset.state.split(' ').includes(b.dataset.v); }).length; $('small', b).textContent = n; }
  };
  const lf = $('.pmx-lf', el);
  if (lf) {
    H.listFilter(lf, { key: `perms-${door.kind}`, rows: () => el.querySelectorAll('.pmx-row'), segOrder: ['chat', 'project', 'everywhere'], segLabel: (v) => (door.kind === 'settings' ? { chat: 'Chats', project: 'Projects', everywhere: 'Everywhere in QuorX' }[v] : SCOPE[v].label), placeholder: 'Search patterns, tools, apps, sites, chats…', label: 'Scope', extra, onApply: applyMore });
    // "Show everything" clears these filters too.
    $('.lf-clear', el)?.addEventListener('click', () => { for (const k of Object.keys(F)) F[k] = 'all'; for (const x of el.querySelectorAll('[data-f]')) x.setAttribute('aria-pressed', String(x.dataset.v === 'all')); applyMore(); });
    for (const b of el.querySelectorAll('[data-f]')) b.onclick = () => { F[b.dataset.f] = b.dataset.v; for (const x of el.querySelectorAll(`[data-f="${b.dataset.f}"]`)) x.setAttribute('aria-pressed', String(x === b)); $('.lf-q', el).dispatchEvent(new Event('input')); };
  }
  // Row actions. Remove asks once, in place.
  const run = async (row, act, v) => {
    const x = find(row); if (!x) return;
    row.classList.add('busy');
    try {
      await change(x, act, v);
      // On or off changes only this row: no need to draw the list again.
      if (act === 'on') { x.on = v; row.classList.remove('busy'); row.classList.toggle('is-off', !v); row.dataset.state = rowState(x).filter(Boolean).join(' '); return; }
      reload();
    } catch (e) { row.classList.remove('busy'); H.flashTip(row, `Not changed: ${e.message}`, 3000); }
  };
  el.onclick = (e) => {
    const b = e.target.closest('button[data-act]'), row = b?.closest('.pmx-row');
    if (b && row) {
      if (b.dataset.act === 'remove' && !b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Remove?'; setTimeout(() => { if (b.isConnected) { b.classList.remove('sure'); b.textContent = 'Remove'; } }, 3000); return; }
      if (b.dataset.act === 'edit') return editForm(row, find(row));
      if (b.getAttribute('aria-pressed') === 'true') return;
      return run(row, b.dataset.act, b.dataset.v);
    }
    const add = e.target.closest('[data-add]');
    if (add) return addForm(add.dataset.add);
    const oc = e.target.closest('[data-open-chat]');
    if (oc) { H.closeWindows?.(); H.showChat(oc.dataset.openChat); }
  };
  el.onchange = (e) => { const cb = e.target.closest('input[data-act="on"]'); if (cb) run(cb.closest('.pmx-row'), 'on', cb.checked); };
  // Edit and Add: a pattern, what happens, and where. A chat's rule stays in its chat.
  const effSeg = (cur) => `<span class="pmx-seg" role="group" aria-label="What happens">${Object.entries({ allow: 'Allow', ask: 'Ask me', deny: 'Deny' }).map(([k, w]) => `<button type="button" data-e="${k}" aria-pressed="${cur === k}">${w}</button>`).join('')}</span>`;
  const whereSeg = (cur, canProject) => `<span class="pmx-seg" role="group" aria-label="Where">${['project', 'everywhere'].map((s) => `<button type="button" data-w="${s}" aria-pressed="${cur === s}" ${s === 'project' && !canProject ? 'disabled' : ''}>${scopeMark(s, true)}${SCOPE[s].label}</button>`).join('')}</span>`;
  const formHTML = (x, title) => `<form class="pmx-form"><div class="pmx-ft">${esc(title)}</div><input class="pmx-match" value="${esc(x?.label || '')}" placeholder="A command pattern: npm run *, git status, python -m pytest*" spellcheck="false" aria-label="Command pattern">
    <div class="pmx-fr"><span class="pmx-fl">Effect</span>${effSeg(x?.effect || 'allow')}</div>
    ${x?.scope === 'chat' ? '' : `<div class="pmx-fr"><span class="pmx-fl">Where</span>${whereSeg(x?.scope || 'project', !!(x?.projectId || projectId))}</div>`}
    <p class="pmx-hint"><code>*</code> stands for anything. Allow runs it without asking; Ask me always shows you a card; Deny never runs it. Deny beats Ask beats Allow.</p>
    <div class="pmx-fa"><span class="pmx-fmsg"></span><span class="grow"></span><button type="button" class="pmx-btn sm pmx-cancel">Cancel</button><button type="submit" class="pmx-btn sm primary">${x ? 'Save' : 'Add rule'}</button></div></form>`;
  const wireForm = (f, done) => {
    for (const b of f.querySelectorAll('[data-e], [data-w]')) b.onclick = () => { for (const q of b.parentElement.children) q.setAttribute('aria-pressed', String(q === b)); };
    $('.pmx-cancel', f).onclick = () => { f.remove(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const match = $('.pmx-match', f).value.trim();
      if (!match) { $('.pmx-match', f).focus(); return; }
      const v = { match, effect: $('[data-e][aria-pressed="true"]', f)?.dataset.e || 'allow', scope: $('[data-w][aria-pressed="true"]', f)?.dataset.w };
      try { await done(v); reload(); } catch (err) { $('.pmx-fmsg', f).textContent = `Not saved: ${err.message}`; }
    };
    $('.pmx-match', f).focus();
  };
  function editForm(row, x) {
    if (!x || row.nextElementSibling?.classList.contains('pmx-form')) return;
    row.insertAdjacentHTML('afterend', formHTML(x, x.scope === 'chat' ? 'Edit this chat’s rule' : 'Edit rule'));
    wireForm(row.nextElementSibling, (v) => change(x, 'edit', v));
  }
  function addForm(where) {
    const slot = el.querySelector(`.pmx-form-slot[data-for="${CSS.escape(where)}"]`);
    if (!slot || slot.firstElementChild) return;
    const pid = where === 'everywhere' ? null : where;
    slot.innerHTML = formHTML(null, where === 'everywhere' ? 'New rule everywhere in QuorX' : `New rule for ${H.G.projects?.find((p) => p.id === pid)?.name || 'this project'}`);
    const f = $('.pmx-form', slot);
    for (const b of f.querySelectorAll('[data-w]')) b.setAttribute('aria-pressed', String(b.dataset.w === (pid ? 'project' : 'everywhere')));
    wireForm(f, async (v) => {
      const to = v.scope === 'project' ? pid || projectId : null;
      const cur = await H.getJ(`/api/permissions${to ? `?project=${encodeURIComponent(to)}` : ''}`);
      const list = (v.scope === 'project' ? cur.project : cur.everywhere) || [];
      check(await H.postJ('/api/permissions', { scope: v.scope === 'project' ? 'project' : 'everywhere', projectId: to, rules: [...list.map(({ problem, scope, ...q }) => q), { match: v.match, effect: v.effect, by: 'user', on: true }] }));
    });
  }
  if (scroller) scroller.scrollTop = top;
  // The tester: the same check a real command gets, with these rules (nothing runs).
  const tf = $('.pmx-try', el), to = $('.pmx-try-open', el);
  if (tf) {
    to.onclick = () => { tf.hidden = !tf.hidden; to.setAttribute('aria-expanded', String(!tf.hidden)); if (!tf.hidden) $('.pmx-try-in', tf).focus(); };
    for (const b of tf.querySelectorAll('[data-pm]')) b.onclick = () => { for (const q of tf.querySelectorAll('[data-pm]')) q.setAttribute('aria-pressed', String(q === b)); if ($('.pmx-try-in', tf).value.trim()) tf.requestSubmit(); };
    tf.onsubmit = async (e) => {
      e.preventDefault();
      const line = $('.pmx-try-in', tf).value.trim(), out = $('.pmx-try-out', tf);
      if (!line) return;
      out.hidden = false; out.innerHTML = '<span class="pmx-wait">Checking…</span>';
      const t = await H.postJ('/api/permissions/test', { projectId: projectId || undefined, line, mode: $('[data-pm][aria-pressed="true"]', tf)?.dataset.pm || 'strict', safety: H.G.settings.safety, chatRules: chat ? (chat.agent.cmdRules || []).map((r) => ({ ...r, scope: 'chat' })) : [] });
      if (t.error) { out.innerHTML = `<p class="pmx-err">${esc(t.error)}</p>`; return; }
      const word = { allow: ['ok', 'Runs without asking'], ask: ['warn', t.who === 'deciders' ? 'The deciders vote' : 'Asks you'], deny: ['bad', 'Never runs'] }[t.verdict] || ['warn', t.verdict];
      const rule = String(t.decidedBy || '').startsWith('rule:') ? ` · decided by your rule in ${SCOPE[t.decidedBy.slice(5)]?.label || t.decidedBy.slice(5)}` : '';
      out.innerHTML = `<div class="pmx-verdict ${word[0]}"><span class="pmx-st ${word[0]}"><i></i>${esc(word[1])}</span><span>${esc(t.why || '')}${esc(rule)}</span></div>
        ${(t.segments || []).length > 1 ? `<ul class="pmx-segs">${t.segments.map((s) => `<li><code>${esc(s.text)}</code> <span class="pmx-eff" data-eff="${esc(s.verdict)}">${esc(EFFECT[s.verdict] || s.verdict)}</span> <small>${esc(s.why || '')}</small></li>`).join('')}</ul>` : ''}`;
    };
  }
}
const rowState = (x) => [x.on === false ? 'off' : 'on', x.kind === 'rule' && !x.hits ? 'never' : '', x.problem ? 'cant' : ''];

// ---------- the window ----------
// Opened from the chat (what applies there), a project's settings (that project), or ⚙ Settings (everything).
export function openPermissions(door) {
  let dlg = document.getElementById('permsDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'permsDlg'; dlg.className = 'pmx-dialog'; dlg.setAttribute('aria-label', 'Permissions');
    dlg.innerHTML = '<header class="pmx-hd"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/></svg><div><b>Permissions</b><small class="pmx-hd-sub"></small></div><span class="grow"></span><button type="button" class="pmx-x" aria-label="Close">✕</button></header><div class="pmx-body"></div>';
    document.body.append(dlg);
    dlg.querySelector('.pmx-x').onclick = () => dlg.close();
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  const sub = door.kind === 'chat' ? 'What applies in this chat' : door.kind === 'project' ? `${H.G.projects?.find((p) => p.id === door.projectId)?.name || 'Project'}` : 'Every project and chat';
  dlg.querySelector('.pmx-hd-sub').textContent = sub;
  if (!dlg.open) dlg.showModal();
  mountPermissions(dlg.querySelector('.pmx-body'), door);
}

// ---------- in the chat: what applies here, and why something ran without asking ----------
// Every permission that applies in chat c (its own, its project's, everywhere's), most recently used first, and the
// chat's last few decisions with who let each run.
export async function appliesHereHTML(c) {
  const { esc } = H;
  const { items } = await gather({ kind: 'chat', chatId: c.id });
  const mode = c.approval === 'yolo'
    ? `<b>⚡ YOLO: the deciders answer for you</b><small>${(H.yoloAsking?.() || 0) ? `${H.yoloAsking()} group${H.yoloAsking() === 1 ? '' : 's'} still ask you. ` : ''}Extreme commands always pause for you.</small>`
    : `<b>🔒 Strict: asks you first</b><small>Asks before ${(H.G.settings.strictAsk || 'paid') === 'every' ? 'every tool' : 'paid media'}, and before commands no rule allows. Read-only commands run.</small>`;
  const tab = (H.G.appliesTab ??= 'allow');
  const pick = (x) => (tab === 'allow' ? ['allow', 'auto'].includes(x.effect) && x.on !== false : x.effect === tab && x.on !== false);
  const list = items.filter(pick).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || (b.hits || 0) - (a.hits || 0));
  const n = (e) => items.filter((x) => (e === 'allow' ? ['allow', 'auto'].includes(x.effect) : x.effect === e) && x.on !== false).length;
  const row = (x) => `<li>${scopeMark(x.scope, true)}<code title="${esc(x.label)}">${esc(x.label)}</code>${x.kind !== 'rule' ? `<span class="pmx-tag">${esc(KIND[x.kind])}</span>` : ''}<span class="grow"></span><small>${x.hits ? `${x.hits}× · ${x.lastUsed ? H.ago(x.lastUsed) : ''}` : x.kind === 'rule' || x.kind === 'tool' ? 'not used' : ''}</small></li>`;
  return `<div class="ap-head">What applies in this chat <small>changes apply from the next reply</small></div>
    <div class="pmx-mode">${mode}</div>
    <div class="pmx-ah"><span>Applies here · ${items.filter((x) => x.on !== false).length}</span><span class="pmx-seg sm" role="group" aria-label="Show">${[['allow', 'Allowed'], ['ask', 'Asks'], ['deny', 'Denied']].map(([k, w]) => `<button type="button" data-tab="${k}" aria-pressed="${tab === k}">${w} <small>${n(k)}</small></button>`).join('')}</span></div>
    <ul class="pmx-applies">${list.slice(0, 8).map(row).join('') || `<li class="pmx-none">${tab === 'allow' ? 'Nothing runs without asking here yet. “Allow always” on a card adds it.' : tab === 'ask' ? 'No rule makes anything ask here.' : 'No rule denies anything here.'}</li>`}${list.length > 8 ? `<li class="pmx-none">+ ${list.length - 8} more in Manage</li>` : ''}</ul>
    ${whyHTML(c)}
    <div class="ap-foot"><span class="pmx-legend">${scopeMark('chat', true)}chat ${scopeMark('project', true)}project ${scopeMark('everywhere', true)}everywhere</span><button type="button" class="pmx-btn sm primary pmx-manage">Manage all permissions</button></div>`;
}
// Who let a step run: a rule (and its scope), you, the deciders, or the built-in classes.
export function whyText(e) {
  const d = String(e.decidedBy || '');
  if (d.startsWith('rule:')) { const s = d.slice(5); return { who: `your rule${e.rule ? ` ${e.rule}` : ''}`, scope: SCOPE[s] ? s : null }; }
  if (d === 'you' || d === 'user') return { who: 'you, once' };
  if (d === 'deciders') return { who: 'the deciders' };
  if (d === 'deciders off') return { who: '⚡ YOLO without a check' };
  if (d.startsWith('class:')) return { who: `built-in: ${d.slice(6)}` };
  return d ? { who: d } : null;
}
function whyHTML(c) {
  const { esc } = H;
  const seen = [];
  for (const m of (c.agent.messages || []).slice().reverse()) {
    for (const e of (m.trace || []).slice().reverse()) {
      if (e.t === 'command' && e.decidedBy && e.decidedBy !== 'you' && !e.background) seen.push({ what: e.command, at: m.at || e.at, why: whyText(e) });
      else if (e.t === 'allowed_used') seen.push({ what: H.TOOL_NAME[e.tool] || e.tool, at: m.at, why: { who: 'your “Allow always”', scope: 'chat' } });
      if (seen.length >= 5) break;
    }
    if (seen.length >= 5) break;
  }
  if (!seen.length) return '';
  return `<div class="pmx-why"><h6>Why did that run without asking?</h6><ul>${seen.map((x) => `<li><code>${esc(H.clip(x.what, 80))}</code><small>${esc(x.why?.who || '')}${x.why?.scope ? ` in ${scopeMark(x.why.scope, false)}` : ''}</small></li>`).join('')}</ul></div>`;
}
