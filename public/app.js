// QuorX front end. One agent per chat; up to two chats side by side, each with its own
// run, so chats work in parallel. Every run streams events from /api/run; approvals are answered
// through /api/approve. Chats live on the server; preferences stay in this browser. Plain JS.

import { startTour, maybeStartTour } from './tour.js';
import { backupCard, drawBackup } from './backup.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c, d = 4) => `$${(Number(c) || 0).toFixed(d)}`;
const secs = (ms) => `${((ms || 0) / 1000).toFixed(1)}s`;
const short = (m) => String(m || '').split('/').pop();
const pct = (p) => `${Math.round((p || 0) * 100)}%`;
// Opened without the app link (server/access.js): every /api call is refused, so say how to sign this browser in.
{
  const raw = window.fetch.bind(window);
  let shown = false;
  window.fetch = async (...a) => {
    const r = await raw(...a);
    if (r.status === 401 && !shown && /^\/api\//.test(new URL(String(a[0]?.url || a[0]), location.href).pathname)) {
      const j = await r.clone().json().catch(() => ({}));
      if (j.code === 'APP_KEY') {
        shown = true;
        const d = document.createElement('div');
        d.className = 'app-key-wall';
        d.setAttribute('role', 'alert');
        d.innerHTML = '<div><h2>Open QuorX with its app link</h2><p>QuorX now answers only its own windows. Open the link it printed when it started (the line that starts with “Open QuorX with this link once”), or use the desktop app. You only do this once per browser.</p><button type="button">Reload</button></div>';
        d.querySelector('button').onclick = () => location.reload();
        document.body.appendChild(d);
      }
    }
    return r;
  };
}
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
// "14:32" today, "Yesterday 14:32", or "17 Oct 14:32".
function stamp(t) {
  const d = new Date(t), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.toDateString() === new Date(now - 864e5).toDateString()) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })} ${hm}`;
}
const timeTag = (t) => { const mode = G.settings?.ui?.timestamps || 'time'; return mode === 'off' ? '' : `<time datetime="${new Date(t).toISOString()}" title="${esc(new Date(t).toLocaleString())}">${mode === 'relative' ? ago(t) : stamp(t)}</time>`; };
// A stable colour per title, so chats are easy to tell apart.
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const initials = (s) => (String(s).match(/[A-Za-z0-9]/g) || ['?']).slice(0, 2).join('').toUpperCase();
const STORE = 'quorx-v1';
const ICON = { html: '📄', md: '📝', image: '🖼', audio: '🎵', video: '🎬', site: '🌐', app: '🚀' };
const REASON = { off: 'Reasoning off', low: 'Reasoning: low', medium: 'Reasoning: medium', high: 'Reasoning: high', default: 'Reasoning: model default' };
const BUCKET = {
  theater: ['already knew', 'The deciders agreed with a guess the agent was already ≥80% sure of: asking changed nothing.'],
  confirmed: ['confirmed', 'The deciders agreed with a guess the agent was unsure of: asking added confidence.'],
  flipped: ['changed answer', 'The deciders disagreed with the agent\'s guess with real confidence: asking changed the answer.'],
  unclear: ['deciders unsure', 'The deciders could not settle it (low confidence).'],
  unmatched: ['guess unclear', 'The agent\'s guess did not match any option, so it can\'t be compared.'],
};
const TOOL_NAME = { remember: '📌 Remember this in every chat', media_plan: '🎞 Production plan', imagine: '🖼 Make a picture', make_video: '🎬 Make a video', compose_music: '🎵 Compose music', speak: '🗣 Speak aloud',
  write_artifact: '📄 Write a page', edit_artifact: '✏️ Edit a page', read_artifact: '👀 Read a page', decide: '⚖️ Ask the deciders',
  list_files: '🗂 List files', read_file: '👀 Read a file', write_file: '📝 Write a file', append_file: '📝 Append to a file', edit_file: '✏️ Edit a file',
  search_docs: '🔎 Search the attached documents', read_doc: '📄 Read an attached document', list_docs: '📎 List attached documents',
  edit_video: '🎞 Edit the film', run_command: '⌨️ Run a command', start_server: '🚀 Start a server', stop_server: '■ Stop a server', launch_config: '🧾 Saved servers', preview_site: '🌐 Preview a site',
  browser: '🌐 Use the browser', look: '👁 Look at the result', search_files: '🔎 Search files', delete_file: '🗑 Delete a file',
  scaffold: '🧱 Use a template', save_skill: '🧩 Save a skill', use_skill: '🧩 Load a skill', fetch_url: '🌍 Read a web page', delegate: '🤝 Ask a helper', plan: '🗺 Plan' };
const CATS = [
  ['image', '🖼 Pictures', 'paid'], ['video', '🎬 Video', 'paid; the most expensive tool'], ['music', '🎵 Music', 'paid'],
  ['speech', '🗣 Voice', 'paid; reads text aloud'], ['listen', '🎤 Mic', 'turns your speech into text (model 1 is used)'],
];
// What each new chat starts with: every paid media tool off. Artifacts, code & servers and the browser are always on.
const CHAT_TOOLS = ['image', 'video', 'music', 'speech'];
// The quality tools: on by default (the best value in the build benchmark); each chat can switch them off in 🧰.
const QUALITY_TOOLS = ['enhancer', 'reviewer', 'freshEyes', 'deciders', 'helpers'];
const DEFAULT_CHAT_TOOLS = { image: false, video: false, music: false, speech: false, enhancer: true, reviewer: true, freshEyes: true, deciders: true, helpers: true };
// Files a code review reads (an automatic review skips replies that only changed pictures, data or docs).
const CODE_FILE = /\.(m?[jt]sx?|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|lua|sh|ps1|vue|svelte|html?|css|scss|sql)$/i;
const REVIEW_CHEAP = 'openai/gpt-6-luna', REVIEW_STRONG = 'anthropic/claude-sonnet-5.5', HELPER_DEFAULT = 'qwen/qwen3.7-flash', LOOK_DEFAULT = 'openai/gpt-6-luna-decisions';
const reviewerModel = () => G.settings.reviewModel || (G.settings.reviewTier === 'strong' ? REVIEW_STRONG : REVIEW_CHEAP);
const helperModel = () => G.settings.helperModel || HELPER_DEFAULT;
const lookModel = () => (Array.isArray(G.settings.lookVoters) && G.settings.lookVoters[0]) || LOOK_DEFAULT;
const enhancerModel = () => G.settings.enhancerModel || helperModel();
const freshModel = () => G.settings.freshEyesModel || (G.settings.freshEyesTier === 'strong' ? REVIEW_STRONG : helperModel());
const QUALITY_INFO = {
  enhancer: { icon: '📝', name: 'Prompt enhancer', kind: 'chat', model: enhancerModel, perBuild: () => '< $0.0001 a request',
    note: 'Spells out what your request implies, so the deciders don\'t read it too literally.',
    tip: 'Before the agent starts, a cheap model reads your message (only your words) and writes what it plainly implies: "make a 30-second movie" implies voices or narration, music and sound effects, not just video. The agent builds to that, and in YOLO the deciders that approve paid tools read it beside your message, so they don\'t turn down the voice-over because you never typed "speech". It shows under your message: ✎ to correct it, ✕ to drop it. First message (default) or every message. Under $0.0001 a request (qwen3.7-flash).' },
  reviewer: { icon: '🔍', name: 'Reviewer', kind: 'chat', model: reviewerModel, perBuild: () => (G.settings.reviewModel ? 'priced by the model below' : G.settings.reviewTier === 'strong' ? '≈ $0.02 a build' : '≈ $0.003 a build'),
    note: 'Plays what was built and sends it back with bugs it reproduced.',
    tip: 'A separate model opens what was built, uses it like a person, and sends it back with bugs it reproduced (with the steps). In the build benchmark it caught a 2048 game that did not work (13 → 19 of 20). Cheap (gpt-6-luna) costs about $0.003 a build but sometimes fails good builds; Strong (Claude Sonnet 5.5) costs about $0.02 a build and agreed with the judge every time. Off: no second opinion: fastest and cheapest, but nothing catches a build that only looks done.' },
  freshEyes: { icon: '👀', name: 'Fresh eyes', kind: 'chat', model: freshModel, perBuild: () => (G.settings.freshEyesTier === 'strong' && !G.settings.freshEyesModel ? '≈ $0.01 a look' : '≈ $0.001 a look'),
    note: 'When the same problem comes back, a clean-context model diagnoses it.',
    tip: 'The second time the same problem shows up (the same error, failed check, console error, or a bug sent back), a second model with a clean context reads the problem, the recent attempts and the relevant files, and tells the agent the likely cause, the evidence, how to fix it and what not to try again, before it digs further in the wrong direction. Fast and cheap by default (the helper model); Strong uses Claude Sonnet 5.5. At most 3 looks per reply.' },
  deciders: { icon: '⚖️', name: 'Deciders', kind: 'decision', model: lookModel, perBuild: () => '< $0.001 a build',
    note: 'Screenshot and click checks, look and decide.',
    tip: 'Fast judges that answer fixed yes/no questions from screenshots: is the page blank, is text cut off, did clicking Start change anything, what does your request leave out. They give the model eyes: in the build benchmark they caught a missing game-over screen and broken invoice lines. One decider answers; the others only when it is unsure. Under $0.001 a build. Off also removes the look and decide tools (and in YOLO the agent answers its own questions).' },
  helpers: { icon: '🧭', name: 'Helpers', kind: 'chat', model: helperModel, perBuild: () => '≈ $0.001–0.01 when used',
    note: 'Cheap read-only searches of big projects.',
    tip: 'Hands read-only jobs (find, read, summarise code) to a cheaper model with its own context, so the main model\'s context stays small and each later step stays cheap. Most useful in big projects; rarely used on small builds. About $0.001–0.01 each time it is used.' },
};

const G = {
  cfg: null, settings: null, byId: new Map(), models: null,
  projects: [], chats: [],      // sidebar summaries from the server
  open: new Map(),              // chatId → loaded chat (its agent, run state and DOM)
  panes: [],                    // chat ids shown side by side (1 or 2)
  focus: 0,                     // which pane the artifact pane and mic follow
  view: { id: null, src: false, files: false },
  sessionCost: 0, sizes: {}, theme: null, sideHidden: false, balanceShown: false,
};
const focused = () => G.open.get(G.panes[G.focus]) || G.open.get(G.panes[0]);

// ---------- preferences (this browser) and chats (the server) ----------
function savePrefs() {
  try { localStorage.setItem(STORE, JSON.stringify({ settings: G.settings, templates: G.templates, sideHidden: G.sideHidden, projectOrder: G.projectOrder, foldedProjects: G.foldedProjects, favModels: G.favModels, recentModels: G.recentModels, budgetSeen: G.budgetSeen, spaceSeen: G.spaceSeen, followAgent: G.followAgent, pickerSort: G.pickerSort, panes: G.panes, sessionCost: G.sessionCost, sizes: G.sizes, theme: G.theme })); } catch { /* storage unavailable */ }
}
// Preferences saved under the app's earlier names (OpenHarness, before that Agent-001) are read until the next save.
function load() { try { return JSON.parse(localStorage.getItem(STORE) || localStorage.getItem('openharness-v1') || localStorage.getItem('agent001-v1') || 'null'); } catch { return null; } }
const stripMsg = ({ el, thinkOpen, tlOpen, ...m }) => ({ ...m, live: false, ...(m.thinking ? { thinking: Object.fromEntries(Object.entries(m.thinking).map(([k, t]) => [k, t.length > 20000 ? t.slice(0, 20000) + '…' : t])) } : {}) });
function chatDoc(c) {
  return { id: c.id, title: c.title, projectId: c.projectId, created: c.created, approval: c.approval, paneHidden: c.paneHidden, tools: c.tools,
    agent: { ...c.agent, messages: c.agent.messages.map(stripMsg) } };
}
const timers = new Map();
// What the server last confirmed for each chat: its rev, and each part as it was sent. The next save sends only
// the messages and artifacts that differ (a PATCH); a chat with no rev yet, or one whose file has moved on since
// (another tab, an older page), is sent whole.
const savedParts = new Map(); // chat id → { rev, head, msgs, arts }
const saving = new Map();     // chat id → the save in flight: saves of one chat go one after another
function chatParts(doc) {
  const { messages, artifacts, ...agent } = doc.agent;
  return { head: JSON.stringify({ ...doc, agent }), msgs: messages.map((m) => JSON.stringify(m)),
    arts: Object.fromEntries(Object.entries(artifacts || {}).map(([k, a]) => [k, JSON.stringify(a ?? null)])) };
}
const putChat = (id, doc) => fetch(`/api/chats/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
async function sendChat(c) {
  const doc = chatDoc(c), parts = chatParts(doc), last = savedParts.get(c.id);
  if (last?.rev) {
    // The body is put together from the parts already turned into text, so nothing is stringified twice.
    const msgs = parts.msgs.flatMap((s, i) => (s === last.msgs[i] ? [] : [`"${i}":${s}`]));
    const arts = Object.entries(parts.arts).filter(([k, s]) => s !== last.arts[k]).map(([k, s]) => `${JSON.stringify(k)}:${s}`)
      .concat(Object.keys(last.arts).filter((k) => !(k in parts.arts)).map((k) => `${JSON.stringify(k)}:null`));
    const headChanged = parts.head !== last.head;
    if (!msgs.length && !arts.length && !headChanged && parts.msgs.length === last.msgs.length) return false;
    const body = `{"base":${JSON.stringify(last.rev)},"count":${parts.msgs.length},"messages":{${msgs.join(',')}},"artifacts":{${arts.join(',')}}${headChanged ? `,"head":${parts.head}` : ''}}`;
    const r = await fetch(`/api/chats/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    const j = r.ok ? await r.json().catch(() => null) : null;
    if (j?.rev) return void savedParts.set(c.id, { rev: j.rev, ...parts });
    // Refused (the file moved on) or an older server: the whole chat instead.
  }
  const r = await putChat(c.id, doc);
  if (!r.ok) throw new Error('save failed');
  const j = await r.json().catch(() => null);
  savedParts.set(c.id, { rev: j?.rev, ...parts });
}
// A chat is saved once it has its first message; saves are debounced per chat.
function saveChat(c, now = false) {
  if (!c || !c.agent.messages.length) return;
  clearTimeout(timers.get(c.id));
  const go = () => {
    const p = (saving.get(c.id) || Promise.resolve()).then(() => sendChat(c)).then((sent) => { if (sent !== false) refreshSidebar(); }, () => { /* offline: retried on the next change */ });
    saving.set(c.id, p);
    p.finally(() => { if (saving.get(c.id) === p) saving.delete(c.id); });
    return p;
  };
  if (now) return go();
  timers.set(c.id, setTimeout(go, 700));
}
const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Older saves held "layouts" of agent columns and versioned artifacts: keep the first agent and
// each artifact's latest state.
function normalise(doc) {
  const agent = doc.agent || doc.layouts?.chat?.[0] || doc.layouts?.[doc.mode]?.[0] || {};
  const artifacts = {};
  for (const [id, a] of Object.entries(agent.artifacts || {})) {
    const last = a.versions ? a.versions.at(-1) || {} : a;
    artifacts[id] = { ...last, id, kind: a.kind, title: a.title, versions: undefined, v: undefined };
  }
  const setup = { model: agent.setup?.model || G.settings.model, reasoning: agent.setup?.reasoning || G.settings.reasoning || 'off' };
  return { id: doc.id, title: doc.title || 'New chat', projectId: doc.projectId || 'scratch', created: doc.created || Date.now(),
    approval: doc.approval || G.settings.approval || 'strict', paneHidden: doc.paneHidden,
    tools: { ...DEFAULT_CHAT_TOOLS, ...(doc.tools || {}) },
    agent: { setup, allowed: agent.allowed || [], extraUsage: agent.extraUsage || [], summary: agent.summary, summaryAt: agent.summaryAt, messages: (agent.messages || []).map((m) => ({ ...m, live: false, arts: m.arts && dedupeArts(m.arts) })), artifacts },
    ctx: [], images: [], docs: [], running: null, el: null };
}
const dedupeArts = (list) => [...new Map(list.map((a) => [a.id, { id: a.id, kind: a.kind, title: a.title }])).values()];
function blankChat(projectId) {
  const from = focused();
  return normalise({ id: newId(), projectId, approval: from?.approval || G.settings.approval, tools: { ...DEFAULT_CHAT_TOOLS, ...(G.settings.newChatTools || {}) },
    agent: { setup: { model: G.settings.model, reasoning: G.settings.reasoning || 'off' } } });
}
// One load per chat at a time: two callers at once share it, so a chat never has two copies
// (one on screen and another that the running reply updates).
const loading = new Map();
function getChat(id) {
  if (G.open.has(id)) return Promise.resolve(G.open.get(id));
  if (!loading.has(id)) loading.set(id, (async () => {
    const doc = await fetch(`/api/chats/${id}`).then((r) => r.json()).catch(() => null);
    if (!doc || doc.error) return null;
    const c = normalise(doc);
    // The chat as loaded is what the server has: the first save sends only what changes from here.
    if (doc.rev) savedParts.set(id, { rev: doc.rev, ...chatParts(chatDoc(c)) }); else savedParts.delete(id);
    G.open.set(id, c);
    reattachRuns(c);
    return c;
  })().finally(() => loading.delete(id)));
  return loading.get(id);
}

// ---------- context from other chats ----------
async function openCtxPicker(c) {
  await refreshSidebar();
  const dlg = $('#ctxPicker'), chosen = new Set(c.ctx.map((x) => x.id));
  const draw = () => {
    const q = $('#ctxSearch').value.trim().toLowerCase();
    $('#ctxList').innerHTML = G.projects.map((p) => {
      const rows = G.chats.filter((x) => (x.projectId || 'scratch') === p.id && x.id !== c.id && x.messages > 0 && (!q || x.title.toLowerCase().includes(q)));
      return rows.length ? `<div class="ctx-proj">📁 ${esc(p.name)}</div>${rows.map((x) => `<label class="ctx-row"><input type="checkbox" data-id="${esc(x.id)}" ${chosen.has(x.id) ? 'checked' : ''}><span class="t">${esc(x.title)}</span><small>${x.messages} msg · ${ago(x.lastAt || x.updated)}</small></label>`).join('')}` : '';
    }).join('') || '<div class="empty">No other chats yet.</div>';
    for (const cb of dlg.querySelectorAll('.ctx-row input')) cb.onchange = () => (cb.checked ? chosen.add(cb.dataset.id) : chosen.delete(cb.dataset.id));
  };
  $('#ctxSearch').value = ''; $('#ctxSearch').oninput = draw; draw();
  const close = () => dlg.close();
  $('#ctxClose').onclick = close; $('#ctxCancel').onclick = close;
  $('#ctxDone').onclick = () => { c.ctx = [...chosen].map((id) => ({ id, title: G.chats.find((x) => x.id === id)?.title || id })); renderAttachments(c); close(); $('.input', c.el.root).focus(); };
  dlg.showModal();
}
// A compact transcript of each attached chat: its latest messages, plus what it built.
async function contextText(list) {
  const parts = [];
  for (const item of list.filter((x) => x.type === 'file')) {
    const t = await fetch(`/ws/${item.projectId}/${item.path.split('/').map(encodeURIComponent).join('/')}`).then((r) => r.ok ? r.text() : '').catch(() => '');
    if (t) parts.push(`### File ${item.path} (project "${G.projects.find((p) => p.id === item.projectId)?.name || item.projectId}")\n\`\`\`\n${t.slice(0, 8000)}${t.length > 8000 ? '\n… (cut)' : ''}\n\`\`\``);
  }
  for (const item of list.filter((x) => x.type === 'term')) parts.push(`### Terminal output the user shared: ${item.title}\n\`\`\`\n${item.text}\n\`\`\``);
  for (const item of list.filter((x) => x.type === 'project')) {
    const p = G.projects.find((x) => x.id === item.id);
    const notes = await fetch(`/ws/${item.id}/AGENT.md`).then((r) => r.ok ? r.text() : '').catch(() => '');
    const files = await fetch(`/api/files?project=${item.id}`).then((r) => r.json()).catch(() => []);
    parts.push(`### Project "${p?.name || item.id}" (${p?.dir || ''})\nFiles: ${files.slice(0, 60).map((f) => f.path).join(', ') || 'none'}${notes ? `\nAGENT.md:\n${notes.slice(0, 5000)}` : ''}`);
  }
  for (const { id, title } of list.filter((x) => !x.type || x.type === 'chat')) {
    // A brief of the whole chat (cached until it changes); its last messages only if the brief can't be written.
    const b = await postJ(`/api/chats/${id}/brief`, {}).catch(() => null);
    if (b && b.brief) {
      if (b.cost) { const here = focused(); if (here) { (here.agent.extraUsage ||= []).push({ kind: 'summary', model: b.model, cost: b.cost, at: Date.now() }); } }
      const proj = G.projects.find((p) => p.id === b.project);
      parts.push(`### Chat "${title}" (project "${proj?.name || b.project}", model ${b.chatModel || '?'}): a brief of the whole chat\n${b.brief}`);
      continue;
    }
    const doc = await fetch(`/api/chats/${id}`).then((r) => r.json()).catch(() => null);
    if (!doc || doc.error) continue;
    const a = normalise(doc).agent;
    const lines = a.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-16).map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 1200)}`);
    const arts = Object.values(a.artifacts).map((x) => `${x.kind} "${x.title}"${x.url && !String(x.url).startsWith('data:') ? ` at ${x.url}` : ''}`);
    if (arts.length) lines.push(`Artifacts: ${arts.join('; ')}`);
    const proj = G.projects.find((p) => p.id === (doc.projectId || 'scratch'));
    parts.push(`### Chat "${title}" (project "${proj?.name || doc.projectId}", model ${a.setup.model})\n${lines.join('\n')}`);
  }
  const text = parts.join('\n\n');
  return text.length > 18000 ? text.slice(0, 18000) : text;
}

// ---------- @ mentions (files, chats, projects) and / commands ----------
// Typing @ suggests recent chats, this project's files and other projects; typing more filters
// them. Picking one attaches it as context for the next message. / lists the chat commands.
import { langOf, mountCode } from './code.js';
import { renderMarkdown, enhance } from './markdown.js';

// The message box's buttons: icons only, coloured by what they do.
const CMP_ICO = {
  attach: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>',
  rec: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  wait: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>',
};
// Small line icons (they take the button's colour, unlike emoji).
const ICO = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};
const COMMANDS = [
  ['model', 'Choose this chat\'s model', (c, arg) => { if (!arg) return $('.model', c.el.root).click(); const id = findModel(c, arg); if (!id) return uiAlert(`No model matches "${arg}".`); c.agent.setup.model = id; saveChat(c); renderComposerBar(c); renderChatHead(c); }],
  ['reason', 'How much the model thinks first', (c, arg) => { if (REASON[arg]) { c.agent.setup.reasoning = arg; saveChat(c); renderComposerBar(c); } }],
  ['creativity', 'How varied the answers are', (c, arg) => { if (CREATIVITY_INFO[arg]) { c.agent.setup.creativity = arg; saveChat(c); renderComposerBar(c); } }],
  ['strict', 'Ask before every tool (this chat)', (c) => { c.approval = 'strict'; saveChat(c); renderComposerBar(c); }],
  ['yolo', 'Don\'t ask before tools (this chat)', (c) => { c.approval = 'yolo'; saveChat(c); renderComposerBar(c); }],
  ['new', 'New chat (in this project, or the one you name)', (c, arg) => { const p = arg && G.projects.find((x) => x.name.toLowerCase() === arg.toLowerCase()); newChat(p ? p.id : c.projectId); }],
  ['clear', 'Clear this conversation', (c) => clearChat(c)],
  ['fresh', 'New chat from a short brief of this one (on a model you pick)', (c, arg) => freshFromChat(c, arg)],
  ['continue', 'Carry on the last reply that ran out of steps', (c, arg) => continueLast(c, arg)],
  ['undo', 'Undo the file changes of the last reply', (c) => { const m = [...c.agent.messages].reverse().find((x) => x.stats?.changed?.length && !x.undone); m ? undoReply(c, m) : uiAlert('No reply with file changes to undo.'); }],
  ['files', 'Browse this project\'s files', () => { G.view.files = true; G.view.run = false; syncLayout(); renderPane(); }],
  ['notes', 'Open this project\'s AGENT.md notes', (c) => openNotes(c)],
  ['file', 'Attach files of any kind (documents, PDFs, sheets, images…)', (c) => $('.imgInput', c.el.root).click()],
  ['image', 'Attach images', (c) => $('.imgInput', c.el.root).click()],
  ['attach', 'Pick chats to attach as context (a checklist)', (c) => openCtxPicker(c)],
  ['review', 'Review the code changes for bugs: the last reply, uncommitted changes, or the branch', (c, arg) => codeReview(c, arg)],
  ['usage', 'This chat\'s cost per model, as a card only you see', (c) => postUsage(c)],
  ['costs', 'What each project and chat has cost', () => openCosts()],
  ['schedule', 'Schedules: chats QuorX starts on its own (every weekday at 9, in an hour…)', () => openSchedules('new')],
  ['skills', 'List the skills the agent can load', (c) => showSkills(c)],
  ['settings', 'Open settings', () => openSettings()],
  ['help', 'What @ and / can do', () => uiAlert('@  attach a file, another chat, or another project as context for your next message.\n/  run a command: ' + COMMANDS.map(([k]) => '/' + k).join(' '))],
];
// What a command takes next. Tab completes the command and lists these; Tab fills one in, Enter runs it.
// need: the command does nothing without one, so Enter on the bare command lists them instead of running it.
const CMD_ARGS = {
  model: { usage: '[model]', list: (c) => modelArgs(c) },
  fresh: { usage: '[model]', list: (c) => modelArgs(c) },
  review: { usage: '[reply|changes|branch]', list: () => [['reply', 'the files the last reply changed'], ['changes', 'uncommitted git changes'], ['branch', 'this branch against main (or name a base: branch dev)']].map(([value, hint]) => ({ value, hint })) },
  continue: { usage: '[steps]', list: () => [10, 20, 30, 50].map((n) => ({ value: String(n), hint: `${n} more steps` })) },
  reason: { usage: '<level>', need: true, list: () => Object.entries(REASON_INFO).map(([v, [label, hint]]) => ({ value: v, hint: `${label}: ${hint}` })) },
  creativity: { usage: '<style>', need: true, list: () => Object.entries(CREATIVITY_INFO).map(([v, [label, hint]]) => ({ value: v, hint: `${label}: ${hint}` })) },
  new: { usage: '[project]', list: (c) => [...G.projects].sort((a, b) => (b.id === c.projectId) - (a.id === c.projectId)).map((p) => ({ value: p.name, hint: p.id === c.projectId ? 'this project' : 'a new chat there' })) },
};
// /model suggestions: the current model, your favourites and recent picks (with their prices when known).
function modelArgs(c) {
  const ids = [c.agent.setup.model, ...(G.favModels?.chat || []), ...(G.recentModels?.chat || [])].filter(Boolean);
  return [...new Set(ids)].map((id) => {
    const m = G.byId?.get(id), price = m?.price ? `$${m.price[0].toFixed(2)} in / $${m.price[1].toFixed(2)} out per M` : ''; // catalogue prices are already per million tokens
    return { value: id, label: short(id), hint: [id === c.agent.setup.model ? 'current' : (G.favModels?.chat || []).includes(id) ? '★ favourite' : 'recent', price].filter(Boolean).join(' · ') };
  });
}
// A typed model name: an exact id, else the one whose short name matches (favourites and recents first).
function findModel(c, q) {
  q = q.toLowerCase();
  const known = [...modelArgs(c).map((x) => x.value), ...(G.models || []).filter((m) => m.kind === 'chat').map((m) => m.id)];
  return known.find((id) => id.toLowerCase() === q) || known.find((id) => short(id).toLowerCase() === q) || known.find((id) => id.toLowerCase().includes(q)) || null;
}
function runCommand(c, line) {
  const [, name, arg = ''] = line.match(/^\/(\w+)\s*(.*)$/) || [];
  const cmd = COMMANDS.find(([k]) => k === name);
  if (!cmd) return false;
  cmd[2](c, arg.trim());
  return true;
}

// ---------- Ctrl+K: one search for chats, commands, settings pages, projects and this project's files ----------
// The same commands as / in the message box (those that need a chat only while one is open).
const PAL = { items: [], active: 0, files: null };
const PAL_GLOBAL = new Set(['new', 'costs', 'schedule', 'settings', 'help']);
function paletteItems(q) {
  const c = focused(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text) => words.every((w) => text.toLowerCase().includes(w));
  const projName = (id) => G.projects.find((p) => p.id === id)?.name || id;
  const out = [];
  const chats = [...G.chats].filter((x) => x.messages > 0).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  for (const x of (words.length ? chats : chats.slice(0, 6))) if (hit(`${x.title} ${projName(x.projectId)}`)) out.push({ group: 'Chats', icon: '💬', label: x.title, hint: `${projName(x.projectId)} · ${ago(x.lastAt || Date.now())}`, run: () => showChat(x.id) });
  for (const [k, desc, fn] of COMMANDS) if ((c || PAL_GLOBAL.has(k)) && hit(`/${k} ${desc}`)) out.push({ group: 'Commands', icon: '⚡', label: `/${k}`, hint: desc, run: () => (c ? runCommand(c, `/${k}`) : fn(null, '')) });
  const acts = [['🏠', 'Home', 'The start screen', () => goHome()], ['◐', 'Switch theme', 'System, dark, light', () => $('#themeBtn').click()], ['⟳', 'Restart the harness', 'Loads server changes', () => $('#restartBtn').click()]];
  for (const [icon, label, hint, run] of acts) if (hit(`${label} ${hint}`)) out.push({ group: 'Actions', icon, label, hint, run });
  if (words.length) for (const p of G.projects) if (hit(`${p.name} new chat project`)) out.push({ group: 'Projects', icon: '📁', label: `New chat in ${p.name}`, hint: `${p.spent ? `$${p.spent.toFixed(3)} spent` : 'project'}`, run: () => newChat(p.id) });
  for (const [group, items] of SETTINGS_NAV) for (const [id, icon, label] of items) if (words.length && hit(`${label} settings ${group}`)) out.push({ group: 'Settings', icon, label, hint: `⚙ Settings · ${group}`, run: () => openSettings(id) });
  if (words.length && c && PAL.files) for (const f of PAL.files) { if (out.length > 80) break; if (hit(f.path)) out.push({ group: 'Files', icon: '📄', label: f.path, hint: projName(c.projectId), run: () => openProjectFile(c, f.path) }); }
  return out.slice(0, 80);
}
async function openProjectFile(c, rel) {
  G.view.files = true; G.view.run = false; syncLayout(); await renderFiles(c);
  const btn = [...document.querySelectorAll('#paneBody .fl')].find((b) => b.dataset.p === rel);
  if (btn) { btn.click(); btn.scrollIntoView({ block: 'nearest' }); }
  if (isPhone()) setMView('preview');
}
function paletteDialog() {
  let d = $('#palette');
  if (d) return d;
  d = document.createElement('dialog');
  d.id = 'palette'; d.className = 'pal';
  d.innerHTML = `<div class="pal-box">
      <label class="pal-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>
        <input id="palInput" type="text" autocomplete="off" spellcheck="false" placeholder="Search chats, commands, settings and files…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="palList"></label>
      <div class="pal-list" id="palList" role="listbox" aria-label="Results"></div>
      <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
    </div>`;
  document.body.appendChild(d);
  const input = $('#palInput', d);
  input.oninput = () => drawPalette();
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); PAL.active = (PAL.active + (e.key === 'ArrowDown' ? 1 : -1) + PAL.items.length) % Math.max(1, PAL.items.length); paintActive(); }
    if (e.key === 'Enter') { e.preventDefault(); runPalette(PAL.active); }
  };
  d.addEventListener('mousedown', (e) => { if (e.target === d) d.close(); });
  return d;
}
function drawPalette() {
  const q = $('#palInput').value.trim(), list = $('#palList');
  PAL.items = paletteItems(q); PAL.active = 0;
  let last = '';
  list.innerHTML = PAL.items.length ? PAL.items.map((it, i) => {
    const head = it.group !== last ? `<div class="pal-group" role="presentation">${esc(it.group)}</div>` : '';
    last = it.group;
    return `${head}<div class="pal-item" role="option" id="pal-${i}" data-i="${i}" aria-selected="false"><span class="pal-ico" aria-hidden="true">${esc(it.icon)}</span><span class="pal-label">${esc(it.label)}</span><span class="pal-hint">${esc(it.hint || '')}</span></div>`;
  }).join('') : `<div class="pal-empty">Nothing matches “${esc(q)}”.</div>`;
  for (const el of list.querySelectorAll('.pal-item')) {
    el.onmousemove = () => { if (PAL.active !== +el.dataset.i) { PAL.active = +el.dataset.i; paintActive(false); } };
    el.onclick = () => runPalette(+el.dataset.i);
  }
  paintActive();
}
function paintActive(scroll = true) {
  for (const el of document.querySelectorAll('#palList .pal-item')) {
    const on = +el.dataset.i === PAL.active;
    el.classList.toggle('on', on); el.setAttribute('aria-selected', String(on));
    if (on && scroll) el.scrollIntoView({ block: 'nearest' });
  }
  $('#palInput')?.setAttribute('aria-activedescendant', PAL.items.length ? `pal-${PAL.active}` : '');
}
function runPalette(i) {
  const it = PAL.items[i]; if (!it) return;
  $('#palette').close();
  it.run();
}
function openPalette() {
  const d = paletteDialog(), c = focused();
  PAL.files = null;
  if (c) projectFiles(c.projectId).then((f) => { PAL.files = f; if (d.open && $('#palInput').value.trim()) drawPalette(); }).catch(() => {});
  $('#palInput', d).value = '';
  drawPalette();
  if (!d.open) d.showModal();
  $('#palInput', d).focus();
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const d = $('#palette'); if (d?.open) d.close(); else openPalette();
  }
});
const fileCache = new Map();
async function projectFiles(pid) {
  const hit = fileCache.get(pid);
  if (hit && Date.now() - hit.at < 30000) return hit.files;
  const files = await fetch(`/api/files?project=${pid}`).then((r) => r.json()).catch(() => []);
  fileCache.set(pid, { at: Date.now(), files: files.filter((f) => !/skipped\)$/.test(f.path)) });
  return fileCache.get(pid).files;
}
function tokenAtCaret(ta) {
  const before = ta.value.slice(0, ta.selectionStart);
  // / at the start: the command, then (after a space) what it takes next.
  const sl = before.match(/^\s*\/(\w*)(\s+([^\n]*))?$/);
  if (sl) {
    if (sl[2] === undefined) return { trigger: '/', query: sl[1].toLowerCase(), start: before.indexOf('/') };
    const cmd = sl[1].toLowerCase();
    return CMD_ARGS[cmd] ? { trigger: 'arg', cmd, query: (sl[3] || '').trim().toLowerCase(), start: before.indexOf('/') } : null;
  }
  const m = before.match(/(^|\s)([@/])([^\s@]*)$/);
  if (!m || (m[2] === '/' && before.trim() !== m[2] + m[3])) return null; // / only at the start
  return { trigger: m[2], query: m[3].toLowerCase(), start: before.length - m[3].length - 1 };
}
async function updateSuggest(c) {
  const ta = $('.input', c.el.root), tok = tokenAtCaret(ta);
  if (!tok) return hideSuggest(c);
  let items = [];
  if (tok.trigger === '/') {
    // Commands that start with what you typed come first, then ones whose description mentions it.
    const q = tok.query, starts = COMMANDS.filter(([k]) => k.startsWith(q)), mentions = q ? COMMANDS.filter(([k, d]) => !k.startsWith(q) && d.toLowerCase().includes(q)) : [];
    items = [...starts, ...mentions].map(([k, d]) => ({ icon: '⌘', label: `/${k}`, usage: CMD_ARGS[k]?.usage || '', hint: d, kind: 'cmd', value: k }));
  } else if (tok.trigger === 'arg') {
    const q = tok.query, all = CMD_ARGS[tok.cmd].list(c), lead = (x) => x.value.toLowerCase().startsWith(q) || (x.label || '').toLowerCase().startsWith(q);
    const leads = all.filter(lead); // words inside descriptions only count when nothing starts with what you typed
    items = [...leads, ...(leads.length ? [] : all.filter((x) => q && `${x.value} ${x.hint}`.toLowerCase().includes(q)))]
      .slice(0, 12).map((x) => ({ icon: '↳', label: x.label || x.value, hint: x.hint, kind: 'arg', value: x.value, cmd: tok.cmd }));
  } else {
    const q = tok.query;
    const chats = G.chats.filter((x) => x.id !== c.id && x.messages > 0);
    const files = await projectFiles(c.projectId);
    const pick = (list, n) => (q ? list : list.slice(0, n));
    const match = (s) => !q || String(s).toLowerCase().includes(q);
    const here = chats.filter((x) => x.projectId === c.projectId && match(x.title)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    const elsewhere = chats.filter((x) => x.projectId !== c.projectId && match(x.title)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    items = [
      ...pick(here, 4).map((x) => ({ icon: '💬', label: x.title, hint: `chat · ${ago(x.lastAt || x.updated)}`, kind: 'chat', value: x })),
      ...pick(files.filter((f) => match(f.path)), 5).map((f) => ({ icon: '📄', label: f.path, hint: 'file in this project', kind: 'file', value: f })),
      ...pick(elsewhere, 3).map((x) => ({ icon: '💬', label: x.title, hint: `chat in ${G.projects.find((p) => p.id === x.projectId)?.name || x.projectId}`, kind: 'chat', value: x })),
      ...pick(G.projects.filter((p) => p.id !== c.projectId && match(p.name)), 3).map((p) => ({ icon: '📁', label: p.name, hint: 'another project: its notes and file list', kind: 'project', value: p })),
    ].slice(0, 12);
  }
  const box = $('.suggest', c.el.root);
  if (!items.length) return hideSuggest(c);
  c.suggest = { items, sel: 0, tok };
  box.hidden = false;
  const head = tok.trigger === '/' ? 'Commands · Tab completes · Enter runs' : tok.trigger === 'arg' ? `/${tok.cmd} ${CMD_ARGS[tok.cmd].usage} · Tab fills in · Enter runs` : tok.query ? 'Matches' : 'Recent and suggested';
  box.innerHTML = `<div class="sg-head cmp-suggest-header">${esc(head)}</div>` + items.map((it, i) => `<div class="sg-item cmp-suggest-row ${i === 0 ? 'on active' : ''}" role="option" data-i="${i}"><span class="sg-ico cmp-suggest-icon">${it.icon}</span><span class="sg-label cmp-suggest-label">${esc(it.label)}${it.usage ? ` <i class="sg-usage">${esc(it.usage)}</i>` : ''}</span><span class="sg-hint cmp-suggest-hint">${esc(it.hint)}</span></div>`).join('');
  for (const el of box.querySelectorAll('.sg-item')) el.onmousedown = (e) => { e.preventDefault(); chooseSuggest(c, Number(el.dataset.i)); };
}
function hideSuggest(c) { const box = c.el && $('.suggest', c.el.root); if (box) box.hidden = true; c.suggest = null; }
function suggestKey(c, e) {
  const s = c.suggest;
  if (!s) return false;
  const box = $('.suggest', c.el.root);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); s.sel = (s.sel + (e.key === 'ArrowDown' ? 1 : s.items.length - 1)) % s.items.length; box.querySelectorAll('.sg-item').forEach((el, i) => { el.classList.toggle('on', i === s.sel); el.classList.toggle('active', i === s.sel); el.setAttribute('aria-selected', String(i === s.sel)); if (i === s.sel) el.scrollIntoView({ block: 'nearest' }); }); return true; }
  if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); chooseSuggest(c, s.sel, 'complete'); return true; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chooseSuggest(c, s.sel, 'run'); return true; }
  if (e.key === 'Escape') { hideSuggest(c); return true; }
  return false;
}
function chooseSuggest(c, i, how = 'run') {
  const s = c.suggest; if (!s) return;
  const it = s.items[i], ta = $('.input', c.el.root);
  const before = ta.value.slice(0, s.tok.start), after = ta.value.slice(ta.selectionStart);
  hideSuggest(c);
  const put = (text) => { ta.value = text; ta.selectionStart = ta.selectionEnd = text.length; ta.focus(); ta.dispatchEvent(new Event('input')); };
  if (it.kind === 'cmd') {
    const args = CMD_ARGS[it.value];
    // Tab (or Enter on a command that needs something next): write it out and list what it takes.
    if (how === 'complete' || args?.need) return put(`/${it.value}${args ? ' ' : ''}`);
    ta.value = (before + after).trim(); runCommand(c, `/${it.value}`); ta.focus(); return;
  }
  if (it.kind === 'arg') {
    if (how === 'complete') return put(`/${it.cmd} ${it.value}`);
    ta.value = ''; ta.dispatchEvent(new Event('input')); runCommand(c, `/${it.cmd} ${it.value}`); ta.focus(); return;
  }
  if (it.kind === 'chat') c.ctx.push({ type: 'chat', id: it.value.id, title: it.value.title });
  if (it.kind === 'file') c.ctx.push({ type: 'file', projectId: c.projectId, path: it.value.path, title: it.value.path });
  if (it.kind === 'project') c.ctx.push({ type: 'project', id: it.value.id, title: `📁 ${it.value.name}` });
  c.ctx = [...new Map(c.ctx.map((x) => [`${x.type}:${x.id || x.path}`, x])).values()];
  ta.value = `${before}@${it.label} ${after}`;
  ta.selectionStart = ta.selectionEnd = before.length + it.label.length + 2;
  ta.focus(); renderAttachments(c);
}
async function openNotes(c) {
  G.view.files = true; G.view.run = false; syncLayout(); await renderFiles(c);
  const btn = [...document.querySelectorAll('#paneBody .fl')].find((b) => b.dataset.p === 'AGENT.md');
  if (btn) btn.click(); else $('#paneBody .fview').textContent = 'No AGENT.md yet. The agent writes it when there is something worth recording.';
}
async function showSkills(c) {
  const list = await fetch(`/api/skills?project=${c.projectId}`).then((r) => r.json()).catch(() => []);
  const off = new Set(G.settings.skillsOff || []);
  uiAlert(list.length ? list.map((k) => `${off.has(k.name) ? '✕' : '✓'} ${k.name} (${k.source}): ${k.description}`).join('\n') + '\n\nSwitch skills on or off in ⚙ Settings.' : 'No skills yet.');
}

// ---------- attached images: 📷, paste or drop; downscaled in the browser ----------
function downscale(file, max = 1568) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const cv = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(cv.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('not an image'));
    img.src = URL.createObjectURL(file);
  });
}
async function addImages(c, files) {
  for (const f of [...files].filter((x) => x.type.startsWith('image/')).slice(0, 4 - c.images.length)) {
    try { const full = await downscale(f); c.images.push({ full, view: await downscale(f, 1024), thumb: await downscale(f, 160) }); } catch { /* skip */ }
  }
  renderAttachments(c);
}
function renderAttachments(c) {
  const box = c.el && $('.attachments', c.el.root);
  if (!box) return;
  box.innerHTML = (c.comments || []).map((x, i) => `<span class="cmt-chip cmp-att-item" title="${esc(x.note || 'No note: the agent will ask what to change')}">${x.crop ? `<img src="${x.crop}" alt="">` : ''}<span class="cmt-what">💬 <b>${esc(x.tag)}</b> ${esc(clip(x.text || x.selector, 40))}</span><button type="button" data-cmt="${i}" aria-label="Remove this comment">✕</button></span>`).join('')
    + c.ctx.map((x, i) => `<span class="ctx-chip cmp-att-item ${x.type === 'file' ? 'file' : x.type === 'project' ? 'project' : x.type === 'term' ? 'termout' : 'chat'}" title="${x.type === 'term' ? esc(clip(x.text, 600)) : 'Attached as context for your next message'}">${x.type === 'file' ? '📄' : x.type === 'project' || x.type === 'term' ? '' : '💬'} ${esc(x.title)}<button type="button" data-ctx="${i}" aria-label="Remove">✕</button></span>`).join('')
    + c.images.map((x, i) => `<span class="img-chip cmp-att-item image"><img src="${x.thumb}" alt="attached image ${i + 1}"><button type="button" data-img="${i}" aria-label="Remove image">✕</button></span>`).join('')
    + (c.docs || []).map((d, i) => docChip(d, i)).join('')
    + ((G.lent ||= {})[c.id] ? `<span class="lent-chip cmp-att-item" title="The agent can work in this tab of yours (signed in as you) in this chat. Sending, deleting, buying and account changes ask you first."><span class="lent-ico" aria-hidden="true">🤖</span><span class="lent-l">${G.lent[c.id].chrome ? 'Your Chrome tab' : 'Your tab'}</span><b>${esc(clip(G.lent[c.id].title || G.lent[c.id].url, 40))}</b><button type="button" class="lent-back" title="Take the tab back: the agent can no longer use it">Take back</button></span>` : '');
  for (const b of box.querySelectorAll('[data-ctx]')) b.onclick = () => { c.ctx.splice(Number(b.dataset.ctx), 1); renderAttachments(c); };
  for (const b of box.querySelectorAll('[data-img]')) b.onclick = () => { c.images.splice(Number(b.dataset.img), 1); renderAttachments(c); };
  for (const b of box.querySelectorAll('[data-cmt]')) b.onclick = () => { c.comments.splice(Number(b.dataset.cmt), 1); renderAttachments(c); };
  const lb = $('.lent-back', box); if (lb) lb.onclick = () => takeBackTab(c.id);
  wireDocChips(c, box);
}

// ---------- sidebar: projects and chats ----------
async function refreshSidebar() {
  try {
    const [projects, chats] = await Promise.all([fetch('/api/projects').then((r) => r.json()), fetch('/api/chats').then((r) => r.json())]);
    if (!Array.isArray(projects) || !Array.isArray(chats)) return; // refused (no app link) or an error: keep what's shown
    [G.projects, G.chats] = [projects, chats];
  } catch { return; }
  renderSidebar();
  budgetNotices();
  folderNotices();
  if (!G.panes.length && $('#chats .landing')) renderLanding($('#chats'));
}
// A notice at the top of the chat when its project is close to (80%) or at its budget. It is only on
// the page (never sent to the agent); ✕ hides it until the next threshold or a new budget.
function budgetNotices() {
  for (const c of G.open.values()) {
    if (!c.el) continue;
    const old = $('.budget-notice', c.el.root);
    const p = G.projects.find((x) => x.id === c.projectId);
    const share = p?.budget ? (p.spent || 0) / p.budget : 0;
    const level = !p || p.budget == null ? null : share >= 1 ? 'full' : share >= 0.8 ? 'near' : null;
    const seen = (G.budgetSeen || {})[p?.id];
    if (!level || (seen && seen.level === level && seen.budget === p.budget)) { old?.remove(); continue; }
    const spent = p.spent || 0, left = Math.max(0, p.budget - spent);
    const html = `<div class="budget-notice ${level}" role="status">
      <span class="bn-ico">${level === 'full' ? '⛔' : '⚠️'}</span>
      <div class="bn-text"><b>${level === 'full' ? `“${esc(p.name)}” has used its $${p.budget.toFixed(2)} budget.` : `“${esc(p.name)}” has used ${Math.round(share * 100)}% of its $${p.budget.toFixed(2)} budget.`}</b>
        <small>$${spent.toFixed(4)} spent${level === 'full' ? ' · replies pause until you raise it' : ` · $${left.toFixed(2)} left`}</small>
        <span class="bn-bar"><i style="width:${Math.min(100, share * 100).toFixed(1)}%"></i></span></div>
      <button type="button" class="bn-raise">Raise budget</button>
      <button type="button" class="bn-x" title="Hide until the next threshold" aria-label="Dismiss">✕</button>
    </div>`;
    if (old) old.outerHTML = html; else $('.chat-head', c.el.root).insertAdjacentHTML('afterend', html);
    const el = $('.budget-notice', c.el.root);
    $('.bn-raise', el).onclick = () => openProjectSettings(p, 'budget');
    $('.bn-x', el).onclick = () => { (G.budgetSeen ??= {})[p.id] = { level, budget: p.budget }; savePrefs(); el.remove(); };
  }
}
function renderSidebar() {
  const q = $('#chatSearch').value.trim().toLowerCase();
  const curProject = focused()?.projectId;
  // Chats open here but not saved yet (no messages) still show while they're on screen.
  const unsaved = [...G.open.values()].filter((c) => !G.chats.some((x) => x.id === c.id) && G.panes.includes(c.id))
    .map((c) => ({ id: c.id, title: c.title, projectId: c.projectId, messages: 0, cost: 0, lastAt: c.created, model: c.agent.setup.model, preview: '' }));
  const all = [...unsaved, ...G.chats];
  // Your order first (drag a project's header to move it); projects you haven't placed keep theirs after.
  const rank = (p) => { const i = (G.projectOrder || []).indexOf(p.id); return i < 0 ? 1e6 + G.projects.indexOf(p) : i; };
  $('#projectList').classList.toggle('has-current', !!curProject);
  const pl = $('#projectList');
  if (!pl.dataset.dragScroll) {
    pl.dataset.dragScroll = '1';
    pl.addEventListener('dragover', (e) => { if (![...e.dataTransfer.types].includes('text/x-project')) return; const r = pl.getBoundingClientRect(), edge = 48; if (e.clientY < r.top + edge) pl.scrollTop -= 14; else if (e.clientY > r.bottom - edge) pl.scrollTop += 14; });
  }
  const pinRank = (p) => (p.pinned ? p.pinned : Infinity);
  $('#projectList').innerHTML = G.projects.filter((p) => !p.archived).sort((a, b) => (pinRank(a) - pinRank(b)) || (rank(a) - rank(b))).map((p) => {
    // Newest first: the chat you used last is at the top of its project.
    const chats = all.filter((c) => (c.projectId || 'scratch') === p.id && (c.messages > 0 || G.panes.includes(c.id))).sort((a, b) => (b.lastAt || b.updated || 0) - (a.lastAt || a.updated || 0));
    const shown = chats.filter((c) => !q || c.title.toLowerCase().includes(q) || String(c.preview || '').toLowerCase().includes(q));
    if (q && !shown.length) return '';
    // The server's total also counts replies that never reached a chat file (stopped, page closed, deleted), and
    // replies running now as they stood when it was fetched: replies running in this page add what they have spent since.
    const liveHere = chats.reduce((s, c) => s + liveOf(G.open.get(c.id)), 0);
    const cost = p.spent != null ? p.spent + Math.max(0, liveHere - (p.runningCost || 0)) : chats.reduce((s, c) => s + (c.cost || 0), 0) + liveHere;
    const share = p.budget ? Math.min(1, cost / p.budget) : 0;
    const folded = (G.foldedProjects || []).includes(p.id) && !q;
    // A project with a chat working glows; with a chat open it's the current one; the rest fade back (see last.css).
    const working = chats.some((c) => G.open.get(c.id)?.running);
    return `<div class="sb-project ${p.id === curProject ? 'current' : ''} ${working ? 'working' : ''} ${folded ? 'folded' : ''} ${p.pinned ? 'pinned' : ''}" data-p="${esc(p.id)}" style="${projStyle(p)}">
      <div class="sb-ph" aria-expanded="${!folded}">
        <div class="sb-pname-wrap"><b class="sb-pname" title="${esc(p.name)} · ${esc(p.dir)}">${esc(p.name)}</b><button type="button" class="sb-fold" aria-expanded="${!folded}" title="${folded ? 'Show' : 'Hide'} this project's chats" aria-label="${folded ? 'Show' : 'Hide'} chats of ${esc(p.name)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></button>${p.missing ? '<button type="button" class="sb-missing" title="The project folder was moved, renamed or deleted: click to reselect it">⚠ missing</button>' : p.needsFolder ? '<button type="button" class="sb-missing needs" title="Pick a folder for this project: its files sit inside QuorX itself and are copied to the folder you pick" aria-label="Pick a folder for this project">📁</button>' : ''}${working ? '<span class="sb-pworking" title="A chat in this project is working" aria-label="Working"></span>' : ''}<span class="sb-psp"></span><button type="button" class="sb-pin sb-picon ${p.pinned ? 'on' : ''}" aria-pressed="${!!p.pinned}" title="${p.pinned ? 'Unpin' : 'Pin to the top (up to 3)'}" aria-label="${p.pinned ? 'Unpin' : 'Pin'} ${esc(p.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v6"/></svg></button><button type="button" class="sb-edit sb-picon" title="Project settings: budget, pin, archive, folder, colour" aria-label="Settings for ${esc(p.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg></button><button type="button" class="sb-new sb-picon" title="New chat in ${esc(p.name)}" aria-label="New chat in ${esc(p.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button><span class="sb-grip" draggable="true" tabindex="0" role="button" title="Drag to move this project (or focus it and press ↑ / ↓)" aria-label="Move ${esc(p.name)}: drag, or press up or down"><svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg></span></div>
        ${p.id === curProject ? projectSpendHTML(p, chats.length, cost, share, chats) : ''}
      </div>
      ${shown.map((c) => {
        const live = G.open.get(c.id);
        const running = !!live?.running, waiting = running && live.waiting;
        const spent = (c.cost || 0) + liveOf(G.open.get(c.id));
        const tip = [c.title || 'Untitled', ...(c.model ? [`Model\t${short(c.model)}`] : []), `Last message\t${new Date(c.lastAt || c.updated || Date.now()).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`, ...(c.messages ? [`Messages\t${c.messages}`] : []), ...(running ? [`Now\t${waiting ? 'waiting for you' : 'working'}`] : []), `Spent\t$${spent.toFixed(3)}`].join('\n');
        return `<div class="sb-chat sb-chat-item ${G.panes.includes(c.id) ? 'on active' : ''} ${running ? 'running' : ''}" data-c="${esc(c.id)}" data-tip-delay="900" title="${esc(tip)}">
          <div class="sb-chat-content">
            <div class="sb-chat-topline"><span class="sb-chat-title">${esc(c.title)}</span>${running ? '<span class="live-dot" aria-label="Running"></span>' : ''}</div>
            ${waiting ? `<div class="sb-chat-prev"><b class="needs">${waiting === 'answer' ? 'Waiting for your answer' : waiting === 'budget' ? 'Waiting: project budget reached' : 'Waiting for your approval'}</b></div>` : running ? '<div class="sb-chat-prev"><i>Working…</i></div>' : ''}
            <div class="sb-chat-meta"><span>${ago(c.lastAt || c.updated || Date.now())}</span>${c.model ? `<span>· ${esc(short(c.model))}</span>` : ''}${c.cost || liveOf(G.open.get(c.id)) ? `<span class="cost${liveOf(G.open.get(c.id)) ? ' live' : ''}">· $${((c.cost || 0) + liveOf(G.open.get(c.id))).toFixed(3)}</span>` : ''}</div>
          </div>
          <div class="sb-chat-acts"><button type="button" class="sb-ren ico-rename" title="Rename chat" aria-label="Rename chat">${ICO.pencil}</button><button type="button" class="sb-del del ico-delete" title="Delete chat (moves it to data/trash)" aria-label="Delete chat">${ICO.trash}</button></div>
        </div>`;
      }).join('') || '<div class="sb-empty">No chats yet</div>'}
    </div>`;
  }).join('');
  renderArchive(all);
  // The collapsed rail lists only the chats working right now (to jump back to them); the rest is in the full sidebar.
  const rail = [...all].filter((c) => G.open.get(c.id)?.running).slice(0, 8);
  $('#railList').innerHTML = rail.map((c) => {
    const running = !!G.open.get(c.id)?.running;
    return `<button type="button" class="sb-rail-btn ${G.panes.includes(c.id) ? 'active' : ''} ${running ? 'live-running' : ''}" data-c="${esc(c.id)}" data-tip="${esc(c.title)}" style="--h:${hue(c.title)}">${esc(initials(c.title))}${running ? '<span class="rail-dot"></span>' : ''}</button>`;
  }).join('');
  for (const b of document.querySelectorAll('#railList .sb-rail-btn')) b.onclick = () => showChat(b.dataset.c, G.focus);
  const today = G.chats.reduce((n, c) => n + (c.today || 0), 0), total = G.chats.reduce((n, c) => n + (c.cost || 0), 0);
  $('#costsPill').textContent = `$${total.toFixed(total < 1 ? 3 : 2)}`; // everything spent so far, all projects
  for (const el of document.querySelectorAll('#projectList .sb-chat')) {
    const id = el.dataset.c;
    el.onclick = (e) => { if (!e.target.closest('button')) { showChat(id, G.focus); closeDrawer(); if (isPhone()) setMView('chat'); } };
    $('.sb-ren', el).onclick = () => renameChat(id);
    $('.sb-del', el).onclick = () => deleteChat(id);
  }
  for (const el of document.querySelectorAll('#projectList .sb-project')) {
    const p = G.projects.find((x) => x.id === el.dataset.p);
    $('.sb-new', el).onclick = (e) => { e.stopPropagation(); newChat(p.id); };
    $('.sb-edit', el).onclick = (e) => { e.stopPropagation(); openProjectSettings(p); };
    $('.sb-pin', el).onclick = (e) => { e.stopPropagation(); setProjectFlag(p, { pinned: !p.pinned }); };
    const miss = $('.sb-missing', el); if (miss) miss.onclick = () => editProject(p, { reselect: true });
    const del = $('.sb-delp', el); if (del) del.onclick = () => deleteProject(p);

    // Drag and drop to reorder projects: only the ⠿ grip drags, so the header's buttons stay easy to click.
    const ph = $('.sb-ph', el), grip = $('.sb-grip', el);
    ph.title = 'Click to fold or unfold its chats';
    // Click the header (not its buttons) to fold the project's chats away and get the space back.
    ph.onclick = (e) => {
      if (e.target.closest('button:not(.sb-fold), .bud-pop, .sb-pstrip, .sb-grip')) return;
      const set = new Set(G.foldedProjects || []);
      set.has(p.id) ? set.delete(p.id) : set.add(p.id);
      G.foldedProjects = [...set]; savePrefs();
      el.classList.toggle('folded', set.has(p.id)); ph.setAttribute('aria-expanded', String(!set.has(p.id)));
      const fb = $('.sb-fold', ph), shut = set.has(p.id); fb.setAttribute('aria-expanded', String(!shut)); fb.title = `${shut ? 'Show' : 'Hide'} this project's chats`; fb.setAttribute('aria-label', `${shut ? 'Show' : 'Hide'} chats of ${p.name}`);
    };
    // Dragging shows a small pill with the project's name under the pointer (not a faded copy of the whole card);
    // the project stays in place as an outline, and a bright line marks where it will land.
    grip.ondragstart = (e) => {
      e.dataTransfer.setData('text/x-project', p.id); e.dataTransfer.effectAllowed = 'move';
      const ghost = document.createElement('div');
      ghost.className = 'sb-drag-ghost'; ghost.style.setProperty('--ph', hue(p.name)); if (p.color) ghost.style.setProperty('--pcx', p.color); ghost.textContent = p.name;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 14, 16);
      setTimeout(() => ghost.remove(), 0);
      el.classList.add('dragging'); $('#projectList').classList.add('drag-on');
    };
    // Keyboard: focus the grip, ↑ / ↓ moves the project one place.
    grip.onkeydown = (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const order = [...document.querySelectorAll('#projectList .sb-project')].map((x) => x.dataset.p), i = order.indexOf(p.id), j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      G.projectOrder = order; savePrefs(); renderSidebar();
      requestAnimationFrame(() => $(`#projectList .sb-project[data-p="${CSS.escape(p.id)}"] .sb-grip`)?.focus());
    };
    grip.ondragend = () => {
      $('#projectList').classList.remove('drag-on'); el.classList.remove('dragging'); for (const x of document.querySelectorAll('.sb-project')) x.classList.remove('drop-before', 'drop-after'); };
    el.ondragover = (e) => {
      if (![...e.dataTransfer.types].includes('text/x-project')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(), before = e.clientY < r.top + Math.min(r.height / 2, 24);
      el.classList.toggle('drop-before', before); el.classList.toggle('drop-after', !before);
    };
    el.ondragleave = (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-before', 'drop-after'); };
    el.ondrop = (e) => {
      const id = e.dataTransfer.getData('text/x-project');
      const before = el.classList.contains('drop-before');
      el.classList.remove('drop-before', 'drop-after');
      if (!id || id === p.id) return;
      e.preventDefault();
      const order = [...document.querySelectorAll('#projectList .sb-project')].map((x) => x.dataset.p).filter((x) => x !== id);
      order.splice(order.indexOf(p.id) + (before ? 0 : 1), 0, id);
      G.projectOrder = order; savePrefs(); renderSidebar();
    };
  }
}
async function renameChat(id) {
  const c = await getChat(id) || G.open.get(id);
  if (!c) return;
  const t = await uiPrompt('Rename chat', c.title); if (!t?.trim()) return;
  c.title = t.trim(); await saveChat(c, true); renderPanes();
}
async function clearChat(c) {
  if (c.running || !await uiConfirm('Clear this conversation? (Its project files stay.)')) return;
  c.agent.messages = []; c.agent.artifacts = {}; saveChat(c, true); renderPanes();
}
async function deleteChat(id) {
  const c = G.open.get(id) || G.chats.find((x) => x.id === id);
  if (G.open.get(id)?.running) return uiAlert('This chat is still running. Stop it first.');
  if (!await uiConfirm(`Delete "${c?.title}"?\nIt moves to data/trash (recoverable). The project folder and its files stay.`)) return;
  await fetch(`/api/chats/${id}`, { method: 'DELETE' });
  G.open.delete(id);
  const i = G.panes.indexOf(id);
  if (i >= 0) { G.panes.splice(i, 1); if (!G.panes.length) showLanding(); else { G.focus = 0; renderPanes(); } }
  refreshSidebar();
}
// ---------- ⚙ project settings: name, folder, budget, and what each chat cost ----------
async function openProjectSettings(p0, focusOn) {
  const dlg = $('#projDlg'), box = $('#projBody');
  const projects = await fetch('/api/projects').then((r) => r.json()).catch(() => G.projects);
  const p = projects.find((x) => x.id === p0.id) || p0;
  box.innerHTML = `
    <header class="pj-head">
      <div class="pj-title" style="--h:${hue(p.name)}${p.color ? `;--pcx:${p.color}` : ''}"><b class="pj-name" title="The project is named after its folder; pick another folder to change it">${esc(p.name)}</b><small>Project settings</small></div>
      <div class="pj-head-acts">
        <label class="pj-pick pj-hpick ${p.color ? 'on' : ''}" title="Name colour: pick any colour"><input type="color" value="${esc(p.color || autoHex(p.name))}" aria-label="Pick the name colour"><span class="pj-pick-sw" style="--sw:${esc(p.color || autoHex(p.name))}"></span><code class="pj-pick-hex">${esc(p.color || 'Auto')}</code></label>
        <button type="button" class="pj-auto pj-hbtn ${p.color ? '' : 'on'}" title="Back to the automatic colour (from the name)" aria-label="Automatic name colour" ${p.color ? '' : 'hidden'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/></svg></button>
        <button type="button" class="pj-pin pj-hbtn ${p.pinned ? 'on' : ''}" aria-pressed="${!!p.pinned}" title="${p.pinned ? 'Pinned to the top of the sidebar: click to unpin' : 'Pin to the top of the sidebar (up to 3)'}" aria-label="Pin to the top" ${p.archived ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v6"/></svg></button>
        <button type="button" class="mp-x pj-close" aria-label="Close">✕</button>
      </div>
    </header>
    <div class="pj-scroll">
      <section class="pj-sec">
        <h4>Folder</h4>
        <div class="pj-folder-row"><div class="pj-folder ${p.missing ? 'missing' : ''}"><button type="button" class="pj-copy" title="Copy the folder path" aria-label="Copy the folder path">${msgIcon('copy')}</button><code class="blurable" title="${esc(p.dir)}
Every chat in this project reads, writes and runs programs in this folder.">${esc(p.dir)}</code></div>
        ${p.missing ? '' : '<button type="button" class="kx-btn sm pj-open" title="Open in File Explorer">📂 Open</button>'}<button type="button" class="kx-btn sm pj-move">${p.missing ? 'Reselect…' : p.needsFolder ? 'Pick a folder…' : 'Change…'}</button></div>
        ${p.github ? `<div class="pj-gh" data-gh="${esc(p.id)}">${ghLineHTML(p.github)}</div>` : ''}
        ${p.missing ? '<p class="pf-warn">⚠ This folder is missing: it was moved, renamed or deleted outside QuorX. Reselect it to keep working.</p>' : p.needsFolder ? '<p class="pf-warn">📁 This project\'s files sit inside QuorX itself. Pick a folder of your own: its files are copied there, and chats can work in it again.</p>' : ''}
      </section>
      <section class="pj-sec" id="pjDesignSec">
        <details class="pj-fold" id="pjDesignFold">
          <summary><h4>Design system <small>how the pages and apps chats build here look</small></h4><span class="pj-fold-state" id="pjDesignState">…</span><svg class="pj-fold-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
          <div id="pjDesign"><div class="kx-wait">Loading…</div></div>
        </details>
      </section>
      <section class="pj-sec" id="pjHooksSec">
        <details class="pj-fold" id="pjHooksFold">
          <summary><h4>Hooks <small>commands QuorX runs around the agent's file writes and commands</small></h4><span class="pj-fold-state" id="pjHooksState">…</span><svg class="pj-fold-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg></summary>
          <div id="pjHooks"><div class="kx-wait">Loading…</div></div>
        </details>
      </section>
      <section class="pj-sec" id="pjBudgetSec">
        <div class="pj-sec-head"><h4>Budget <small>for all chats together</small></h4>
        <div class="pj-budget-mode"><button type="button" class="pj-mode ${p.budget == null ? 'on' : ''}" data-mode="none">No limit</button><button type="button" class="pj-mode ${p.budget != null ? 'on' : ''}" data-mode="set">Set a budget</button></div></div>
        <div id="pjBudget"></div>
      </section>
      <section class="pj-sec">
        <div class="pj-sec-head"><h4>Costs <small>per chat</small></h4><div class="pj-kpis" id="pjKpis"></div></div>
        <div id="pjChats" class="pj-chats"><div class="kx-wait">Loading…</div></div>
      </section>
      ${p.id !== 'scratch' ? `<section class="pj-sec danger"><div class="pj-row"><h4>Danger zone</h4><button type="button" class="kx-btn sm pj-archive" title="Archive: out of the sidebar and the start screen; find it again under Archived at the bottom of the sidebar">${p.archived ? 'Unarchive' : 'Archive'}</button><button type="button" class="kx-btn sm pj-del">🗑 Delete project</button><span class="pj-hint">Its chats move to the trash; the folder and files are not touched.</span></div></section>` : ''}
    </div>`;
  const close = () => dlg.close();
  $('.pj-close', box).onclick = close;
  const pjOpen = $('.pj-open', box); if (pjOpen) pjOpen.onclick = () => openFolder(p.id);
  const pjCopy = $('.pj-copy', box);
  pjCopy.onclick = () => navigator.clipboard?.writeText(p.dir).then(() => flashTip(pjCopy, 'Copied')).catch(() => flashTip(pjCopy, 'Could not copy'));
  loadGhMeta(box);
  // Name colour: saved at once; the sidebar, start screen and chat headers follow.
  const setColor = async (color) => {
    const r = await postJ(`/api/projects/${p.id}/color`, { color: color || null }).catch((e) => ({ error: e.message }));
    if (r?.error) return uiAlert(`Could not change the colour: ${r.error}`);
    p.color = r.color || undefined;
    const gp = G.projects.find((x) => x.id === p.id); if (gp) gp.color = p.color;
    const au = $('.pj-auto', box), pk = $('.pj-pick', box);
    au.hidden = !p.color; pk.classList.toggle('on', !!p.color);
    $('.pj-pick-sw', box).style.setProperty('--sw', p.color || autoHex(p.name)); $('.pj-pick-hex', box).textContent = p.color || 'Auto';
    const tt = $('.pj-title', box); if (p.color) tt.style.setProperty('--pcx', p.color); else tt.style.removeProperty('--pcx');
    refreshSidebar();
    for (const ch of G.open.values()) if (ch.projectId === p.id) renderChatHead(ch);
    const land = $('.landing'); if (land) renderLanding(land.parentElement);
  };
  $('.pj-auto', box).onclick = () => setColor('');
  // The picker previews as you drag and saves when you let go.
  const picker = $('.pj-pick input', box);
  picker.oninput = () => { $('.pj-pick-sw', box).style.setProperty('--sw', picker.value); $('.pj-pick-hex', box).textContent = picker.value; };
  picker.onchange = () => setColor(picker.value);
  $('.pj-move', box).onclick = async () => { dlg.close(); await editProject(p, { reselect: p.missing || p.needsFolder }); };
  const del = $('.pj-del', box); if (del) del.onclick = async () => { dlg.close(); await deleteProject(p); };
  const pin = $('.pj-pin', box);
  if (pin) pin.onclick = async () => {
    await setProjectFlag(p, { pinned: !p.pinned });
    const now = G.projects.find((x) => x.id === p.id); p.pinned = now?.pinned;
    pin.classList.toggle('on', !!p.pinned); pin.setAttribute('aria-pressed', String(!!p.pinned));
    pin.dataset.ohTitle = p.pinned ? 'Pinned to the top of the sidebar: click to unpin' : 'Pin to the top of the sidebar (up to 3)';
  };
  const arc = $('.pj-archive', box);
  if (arc) arc.onclick = async () => { const to = !p.archived; await setProjectFlag(p, { archived: to }); dlg.close(); };
  // budget: "No limit" or the editor
  const mountBudget = () => editBudget(p, undefined, $('#pjBudget', box));
  const setMode = async (mode) => {
    for (const b of box.querySelectorAll('.pj-mode')) b.classList.toggle('on', b.dataset.mode === mode);
    if (mode === 'set') { $('#pjBudget', box).hidden = false; mountBudget(); return; }
    $('#pjBudget', box).hidden = true; $('#pjBudget', box).innerHTML = '';
    if (p.budget != null) {
      const r = await fetch(`/api/projects/${p.id}/budget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budget: null }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
      if (r.error) { uiAlert(`Could not remove the budget: ${r.error}.`); return setMode('set'); }
      p.budget = null; refreshSidebar();
      const b = $('#pjKpis > div:nth-child(3) b', box); if (b) b.textContent = 'No limit';
    }
  };
  for (const b of box.querySelectorAll('.pj-mode')) b.onclick = () => setMode(b.dataset.mode);
  if (p.budget != null) mountBudget(); else $('#pjBudget', box).hidden = true;
  // costs: totals and a paged list of chats
  let offset = 0;
  const loadChats = async (more) => {
    const page = await fetch(`/api/costs/chats?project=${encodeURIComponent(p.id)}&sort=cost&offset=${offset}&limit=15`).then((r) => r.json()).catch(() => null);
    const list = $('#pjChats', box);
    if (!page) { list.innerHTML = '<div class="kx-wait">Could not load costs.</div>'; return; }
    if (!more) {
      const today = page.chats.reduce((n, c) => n + c.today, 0);
      $('#pjKpis', box).innerHTML = `<div><small>Spent</small><b>$${(p.spent || 0).toFixed(4)}</b></div><div><small>Chats</small><b class="plain">${page.total}</b></div><div><small>Budget</small><b class="plain">${p.budget != null ? `$${p.budget.toFixed(2)}` : 'No limit'}</b></div>`;
      list.innerHTML = page.total ? `<table class="cost-table pj-table"><thead><tr><th>Chat</th><th>Msgs</th><th>Models</th><th>Today</th><th>Total</th></tr></thead><tbody></tbody></table>` : '<div class="kx-wait">No chats with spending yet.</div>';
    }
    const body = $('tbody', list);
    if (body) body.insertAdjacentHTML('beforeend', page.chats.map((c) => costRow(c)).join(''));
    offset = page.offset + page.chats.length;
    list.querySelector('.cx-more')?.remove();
    if (offset < page.total) { list.insertAdjacentHTML('beforeend', `<button type="button" class="cx-more">Show more (${page.total - offset} more)</button>`); $('.cx-more', list).onclick = () => loadChats(true); }
    for (const a of list.querySelectorAll('[data-open]')) a.onclick = (e) => { e.preventDefault(); dlg.close(); showChat(a.dataset.open); if (isPhone()) setMView('chat'); };
  };
  loadChats(false);
  // After a save: the Budget figure above the chat list follows.
  $('#pjBudget', box).addEventListener('budget-saved', (e) => { const b = $('#pjKpis > div:nth-child(3) b', box); if (b) b.textContent = e.detail.budget != null ? `$${e.detail.budget.toFixed(2)}` : 'No limit'; });
  // Folded to one row: which design system (or none); the starters and editing open from it.
  mountDesign(p, $('#pjDesign', box)).then(() => { const st = $('#pjDesignState', box), cur = $('#pjDesign .ds-current b', box); if (st) { st.textContent = cur ? cur.textContent : 'None'; st.classList.toggle('none', !cur); } });
  mountHooks(p, $('#pjHooks', box), (n) => { const st = $('#pjHooksState', box); if (st) { st.textContent = n ? `${n} on` : 'None'; st.classList.toggle('none', !n); } });
  if (!dlg.open) dlg.showModal();
  if (focusOn === 'hooks') { $('#pjHooksFold', box).open = true; $('#pjHooksSec', box).scrollIntoView({ block: 'start' }); }
  if (focusOn === 'budget') $('#pjBudgetSec', box).scrollIntoView({ block: 'start' });
  if (focusOn === 'design') { $('#pjDesignFold', box).open = true; $('#pjDesignSec', box).scrollIntoView({ block: 'start' }); }
}
// Project settings → Hooks: commands QuorX runs around the agent's tool calls, in this order. Kept in QuorX's data
// folder (never in the project), so a folder you open can't bring its own. Each still goes through the command rules.
const HOOK_WHEN = { after_write: 'After a file write', before_command: 'Before a command', after_command: 'After a command' };
const HOOK_MATCH_HINT = { after_write: 'files, e.g. *.ts, src/** (empty: every file)', before_command: 'commands, e.g. npm *, git push* (empty: every command)', after_command: 'commands, e.g. npm test* (empty: every command)' };
async function mountHooks(p, el, onCount) {
  if (!el) return;
  if (p.missing || p.needsFolder) { el.innerHTML = '<p class="pj-hint">Pick a folder for this project first.</p>'; return; }
  const r = await fetch(`/api/projects/${p.id}/hooks`).then((x) => x.json()).catch((e) => ({ error: e.message }));
  if (r.error) { el.innerHTML = `<p class="pf-warn">Could not read the hooks: ${esc(r.error)}</p>`; return; }
  let list = r.hooks, saved = JSON.stringify(list);
  const draw = () => {
    const dirty = JSON.stringify(list) !== saved;
    el.innerHTML = `<p class="pj-hint">QuorX runs these commands itself around the agent's tool calls, top to bottom; the agent can't skip or change them. Each still goes through your command rules and Stop. <code>{file}</code> is the file just written.</p>
      ${list.length ? `<ol class="hk-list">${list.map((h, i) => `<li class="hk-row ${h.on ? '' : 'off'}" data-i="${i}">
        <div class="hk-top">
          <select class="hk-event" aria-label="When this hook runs">${Object.entries(HOOK_WHEN).map(([v, l]) => `<option value="${v}" ${h.event === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input class="hk-match" value="${esc(h.match)}" placeholder="${esc(HOOK_MATCH_HINT[h.event])}" aria-label="Which ${h.event === 'after_write' ? 'files' : 'commands'}" spellcheck="false">
          <span class="hk-order"><button type="button" class="hk-up" title="Run earlier" aria-label="Move up" ${i ? '' : 'disabled'}>↑</button><button type="button" class="hk-down" title="Run later" aria-label="Move down" ${i < list.length - 1 ? '' : 'disabled'}>↓</button><button type="button" class="hk-del" title="Remove this hook" aria-label="Remove this hook">✕</button></span>
        </div>
        <input class="hk-cmd" value="${esc(h.command)}" placeholder="${h.event === 'after_write' ? 'npx eslint {file}' : 'npm test'}" aria-label="Command" spellcheck="false">
        <div class="hk-opts">
          <label class="sq-check" title="${h.event === 'before_command' ? 'When this hook fails, the agent\'s command does not run and the agent gets the hook\'s output' : 'When this hook fails, its output goes back to the agent to fix'}"><input type="checkbox" class="hk-feedback" ${h.feedback ? 'checked' : ''}><span>${h.event === 'before_command' ? 'Stop the command if it fails' : 'Tell the agent if it fails'}</span></label>
          <label class="hk-time" title="The hook is stopped after this long">Time limit <input type="number" class="hk-timeout" min="1" max="600" value="${h.timeout}"> s</label>
          <label class="sq-check" title="Switch this hook off without removing it"><input type="checkbox" class="hk-on" ${h.on ? 'checked' : ''}><span>On</span></label>
        </div></li>`).join('')}</ol>` : '<p class="pj-hint hk-empty">No hooks yet. For example: after a file write, run <code>npm run lint</code>.</p>'}
      <div class="hk-acts"><button type="button" class="kx-btn sm hk-add">+ Add hook</button><span class="hk-state">${dirty ? 'Not saved yet' : ''}</span><button type="button" class="kx-btn sm primary hk-save" ${dirty ? '' : 'disabled'}>Save hooks</button></div>`;
    for (const row of el.querySelectorAll('.hk-row')) {
      const i = Number(row.dataset.i), h = list[i];
      const set = (k, v, redraw) => { h[k] = v; if (redraw) draw(); else { const dirtyNow = JSON.stringify(list) !== saved; $('.hk-save', el).disabled = !dirtyNow; $('.hk-state', el).textContent = dirtyNow ? 'Not saved yet' : ''; } };
      $('.hk-event', row).onchange = (e) => set('event', e.target.value, true);
      $('.hk-match', row).oninput = (e) => set('match', e.target.value);
      $('.hk-cmd', row).oninput = (e) => set('command', e.target.value);
      $('.hk-timeout', row).oninput = (e) => set('timeout', Math.max(1, Math.min(600, Number(e.target.value) || 60)));
      $('.hk-feedback', row).onchange = (e) => set('feedback', e.target.checked);
      $('.hk-on', row).onchange = (e) => { set('on', e.target.checked); row.classList.toggle('off', !e.target.checked); };
      $('.hk-up', row).onclick = () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); };
      $('.hk-down', row).onclick = () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); };
      $('.hk-del', row).onclick = () => { list.splice(i, 1); draw(); };
    }
    $('.hk-add', el).onclick = () => { list.push({ event: 'after_write', match: '', command: '', timeout: 60, feedback: true, on: true }); draw(); el.querySelector('.hk-row:last-child .hk-cmd')?.focus(); };
    $('.hk-save', el).onclick = async () => {
      const res = await postJ(`/api/projects/${p.id}/hooks`, { hooks: list });
      if (!res || res.error) { $('.hk-state', el).textContent = `Not saved: ${res?.error || 'no answer'}`; return; }
      list = res.hooks; saved = JSON.stringify(list); draw();
      $('.hk-state', el).textContent = '✓ Saved';
      onCount?.(list.filter((h) => h.on).length);
    };
  };
  draw();
  onCount?.(list.filter((h) => h.on).length);
}
// Project settings → Design system: the project's DESIGN.md + tokens.css (edit, change, remove), or a starter to use.
// Replacing or removing moves the old files to the project's .quorx/trash, so nothing is lost.
async function mountDesign(p, el) {
  if (!el) return;
  if (p.missing || p.needsFolder) { el.innerHTML = '<p class="pj-hint">Pick a folder for this project first.</p>'; return; }
  const [cur, systems] = await Promise.all([
    fetch(`/api/projects/${p.id}/design`).then((r) => r.json()).catch(() => ({ error: 'could not load' })),
    fetch('/api/design-systems').then((r) => r.json()).catch(() => []),
  ]);
  const has = !!(cur.md || cur.tokens);
  const swatch = (s) => `<span class="ds-sw" aria-hidden="true">${s.swatches.map((w) => `<i style="background:${esc(w.value)}" title="--${esc(w.token)} ${esc(w.value)}"></i>`).join('')}</span>`;
  const grid = (replace) => `<div class="ds-grid" role="list">${systems.map((s) => `<div class="ds-card" role="listitem">
      ${swatch(s)}
      <div class="ds-name"><b>${esc(s.name)}</b><span class="tag">${s.dark === 'only' ? 'dark only' : s.dark === 'yes' ? 'light + dark' : 'light'}</span></div>
      <p class="ds-desc">${esc(s.description)}</p>
      <p class="ds-fonts">${esc(s.fonts.display)} · ${esc(s.fonts.body)}</p>
      <button type="button" class="kx-btn sm ds-use" data-id="${esc(s.id)}">${replace ? 'Switch to this' : 'Use this'}</button>
    </div>`).join('')}</div>`;
  const hint = '<p class="pj-hint">Or make one from a reference: in a chat, ask "make a design system from https://…" or attach a screenshot and ask for one.</p>';
  if (cur.error) { el.innerHTML = `<p class="pf-warn">Could not read the design files: ${esc(cur.error)}</p>`; return; }
  el.innerHTML = has ? `
    <div class="ds-current">
      <div class="ds-cur-top"><b>${esc(cur.name || 'Project design system')}</b><span class="ds-files">${[cur.md ? 'DESIGN.md' : '', cur.tokens ? `tokens.css · ${cur.colors} colours` : ''].filter(Boolean).join(' · ')}</span></div>
      <div class="ds-acts"><button type="button" class="kx-btn sm ds-edit">Edit DESIGN.md</button><button type="button" class="kx-btn sm ds-change">Change…</button><button type="button" class="kx-btn sm ds-remove">Remove</button></div>
      <div class="ds-panel" hidden></div>
    </div>`
    : `<p class="pj-hint">None yet: each chat picks its own look. Pick a starter to give every chat in this project the same colours, type and components.</p>${grid(false)}${hint}`;
  const panel = $('.ds-panel', el);
  const reload = () => mountDesign(p, el);
  const apply = async (id, overwrite) => {
    const r = await postJ(`/api/projects/${p.id}/design`, { system: id, overwrite }).catch((e) => ({ error: e.message }));
    if (r?.error) return uiAlert(`Could not use that design system: ${r.error}`);
    if (r.applied === false) {
      // A DESIGN.md or tokens.css is already there: confirm in place before replacing it.
      const card = el.querySelector(`.ds-use[data-id="${CSS.escape(id)}"]`)?.closest('.ds-card');
      const ask = document.createElement('div'); ask.className = 'ds-confirm';
      ask.innerHTML = `<p>This project already has ${esc(r.exists.join(' and '))}. Replace ${r.exists.length > 1 ? 'them' : 'it'}? The old ${r.exists.length > 1 ? 'files go' : 'file goes'} to the project's trash.</p><div class="ds-acts"><button type="button" class="kx-btn primary sm ds-yes">Replace</button><button type="button" class="kx-btn sm ds-no">Cancel</button></div>`;
      (card || el).appendChild(ask);
      $('.ds-yes', ask).onclick = () => apply(id, true);
      $('.ds-no', ask).onclick = () => ask.remove();
      return;
    }
    reload();
  };
  for (const b of el.querySelectorAll('.ds-use')) b.onclick = () => apply(b.dataset.id, false);
  if (!has) return;
  $('.ds-edit', el).onclick = () => {
    panel.hidden = false;
    panel.innerHTML = `<textarea class="ds-text" spellcheck="false" aria-label="DESIGN.md">${esc(cur.md)}</textarea><div class="ds-acts"><button type="button" class="kx-btn primary sm ds-save">Save</button><button type="button" class="kx-btn sm ds-cancel">Cancel</button><span class="pj-hint">The previous version goes to the project's trash.</span></div>`;
    const ta = $('.ds-text', panel); ta.focus();
    $('.ds-cancel', panel).onclick = () => { panel.hidden = true; panel.innerHTML = ''; };
    $('.ds-save', panel).onclick = async () => {
      const r = await postJ(`/api/projects/${p.id}/design`, { md: ta.value }).catch((e) => ({ error: e.message }));
      if (r?.error) return uiAlert(`Could not save DESIGN.md: ${r.error}`);
      reload();
    };
  };
  $('.ds-change', el).onclick = () => {
    panel.hidden = false;
    panel.innerHTML = `${grid(true)}${hint}`;
    for (const b of panel.querySelectorAll('.ds-use')) b.onclick = () => apply(b.dataset.id, false);
  };
  $('.ds-remove', el).onclick = () => {
    panel.hidden = false;
    panel.innerHTML = `<div class="ds-confirm"><p>Remove this project's DESIGN.md and tokens.css? They move to the project's trash, and chats go back to picking their own look. Pages already built keep linking tokens.css until you change them.</p><div class="ds-acts"><button type="button" class="kx-btn primary sm ds-yes">Remove</button><button type="button" class="kx-btn sm ds-no">Keep</button></div></div>`;
    $('.ds-no', panel).onclick = () => { panel.hidden = true; panel.innerHTML = ''; };
    $('.ds-yes', panel).onclick = async () => {
      const r = await postJ(`/api/projects/${p.id}/design`, { remove: true }).catch((e) => ({ error: e.message }));
      if (r?.error) return uiAlert(`Could not remove the design files: ${r.error}`);
      reload();
    };
  };
}
// The strip under a project's name: one box with its spend (a meter when it has a budget) and its + ⚙ 🗑 buttons.
// The open chat's project: one line of what it has spent (of its budget), and a bar along the header's bottom edge.
// Read-only: clicking it opens the project's budget settings.
function projectSpendHTML(p, n, cost, share, chats = []) {
  const usd = (v) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
  const has = p.budget != null, pct = Math.round(share * 100), state = !has ? 'none' : share >= 1 ? 'full' : share >= 0.85 ? 'near' : 'ok';
  const info = has ? `<b class="cost">${usd(cost)}</b> of $${p.budget.toFixed(p.budget < 10 ? 2 : 0)} · ${state === 'full' ? 'budget used up' : `${pct}%`} · ${n} chat${n === 1 ? '' : 's'}`
    : `<b class="cost">${usd(cost)}</b> spent · no limit · ${n} chat${n === 1 ? '' : 's'}`;
  const clean = (t) => String(t || 'Untitled').replace(/\s+/g, ' ').slice(0, 48);
  const byCost = [...chats].sort((a, b) => (b.cost || 0) - (a.cost || 0));
  const tip = [`${p.name}${has ? ` · ${state === 'full' ? 'budget reached' : `$${Math.max(0, p.budget - cost).toFixed(2)} left of $${p.budget.toFixed(2)}`}` : ' · no budget'}`,
    ...byCost.slice(0, 8).map((c) => `${clean(c.title)}\t${usd(c.cost || 0)}`),
    ...(byCost.length > 8 ? [`${byCost.length - 8} more chats\t${usd(byCost.slice(8).reduce((t, c) => t + (c.cost || 0), 0))}`] : []),
    `Total\t${usd(cost)}`].join('\n');
  return `<span class="sb-budget sb-pinfo ${state}" data-tip-delay="900" title="${esc(tip)}">${info}</span>`;
}
// A project's budget covers every chat in it. Edited in a compact panel under the project:
// − / $ / ＋, quick +$1 +$5 +$10 ×2, never below what is already spent. Spend updates live; while a chat in
// the project is working the budget is locked (it can change once the chat finishes).
function editBudget(p, suggest, mount) {
  return new Promise((resolve) => {
    document.querySelector('.bud-pop:not(.inline)')?.remove();
    const host = mount || document.querySelector(`#projectList .sb-project[data-p="${CSS.escape(p.id)}"]`);
    if (mount) mount.innerHTML = '';
    let spent = p.spent || 0;
    const floor = () => Math.ceil(spent * 100) / 100;
    // Working = a chat in this project is running here, or the server says one is (another tab, a resumed reply).
    let serverBusy = !!p.running;
    const busy = () => serverBusy || [...G.open.values()].some((c) => c.running && c.projectId === p.id);
    let value = Math.max(floor(), Number(suggest ?? (p.budget != null ? p.budget : Math.max(1, Math.ceil(spent * 2)))));
    const pop = document.createElement('div');
    pop.className = 'bud-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Budget for ${p.name}`);
    pop.innerHTML = `<div class="bp-row1"><b>💵 Budget</b><span class="bp-for">${esc(p.name)}</span><button type="button" class="bp-x" aria-label="Close">✕</button></div>
      <div class="bp-meter"><span class="bp-spent"></span><span class="bp-bar"><i></i></span></div>
      <div class="bp-step"><button type="button" class="bp-minus" aria-label="Less">−</button><label class="bp-field"><span>$</span><input type="number" inputmode="decimal" step="0.5" aria-label="Budget in dollars"></label><button type="button" class="bp-plus" aria-label="More">＋</button></div>
      <div class="bp-quick"><button type="button" data-add="1">+$1</button><button type="button" data-add="5">+$5</button><button type="button" data-add="10">+$10</button><button type="button" data-mul="2">×2</button></div>
      <p class="bp-msg" hidden></p>
      <div class="bp-acts">${p.budget != null ? '<button type="button" class="bp-none" title="Remove the budget (no limit)">No limit</button>' : ''}<span class="kx-spacer"></span><button type="button" class="bp-cancel">Cancel</button><button type="button" class="bp-save">Save</button></div>`;
    (host || document.body).appendChild(pop);
    if (!host) pop.classList.add('floating');
    if (mount) { pop.classList.add('inline'); $('.bp-row1', pop).hidden = true; $('.bp-cancel', pop).textContent = 'Reset'; }
    const input = $('input', pop), msg = $('.bp-msg', pop);
    const money2 = (v) => `$${v.toFixed(2)}`;
    // Everything on screen comes from (spent, value, busy).
    const draw = () => {
      const lock = busy();
      value = Math.max(value, floor());
      if (document.activeElement !== input) input.value = value.toFixed(2);
      input.min = floor().toFixed(2);
      const share = value > 0 ? Math.min(1, spent / value) : 1;
      $('.bp-spent', pop).innerHTML = `<b>$${spent.toFixed(4)}</b> spent of ${money2(value)} <small>· min ${money2(floor())}</small>`;
      const bar = $('.bp-bar i', pop); bar.style.width = `${(share * 100).toFixed(1)}%`; bar.className = share >= 1 ? 'full' : share >= 0.85 ? 'near' : '';
      pop.classList.toggle('locked', lock);
      for (const el of pop.querySelectorAll('.bp-step button, .bp-quick button, .bp-save, .bp-none, input')) el.disabled = lock;
      if (lock) { msg.hidden = false; msg.className = 'bp-msg wait'; msg.textContent = `⏳ A chat in “${p.name}” is working. You can change the budget when it finishes.`; }
      else if (msg.classList.contains('wait')) { msg.hidden = true; msg.className = 'bp-msg'; }
      $('.bp-minus', pop).disabled = lock || value <= floor() + 1e-9;
    };
    const setValue = (v) => { value = Math.max(floor(), Math.round(v * 100) / 100); draw(); };
    $('.bp-minus', pop).onclick = () => setValue(value - 0.5);
    $('.bp-plus', pop).onclick = () => setValue(value + 0.5);
    for (const b of pop.querySelectorAll('.bp-quick [data-add]')) b.onclick = () => setValue(value + Number(b.dataset.add));
    $('.bp-quick [data-mul]', pop).onclick = () => setValue(value * 2);
    input.oninput = () => { const v = Number(input.value); if (v >= 0) { value = v; const under = v < floor(); msg.hidden = !under; msg.className = 'bp-msg'; if (under) msg.textContent = `Can't go below ${money2(floor())} (already spent).`; draw(); } };
    input.onblur = () => { setValue(Number(input.value) || floor()); };
    // Live spend while the panel is open.
    const poll = setInterval(async () => {
      if (!pop.isConnected) return clearInterval(poll);
      const list = await fetch('/api/projects').then((r) => r.json()).catch(() => null);
      const q = list?.find((x) => x.id === p.id);
      if (q) { spent = q.spent || 0; serverBusy = !!q.running; Object.assign(p, { spent, budget: q.budget, running: q.running, runningCost: q.runningCost }); }
      draw();
    }, 2000);
    const close = (v) => {
      document.removeEventListener('pointerdown', outside, true);
      if (mount) { resolve(v); if (v) { clearInterval(poll); editBudget(p, undefined, mount); } else { value = p.budget ?? value; msg.hidden = true; draw(); } return; }
      clearInterval(poll); pop.remove(); resolve(v);
    };
    const outside = (e) => { if (!pop.contains(e.target) && !e.target.closest('.sb-budget')) close(null); };
    if (!mount) setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    const save = async (budget) => {
      if (busy()) return draw();
      if (budget != null && budget < floor()) { setValue(floor()); return; }
      $('.bp-save', pop).disabled = true;
      const r = await fetch(`/api/projects/${p.id}/budget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budget }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
      if (r.error) { msg.hidden = false; msg.className = 'bp-msg bad'; msg.textContent = `Could not set the budget: ${r.error}.`; if (r.spent != null) spent = r.spent; draw(); $('.bp-save', pop).disabled = false; return; }
      Object.assign(p, { budget: r.budget, spent: r.spent ?? spent });
      close(r); refreshSidebar(); mount?.dispatchEvent(new CustomEvent('budget-saved', { detail: r }));
    };
    $('.bp-save', pop).onclick = () => save(value);
    $('.bp-cancel', pop).onclick = () => close(null);
    $('.bp-x', pop).onclick = () => close(null);
    const none = $('.bp-none', pop); if (none) none.onclick = () => save(null);
    pop.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); save(value); }
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.target === input && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); setValue(value + (e.key === 'ArrowUp' ? 0.5 : -0.5)); input.value = value.toFixed(2); }
    };
    draw();
    if (!busy()) { input.focus(); input.select(); }
  });
}
async function deleteProject(p) {
  if ([...G.open.values()].some((c) => c.running && c.projectId === p.id)) return uiAlert('A chat in this project is still running. Stop it first.');
  const n = G.chats.filter((c) => (c.projectId || 'scratch') === p.id).length;
  if (!await uiConfirm(`Delete the project "${p.name}"?\n\n• Its ${n} chat${n === 1 ? '' : 's'} move to data/trash (recoverable).\n• The folder ${p.dir} and its files are NOT touched.`)) return;
  const r = await fetch(`/api/projects/${p.id}`, { method: 'DELETE' }).then((x) => x.json()).catch(() => ({}));
  if (!r.ok) return uiAlert('Could not delete that project.');
  for (const [id, c] of G.open) if (c.projectId === p.id) { G.open.delete(id); G.panes = G.panes.filter((x) => x !== id); }
  if (!G.panes.length) showLanding(); else renderPanes();
  refreshSidebar();
}

// ---------- opening chats into the panes ----------
async function showChat(id, pane = G.focus) {
  const c = await getChat(id);
  if (!c) return uiAlert('Could not open that chat.');
  // One chat on screen at a time (others keep running in the background).
  G.panes = [id]; G.focus = 0;
  G.view = { id: null, src: false, files: false }; G.traceRun = null;
  withTransition(() => { renderPanes(); savePrefs(); renderSidebar(); });
}
async function newChat(projectId = focused()?.projectId || 'scratch', pane = G.focus) {
  const c = blankChat(projectId);
  G.open.set(c.id, c);
  G.panes = [c.id]; G.focus = 0;
  G.view = { id: null, src: false, files: false }; G.traceRun = null;
  await withTransition(() => { renderPanes(); savePrefs(); renderSidebar(); $('.input', c.el.root)?.focus(); });
  return c;
}
// Switching chats and going home cross-fade (View Transitions, --dur-view); instant with reduced motion,
// in browsers without the API, and while a dialog is open (a snapshot would freeze it).
// Resolves once the new view is in the page.
function withTransition(fn) {
  // A hidden page doesn't animate, and a transition started there would hold both snapshots on screen.
  if (!document.startViewTransition || motionReduced() || document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) { fn(); return Promise.resolve(); }
  return new Promise((resolve) => {
    let ran = false;
    const once = () => { if (!ran) { ran = true; fn(); resolve(); } };
    const t = document.startViewTransition(once);
    t.updateCallbackDone.catch(() => {});
    // A window that isn't painting (covered, or a background pane) holds the callback back: don't wait for it.
    setTimeout(() => { if (!ran) { try { t.skipTransition(); } catch { /* already done */ } once(); } }, 200);
  });
}

// ---------- models and prices ----------
function videoRate(m, res = '480p') {
  const k = m.skus || {};
  const hit = Object.keys(k).find((x) => x.includes(res) && /second/.test(x)) || Object.keys(k).find((x) => /second/.test(x) && !/\d+p|[0-9]k/i.test(x));
  if (hit) return `$${(/cents/.test(hit) ? Number(k[hit]) / 100 : Number(k[hit])).toFixed(3)}/s${hit.includes(res) ? ` at ${res}` : ''}`;
  return k.video_tokens ? 'priced per video token (rough estimate)' : 'price unknown';
}
function priceOf(id, extra = {}) {
  const m = G.byId.get(id);
  if (!m) return id ? (G.byId.size ? 'not in the catalogue' : 'loading prices…') : '';
  return priceText(m, extra);
}
// ---------- 🟢 🟡 🔴: how each model did in QuorX's own tests ----------
// 🟢 recommended (it did well in our benchmarks) · 🟡 fine or untested here · 🔴 avoid (it did badly, or can't work in the harness).
// Only measured results earn green or red by name; everything else is judged from plain catalogue facts, or left 🟡.
const RATED = {
  'deepseek/deepseek-v4.1-flash-1017': ['g', 'Build benchmark: harness builds averaged 18.7 of 20 and all passed, for about $0.05 a build.'],
  'anthropic/claude-haiku-5.5': ['g', 'Build benchmark: strong even in one shot (18.3 of 20), 19.2 through the harness, all passed; about $0.04 a build.'],
  'anthropic/claude-sonnet-5.5': ['g', 'Best reviewer: agreed with the benchmark judge 7 of 7 times, for about $0.02 a build. Also a strong builder (pricier).'],
  'openai/gpt-6.1-sol': ['g', 'As reviewer it agreed with the benchmark judge 7 of 7 times, but costs about $0.07 a build (Sonnet 5.5 did the same for $0.02).'],
  'anthropic/claude-opus-5.5': ['g', 'Frontier model: 100% on our earlier question benchmark. The most capable, and the priciest.'],
  'openai/gpt-6-luna': ['y', 'Cheap reviewer (the default): never passed a broken build, but failed good ones often (agreed with the judge 43% of the time).'],
  'qwen/qwen3.7-flash': ['y', 'The default helper: very cheap, uses tools, 1M-token window. Rarely needed on small builds.'],
  'deepseek/deepseek-v4.1-flash': ['r', 'Not recommended: use DeepSeek V4.1 Flash 1017 instead (newer, same price class). In our small-model study this older build scored 11.7 of 20 with 1 of 9 builds passing.'],
  'z-ai/glm-5.3-flash': ['y', 'Small-model study: 11.0 of 20, 0 of 9 passed, and slow (twice hit the 15-minute limit).'],
  'inclusionai/ling-3.1-flash': ['y', 'Small-model study: 10.3 of 20, 1 of 9 passed.'],
  'inception/mercury-2.5': ['r', 'Small-model study: 8.3 of 20, 0 of 9 builds passed; often gave up early.'],
  'poolside/laguna-s-2.1:free': ['r', 'Small-model study: 7.2 of 20, provider errors and rate limits, and built nothing 3 times.'],
  'nvidia/nemotron-3-ultra-550b-a55b:free': ['r', 'Small-model study: 9.7 of 20, 0 of 9 passed, slow (free tier).'],
  'openai/gpt-6-luna-decisions': ['g', 'The default decider for screenshot checks: reads images, answers in about 0.55 s, and settled 78% of checks on its own.'],
  'typesafe/jev-1.14': ['g', 'In the default decider panel: reads images, answers in about 0.57 s.'],
  'liquid/d1-ultra': ['y', 'In the default decider panel, but the slowest of the three (about 1 s).'],
  'tencent/hy-image-v3.5-preview': ['g', 'Made 100+ pictures in your ANI★VERSE build without trouble.'],
};
const REC_ICON = { g: '🟢', y: '🟡', r: '🔴' };
const REC_WORD = { g: 'Recommended', y: 'OK or untested', r: 'Avoid' };
function rateModel(idOrModel, kind) {
  const m = typeof idOrModel === 'string' ? G.byId?.get(idOrModel) : idOrModel;
  const id = typeof idOrModel === 'string' ? idOrModel : idOrModel?.id;
  if (!id) return null;
  if (RATED[id]) return { r: RATED[id][0], why: RATED[id][1] };
  const k = kind || m?.kind;
  if (k === 'chat' || (!k && m?.tools !== undefined)) {
    if (m && !m.tools) return { r: 'r', why: 'Can\'t call tools, so in QuorX it can\'t write files, use the browser or check its work.' };
    if (/:free$|^openrouter\/free/.test(id)) return { r: 'r', why: 'Free tier: in our tests free models hit rate limits and provider errors and gave up.' };
    return { r: 'y', why: `Not tested in QuorX yet.${m && !(m.in || []).includes('image') ? ' It can\'t see screenshots (the deciders still can).' : ''}` };
  }
  if (k === 'decision') return { r: 'y', why: (m?.in || []).includes('image') ? 'Not tested here yet. Reads images, so it can do screenshot checks.' : 'Not tested here yet. Text only: it can\'t do screenshot checks.' };
  return { r: 'y', why: 'Not tested in QuorX yet.' };
}
// The dot, with its reason on hover.
function recDot(id, kind) {
  const r = rateModel(id, kind);
  return r ? `<span class="rec rec-${r.r}" title="${esc(`${REC_WORD[r.r]}: ${r.why}`)}" aria-label="${REC_WORD[r.r]}">${REC_ICON[r.r]}</span>` : '';
}
const shortPrice = (id) => { const m = G.byId.get(id); return m && m.kind === 'chat' ? `$${m.price[0].toFixed(2)}/$${m.price[1].toFixed(2)}` : ''; };
function priceText(m, extra = {}) {
  if (m.kind === 'decision') return `$${m.price[0].toFixed(3)}/M in · output free`;
  if (m.kind === 'image') return m.perImage ? `$${m.perImage} per picture` : m.price[1] ? `≈ $${(m.price[1] * 15000 / 1e6).toFixed(3)} per 1K picture` : 'price unknown';
  if (m.kind === 'speech') return `$${m.price[0].toFixed(2)} per M characters · ≈ $${(m.price[0] * 500 / 1e6).toFixed(4)} per 500 chars`;
  if (m.kind === 'music') return `$${m.perUse} per ${m.length}`;
  if (m.kind === 'video') return `${videoRate(m, extra.res)}${m.durations?.length ? ` · ${Math.min(...m.durations)}–${Math.max(...m.durations)}s` : ''}`;
  return `$${m.price[0].toFixed(3)} in / $${m.price[1].toFixed(2)} out per M tokens`;
}
function videoNum(m, res = '480p') {
  const k = m.skus || {};
  const hit = Object.keys(k).find((x) => x.includes(res) && /second/.test(x)) || Object.keys(k).find((x) => /second/.test(x));
  return hit ? (/cents/.test(hit) ? Number(k[hit]) / 100 : Number(k[hit])) : 1e9;
}
// One comparable number per model, for "cheapest first".
function priceNum(m) {
  if (m.kind === 'decision' || m.kind === 'speech' || m.kind === 'listen') return m.price[0];
  if (m.kind === 'image') return m.perImage ?? (m.price[1] ? (m.price[1] * 15000) / 1e6 : 1e9);
  if (m.kind === 'video') return videoNum(m);
  if (m.kind === 'music') return m.perUse ?? 1e9;
  return m.price[0] + m.price[1];
}
// ---------- the model picker (every place a model is chosen) ----------
const KIND_TITLE = { chat: 'Chat model', decision: 'Decider model', image: 'Picture model', video: 'Video model', music: 'Music model', speech: 'Voice model', listen: 'Speech-to-text model' };
const KIND_NOTE = { chat: 'Models that can use tools (the agent needs them).', decision: 'Fast judges that answer yes/no, choice and score questions.', image: 'Text-to-picture models.', video: 'Text-to-video models.', music: 'Music models.', speech: 'Text-to-speech models.', listen: 'Chat models that accept audio (used for the mic).' };
const SORTS = [['best', 'Recommended'], ['cheap', 'Cheapest'], ['pricey', 'Priciest'], ['new', 'Newest'], ['old', 'Oldest'], ['name', 'Name'], ['ctx', 'Largest context']];
const FILTERS = [
  ['free', 'Free', (m) => priceNum(m) === 0 || /:free$/.test(m.id)],
  ['vision', '👁 Sees images', (m) => (m.in || []).includes('image') && m.kind !== 'image'],
  ['tools', '🧰 Uses tools', (m) => !!m.tools],
  ['reasoning', '🧠 Reasoning', (m) => !!m.reasoning],
  ['long', '📜 Long context', (m) => (m.ctx || 0) >= 200000],
  ['new', '✨ New (60 days)', (m) => m.created && Date.now() / 1000 - m.created < 60 * 864e2],
  ['fav', '★ Favourites', (m) => (G.favModels?.[m.kind] || []).includes(m.id)],
];
const providerOf = (id) => String(id).replace(/^~/, '').split('/')[0] || 'other';
const PROVIDER_NAME = (p) => ({ 'x-ai': 'xAI', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', 'meta-llama': 'Meta', mistralai: 'Mistral', deepseek: 'DeepSeek', qwen: 'Qwen', nvidia: 'NVIDIA', cohere: 'Cohere', inclusionai: 'inclusionAI', openrouter: 'OpenRouter', 'black-forest-labs': 'Black Forest Labs', elevenlabs: 'ElevenLabs' }[p] || p.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
const cleanName = (m) => String(m.name || m.id).replace(/\s*\(free\)\s*$/i, '').replace(/^[^:]+:\s*/, '');
const ctxText = (n) => (!n ? '' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const agoDate = (sec) => { if (!sec) return ''; const d = (Date.now() / 1000 - sec) / 86400; return d < 1 ? 'today' : d < 30 ? `${Math.round(d)}d ago` : d < 365 ? `${Math.round(d / 30)}mo ago` : `${+(d / 365).toFixed(1)}y ago`; };
// A short, comparable price for the list; the full wording stays in the tooltip.
function priceCell(m) {
  const n = priceNum(m), usd = (x, d = 2) => (x > 0 && x < 0.01 ? `$${Number(x.toPrecision(2))}` : `$${x.toFixed(d)}`);
  if (n === 0 || /:free$/.test(m.id)) return '<span class="mp-free">Free</span>';
  if (m.kind === 'chat' || m.kind === 'listen') return `<span class="mp-money">${usd(m.price[0])}</span><small>in</small><span class="mp-money">${usd(m.price[1])}</span><small>out /M</small>`;
  if (m.kind === 'decision') return `<span class="mp-money">${usd(m.price[0], 3)}</span><small>/M in</small>`;
  if (m.kind === 'image') return m.perImage ? `<span class="mp-money">${usd(m.perImage, 3)}</span><small>/picture</small>` : m.price[1] ? `<span class="mp-money">≈${usd(m.price[1] * 15000 / 1e6, 3)}</span><small>/picture</small>` : '<small>price unknown</small>';
  if (m.kind === 'video') return n < 1e8 ? `<span class="mp-money">${usd(n)}</span><small>/second</small>` : '<small>price unknown</small>';
  if (m.kind === 'music') return m.perUse ? `<span class="mp-money">${usd(m.perUse)}</span><small>/${esc(m.length || 'clip')}</small>` : '<small>price unknown</small>';
  if (m.kind === 'speech') return `<span class="mp-money">${usd(m.price[0])}</span><small>/M chars</small>`;
  return esc(priceText(m));
}
const PK = { kind: 'chat', current: '', filters: new Set(), providers: new Set(), sort: 'cheap', q: '', sel: 0, shown: 0, list: [], done: null, observer: null };

// pickModel(kind, current, { context }) → the chosen id, or null.
function pickModel(kind, current, opts = {}) {
  return new Promise((resolve) => {
    Object.assign(PK, { kind, current: current || '', q: '', sel: 0, providers: new Set(), filters: new Set(), context: opts.context || '' });
    PK.sort = G.pickerSort?.[kind] || 'best';
    PK.done = (v) => { if ($('#picker').open) $('#picker').close(); PK.done = null; resolve(v); };
    $('#pkSearch').value = '';
    $('#picker').oncancel = () => { PK.done?.(null); };
    drawPicker(true);
    $('#picker').showModal();
    setTimeout(() => $('#pkSearch').focus(), 30);
  });
}
function pickerModels() { return (G.models || []).filter((m) => m.kind === PK.kind); }
function drawPicker(full = false) {
  const all = pickerModels();
  $('#pkTitle').textContent = `Choose a ${(KIND_TITLE[PK.kind] || 'model').toLowerCase()}`;
  $('#pkSub').textContent = [PK.context, KIND_NOTE[PK.kind]].filter(Boolean).join(' · ');
  // No key yet: browsing works (the lists are public), running doesn't.
  const banner = $('#pkBanner');
  banner.hidden = !!G.cfg?.hasKey;
  banner.innerHTML = G.cfg?.hasKey ? '' : '🔑 <b>No OpenRouter key yet.</b> You can browse models and prices now; nothing runs until you add a key. <button type="button" class="mp-link" id="pkAddKey">Add a key →</button>';
  const ak = $('#pkAddKey'); if (ak) ak.onclick = () => { PK.done?.(null); openSettings('keys'); };
  // What is chosen now.
  const cur = G.byId.get(PK.current) || all.find((m) => m.id === PK.current);
  const cc = $('#pkCurrent');
  cc.hidden = !PK.current;
  cc.innerHTML = PK.current ? `<span class="mp-cur-label">Current</span>${cur ? `<b>${esc(cleanName(cur))}</b><code>${esc(cur.id)}</code><span class="mp-cur-price">${priceCell(cur)}</span>` : `<code>${esc(PK.current)}</code><span class="mp-warn">not in today's catalogue (it may have been renamed or removed)</span>`}` : '';
  if (full) {
    // Sort and filter controls (counts come from the whole list of this kind).
    $('#pkSort').innerHTML = SORTS.map(([k, l]) => `<button type="button" class="mp-sort ${PK.sort === k ? 'on' : ''}" data-sort="${k}" aria-pressed="${PK.sort === k}">${l}</button>`).join('');
    for (const b of document.querySelectorAll('#pkSort .mp-sort')) b.onclick = () => { PK.sort = b.dataset.sort; (G.pickerSort ??= {})[PK.kind] = PK.sort; savePrefs(); drawPicker(true); };
  }
  const usable = FILTERS.filter(([k, , f]) => k === 'fav' ? (G.favModels?.[PK.kind] || []).length : all.some(f) && !all.every(f));
  $('#pkFilters').innerHTML = usable.map(([k, l, f]) => `<button type="button" class="mp-chip ${PK.filters.has(k) ? 'on' : ''}" data-f="${k}" aria-pressed="${PK.filters.has(k)}">${l} <small>${all.filter(f).length}</small></button>`).join('')
    + `<div class="mp-prov-wrap"><button type="button" class="mp-chip mp-prov-btn ${PK.providers.size ? 'on' : ''}" aria-haspopup="true">🏢 ${PK.providers.size ? `${PK.providers.size} provider${PK.providers.size > 1 ? 's' : ''}` : 'All providers'} ▾</button><div class="mp-prov-pop" hidden></div></div>`
    + (PK.filters.size || PK.providers.size ? '<button type="button" class="mp-link mp-clear">Clear filters</button>' : '');
  for (const b of document.querySelectorAll('#pkFilters .mp-chip[data-f]')) b.onclick = () => { PK.filters.has(b.dataset.f) ? PK.filters.delete(b.dataset.f) : PK.filters.add(b.dataset.f); PK.sel = 0; drawPicker(); };
  const clr = $('#pkFilters .mp-clear'); if (clr) clr.onclick = () => { PK.filters.clear(); PK.providers.clear(); drawPicker(); };
  // Providers: a searchable multi-select with counts.
  const provBtn = $('#pkFilters .mp-prov-btn'), provPop = $('#pkFilters .mp-prov-pop');
  provBtn.onclick = () => {
    if (!provPop.hidden) { provPop.hidden = true; return; }
    const counts = {}; for (const m of all) { const p = providerOf(m.id); counts[p] = (counts[p] || 0) + 1; }
    const list = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    provPop.innerHTML = `<input class="mp-prov-q" placeholder="Find a provider" aria-label="Find a provider"><div class="mp-prov-list">${list.map(([p, n]) => `<label class="mp-prov-row"><input type="checkbox" value="${esc(p)}" ${PK.providers.has(p) ? 'checked' : ''}><span class="mp-ava sm" style="--h:${hue(p)}">${esc(initials(PROVIDER_NAME(p)))}</span><span>${esc(PROVIDER_NAME(p))}</span><small>${n}</small></label>`).join('')}</div>`;
    provPop.hidden = false;
    $('.mp-prov-q', provPop).oninput = (e) => { const q = e.target.value.toLowerCase(); for (const r of provPop.querySelectorAll('.mp-prov-row')) r.hidden = !r.textContent.toLowerCase().includes(q); };
    for (const cb of provPop.querySelectorAll('input[type=checkbox]')) cb.onchange = () => { cb.checked ? PK.providers.add(cb.value) : PK.providers.delete(cb.value); PK.sel = 0; drawList(); provBtn.innerHTML = `🏢 ${PK.providers.size ? `${PK.providers.size} provider${PK.providers.size > 1 ? 's' : ''}` : 'All providers'} ▾`; provBtn.classList.toggle('on', PK.providers.size > 0); };
    $('.mp-prov-q', provPop).focus();
  };
  drawList();
}
function drawList() {
  const box = $('#pkList'), count = $('#pkCount');
  PK.observer?.disconnect();
  // Loading, failed, or empty catalogue.
  if (G.modelsState !== 'ready' || !G.models) {
    count.textContent = '';
    box.innerHTML = G.modelsState === 'error'
      ? `<div class="mp-empty"><b>Couldn't load the model list.</b><p>${esc(G.modelsError || 'OpenRouter did not answer.')}</p><button type="button" class="mp-btn" id="pkRetry">↻ Try again</button></div>`
      : `<div class="mp-loading">${'<div class="mp-skel"></div>'.repeat(6)}<p>Loading models and prices from OpenRouter…</p></div>`;
    const r = $('#pkRetry'); if (r) r.onclick = async () => { r.disabled = true; r.textContent = 'Loading…'; await loadModels(true); };
    return;
  }
  const q = ($('#pkSearch').value || '').trim().toLowerCase();
  const all = pickerModels();
  const active = FILTERS.filter(([k]) => PK.filters.has(k));
  let list = all.filter((m) => active.every(([, , f]) => f(m)) && (!PK.providers.size || PK.providers.has(providerOf(m.id)))
    && (!q || `${m.id} ${m.name} ${PROVIDER_NAME(providerOf(m.id))}`.toLowerCase().includes(q)));
  const RANK = { g: 0, y: 1, r: 2 };
  const by = { best: (a, b) => RANK[rateModel(a, PK.kind)?.r ?? 'y'] - RANK[rateModel(b, PK.kind)?.r ?? 'y'] || priceNum(a) - priceNum(b), cheap: (a, b) => priceNum(a) - priceNum(b), pricey: (a, b) => priceNum(b) - priceNum(a), new: (a, b) => (b.created || 0) - (a.created || 0), old: (a, b) => (a.created || 0) - (b.created || 0), name: (a, b) => cleanName(a).localeCompare(cleanName(b)), ctx: (a, b) => (b.ctx || 0) - (a.ctx || 0) }[PK.sort];
  list.sort((a, b) => by(a, b) || cleanName(a).localeCompare(cleanName(b)));
  // Favourites and recent ones first when nothing narrows the list.
  const plain = !q && !PK.filters.size && !PK.providers.size;
  const favs = plain ? (G.favModels?.[PK.kind] || []).map((id) => all.find((m) => m.id === id)).filter(Boolean) : [];
  const recent = plain ? (G.recentModels?.[PK.kind] || []).filter((id) => !favs.some((f) => f.id === id)).map((id) => all.find((m) => m.id === id)).filter(Boolean).slice(0, 5) : [];
  PK.list = [...favs, ...recent, ...list];
  count.innerHTML = `<b>${list.length}</b> of ${all.length} ${KIND_TITLE[PK.kind]?.toLowerCase() || 'model'}s${list.length !== all.length ? ' match' : ''} · sorted by ${SORTS.find((x) => x[0] === PK.sort)[1].toLowerCase()} <span class="rec-legend" title="From QuorX's own benchmarks where a model was tested; otherwise from what the catalogue says it can do. Hover a dot for the reason.">🟢 recommended · 🟡 OK or untested · 🔴 avoid</span>`;
  if (!list.length && !favs.length) {
    box.innerHTML = `<div class="mp-empty"><b>No model matches.</b><p>${q ? `Nothing for “${esc(q)}”. ` : ''}Try fewer filters.</p>${PK.filters.size || PK.providers.size || q ? '<button type="button" class="mp-btn" id="pkClearAll">Clear search and filters</button>' : ''}</div>`;
    const c = $('#pkClearAll'); if (c) c.onclick = () => { $('#pkSearch').value = ''; PK.filters.clear(); PK.providers.clear(); drawPicker(); };
    return;
  }
  const section = (t) => `<div class="mp-sec">${t}</div>`;
  box.innerHTML = (favs.length ? section('★ Favourites') : '') + favs.map((m, i) => rowHTML(m, i)).join('')
    + (recent.length ? section('Recently used') : '') + recent.map((m, i) => rowHTML(m, favs.length + i)).join('')
    + ((favs.length || recent.length) ? section(`All ${KIND_TITLE[PK.kind]?.toLowerCase() || 'model'}s`) : '');
  PK.shown = favs.length + recent.length;
  appendRows(120);
  wireRows();
  if (PK.sel >= PK.list.length) PK.sel = 0;
  markSel(false);
}
// How each model has done in your own replies (logs/runs.jsonl, last 30 days): shown next to its price once it has
// a few checked replies, so a cheap model that keeps failing looks like what it is.
async function loadScores() {
  const rows = await fetch('/api/scorecard?days=30').then((r) => r.json()).catch(() => []);
  G.scores = Object.fromEntries((Array.isArray(rows) ? rows : []).map((r) => [r.model, r]));
}
// Model cards (models/cards/, served at /api/model-cards): limits, quirks, provider tips and QuorX's own results.
async function loadCards() {
  G.cards = await fetch('/api/model-cards').then((r) => r.json()).catch(() => ({}));
}
// A "card" tag beside the rating; the whole card shows on hover.
function cardChip(id) {
  const c = G.cards?.[id];
  if (!c) return '';
  const bullets = (xs) => xs.map((x) => `• ${x}`).join('\n');
  const text = [`Model card · ${id}`, c.limits && `Limits: ${c.limits}`, c.quirks.length && `Quirks:\n${bullets(c.quirks)}`, c.tips.length && `Prompting tips (provider docs):\n${bullets(c.tips)}`,
    c.bench && `QuorX results: ${c.bench}`, c.sources.length && `Sources: ${c.sources.join(' · ')}`, c.refreshed && `Catalogue facts as of ${c.refreshed}`].filter(Boolean).join('\n\n');
  return `<span class="mp-card" title="${esc(text)}" aria-label="${esc(text)}">card</span>`;
}
function scoreBadge(id) {
  const s = G.scores?.[id];
  if (!s || s.checked < 3) return '';
  const pct = Math.round((s.passed / s.checked) * 100), tone = pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'bad';
  return `<span class="mp-score" data-tone="${tone}" title="Your last 30 days: ${s.passed} of ${s.checked} replies passed QuorX's checks; ${s.replies} replies in all, about ${money(s.avgCost, 3)} and ${s.avgSteps} steps each.">✓ ${pct}% <small>of ${s.checked}</small></span>`;
}
function rowHTML(m, i) {
  const p = providerOf(m.id), fav = (G.favModels?.[m.kind] || []).includes(m.id);
  const caps = [(m.in || []).includes('image') && m.kind !== 'image' ? ['👁', 'Sees images'] : null, m.tools ? ['🧰', 'Uses tools'] : null, m.reasoning ? ['🧠', 'Reasoning'] : null, (m.in || []).includes('audio') ? ['🎙', 'Hears audio'] : null, m.voices?.length ? ['🗣', `${m.voices.length} voices`] : null].filter(Boolean);
  return `<div class="mp-row ${m.id === PK.current ? 'cur' : ''}" role="option" data-i="${i}" data-id="${esc(m.id)}" aria-selected="false" title="${esc(m.desc || priceText(m))}">
    <span class="mp-ava" style="--h:${hue(p)}" title="${esc(PROVIDER_NAME(p))}">${esc(initials(PROVIDER_NAME(p)))}</span>
    <span class="mp-main"><span class="mp-name">${recDot(m, PK.kind)}${cardChip(m.id)} ${esc(cleanName(m))}${m.id === PK.current ? ' <span class="mp-tag cur">current</span>' : ''}</span><span class="mp-id">${esc(m.id)}</span></span>
    <span class="mp-caps">${caps.map(([i2, t]) => `<span title="${t}">${i2}</span>`).join('')}</span>
    <span class="mp-meta">${scoreBadge(m.id)}${m.ctx ? `<span title="Context window">${ctxText(m.ctx)}</span>` : ''}${m.created ? `<span title="${new Date(m.created * 1000).toLocaleDateString()}">${agoDate(m.created)}</span>` : ''}</span>
    <span class="mp-price" title="${esc(priceText(m))}">${priceCell(m)}</span>
    <button type="button" class="mp-star ${fav ? 'on' : ''}" data-star="${esc(m.id)}" title="${fav ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${fav ? '★' : '☆'}</button>
  </div>`;
}
// Long lists render in pages as you scroll.
function appendRows(n) {
  const box = $('#pkList'), start = PK.shown, end = Math.min(PK.list.length, start + n);
  box.querySelector('.mp-more')?.remove();
  box.insertAdjacentHTML('beforeend', PK.list.slice(start, end).map((m, k) => rowHTML(m, start + k)).join(''));
  PK.shown = end;
  if (end < PK.list.length) {
    box.insertAdjacentHTML('beforeend', `<div class="mp-more">Showing ${end} of ${PK.list.length} · scroll for more</div>`);
    PK.observer = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { PK.observer.disconnect(); appendRows(150); wireRows(); } }, { root: box });
    PK.observer.observe(box.querySelector('.mp-more'));
  }
}
function wireRows() {
  for (const r of document.querySelectorAll('#pkList .mp-row:not([data-wired])')) {
    r.dataset.wired = '1';
    r.onclick = (e) => { if (e.target.closest('.mp-star')) return; choose(r.dataset.id); };
    r.onmousemove = () => { const i = Number(r.dataset.i); if (PK.sel !== i) { PK.sel = i; markSel(false); } };
  }
  for (const s of document.querySelectorAll('#pkList .mp-star:not([data-wired])')) {
    s.dataset.wired = '1';
    s.onclick = () => { const id = s.dataset.star, list = ((G.favModels ??= {})[PK.kind] ??= []); const i = list.indexOf(id); i >= 0 ? list.splice(i, 1) : list.unshift(id); savePrefs(); drawPicker(); };
  }
}
function markSel(scroll = true) {
  for (const r of document.querySelectorAll('#pkList .mp-row')) { const on = Number(r.dataset.i) === PK.sel; r.classList.toggle('kb', on); r.setAttribute('aria-selected', String(on)); if (on && scroll) r.scrollIntoView({ block: 'nearest' }); }
}
function choose(id) {
  const list = ((G.recentModels ??= {})[PK.kind] ??= []);
  const i = list.indexOf(id); if (i >= 0) list.splice(i, 1);
  list.unshift(id); list.length = Math.min(list.length, 8); savePrefs();
  PK.done?.(id);
}
function wirePicker() {
  $('#pkSearch').oninput = () => { PK.sel = 0; drawList(); };
  $('#pkSearch').onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!PK.list.length) return;
      PK.sel = Math.max(0, Math.min(PK.list.length - 1, PK.sel + (e.key === 'ArrowDown' ? 1 : -1)));
      if (PK.sel >= PK.shown) { appendRows(150); wireRows(); }
      markSel();
    } else if (e.key === 'Enter') { e.preventDefault(); const m = PK.list[PK.sel]; if (m) choose(m.id); }
  };
  $('#pkClose').onclick = () => PK.done?.(null);
  $('#pkRefresh').onclick = async () => { const b = $('#pkRefresh'); b.disabled = true; b.textContent = '↻ Refreshing…'; await loadModels(true); b.disabled = false; b.textContent = '↻ Refresh'; };
  document.addEventListener('pointerdown', (e) => { const pop = $('#pkFilters .mp-prov-pop'); if (pop && !pop.hidden && !e.target.closest('.mp-prov-wrap')) pop.hidden = true; }, true);
}

// The model lists come from OpenRouter (public; no key needed). States: loading, ready, error.
async function loadModels(refresh = false) {
  if (!G.models) G.modelsState = 'loading';
  if ($('#picker').open) drawList();
  try {
    const r = await fetch(`/api/models${refresh ? '?refresh=1' : ''}`);
    const list = await r.json();
    if (!r.ok || !Array.isArray(list)) throw new Error(list?.error || `HTTP ${r.status}`);
    G.models = list.filter((m) => !(m.price[0] < 0 || m.price[1] < 0));
    G.byId = new Map(G.models.filter((m) => m.kind !== 'listen').map((m) => [m.id, m]));
    G.modelsState = 'ready'; G.modelsError = ''; G.modelsAt = Date.now();
    for (const c of G.open.values()) if (c.el) renderComposerBar(c);
  } catch (e) {
    // Keep what we had; only show the error when there is nothing to show.
    if (!G.models) { G.modelsState = 'error'; G.modelsError = e.message; }
  }
  if ($('#picker').open) drawPicker(true);
  const info = $('#stCatInfo'); if (info && G.modelsState === 'ready') info.textContent = `${G.models.length} models loaded · ${new Date(G.modelsAt).toLocaleTimeString()}`;
}

// ---------- tiny markdown ----------
// Chat markdown (headings, lists, tables, code with Copy, math…) lives in markdown.js.
const md = (src) => renderMarkdown(src);

// ---------- landing: where the app opens, and where you land when the open chat or project is deleted ----------
function showLanding() { G.panes = []; G.focus = 0; G.view = { id: null, src: false, files: false }; G.traceRun = null; renderPanes(); savePrefs(); renderSidebar(); syncHome(); }
// Wider screens: the title (with 💲 and the notices) heads the sidebar, and ⟳ ◐ ⚙ sit in its footer beside the version,
// so the chat and the side pane reach the top of the window. Phones keep the top bar. Moving the elements keeps their
// handlers, so each button still works wherever it is.
function placeChrome() {
  const desk = !isPhone(), top = $('header.top'), title = $('#sbTitlebar'), foot = $('#sbFootBtns');
  if (!top || !title || !foot) return;
  document.body.classList.toggle('top-in-sidebar', desk);
  const brand = $('#brandHome'), git = $('#brandGit'), sep = $('.top-sep', top) || null, bits = ['#spend', '#staleNote'].map((q) => $(q)).filter(Boolean);
  const upd = $('#updNote'), btns = ['#restartBtn', '#themeBtn', '#settingsBtn'].map((q) => $(q)).filter(Boolean);
  // The ☰ panel toggle leads the title row on wider screens; phones keep it beside the search.
  const tog = $('#sbCollapseBtn'), tools = $('.sb-tools');
  if (desk) { title.append(brand, ...(git ? [git] : []), ...bits); if (tog) title.prepend(tog); foot.append(...(upd ? [upd] : []), ...btns); return; }
  if (tog && tools) tools.prepend(tog);
  top.prepend(brand);
  if (git) brand.after(git);
  if (sep) sep.after(...bits, ...(upd ? [upd] : [])); else top.append(...bits, ...(upd ? [upd] : []));
  top.append(...btns);
}
// 🏠 Home (sidebar, rail, and the app name in the top bar): back to the start screen. Lit while you're on it.
function goHome() { withTransition(showLanding); closeDrawer(); if (isPhone()) setMView('chat'); }
function syncHome() { const on = !G.panes.length && !$('.work')?.classList.contains('news-on'); for (const b of document.querySelectorAll('#homeBtn, #railHome')) { b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); } }
function renderLanding(box) {
  const archived = new Set(G.projects.filter((p) => p.archived).map((p) => p.id));
  const allRecent = [...G.chats].filter((c) => c.messages > 0 && !archived.has(c.projectId || 'scratch')).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  // Six at a time, with ‹ › to page through the rest (the page you were on is kept while you're here).
  const PAGE = 6, pages = (n) => Math.max(1, Math.ceil(n / PAGE));
  const pager = (key, page, n, what) => n > PAGE ? `<span class="ld-pg"><span class="ld-pg-n">${page * PAGE + 1}–${Math.min(n, page * PAGE + PAGE)} of ${n}</span><button type="button" class="ld-pg-b" data-pg="${key}" data-d="-1" aria-label="Previous ${what}" title="Previous ${what}" ${page === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg></button><button type="button" class="ld-pg-b" data-pg="${key}" data-d="1" aria-label="Next ${what}" title="Next ${what}" ${page >= pages(n) - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button></span>` : '';
  const projName = (id) => G.projects.find((p) => p.id === id)?.name || id;
  // One list: pinned projects first (in the order you pinned them), then the one with the most recent chat; each with its latest chats. Six at a time.
  const lastUsed = (id) => Math.max(0, ...G.chats.filter((c) => (c.projectId || 'scratch') === id).map((c) => c.lastAt || 0));
  const projects = G.projects.filter((p) => !p.archived).sort((a, b) => ((a.pinned || Infinity) - (b.pinned || Infinity)) || (lastUsed(b.id) - lastUsed(a.id)) || a.name.localeCompare(b.name));
  const last = G.landingProject && G.projects.some((p) => p.id === G.landingProject) ? G.landingProject : (allRecent[0]?.projectId || 'scratch');
  G.ldProjPage = Math.min(G.ldProjPage || 0, pages(projects.length) - 1);
  const shownProjects = projects.slice(G.ldProjPage * PAGE, G.ldProjPage * PAGE + PAGE);
  box.innerHTML = `<section class="landing">
    <header class="ld-brand"><img class="ld-mark ld-logo" src="brand/quorx-64.png" alt=""><h1>Quor<span>X</span></h1><span class="ld-tag">What are we building?</span></header>
    <div class="ld-hrow"><h2 class="ld-h">Projects <small>· pinned first, then latest chats</small></h2>${pager('proj', G.ldProjPage, projects.length, 'projects')}</div>
    <div class="ld-projects">${shownProjects.map((p) => {
      const mine = allRecent.filter((c) => (c.projectId || 'scratch') === p.id), n = mine.length, spent = p.spent || 0;
      const share = p.budget ? Math.min(1, spent / p.budget) : 0, state = share >= 1 ? 'full' : share >= 0.8 ? 'near' : 'ok';
      return `<div class="ld-project" style="${projStyle(p)}"><div class="ld-p-top">${p.pinned ? '<span class="ld-p-pin" title="Pinned" aria-label="Pinned"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4z"/><path d="M12 14v6"/></svg></span>' : ''}<b>${esc(p.name)}</b>${p.github ? `<a class="ld-p-gh" href="${esc(p.github.url)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(p.github.owner)}/${esc(p.github.repo)} on GitHub" aria-label="Open on GitHub">${GH_ICO}</a>` : ''}<button type="button" class="ld-p-set" data-set="${esc(p.id)}" title="Project settings" aria-label="Settings for ${esc(p.name)}">${ICO.gear}</button><button type="button" class="ld-p-plus" data-new="${esc(p.id)}" title="New chat in ${esc(p.name)}" aria-label="New chat in ${esc(p.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>
        <small class="ld-p-meta">${n} chat${n === 1 ? '' : 's'} · <span class="money">$${spent.toFixed(3)}</span>${p.budget != null ? ` of $${p.budget.toFixed(2)}` : ' · no limit'}</small>
        ${p.budget != null ? `<span class="ld-bar ${state}"><i style="width:${(share * 100).toFixed(1)}%"></i></span>` : ''}
        <div class="ld-p-chats">${mine.slice(0, 3).map((c) => `<button type="button" class="ld-chat ld-pc" data-c="${esc(c.id)}" title="${esc(c.title)}"><b>${esc(c.title)}</b><small>${ago(c.lastAt || Date.now())}</small><span class="ld-cost">$${(c.cost || 0).toFixed(3)}</span></button>`).join('') || '<span class="ld-p-none">No chats yet</span>'}${n > 3 ? `<span class="ld-p-more">+${n - 3} more in the sidebar</span>` : ''}</div></div>`;
    }).join('')}</div>
    <p class="ld-tips">Tips: type <kbd>@</kbd> to add files or other chats as context, <kbd>/</kbd> for commands, and ⚙ for settings.</p>
    <div class="ld-dock">
    <div class="ld-sbox" id="ldStart">
      <textarea class="ld-sb-input" id="ldStartText" rows="2" placeholder="What are we building? Describe it, or ask about your code…" aria-label="Your first message"></textarea>
      <div class="ld-sb-row">
        <button type="button" class="ld-chip" id="ldChip" aria-haspopup="menu" aria-expanded="false" title="Where this chat runs: a project, any folder, or a new project from a template"></button>
        <span class="ld-sb-path blurable" id="ldChipPath"></span>
        <span class="ld-sb-sp"></span>
        <span class="ld-sb-hint">Enter to start · Shift+Enter for a new line</span>
        <button type="button" class="ld-sb-send" id="ldStartGo" aria-label="Start the chat" title="Start the chat (Enter)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>
      </div>
      <div class="ld-menu" id="ldMenu" role="menu" hidden></div>
    </div>
    <p class="ld-folder-err" role="alert" hidden></p>
    </div>
  </section>`;
  for (const b of box.querySelectorAll('[data-pg]')) b.onclick = () => {
    const k = b.dataset.pg === 'chat' ? 'ldChatPage' : 'ldProjPage', y = $('.landing', box).scrollTop;
    G[k] = Math.max(0, (G[k] || 0) + Number(b.dataset.d));
    renderLanding(box); $('.landing', box).scrollTop = y;
    $(`[data-pg="${b.dataset.pg}"][data-d="${b.dataset.d}"]`, box)?.focus(); // keep paging with the keyboard
  };
  wireStartBox(box, last, projects);
  loadGhMeta(box);
  for (const b of box.querySelectorAll('.ld-chat')) b.onclick = () => { showChat(b.dataset.c); if (isPhone()) setMView('chat'); };
  for (const b of box.querySelectorAll('[data-new]')) b.onclick = () => newChat(b.dataset.new);
  for (const b of box.querySelectorAll('[data-set]')) b.onclick = () => openProjectSettings(G.projects.find((p) => p.id === b.dataset.set));
}
// ---------- pinned and archived projects ----------
async function setProjectFlag(p, flags) {
  const r = await postJ(`/api/projects/${encodeURIComponent(p.id)}/flags`, flags).catch((e) => ({ error: e.message }));
  if (r?.error) return uiAlert(r.error.charAt(0).toUpperCase() + r.error.slice(1));
  await refreshSidebar();
}
function renderArchive(all = G.chats) {
  const box = $('#archiveBox'); if (!box) return;
  const arch = G.projects.filter((p) => p.archived).sort((a, b) => (b.archived || 0) - (a.archived || 0));
  box.hidden = !arch.length;
  $('#archiveCount').textContent = arch.length;
  const open = !!G.archiveOpen && arch.length > 0;
  $('#archiveHead').setAttribute('aria-expanded', String(open)); $('#archiveBody').hidden = !open;
  if (!open) return;
  const q = $('#archiveSearch').value.trim().toLowerCase();
  $('#archiveList').innerHTML = arch.map((p) => {
    const chats = all.filter((c) => (c.projectId || 'scratch') === p.id && c.messages > 0).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    const hits = q ? chats.filter((c) => c.title.toLowerCase().includes(q) || String(c.preview || '').toLowerCase().includes(q)) : [];
    if (q && !p.name.toLowerCase().includes(q) && !hits.length) return '';
    return `<div class="sb-arch-item" style="${projStyle(p)}"><div class="sb-arch-row"><b class="sb-arch-name">${esc(p.name)}</b><small>${chats.length} chat${chats.length === 1 ? '' : 's'} · <span class="cost">$${(p.spent || 0).toFixed(3)}</span></small><button type="button" class="ghost sb-unarch" data-p="${esc(p.id)}" title="Unarchive: back in the list above" aria-label="Unarchive ${esc(p.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M12 18v-6M9.5 14.5 12 12l2.5 2.5"/></svg></button></div>
      ${hits.slice(0, 6).map((c) => `<button type="button" class="sb-arch-chat" data-c="${esc(c.id)}" title="${esc(c.title)}">${esc(c.title)}<small>${ago(c.lastAt || c.updated || Date.now())}</small></button>`).join('')}</div>`;
  }).join('') || '<div class="sb-empty">Nothing archived matches</div>';
  for (const b of box.querySelectorAll('.sb-unarch')) b.onclick = () => setProjectFlag(G.projects.find((p) => p.id === b.dataset.p), { archived: false });
  for (const b of box.querySelectorAll('.sb-arch-chat')) b.onclick = () => { showChat(b.dataset.c, G.focus); closeDrawer(); if (isPhone()) setMView('chat'); };
}
(() => {
  const head = document.getElementById('archiveHead'), find = document.getElementById('archiveSearch');
  if (head) head.onclick = () => { G.archiveOpen = !G.archiveOpen; renderArchive(); if (G.archiveOpen) find?.focus(); };
  if (find) find.oninput = () => renderArchive();
})();
// ---------- a project's GitHub repo: a link, and (from GitHub, cached) public or private, person or organization ----------
const GH_ICO = '<svg class="gh-mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const GH_BADGE = {
  private: ['<path d="M7 11V8a5 5 0 0 1 10 0v3"/><rect x="5" y="11" width="14" height="9" rx="2"/>', 'Private'],
  internal: ['<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16"/>', 'Internal'],
  public: ['<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"/>', 'Public'],
  Organization: ['<path d="M4 21V6l8-3 8 3v15M9 21v-4h6v4M8 9h.01M12 9h.01M16 9h.01M8 13h.01M12 13h.01M16 13h.01"/>', 'Organization'],
  User: ['<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>', 'Personal'],
};
const ghBadge = (k, title) => { const b = GH_BADGE[k]; return b ? `<span class="gh-b gh-${k.toLowerCase()}" title="${esc(title)}"><svg viewBox="0 0 24 24" aria-hidden="true">${b[0]}</svg><span class="gh-bl">${b[1]}</span></span>` : ''; };
function ghLineHTML(g) {
  return `<a class="gh-link" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(g.owner)}/${esc(g.repo)} on GitHub">${GH_ICO}<span>${esc(g.owner)}/<b>${esc(g.repo)}</b></span></a><span class="gh-meta"></span>`;
}
// Asked once per project per page (the server keeps the answer for an hour).
function loadGhMeta(scope) {
  for (const el of scope.querySelectorAll('[data-gh]')) {
    const id = el.dataset.gh, meta = $('.gh-meta', el);
    if (!meta || meta.dataset.done) continue;
    meta.dataset.done = '1';
    ((G.ghMeta ||= {})[id] ||= getJ(`/api/projects/${encodeURIComponent(id)}/github`).catch(() => null)).then((r) => {
      const g = r?.github; if (!g || !meta.isConnected) return;
      const vis = g.visibility === 'private' ? ghBadge('private', g.guess ? 'Not public on GitHub (sign in the GitHub command line, gh, to see your private repos for sure)' : 'Private repository')
        : g.visibility ? ghBadge(g.visibility, g.visibility === 'public' ? 'Public repository' : 'Visible inside its organization') : '';
      const own = g.ownerType ? ghBadge(g.ownerType, g.ownerType === 'Organization' ? `Owned by the ${g.owner} organization` : `Owned by ${g.owner}`) : '';
      meta.innerHTML = vis + own;
    });
  }
}
// ---------- the start box: the first message, and (on its chip) where the chat runs ----------
// Enter starts a chat in the chip's project with what you typed (an empty box just opens one). The chip's menu holds
// the other ways in: a recent project, any folder on this PC, or a new project from a template. Picking one only
// changes the chip, so what you typed stays.
function wireStartBox(box, first, projects) {
  const ta = $('#ldStartText', box), chip = $('#ldChip', box), menu = $('#ldMenu', box), err = $('.ld-folder-err', box);
  const proj = () => G.projects.find((p) => p.id === G.landingProject) || G.projects.find((p) => p.id === first) || G.projects[0];
  if (!G.projects.some((p) => p.id === G.landingProject)) G.landingProject = first;
  const drawChip = () => {
    const p = proj();
    chip.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><b class="ld-chat-proj" style="${projStyle(p)}">${esc(p?.name || 'Scratch')}</b><svg class="ld-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
    const dir = p?.dir || p?.path || '';
    $('#ldChipPath', box).textContent = dir; $('#ldChipPath', box).title = dir;
  };
  drawChip();
  ta.value = G.landingDraft || '';
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, Math.round(innerHeight * 0.3))}px`; };
  fit();
  ta.oninput = () => { G.landingDraft = ta.value; fit(); };
  const go = async () => {
    const p = proj(); if (!p) return;
    const text = ta.value.trim();
    G.landingProject = p.id; G.landingDraft = '';
    const c = await newChat(p.id);
    if (c && text) send(c, text);
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
    if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openMenu(); }
  };
  $('#ldStartGo', box).onclick = go;
  // The chip's menu: recent projects (with what each has spent), then a folder, then templates.
  const pick = (id) => { G.landingProject = id; drawChip(); closeMenu(); ta.focus(); };
  const items = () => [...menu.querySelectorAll('.ld-mi:not([hidden])')];
  const closeMenu = () => { menu.hidden = true; chip.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!menu.contains(e.target) && e.target !== chip && !chip.contains(e.target)) closeMenu(); };
  const drawMenu = (showTemplates) => {
    const cur = proj()?.id;
    menu.innerHTML = `${projects.length > 8 ? '<input class="ld-mfind" type="search" placeholder="Find a project" aria-label="Find a project">' : ''}
      <div class="ld-mh">Recent projects</div>
      ${projects.map((p) => `<button type="button" class="ld-mi" role="menuitemradio" aria-checked="${p.id === cur}" data-pid="${esc(p.id)}" data-name="${esc(p.name.toLowerCase())}"><span class="ld-mck">${p.id === cur ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>' : ''}</span><b class="ld-chat-proj" style="${projStyle(p)}">${esc(p.name)}</b><span class="ld-cost">$${(p.spent || 0).toFixed(3)}</span></button>`).join('')}
      <div class="ld-msep"></div>
      <button type="button" class="ld-mi ld-mi-act" role="menuitem" data-act="folder"><span class="ld-mck"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z"/><path d="M3 10h18l-2 9H5z"/></svg></span>Open a folder on this PC…</button>
      ${G.starters?.length ? `<button type="button" class="ld-mi ld-mi-act" role="menuitem" data-act="templates" aria-expanded="${!!showTemplates}"><span class="ld-mck"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span>New project from a template<svg class="ld-chev ld-mi-end" viewBox="0 0 24 24" aria-hidden="true"><path d="${showTemplates ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'}"/></svg></button>
      ${showTemplates ? G.starters.map((t) => `<button type="button" class="ld-mi ld-mi-tpl" role="menuitem" data-starter="${esc(t.name)}" title="${esc(t.description)}"><span class="ld-mck"></span><span class="ld-mtpl"><b>${esc(starterName(t.name))}</b><small>${esc(t.description)}</small></span></button>`).join('') : ''}` : ''}`;
    const find = $('.ld-mfind', menu);
    if (find) find.oninput = () => { const q = find.value.trim().toLowerCase(); for (const b of menu.querySelectorAll('[data-pid]')) b.hidden = !!q && !b.dataset.name.includes(q); };
    for (const b of menu.querySelectorAll('[data-pid]')) b.onclick = () => pick(b.dataset.pid);
    const fb = $('[data-act="folder"]', menu);
    if (fb) fb.onclick = async () => { const id = await openFolderAsProject(fb, err, { pickOnly: true }); if (id) { G.landingProject = id; renderSidebar(); liveStart(); } };
    const tb = $('[data-act="templates"]', menu);
    if (tb) tb.onclick = () => { drawMenu(!showTemplates); $('[data-act="templates"]', menu)?.focus(); };
    for (const b of menu.querySelectorAll('[data-starter]')) b.onclick = async () => {
      closeMenu();
      const r = await startFromTemplate(b.dataset.starter, chip, { pickOnly: true });
      if (!r) return;
      G.landingProject = r.id;
      if (!(G.landingDraft || '').trim()) G.landingDraft = r.text;
      liveStart();
    };
  };
  // After a folder or template pick the list refresh may have redrawn the home screen: bring the start box that is on
  // screen now up to date (its chip shows the picked project, its menu is shut) and put the cursor back in it.
  const liveStart = () => {
    if (box.isConnected && $('#ldChip', box) === chip) { drawChip(); closeMenu(); ta.value = G.landingDraft || ''; fit(); }
    else { const land = $('.landing'); if (land) renderLanding(land.parentElement); }
    const t = $('#ldStartText'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  };
  const openMenu = () => {
    drawMenu(false);
    menu.hidden = false; chip.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    ($('.ld-mfind', menu) || menu.querySelector('[aria-checked="true"]') || items()[0])?.focus();
  };
  chip.onclick = () => (menu.hidden ? openMenu() : closeMenu());
  menu.onkeydown = (e) => {
    const list = items(), at = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); chip.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Enter' && document.activeElement?.classList.contains('ld-mfind')) { e.preventDefault(); list[0]?.click(); }
  };
  if (!isPhone()) requestAnimationFrame(() => { if (box.isConnected && !document.querySelector('dialog[open]')) ta.focus(); });
}
// A template → a new project: pick where it goes, name its folder, and the harness makes <where>/<name>, copies the
// template in and opens a chat there with the message started (you say what to build).
async function startFromTemplate(tpl, btn, { pickOnly = false } = {}) {
  const label = btn.innerHTML;
  btn.disabled = true;
  const pick = await postJ('/api/pick-folder', { start: '' }).catch((e) => ({ error: e.message }));
  btn.disabled = false; btn.innerHTML = label;
  let parent = pick?.path;
  if (pick?.error) parent = await uiPrompt(`Where should the new ${starterName(tpl)} project go?\nThe folder dialog couldn't open here (${pick.error}). Type the full path of the folder to put it in.`, '', { ok: 'Next' });
  if (!parent) return; // closed without picking
  for (let name = tpl; ;) {
    name = await uiPrompt(`Name the new project\nA folder with this name is made inside ${parent}, and the ${starterName(tpl)} template is copied into it.`, name, { ok: 'Create' });
    if (!name?.trim()) return;
    const r = await postJ('/api/projects/from-template', { parent, name: name.trim(), template: tpl }).catch((e) => ({ error: e.message }));
    if (r.code === 'NOT_EMPTY') { await uiAlert(`That folder isn't empty\n${r.error}`); continue; }
    if (r.error) return uiAlert(`Could not create the project\n${r.error}`);
    await refreshSidebar();
    G.landingProject = r.id;
    const note = `This project starts from the ${starterName(tpl)} template (already copied into its folder: ${(r.written || []).slice(0, 6).join(', ')}${(r.written || []).length > 6 ? ', …' : ''}). Build: `;
    if (pickOnly) return { id: r.id, text: note };
    const c = await newChat(r.id), inp = c?.el && $('.input', c.el.root);
    if (!inp) return;
    inp.value = `This project starts from the ${starterName(tpl)} template (already copied into its folder: ${(r.written || []).slice(0, 6).join(', ')}${(r.written || []).length > 6 ? ', …' : ''}). Build: `;
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
}
// templates/<name> → a readable name for the start screen ("node-http" → "Node server").
const starterName = (n) => ({ 'canvas-game': 'Canvas game', 'node-http': 'Node server', 'python-http': 'Python server', 'static-site': 'Static site' })[n]
  || n.replace(/[-_]+/g, ' ').replace(/^./, (x) => x.toUpperCase());
// 📂 Open folder…: the PC's own folder dialog. A folder that is already a project opens a chat there;
// any other folder becomes a new project named after it. If the dialog can't open here, the New project window does.
async function openFolderAsProject(btn, errEl, { pickOnly = false } = {}) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Pick it in the window on your PC…'; if (errEl) errEl.hidden = true;
  const r = await postJ('/api/pick-folder', { start: '' }).catch((e) => ({ error: e.message }));
  btn.disabled = false; btn.textContent = label;
  if (r.error) {
    if (/type the path/.test(r.error)) return editProject(null);
    const msg = /^not found$/i.test(r.error) ? 'The running server is older than this page and has no folder dialog yet: restart it (npm start), then try again.' : r.error;
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; } return;
  }
  if (!r.path) return; // closed without picking
  const norm = (d) => String(d || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const known = G.projects.find((x) => norm(x.dir) === norm(r.path) || norm(x.path) === norm(r.path));
  if (known) { G.landingProject = known.id; return pickOnly ? known.id : newChat(known.id); }
  const made = await postJ('/api/projects', { id: `p${Date.now().toString(36)}`, name: baseName(r.path), path: r.path });
  if (made.error) { if (errEl) { errEl.textContent = made.error; errEl.hidden = false; } return; }
  G.landingProject = made.id; // before the refresh: it redraws the start box, whose chip should show this project
  await refreshSidebar();
  if (pickOnly) return made.id;
  await newChat(made.id);
}
// ---------- the pane's tabs: icons only when their names don't fit (the servers and full-width buttons stay on) ----------
(() => {
  const bar = document.getElementById('paneTabs'); if (!bar || !window.ResizeObserver) return;
  let w = -1, tm = 0;
  // Icons only as soon as any tab's name stops fitting (tabs shrink before the bar overflows), with a little room to spare.
  // Checked once the size has settled (the pane can be mid-resize when the size first changes).
  const fit = () => { clearTimeout(tm); tm = setTimeout(check, 60); };
  const check = () => {
    w = bar.clientWidth;
    bar.classList.remove('icons-only');
    // What the tabs and buttons need side by side (the spacer between them takes whatever is left, so it doesn't count).
    const kids = [...bar.children].filter((k) => !k.classList.contains('pt-spacer') && k.getClientRects().length);
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0, pad = parseFloat(getComputedStyle(bar).paddingLeft) + parseFloat(getComputedStyle(bar).paddingRight);
    const need = kids.reduce((n, k) => n + k.scrollWidth, 0) + gap * Math.max(0, kids.length - 1) + pad;
    const squeezed = [...bar.querySelectorAll('[data-tab]')].some((t) => t.scrollWidth > t.clientWidth + 1) || need > bar.clientWidth - 8;
    if (squeezed) bar.classList.add('icons-only');
    // The pane may still have been resizing: look again shortly, and once more if the width moved since.
    setTimeout(() => { if (bar.clientWidth !== w) fit(); }, 250);
  };
  const ro = new ResizeObserver(fit); ro.observe(bar);
  const pane = document.getElementById('pane'); if (pane) { ro.observe(pane); pane.addEventListener('transitionend', fit); }
  addEventListener('resize', fit);
  new MutationObserver(() => fit()).observe(bar, { subtree: true, childList: true, characterData: true }); // counts and dots change the width
})();
// ---------- the row under the tabs (Stop all, Close, Replay…): its text buttons shrink to their symbol when it's tight ----------
// A button whose label starts with a symbol (■ Stop all, ✕ Close, ⏵ Replay) keeps just the symbol, and its full label
// moves to its tip. Undone as soon as there is room again.
(() => {
  const bar = document.getElementById('appBar'); if (!bar || !window.ResizeObserver) return;
  let busy = false;
  const SYM = /^([^\p{L}\p{N}\s]+)\s+(\S.*)$/u;
  const fit = () => {
    if (busy || bar.hidden) return;
    busy = true;
    try {
      // Back to full labels (and their own tips) first, then measure.
      for (const b of bar.querySelectorAll('button[data-full]')) {
        if (b.dataset.html) b.innerHTML = b.dataset.html; else b.textContent = b.dataset.full;
        b.classList.remove('sym-only'); b.removeAttribute('title');
        if (b.dataset.tipOrig) b.dataset.ohTitle = b.dataset.tipOrig; else delete b.dataset.ohTitle;
        delete b.dataset.full; delete b.dataset.html;
      }
      // The bar may be laid out as part of its parent row (display: contents): measure the row it sits in.
      const row = getComputedStyle(bar).display === 'contents' ? bar.parentElement : bar;
      const one = 34, wraps = getComputedStyle(row).flexWrap === 'wrap';
      // A row that wraps on purpose (the Browser bar in a narrow pane: address above, actions below) is tight only when
      // its actions no longer fit on one line of their own.
      const acts = wraps ? [...bar.children].filter((k) => k.getClientRects().length) : [];
      const tight = wraps ? new Set(acts.map((k) => { const r = k.getBoundingClientRect(); return Math.round((r.top + r.height / 2) / 12); })).size > 2 || row.scrollWidth > row.clientWidth + 1
        : row.scrollWidth > row.clientWidth + 1 || row.getBoundingClientRect().height > one + 10;
      if (!tight) return;
      for (const b of bar.querySelectorAll('button')) {
        const t = b.textContent.trim(); if (!t) continue;
        const kids = [...b.children], m = t.match(SYM);
        const iconOnlyKids = kids.length > 0 && kids.every((k) => k.matches('svg, img, .ico'));
        if (b.dataset.tipOrig == null) b.dataset.tipOrig = b.dataset.ohTitle || b.getAttribute('title') || '';
        let label;
        if (iconOnlyKids) { label = t; b.dataset.html = b.innerHTML; b.dataset.full = t; for (const n of [...b.childNodes]) if (n.nodeType === 3) n.remove(); }
        else if (m && !b.children.length) { label = m[2]; b.dataset.full = t; b.textContent = m[1]; }
        else if ((b.classList.contains('back') || /^close$/i.test(t)) && !b.children.length) { label = t; b.dataset.full = t; b.textContent = '✕'; }
        else continue;
        b.classList.add('sym-only');
        if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', label);
        const orig = b.dataset.tipOrig;
        b.dataset.ohTitle = orig && orig !== label ? `${label}: ${orig}` : label;
      }
    } finally { busy = false; }
  };
  const ro = new ResizeObserver(() => fit()); ro.observe(bar); if (bar.parentElement) ro.observe(bar.parentElement);
  addEventListener('resize', () => setTimeout(fit, 0));
  new MutationObserver(() => { if (!busy) setTimeout(fit, 0); }).observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
})();
// A reply that ended without its totals (the harness restarted, or the connection dropped for good) still paid for
// the calls it made: their costs are in its steps, so the chat and the Costs window count them.
// ---------- what a running reply has spent so far: sent after every model call, shown as it climbs ----------
const liveOf = (c) => (c?.agent?.messages || []).reduce((s, m) => s + (m.role === 'assistant' && !m.stats && m.live ? m.liveCost || 0 : 0), 0);
const stoppedByYou = (m) => m.error === 'Stopped.';
function liveFootHTML(m) {
  return `<span class="f-cost live" title="Spent so far by this reply, updated after every model call">${money(m.liveCost, 5)}</span><span class="f-dur live" title="Model calls so far">${m.liveCalls || 0} call${m.liveCalls === 1 ? '' : 's'}</span>`;
}
let liveSideAt = 0, liveSideTimer = null;
function liveSpend(c, m) {
  // The reply's footer: just its numbers once it shows them (the rest of the reply is left alone).
  const f = m.el && $('.foot', m.el);
  if (f && $('.f-cost.live', f)) { $('.f-cost.live', f).textContent = money(m.liveCost, 5); const d = $('.f-dur.live', f); if (d) d.textContent = `${m.liveCalls || 0} call${m.liveCalls === 1 ? '' : 's'}`; }
  else if (m.el) updateMsg(c, m);
  renderChatHead(c);
  // The sidebar at most every 1.5 s (it is redrawn whole).
  const due = 1500 - (Date.now() - liveSideAt);
  if (due <= 0) { liveSideAt = Date.now(); renderSidebar(); }
  else if (!liveSideTimer) liveSideTimer = setTimeout(() => { liveSideTimer = null; liveSideAt = Date.now(); renderSidebar(); }, due);
}
function partialSpend(m) { if (partialSpendQuiet(m)) { G.sessionCost += m.stats.cost; renderSpend(); } }
function partialSpendQuiet(m) {
  if (m.stats || !m.trace?.length) return false;
  const byModel = {};
  let cost = 0, calls = 0, tokensOut = 0;
  for (const e of m.trace) {
    if ((e.t !== 'llm_done' && e.t !== 'helper_done') || !(Number(e.cost) >= 0)) continue;
    const c = Number(e.cost) || 0, model = e.actual || e.model || '?';
    cost += c; calls++; tokensOut += Number(e.tokensOut) || 0;
    const b = (byModel[model] ||= { cost: 0, calls: 0, role: e.t === 'helper_done' ? 'helper' : 'writer' }); b.cost += c; b.calls++;
  }
  if (!calls) return false;
  m.stats = { cost, llmCalls: calls, tokensOut, byModel, partial: true, fromSteps: true };
  return true;
}
// The share of tokens in that came from the provider's prompt cache. Only calls whose provider reported caching count;
// null when none did (an unknown, not a 0%).
const cacheShare = (v) => (v?.cachedIn > 0 ? (v.cacheRead || 0) / v.cachedIn : null);
function cacheTag(v) {
  const sh = cacheShare(v);
  if (sh == null) return '';
  return `<span class="tok-cache ${sh >= 0.5 ? 'hit' : ''}" title="${esc(`${(v.cacheRead || 0).toLocaleString()} of ${v.cachedIn.toLocaleString()} tokens in were read from the provider's prompt cache${v.cacheWrite ? `; ${v.cacheWrite.toLocaleString()} written to it` : ''}. Cached tokens cost less.`)}">${pct(sh)} cached</span>`;
}
// ---------- the end of the Steps pane: what this reply cost (so far, while it runs), by model, and the chat's total ----------
function traceCostHTML(c, m) {
  const s = m.stats || (m.live && m.liveCost != null ? { cost: m.liveCost, byModel: m.liveByModel || {}, tokensIn: m.liveTokens?.[0], tokensOut: m.liveTokens?.[1], live: true } : null);
  if (!s) return '';
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
  const models = Object.entries(s.byModel || {}).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  const calls = models.reduce((n, [, v]) => n + (v.calls || 0), 0) || s.llmCalls || 0;
  const sumCache = (list) => list.reduce((a, [, v]) => ({ cacheRead: a.cacheRead + (v.cacheRead || 0), cachedIn: a.cachedIn + (v.cachedIn || 0), cacheWrite: a.cacheWrite + (v.cacheWrite || 0) }), { cacheRead: 0, cachedIn: 0, cacheWrite: 0 });
  const t = chatTotals(c); // every reply in the chat (this one included, live or done) and calls outside replies
  const rows = models.map(([id, v]) => `<tr><td><span class="tc-model" title="${esc(id)}">${esc(short(id))}</span>${v.role && v.role !== 'writer' ? ` <i>${esc(v.role)}</i>` : ''}</td><td>${v.calls || 0}×</td><td>${v.tokensIn || v.tokensOut ? `<span class="tok-in">${k(v.tokensIn)} in</span> · <span class="tok-out">${k(v.tokensOut)} out</span>` : ''}</td><td class="tc-cache">${cacheTag(v)}</td><td class="tc-c">${money(v.cost || 0, 5)}</td></tr>`).join('');
  return `<div class="trace-cost">
    <div class="tc-head"><span>💲 ${s.live ? 'Spent so far' : s.partial ? 'This reply spent (it ended early)' : 'This reply cost'}</span><b>${money(s.cost || 0, 5)}</b></div>
    <div class="tc-sub">${calls} model call${calls === 1 ? '' : 's'}${s.tokensIn ? ` · <span class="tok-in">${k(s.tokensIn)} tokens in</span>` : ''}${s.tokensOut ? ` · <span class="tok-out">${k(s.tokensOut)} tokens out</span>` : ''}${cacheShare(sumCache(models)) != null ? ` · ${cacheTag(sumCache(models))}` : ''}${s.ms ? ` · ${secs(s.ms)}` : ''}${s.mediaSpent ? ` · media ${money(s.mediaSpent, 4)}` : ''}</div>
    ${rows ? `<table class="tc-table"><tbody>${rows}</tbody></table>` : ''}
    <div class="tc-chat"><span>Whole chat so far · ${t.replies} repl${t.replies === 1 ? 'y' : 'ies'}${t.msgs ? ` · ${t.msgs} message${t.msgs === 1 ? '' : 's'}` : ''}</span><b>${money(t.cost, 4)}</b></div>
  </div>`;
}
// ---------- zoom: Ctrl + / − / 0 (and Ctrl+wheel) ----------
// In the terminal they change its text size only, as in an editor's terminal. Elsewhere, in the desktop app they zoom
// QuorX (remembered); in a browser the browser's own zoom does that. Browser tabs in the pane zoom on their own.
const TERM_FONT = [9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];
function termFont(dir) {
  let cur = 13; try { cur = Number(localStorage.getItem('oh-term-font')) || 13; } catch { /* default */ }
  const i = TERM_FONT.indexOf(cur);
  const next = dir === 'reset' ? 13 : TERM_FONT[Math.max(0, Math.min(TERM_FONT.length - 1, (i < 0 ? 4 : i) + (dir === 'in' ? 1 : -1)))];
  try { localStorage.setItem('oh-term-font', String(next)); } catch { /* this session only */ }
  for (const x of G.xt?.values() || []) { x.term.options.fontSize = next; try { x.fit.fit(); } catch { /* hidden */ } }
  return next;
}
const zoomDir = (e) => (!(e.ctrlKey || e.metaKey) || e.altKey ? null : ['=', '+'].includes(e.key) || e.code === 'NumpadAdd' ? 'in' : ['-', '_'].includes(e.key) || e.code === 'NumpadSubtract' ? 'out' : e.key === '0' || e.code === 'Numpad0' ? 'reset' : null);
const inTerminal = (el) => !!el?.closest?.('.xt-host');
// Pages shown in the pane (artifacts, page previews) zoom on their own, in Chrome's steps, remembered. They're scaled
// as a whole, laid out wider or narrower to match, like a browser's zoom; the page inside never notices.
const PAGE_ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
let pageZoom = (() => { try { const z = Number(localStorage.getItem('oh-page-zoom')); return z >= 0.5 && z <= 2 ? z : 1; } catch { return 1; } })();
function fitFrame(f) {
  const z = pageZoom;
  if (z === 1) { for (const p of ['width', 'height', 'transform', 'transform-origin', 'max-width']) f.style.removeProperty(p); f.parentElement?.classList.remove('zoomed-frame'); return; }
  f.style.setProperty('width', `${100 / z}%`, 'important'); f.style.setProperty('max-width', 'none', 'important');
  f.style.setProperty('height', `${100 / z}%`, 'important');
  f.style.transform = `scale(${z})`; f.style.transformOrigin = '0 0';
  f.parentElement?.classList.add('zoomed-frame');
}
const paneFrames = () => [...document.querySelectorAll('#paneBody iframe, .lb-doc iframe')];
function zoomPages(dir) {
  const i = PAGE_ZOOMS.findIndex((z) => Math.abs(z - pageZoom) < 0.01);
  pageZoom = dir === 'reset' ? 1 : PAGE_ZOOMS[Math.max(0, Math.min(PAGE_ZOOMS.length - 1, (i < 0 ? 5 : i) + (dir === 'in' ? 1 : -1)))];
  try { localStorage.setItem('oh-page-zoom', String(pageZoom)); } catch { /* this session only */ }
  for (const f of paneFrames()) fitFrame(f);
  return pageZoom;
}
// New frames (a different artifact, a re-drawn pane) come up at the remembered zoom.
new MutationObserver((list) => { if (pageZoom === 1) return; for (const r of list) for (const n of r.addedNodes) { if (n.nodeName === 'IFRAME') fitFrame(n); else if (n.querySelectorAll) for (const f of n.querySelectorAll('iframe')) if (f.closest('#paneBody, .lb-doc')) fitFrame(f); } })
  .observe(document.body, { childList: true, subtree: true });
// What a zoom is for: the frame or terminal that has focus (keys), or that the mouse is over (wheel).
let lastPointer = null;
document.addEventListener('pointermove', (e) => { lastPointer = [e.clientX, e.clientY]; }, { capture: true, passive: true });
const isPaneFrame = (el) => el?.nodeName === 'IFRAME' && !!el.closest('#paneBody, .lb-doc');
function zoomTarget(kind) {
  const el = kind === 'wheel' ? (lastPointer ? document.elementFromPoint(...lastPointer) : null) : document.activeElement;
  return isPaneFrame(el) ? 'page' : inTerminal(el) ? 'terminal' : 'app';
}
function zoomFor(target, dir) {
  if (target === 'terminal') return flashTip($('#paneBody .tpane.on .term-x') || $('#paneBody .term-x') || document.body, `Terminal text ${termFont(dir)}px`);
  if (target === 'page') { const z = zoomPages(dir); const f = paneFrames()[0]; return flashTip(f?.parentElement || document.body, `Page ${Math.round(z * 100)}%`); }
  window.ohDesktop?.zoom?.(dir).then((f) => flashTip(document.body, `QuorX ${Math.round(f * 100)}%`)).catch(() => {});
}
// In the desktop app the keys and Ctrl+wheel arrive from the app (they reach it even inside a frame).
window.ohDesktop?.on?.((ev) => { if (ev.type === 'zoom-key') zoomFor(zoomTarget('key'), ev.dir); if (ev.type === 'zoom-wheel') zoomFor(zoomTarget('wheel'), ev.dir); });
// In a browser the page sees its own keys and wheel: the terminal and pane pages take theirs; the rest is the browser's zoom.
document.addEventListener('keydown', (e) => {
  const dir = zoomDir(e); if (!dir || window.ohDesktop?.zoom) return;
  const t = zoomTarget('key'); if (t === 'app') return;
  e.preventDefault(); e.stopPropagation(); zoomFor(t, dir);
}, true);
document.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  // The terminal's text, in the desktop app too (the page takes the wheel first, so the app never sees it).
  if (inTerminal(e.target)) { e.preventDefault(); termFont(e.deltaY < 0 ? 'in' : 'out'); }
}, { capture: true, passive: false });
// ---------- pages the agent made: from the pages address when there is one ----------
// There they have an origin of their own (not this app's), so localStorage and the like work and the frame can be
// allowed its origin. Only on this computer: the pages address answers no other device.
function pageUrl(u) {
  const p = G.cfg?.pagePort;
  if (!p || !/^\/(ws|art|preview)\//.test(u) || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return u;
  return `${location.protocol}//${location.hostname}:${p}${u}`;
}
const pageSandbox = (u) => `allow-scripts allow-forms allow-modals allow-popups allow-downloads${/^https?:/.test(u) && !u.startsWith(location.origin) ? ' allow-same-origin' : ''}`;
// ---------- looking at what you sent: pictures large (← → between them), files in the Files preview ----------
function openViewer(build) {
  let d = $('#lbDlg');
  if (!d) {
    d = document.createElement('dialog'); d.id = 'lbDlg'; d.className = 'lb-dlg';
    d.innerHTML = '<div class="lb"><button type="button" class="lb-x" aria-label="Close" title="Close (Esc)">✕</button><div class="lb-body"></div></div>';
    document.body.appendChild(d);
    $('.lb-x', d).onclick = () => d.close();
    d.addEventListener('mousedown', (e) => { d._down = e.target === d; });
    d.addEventListener('click', (e) => { if (e.target === d && d._down) d.close(); });
    d.addEventListener('close', () => { $('.lb-body', d).innerHTML = ''; d.onkeydown = null; });
  }
  build($('.lb-body', d), d);
  if (!d.open) d.showModal();
}
function viewPictures(list, start) {
  openViewer((body, d) => {
    let i = start;
    const draw = () => {
      body.innerHTML = `<div class="lb-pic pv-checker"><img src="${esc(list[i])}" alt="picture ${i + 1}"></div>${list.length > 1 ? `<div class="lb-nav"><button type="button" class="lb-prev" aria-label="Previous">‹</button><span>${i + 1} of ${list.length}</span><button type="button" class="lb-next" aria-label="Next">›</button></div>` : ''}`;
      const go = (k) => { i = (i + k + list.length) % list.length; draw(); };
      const pv = $('.lb-prev', body), nx = $('.lb-next', body);
      if (pv) pv.onclick = () => go(-1); if (nx) nx.onclick = () => go(1);
      d.onkeydown = (e) => { if (list.length > 1 && e.key === 'ArrowLeft') go(-1); if (list.length > 1 && e.key === 'ArrowRight') go(1); };
    };
    draw();
  });
}
document.addEventListener('click', (e) => {
  const img = e.target.closest?.('.msg .u-imgs img');
  if (img) {
    const box = img.closest('.u-imgs'), thumbs = [...box.querySelectorAll('img')].map((x) => x.src);
    let views = []; try { views = JSON.parse(box.dataset.views || '[]'); } catch { /* none kept */ }
    viewPictures(thumbs.map((t, k) => views[k] || t), Number(img.dataset.k) || 0); // older messages kept only the small copy
    return;
  }
  // Screenshots in a reply's steps, the Steps pane, the judges' cards and pictures in a reply: large, with ‹ › between
  // the others in the same reply (or the same Steps list).
  const shot = e.target.closest?.('img.shot, img.dsnap, .msg .msg-md img');
  if (shot && shot.src) {
    const scope = shot.closest('.msg, .trace, #paneBody') || document.body;
    const all = [...scope.querySelectorAll('img.shot, img.dsnap, .msg-md img')].filter((x) => x.src && x.offsetParent !== null || x === shot);
    viewPictures(all.map((x) => x.src), Math.max(0, all.indexOf(shot)));
    return;
  }
  const doc = e.target.closest?.('.msg .u-doc[data-doc]');
  if (doc) {
    let dd = null; try { dd = JSON.parse(doc.dataset.doc); } catch { return; }
    const c = focused(); if (!c) return;
    G.filesProject = c.projectId;
    openViewer((body) => {
      if (!dd.rel) { body.innerHTML = `<div class="fx-empty big">${esc(dd.name)}<br><small>Sent before previews were kept: find it in Files → .quorx/uploads.</small></div>`; return; }
      body.innerHTML = '<div class="lb-doc fview"></div>';
      previewFile($('.lb-doc', body), { name: dd.rel, src: `/ws/${c.projectId}/${dd.rel.split('/').map(encodeURIComponent).join('/')}`, size: dd.size, full: dd.name });
    });
  }
});
// ---------- the app's own confirm / alert / prompt windows (instead of the browser's grey boxes) ----------
// The first line of the message is the heading; the rest is the body (• lines become a list). A question that starts
// with Delete / Remove / Clear / Discard gets a red button named after it; Enter confirms, Esc or a click outside cancels.
const ASK_VERBS = { delete: 'Delete', remove: 'Remove', clear: 'Clear', discard: 'Discard', restart: 'Restart', undo: 'Undo', read: 'Read', permanently: 'Delete' };
function askBody(text) {
  return String(text || '').split(/\n\s*\n/).filter((x) => x.trim()).map((para) => {
    const lines = para.trim().split('\n');
    if (lines.every((l) => /^\s*•/.test(l))) return `<ul>${lines.map((l) => `<li>${esc(l.replace(/^\s*•\s*/, ''))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(esc).join('<br>')}</p>`;
  }).join('');
}
// alt adds a third answer between Cancel and OK (shown in red with altDanger); choosing it resolves to 'alt'.
function ask(message, { ok, cancel = 'Cancel', danger, input = null, alertOnly = false, alt = null, altDanger = false } = {}) {
  return new Promise((resolve) => {
    const [head, ...rest] = String(message || '').split('\n');
    const verb = ASK_VERBS[(head.match(/^\s*(\w+)/)?.[1] || '').toLowerCase()];
    ok ??= alertOnly ? 'OK' : verb || 'OK';
    danger ??= !alertOnly && /^(Delete|Remove|Clear|Discard|Permanently)/i.test(head.trim());
    const d = document.createElement('dialog');
    d.className = 'ask-dlg';
    d.innerHTML = `<form class="ask" method="dialog">
      <h3>${esc(head)}</h3>${rest.join('\n').trim() ? `<div class="ask-body">${askBody(rest.join('\n'))}</div>` : ''}
      ${input != null ? `<input class="ask-in" spellcheck="false" value="${esc(input)}">` : ''}
      <footer>${alertOnly ? '' : `<button type="button" class="ask-cancel">${esc(cancel)}</button>`}${alt ? `<button type="button" class="ask-alt ${altDanger ? 'danger' : ''}">${esc(alt)}</button>` : ''}<button type="submit" class="ask-ok ${danger ? 'danger' : ''}">${esc(ok)}</button></footer>
    </form>`;
    document.body.appendChild(d);
    const no = input != null ? null : alertOnly;
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; d.close(); d.remove(); resolve(v); };
    $('.ask-cancel', d)?.addEventListener('click', () => done(no));
    $('.ask-alt', d)?.addEventListener('click', () => done('alt'));
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(no); });
    d.addEventListener('mousedown', (e) => { d._down = e.target === d; });
    d.addEventListener('click', (e) => { if (e.target === d && d._down) done(no); });
    $('form', d).onsubmit = (e) => { e.preventDefault(); done(input != null ? $('.ask-in', d).value : true); };
    d.showModal();
    const f = $('.ask-in', d) || $('.ask-ok', d); f.focus(); f.select?.();
  });
}
const uiConfirm = (message, opts) => ask(message, opts);
const uiAlert = (message) => ask(message, { alertOnly: true });
const uiPrompt = (message, value = '', opts) => ask(message, { input: value, ok: 'Save', ...opts });
// The message box grows with its text up to 40% of the window, then scrolls. Where the browser can size it from
// its content (field-sizing), CSS does it; otherwise this does, on every change.
const FIELD_SIZING = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
function fitInput(ta) {
  if (FIELD_SIZING || !ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.round(innerHeight * 0.4))}px`;
}
// A project's colours: --ph is the automatic hue from its name; --pcx is the colour you picked in its settings.
// The automatic name colour as #rrggbb (what the picker starts from).
function autoHex(name) {
  const h = hue(name || '') / 360, s = 0.55, l = 0.55, k = (n) => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
  return `#${f(0)}${f(8)}${f(4)}`;
}
const projStyle = (p) => `--ph:${hue(p?.name || '')}${p?.color ? `;--pcx:${p.color}` : ''}`;
// ---------- tooltips: one themed tip for every title= and data-tip= on the page ----------
// The browser's own grey tooltip is held back while the pointer is over an element (its title moves aside and comes
// back on leave, so code that sets or reads titles keeps working). The tip shows after a short pause, instantly when
// moving between tipped things, sits below (or above) the element inside the window, and goes on click, scroll or Esc.
// It lives in the top layer (a popover), so it shows above open dialogs too.
const TIP = { el: null, target: null, timer: 0, hidAt: 0 };
function tipBox() {
  if (TIP.el) return TIP.el;
  const el = document.createElement('div');
  el.className = 'oh-tip'; el.setAttribute('role', 'tooltip'); el.id = 'ohTip';
  if ('popover' in el) el.popover = 'manual';
  document.body.appendChild(el);
  return (TIP.el = el);
}
// A web link in content (data-cl) opens only with Ctrl+click (Cmd+click on a Mac), in the Browser tab: its tip says so,
// with the address under it when the link's text doesn't show it.
const MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const LINK_TIP = `${MAC ? 'Cmd' : 'Ctrl'}+click to open in the Browser tab`;
function tipText(t) {
  const own = t.dataset.ohTitle ?? t.getAttribute('data-tip') ?? '';
  if (t.tagName !== 'A' || t.dataset.cl == null) return own;
  const href = t.getAttribute('href') || '';
  return [LINK_TIP, own, href && href !== t.textContent.trim() ? href : ''].filter(Boolean).join('\n');
}
function showTip(t, override) {
  const text = (override ?? tipText(t)).trim();
  if (!text || !t.isConnected) return;
  const box = tipBox();
  const lines = text.split('\n');
  box.classList.toggle('card', lines.length > 1);
  if (lines.length > 1) {
    box.replaceChildren(...lines.map((l, i) => {
      const el = document.createElement('div');
      const tab = l.indexOf('\t');
      if (i === 0) { el.className = 'tip-h'; el.textContent = l; }
      else if (tab > 0) { el.className = 'tip-row'; const a = document.createElement('span'), b = document.createElement('b'); a.textContent = l.slice(0, tab); b.textContent = l.slice(tab + 1); if (/^\$\d/.test(b.textContent)) b.classList.add('money'); if (/^total$/i.test(a.textContent.trim())) el.classList.add('tip-total'); el.append(a, b); }
      else { el.className = 'tip-note'; el.textContent = l; }
      return el;
    }));
  } else box.textContent = text;
  if (box.popover) { try { box.hidePopover(); } catch { /* not open */ } try { box.showPopover(); } catch { /* unsupported */ } }
  box.classList.add('on');
  const r = t.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight, gap = 8;
  const below = r.bottom + gap + h <= innerHeight - 6 || r.top - gap - h < 6;
  box.style.left = `${Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2))}px`;
  box.style.top = `${below ? Math.min(innerHeight - h - 6, r.bottom + gap) : r.top - gap - h}px`;
  box.dataset.side = below ? 'below' : 'above';
  avoidDesk(box);
}
// In the desktop app the Browser tab's page is a real window drawn above everything on this page, so a tip or
// popup that would land on it moves to its left; when there is no room, the tab shows its still picture meanwhile.
function avoidDesk(box) {
  box.classList.remove('covers');
  const d = G.dsk;
  if (!DESK || !d?.shown || !d.ph?.isConnected) return;
  const v = d.ph.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (!(b.left < v.right && b.right > v.left && b.top < v.bottom && b.bottom > v.top)) return;
  if (v.left - b.width - 8 >= 6) { box.style.left = `${Math.round(v.left - b.width - 8)}px`; return; }
  box.classList.add('covers');
}
function hideTip() {
  clearTimeout(TIP.timer);
  TIP.target = null;
  if (TIP.el?.classList.contains('on')) { TIP.el.classList.remove('on'); TIP.hidAt = Date.now(); if (TIP.el.popover) { try { TIP.el.hidePopover(); } catch { /* closed */ } } }
}
// A tip never outlives its target: a click hides it, and so does the target being removed or hidden under the pointer
// (a window closing, a list redrawn), which sends no pointer event of its own.
document.addEventListener('pointerdown', () => hideTip(), true);
setInterval(() => { const t = TIP.target; if (TIP.el?.classList.contains('on') && !TIP.el.classList.contains('flash') && (!t || !t.isConnected || !t.getClientRects().length)) hideTip(); }, 300); // a flash ("Copied") goes by itself
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  // A link's tip in the terminal stays while the pointer moves along the link (the terminal's rows are many elements).
  if (TIP.target?.classList?.contains('xt-tip-at') && e.target.closest?.('.xterm')) return;
  const t = e.target.closest?.('a[data-cl], [data-oh-title], [data-tip], [title]');
  if (t === TIP.target) return;
  hideTip();
  if (!t || t.closest('.oh-tip')) return;
  if (t.hasAttribute('title')) adoptTitle(t);
  if (!tipText(t).trim()) return;
  TIP.target = t;
  const wait = t.dataset.tipDelay ? Number(t.dataset.tipDelay) : Date.now() - TIP.hidAt < 400 ? 0 : 450; // a long one (data-tip-delay) always waits: rows you only pass over stay quiet
  TIP.timer = setTimeout(() => TIP.target === t && showTip(t), wait);
});
// The browser's own tooltip never shows: a title is moved to data-oh-title as soon as it is set (also when a live
// reply redraws a button under the pointer). A button with no other label keeps it as its accessible name.
function adoptTitle(el) {
  const t = el.getAttribute('title');
  if (t == null) return;
  el.removeAttribute('title');
  el.dataset.ohTitle = t;
  if (t && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.textContent.trim()) el.setAttribute('aria-label', t.split('\n')[0]);
  if (TIP.target === el && TIP.el?.classList.contains('on')) showTip(el); // a tip that is showing follows the new text
}
new MutationObserver((list) => {
  for (const r of list) {
    if (r.type === 'attributes') { if (r.target.nodeType === 1) adoptTitle(r.target); continue; }
    for (const n of r.addedNodes) { if (n.nodeType !== 1) continue; if (n.hasAttribute('title')) adoptTitle(n); for (const x of n.querySelectorAll('[title]')) adoptTitle(x); }
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
for (const x of document.querySelectorAll('[title]')) adoptTitle(x);
// A short confirmation in the same tip (e.g. "Copied") that goes by itself.
function flashTip(el, text, ms = 1300) {
  clearTimeout(TIP.timer); clearTimeout(TIP.flash);
  showTip(el, text);
  TIP.el.classList.add('flash');
  TIP.flash = setTimeout(() => { TIP.el?.classList.remove('flash'); hideTip(); }, ms);
}
document.addEventListener('pointerout', (e) => { if (TIP.target && !TIP.target.contains(e.relatedTarget)) hideTip(); });
for (const ev of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(ev, hideTip, true);
document.addEventListener('scroll', hideTip, true);
addEventListener('blur', hideTip);
// ---------- the chat follows its newest output ----------
// Follow mode is on while you're at the bottom: anything that grows (streamed text, cards, images, maths) keeps
// the end in view. Scrolling up turns it off; scrolling back down, sending a message or opening the chat turns it
// on again. While it's off, a ↓ Latest button jumps back.
function keepAtBottom(c, msgs, root) {
  c.follow = true;
  const jump = document.createElement('button');
  jump.type = 'button'; jump.className = 'jump-latest'; jump.hidden = true; jump.textContent = '↓ Latest';
  jump.title = 'Jump to the newest messages and keep following them';
  $('.composer', root)?.appendChild(jump);
  const nearEnd = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  const toEnd = () => { if (!c.follow) return; msgs.scrollTop = msgs.scrollHeight; jump.hidden = true; };
  c.toEnd = toEnd;
  followScroll(msgs, { get: () => c.follow, set: (v) => { c.follow = v; }, near: 80, onChange: (v) => { jump.hidden = v; } });
  jump.onclick = () => { c.follow = true; toEnd(); };
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => toEnd());
    for (const el of msgs.children) ro.observe(el);
    new MutationObserver((list) => { for (const r of list) for (const n of r.addedNodes) if (n.nodeType === 1) ro.observe(n); toEnd(); }).observe(msgs, { childList: true });
  }
  toEnd();
  // Pictures, maths and code highlighting finish after the first paint: follow them too.
  setTimeout(toEnd, 300); setTimeout(toEnd, 1200);
}
// Keeps a scroll box at its end while following. Only your own scrolling (wheel, touch, keys, the scrollbar) stops
// it; content that grows under it (a picture that loads late, maths that renders) moves it back to the end instead.
function followScroll(box, { get, set, near = 60, onChange }) {
  let userAt = 0, lastH = box.scrollHeight;
  for (const ev of ['wheel', 'touchmove', 'keydown', 'pointerdown']) box.addEventListener(ev, () => { userAt = Date.now(); }, { passive: true });
  box.addEventListener('scroll', () => {
    const grew = box.scrollHeight !== lastH; lastH = box.scrollHeight;
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < near;
    if (atEnd) set(true);
    else if (get() && grew && Date.now() - userAt > 500) box.scrollTop = box.scrollHeight;
    else set(false);
    onChange?.(get());
  }, { passive: true });
  // pictures that finish loading later
  box.addEventListener('load', (e) => { if (e.target.tagName === 'IMG' && get()) box.scrollTop = box.scrollHeight; }, true);
}
// ---------- the chat panes ----------
function renderPanes() {
  const box = $('#chats');
  G.panes = G.panes.filter((id) => G.open.has(id));
  syncHome();
  box.innerHTML = '';
  if (!G.panes.length) { renderLanding(box); syncLayout(); renderPane(); return; }
  box.classList.toggle('split', G.panes.length > 1);
  G.panes.forEach((id, i) => {
    const c = G.open.get(id);
    const root = document.createElement('section');
    root.className = `chatpane ${i === G.focus ? 'focus' : ''}`;
    root.dataset.pane = i;
    root.innerHTML = `
      <header class="chat-head chat-header dir-a-head" style="--h:${hue(c.title)}">
        <div class="dir-a-toprow">
          <div class="dir-a-crumbs">
            <button type="button" class="ch-proj-tag proj-hue-tag" title="Open the project folder in File Explorer"><svg class="proj-folder-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg><span class="ch-proj-name"></span></button>
            <a class="ch-gh" target="_blank" rel="noopener noreferrer" aria-label="Open on GitHub" hidden></a>
            <span class="dir-a-crumb-sep">/</span>
            <span class="dir-a-msgs-count"></span>
          </div>
          <div class="dir-a-meta-chips">
            <button type="button" class="ch-cost cost-badge-amber" title="What this chat has cost (click for the breakdown)"></button>
          </div>
        </div>
        <div class="dir-a-mainrow">
          <div class="dir-a-identity">
            <input class="ch-name ch-title dir-a-title-input" value="${esc(c.title)}" aria-label="Chat title" title="Click to rename">
            <span class="title-confirm" hidden><button type="button" class="tc-ok" title="Save the new title (Enter)" aria-label="Save title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button><button type="button" class="tc-no" title="Keep the old title (Esc)" aria-label="Cancel rename"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></span>
            <span class="dir-a-state-badge idle"></span>
          </div>
          <div class="ch-acts ch-actions dir-a-actions">
            <button type="button" class="ch-btn ch-pane hdr-icon-btn phone-only" title="Switch to what this chat built" aria-label="Artifact pane"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M13 3v18"/></svg></button>
            <button type="button" class="ch-btn ch-panel hdr-icon-btn" aria-pressed="true" title="Side panel: artifacts, browser, steps, terminal, files (lit while it's open)" aria-label="Show or hide the side panel"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/></svg></button>
            <button type="button" class="ch-btn ch-rename hdr-icon-btn" title="Rename this chat" aria-label="Rename chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg></button>
            <span class="dir-a-actions-sep"></span>
            <button type="button" class="ch-btn ch-delete hdr-icon-btn danger" title="Delete this chat (it moves to data/trash; the project's files stay)" aria-label="Delete chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg></button>
          </div>
        </div>
        <div class="usage-pop" role="dialog" aria-label="Usage for this chat" hidden></div>
      </header>
      <div class="msgs"></div>
      <form class="composer composer-v2">
        <div class="composer-box">
        <div class="cmp-control-rack opts-open"><span class="cmp-model-slot"></span><button type="button" class="cmp-set-btn" aria-haspopup="dialog" aria-expanded="false" title="This chat's settings: reasoning, creativity, Strict / YOLO, tools"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg><span class="cmp-set-l">This chat</span><span class="cmp-set-sum"></span></button><span class="cmp-follow-slot"></span>
          <div class="cs-scrim" hidden></div>
          <div class="chat-set" role="dialog" aria-label="This chat's settings" hidden>
            <div class="cs-head"><b>This chat's settings</b><small>Changes here apply to this chat only</small><button type="button" class="cs-gear" title="All settings: models, prices and defaults (⚙ Settings)" aria-label="Open all settings">${ICO.gear}</button><button type="button" class="cs-x" aria-label="Discard changes and close" title="Close (discards unsaved changes)">✕</button></div>
            <div class="cbar"></div>
            <div class="cs-glob"></div>
            <details class="cs-adv"><summary>Advanced <small>· each tool's model, strength and price</small></summary><div class="toolbar cmp-tools-wrap" aria-label="Tools the agent may use"></div></details>
            <div class="cs-foot"><span class="cs-note">No changes</span><button type="button" class="cs-undo" title="Put back what was set when you opened this" disabled>Undo</button><button type="button" class="cs-ok" title="Save changes" disabled>✓ Save</button></div>
          </div>
        </div>
        <div class="attachments cmp-attachments-tray"></div>
        <div class="suggest cmp-suggest-popup" role="listbox" hidden></div>
        <div class="composer-row cmp-input-row">
          <textarea class="input cmp-textarea" rows="1" placeholder="Ask, or ask for something to be built…  @ to add files or chats · / for commands"></textarea>
          <div class="composer-actions cmp-bottom-bar">
            <div class="cmp-actions-left">
              <button type="button" class="cmp-act-btn imgBtn attachBtn" title="Attach files of any kind: documents, PDFs, spreadsheets, code, images… (or paste / drop them)" aria-label="Attach files">${CMP_ICO.attach}</button>
              <input type="file" class="imgInput" multiple hidden>
              <button type="button" class="cmp-act-btn micBtn" title="Speak your message (transcribed into the box)" aria-label="Speak your message">${CMP_ICO.mic}</button>
              <button type="button" class="cmp-act-btn enhBtn" title="Enhance: rewrite what you wrote clearer and fuller before you send it (press again to go further). Uses the prompt enhancer's model, a fraction of a cent." aria-label="Enhance your message">✨<span class="enh-l">Enhance</span></button>
              <button type="button" class="cmp-act-btn enhUndo" title="Undo the last ✨ Enhance: your words back" aria-label="Undo enhance" hidden>↶</button>
            </div>
            <div class="cmp-actions-right">
              <button type="button" class="cmp-stop-btn stopBtn" title="Stop the agent" aria-label="Stop" hidden>${CMP_ICO.stop}</button>
              <button type="submit" class="cmp-send-btn sendBtn" title="Send (Enter)" aria-label="Send">${CMP_ICO.send}</button>
            </div>
          </div>
        </div>
        </div>
      </form>`;
    box.appendChild(root);
    c.el = { root };
    wirePane(c, root, i);
    renderChatHead(c); renderComposerBar(c); renderAllowed(c); renderAttachments(c); syncRunState(c);
    const msgs = $('.msgs', root);
    if (!c.agent.messages.length) msgs.innerHTML = `<div class="hint"><b>${esc(c.title)}</b><br>${esc(short(c.agent.setup.model))} · ${c.approval === 'strict' ? '🔒 Strict: asks before each tool it uses' : '⚡ YOLO: uses its tools without asking'}<br>The agent decides by itself when to ask the deciders.</div>`;
    for (const m of c.agent.messages) msgs.appendChild(renderMsg(c, m));
    keepAtBottom(c, msgs, root);
  });
  renderToolbars(); syncLayout(); renderPane(); applyKeyLock(); budgetNotices(); folderNotices();
  for (const id of G.panes) checkSpace(G.open.get(id));
  for (const pid of new Set(G.panes.map((id) => G.open.get(id)?.projectId))) refreshUndoable(pid);
  pollDev();
}
function wirePane(c, root, i) {
  root.addEventListener('pointerdown', () => { if (G.focus !== i) { G.focus = i; for (const p of document.querySelectorAll('.chatpane')) p.classList.toggle('focus', p === root); G.view = { id: null, src: false, files: false }; G.traceRun = null; renderPane(); syncLayout(); renderSidebar(); } }, true);
  // Renaming: ✓ (or Enter) saves the new title, ✕ (or Esc) puts the old one back. Nothing saves by itself.
  const nameIn = $('.ch-name', root), tconf = $('.title-confirm', root);
  const saveTitle = () => { c.title = nameIn.value.trim() || 'New chat'; nameIn.value = c.title; tconf.hidden = true; saveChat(c); renderSidebar(); nameIn.blur(); };
  const undoTitle = () => { nameIn.value = c.title; tconf.hidden = true; nameIn.blur(); };
  nameIn.oninput = () => { tconf.hidden = nameIn.value.trim() === c.title; };
  nameIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveTitle(); } else if (e.key === 'Escape') { e.preventDefault(); undoTitle(); } };
  for (const b of tconf.querySelectorAll('button')) b.onmousedown = (e) => e.preventDefault(); // keep the focus in the title while clicking
  $('.tc-ok', tconf).onclick = saveTitle;
  $('.tc-no', tconf).onclick = undoTitle;
  $('.ch-cost', root).onclick = () => toggleUsage(c);
  $('.ch-proj-tag', root).onclick = () => openFolder(c.projectId);
  // Rename and delete on the header; the project tag opens the folder (servers and the terminal live in the pane's tab bar).
  $('.ch-rename', root).onclick = () => { const n = $('.ch-name', root); n.focus(); n.select(); };
  $('.ch-panel', root).onclick = () => { if (G.paneMax) $('#paneMaxBtn')?.click(); setPaneHidden(!G.paneHidden); };
  { const pb = $('.ch-panel', root); pb.classList.toggle('on', !G.paneHidden); pb.setAttribute('aria-pressed', String(!G.paneHidden)); }
  $('.ch-delete', root).onclick = () => deleteChat(c.id);
  // On a phone ◧ switches between the chat and what it built; on a desktop the pane is always there.
  $('.ch-pane', root).onclick = () => setMView(G.mview === 'preview' ? 'chat' : 'preview');
  const form = $('.composer', root), ta = $('.input', root);
  form.addEventListener('submit', () => setTimeout(() => fitInput(ta))); // the box shrinks back once it's cleared
  form.onsubmit = (e) => { e.preventDefault(); const t = ta.value; if (/^\/\w+(\s|$)/.test(t.trim()) && runCommand(c, t.trim())) { ta.value = ''; return; } if (c.running?.runId && (t.trim() || hasAttachments(c))) { ta.value = ''; steer(c, t.trim()); return; } if ((t.trim() || hasAttachments(c)) && !c.running) { if (folderMissing(c)) return; if ((c.docs || []).some((d) => d.busy)) { uiAlert('Some attached files are still being read. Send when their chips say they are ready.'); return; } ta.value = ''; send(c, t); } };
  ta.onkeydown = (e) => { if (suggestKey(c, e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } };
  ta.oninput = () => { updateSuggest(c); fitInput(ta); };
  ta.onblur = () => setTimeout(() => hideSuggest(c), 150);
  ta.onpaste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(c, files); } };
  root.ondragover = (e) => { const ty = [...e.dataTransfer.types]; if (['Files', 'application/x-quorx-file', 'application/x-quorx-tab', 'application/x-quorx-term'].some((k) => ty.includes(k))) { e.preventDefault(); root.classList.add('drop'); } };
  root.ondragleave = () => root.classList.remove('drop');
  root.ondrop = (e) => {
    root.classList.remove('drop');
    const pf = e.dataTransfer.getData('application/x-quorx-file'); if (pf) { e.preventDefault(); try { const f = JSON.parse(pf); addFileToChat(f.projectId, f.path, root); } catch { /* not ours */ } return; }
    const sid = e.dataTransfer.getData('application/x-quorx-tab'); if (sid) { e.preventDefault(); lendTab(c, sid); return; }
    const tf = e.dataTransfer.getData('application/x-quorx-term'); if (tf && G.term) { e.preventDefault(); termToChat(termScreenText(G.term, tf), root); return; }
    if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(c, e.dataTransfer.files); }
  };
  $('.imgBtn', root).onclick = () => $('.imgInput', root).click();
  $('.imgInput', root).onchange = (e) => { addFiles(c, e.target.files); e.target.value = ''; };
  $('.micBtn', root).onclick = () => toggleMic(c);
  $('.enhBtn', root).onclick = () => enhanceDraft(c);
  $('.enhUndo', root).onclick = () => undoEnhance(c);
  $('.stopBtn', root).onclick = () => c.running?.abort();
}
function chatTotals(c) {
  for (const m of c.agent.messages) if (m.role === 'assistant' && !m.stats && !m.live && m.trace?.length) partialSpendQuiet(m); // older replies that ended part-way
  const done = c.agent.messages.filter((m) => m.role === 'assistant' && m.stats);
  return { cost: done.reduce((s, m) => s + m.stats.cost, 0) + (c.agent.extraUsage || []).reduce((s, x) => s + (x.cost || 0), 0) + liveOf(c), replies: done.length, msgs: c.agent.messages.filter((m) => m.role === 'user').length };
}
function renderChatHead(c) {
  if (!c.el) return;
  const p = G.projects.find((x) => x.id === c.projectId);
  const t = chatTotals(c), r = c.el.root;
  const head = $('.chat-head', r);
  head.style.setProperty('--ph', hue(p?.name || c.projectId));
  if (p?.color) head.style.setProperty('--pcx', p.color); else head.style.removeProperty('--pcx');
  $('.ch-proj-name', r).textContent = p?.name || c.projectId;
  $('.ch-proj-tag', r).title = `Open the project folder in File Explorer\n${p?.dir || ''}`;
  const gh = $('.ch-gh', r);
  if (gh) { gh.hidden = !p?.github; if (p?.github && gh.getAttribute('href') !== p.github.url) { gh.href = p.github.url; gh.title = `Open ${p.github.owner}/${p.github.repo} on GitHub`; gh.innerHTML = GH_ICO; } }
  $('.dir-a-msgs-count', r).textContent = `${t.msgs} msg${t.msgs === 1 ? '' : 's'}`;
  $('.ch-cost', r).textContent = money(t.cost, t.cost < 1 ? 4 : 2);
  // State: Ready, Running, or waiting for your approval.
  const st = $('.dir-a-state-badge', r), state = c.waiting ? 'waiting' : c.running ? 'running' : 'idle'; // not 'approval': that class belongs to the approval cards
  st.className = `dir-a-state-badge ${state}`;
  st.innerHTML = state === 'idle' ? 'Ready' : `<span class="live-beacon ${state}"></span>${state === 'running' ? 'Running' : c.waiting === 'answer' ? 'Needs your answer' : c.waiting === 'budget' ? 'Budget reached' : 'Needs your approval'}`;
  st.title = st.textContent; // in a narrow chat only the dot shows; the words stay here
}
// The control centre above the message box: model, reasoning, Strict/YOLO for THIS chat.
function renderComposerBar(c) {
  if (!c.el) return;
  const s = c.agent.setup;
  const bar = $('.cbar', c.el.root);
  const rack = bar.closest('.cmp-control-rack'), slot = $('.cmp-model-slot', rack), glob = $('.cs-glob', rack), setBtn = $('.cmp-set-btn', rack), panel = $('.chat-set', rack), followSlot = $('.cmp-follow-slot', rack), scrim = $('.cs-scrim', rack);
  slot.innerHTML = `<button type="button" class="mbtn model cmp-model-chip" title="Model for this chat: ${esc(priceOf(s.model))} (click to pick any model)">${recDot(s.model, 'chat')} ${esc(short(s.model))} <small>${esc(shortPrice(s.model))}</small></button>`;
  bar.innerHTML = `
    <div class="cs-sec"><h5>Thinking</h5><div class="cs-row">${levelsHTML(s)}</div></div>
    <div class="cs-sec"><h5>Permission</h5><div class="cs-row cs-perm">
    <div class="seg perm cmp-perm-switch" title="How much permission this chat's agent asks for">
      <button type="button" data-approval="strict" class="${c.approval === 'strict' ? 'on' : ''}" title="Asks before every tool it uses">🔒 Strict</button>
      <button type="button" data-approval="yolo" class="${c.approval === 'yolo' ? 'on' : ''}" title="Uses its tools without asking (budget cap still applies)">⚡ YOLO</button>
    </div></div></div>
    <div class="cs-sec"><h5>Tools <small>· hover one for what it does</small></h5><div class="cs-row cs-tools">${quickToolsHTML(c)}</div></div>`;
  // The two caps every reply has (all chats): what all its model calls may cost, and what its paid media may cost.
  const cap = (k, label, v, step, tip) => `<label class="cs-num" title="${esc(tip)}"><span>${label}</span><span class="cs-inp"><i>$</i><input type="number" min="0" step="${step}" data-k="${k}" value="${esc(String(v))}" aria-label="${label} in dollars"></span></label>`;
  glob.innerHTML = `<div class="cs-sec"><h5>Budget <small>· all chats</small></h5><div class="cs-row cs-caps">${cap('replyBudget', 'Cap per reply', G.settings.replyBudget ?? G.cfg.defaults.replyBudget ?? 1, 0.25, 'Everything one reply calls: the agent, deciders, helpers, checks and media. At 85% the agent is told to wrap up; at the cap Strict asks you, YOLO stops. 0 = no cap.')}${cap('budget', 'Paid media per reply', G.settings.budget, 0.05, 'A paid picture, voice, music or video call that would go over this is stopped, in Strict and in YOLO.')}</div></div>`;
  followSlot.innerHTML = `
    <label class="sq-check cmp-follow" title="Follow the agent: when it opens or checks a page in its browser, or starts a site or app, the Browser tab switches to it; when it runs a command, the Terminal tab shows its output. So you can watch. Off: the pane stays where you put it (all chats)."><input type="checkbox" class="follow-agent" ${G.followAgent !== false ? 'checked' : ''}><svg class="fl-eye" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><span>Follow</span></label>
    <label class="sq-check cmp-chrome ${G.ext?.connected && !G.ext.outdated ? '' : 'off'}" title="${G.ext?.outdated ? 'Chrome: the QuorX extension is an older version. Reload it once in chrome://extensions (↻ on the QuorX card).' : G.ext?.connected ? 'Chrome: let the agent in this chat open tabs in your own Chrome (a QuorX window), signed in as you. Sending, deleting, buying and account changes ask you first. It never touches your other tabs.' : 'Chrome: the QuorX extension is not connected (⚙ Settings → Code & servers → Chrome extension). Ticked, the agent can use your Chrome once it is.'}"><input type="checkbox" class="chrome-access" ${c.tools?.chrome ? 'checked' : ''}><span>🧩 Chrome</span></label>
`;
  for (const inp of glob.querySelectorAll('.cs-num input')) inp.onchange = () => { const v = Math.max(0, Number(inp.value) || 0); inp.value = String(v); G.settings[inp.dataset.k] = v; savePrefs(); };
  // The button says what matters at a glance (YOLO in red, reasoning on) and opens the panel.
  const rName = REASON_INFO[s.reasoning]?.[0];
  $('.cmp-set-sum', setBtn).textContent = [c.approval === 'yolo' ? 'YOLO' : '', (s.reasoning || 'off') !== 'off' && rName ? rName : ''].filter(Boolean).join(' · ');
  setBtn.classList.toggle('yolo', c.approval === 'yolo');
  setBtn.dataset.ohTitle = `This chat's settings (this chat only)\nReasoning\t${rName || s.reasoning || 'off'}\nCreativity\t${CREATIVITY_INFO[s.creativity]?.[0] || 'Default'}\nPermission\t${c.approval === 'yolo' ? 'YOLO' : 'Strict'}`;
  if (!setBtn.dataset.wired) {
    setBtn.dataset.wired = '1';
    // Changes take effect as you make them, and stay only once you press ✓: ✕ puts back what was there when the
    // window opened. With unsaved changes, a click outside or Esc doesn't close it (it points at ✓ and ✕ instead).
    const okBtn = $('.cs-ok', panel), undoBtn = $('.cs-undo', panel), note = $('.cs-note', panel);
    const state = () => JSON.stringify({ r: c.agent.setup.reasoning, cr: c.agent.setup.creativity, a: c.approval, t: c.tools, al: c.agent.allowed, set: G.settings });
    let snap = null;
    const dirty = () => snap != null && state() !== snap;
    const mark = () => { const d = dirty(); okBtn.disabled = !d; undoBtn.disabled = !d; panel.classList.toggle('dirty', d); const t = d ? 'Unsaved changes' : 'No changes'; if (note.textContent !== t) note.textContent = t; }; // only when it changes: the observer below watches this window, so writing it every time would loop
    const shut = () => { snap = null; panel.classList.remove('dirty', 'nudge'); panel.hidden = true; scrim.hidden = true; rack.classList.remove('cs-open'); setBtn.classList.remove('on'); setBtn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey, true); };
    const nudge = () => { panel.classList.remove('nudge'); void panel.offsetWidth; panel.classList.add('nudge'); okBtn.focus(); };
    const discard = (andClose = true) => {
      if (dirty()) {
        const o = JSON.parse(snap);
        Object.assign(c.agent.setup, { reasoning: o.r, creativity: o.cr });
        c.approval = o.a; c.tools = o.t; c.agent.allowed = o.al;
        for (const k of Object.keys(G.settings)) delete G.settings[k];
        Object.assign(G.settings, o.set);
        saveChat(c); savePrefs();
        if (c.running?.runId) postJ(`/api/runs/${c.running.runId}/mode`, { approval: c.approval }).catch(() => {});
        renderComposerBar(c); renderToolbars();
      }
      if (andClose) shut(); else mark();
    };
    const save = () => { saveChat(c); savePrefs(); shut(); };
    const outside = (e) => { if ((!rack.contains(e.target) || e.target === scrim) && !e.target.closest?.('dialog, .oh-tip')) { if (dirty()) { e.preventDefault(); e.stopPropagation(); nudge(); } else shut(); } };
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.stopPropagation(); if (dirty()) nudge(); else { shut(); setBtn.focus(); } } };
    new MutationObserver(() => { if (snap != null) mark(); }).observe(panel, { childList: true, subtree: true });
    panel.addEventListener('change', () => setTimeout(mark));
    panel.addEventListener('click', () => setTimeout(mark));
    scrim.onclick = () => (dirty() ? nudge() : shut());
    setBtn.onclick = () => {
      if (!panel.hidden) return dirty() ? nudge() : shut();
      snap = state(); mark();
      panel.hidden = false; scrim.hidden = false; rack.classList.add('cs-open'); setBtn.classList.add('on'); setBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true);
    };
    okBtn.onclick = save;
    $('.cs-x', panel).onclick = () => discard(true);
    undoBtn.onclick = () => discard(false);
  }
  $('.model', slot).onclick = async () => { const id = await pickModel('chat', s.model, { context: `For “${clip(c.title, 40)}”` }); if (id) { s.model = id; saveChat(c); renderComposerBar(c); renderChatHead(c); } };
  for (const b of bar.querySelectorAll('.lvl-b')) b.onclick = () => { c.agent.setup[b.closest('.lvl').dataset.key] = b.dataset.v; saveChat(c); renderComposerBar(c); };
  for (const b of bar.querySelectorAll('.qt-b')) b.onclick = () => {
    const k = b.dataset.k;
    if (k === 'listen') { (G.settings.tools.listen ??= {}).on = G.settings.tools.listen.on === false; savePrefs(); }
    else { c.tools[k] = !({ ...DEFAULT_CHAT_TOOLS, ...c.tools })[k]; saveChat(c); }
    renderToolbars(); renderComposerBar(c);
  };
  const gear = $('.cs-gear', rack); if (gear && !gear.dataset.wired) { gear.dataset.wired = '1'; gear.onclick = () => openSettings(); }
  $('.follow-agent', followSlot).onchange = (e) => { G.followAgent = e.target.checked; savePrefs(); for (const ch of G.open.values()) if (ch !== c) renderComposerBar(ch); };
  $('.chrome-access', followSlot).onchange = (e) => { c.tools.chrome = e.target.checked; saveChat(c); };
  for (const b of bar.querySelectorAll('.perm button')) b.onclick = () => { c.approval = b.dataset.approval; saveChat(c); renderComposerBar(c); if (c.running?.runId) postJ(`/api/runs/${c.running.runId}/mode`, { approval: c.approval }).catch(() => {}); };
  renderAllowed(c);
}
// ---------- usage (per chat): every model this chat paid for, grouped by kind of call ----------
const USAGE_KIND = {
  writer: ['💬', 'Chat model'], strong: ['💬', 'Chat model (strong)'], summary: ['🗜', 'Summaries'], decider: ['⚖️', 'Deciders · checks, look, decide'],
  reviewer: ['🔍', 'Reviewer'], codereview: ['🔎', 'Code reviews'], helper: ['🧭', 'Helpers'], freshEyes: ['👀', 'Fresh eyes'], enhancer: ['📝', 'Prompt enhancer'],
  image: ['🖼', 'Pictures'], video: ['🎬', 'Video'], music: ['🎵', 'Music'], speech: ['🗣', 'Voice'], listen: ['🎤', 'Mic (speech to text)'], media: ['🎨', 'Media'],
};
function chatUsage(c) {
  const rows = new Map(), add = (kind, model, v) => {
    const k = `${kind}|${model}`, r = rows.get(k) || { kind, model, calls: 0, cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cachedIn: 0, cacheWrite: 0 };
    r.calls += v.calls || 0; r.cost += v.cost || 0; r.tokensIn += v.tokensIn || 0; r.tokensOut += v.tokensOut || 0;
    r.cacheRead += v.cacheRead || 0; r.cachedIn += v.cachedIn || 0; r.cacheWrite += v.cacheWrite || 0; rows.set(k, r);
  };
  let replies = 0;
  for (const m of c.agent.messages) {
    if (m.role !== 'assistant' || !m.stats) continue;
    replies++;
    for (const [model, v] of Object.entries(m.stats.byModel || {})) add(v.role || 'writer', model, v);
  }
  for (const x of c.agent.extraUsage || []) add(x.kind, x.model, { calls: 1, cost: x.cost });
  const list = [...rows.values()].sort((a, b) => b.cost - a.cost);
  return { replies, cost: list.reduce((n, r) => n + r.cost, 0), calls: list.reduce((n, r) => n + r.calls, 0), rows: list };
}
function usageHTML(u, at) {
  const kinds = [...new Set(u.rows.map((r) => r.kind))].sort((a, b) => u.rows.filter((r) => r.kind === b).reduce((n, r) => n + r.cost, 0) - u.rows.filter((r) => r.kind === a).reduce((n, r) => n + r.cost, 0));
  const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const pct = (x) => (u.cost > 0 ? Math.max(1, Math.round((x / u.cost) * 100)) : 0);
  return `<div class="usage-card">
    <div class="uc-head"><b>📊 Usage for this chat</b>${at ? `<span>${esc(new Date(at).toLocaleString())}</span>` : '<span>live</span>'}</div>
    <div class="uc-kpis"><div><small>Total</small><b>${money(u.cost, 4)}</b></div><div><small>Replies</small><b>${u.replies}</b></div><div><small>Model calls</small><b>${u.calls}</b></div></div>
    ${u.rows.length ? kinds.map((k) => {
      const rs = u.rows.filter((r) => r.kind === k), sub = rs.reduce((n, r) => n + r.cost, 0), [ico, name] = USAGE_KIND[k] || ['•', k];
      return `<div class="uc-kind"><div class="uc-kind-h"><span>${ico} ${esc(name)}</span><b>${money(sub, 4)}</b></div>
        ${rs.map((r) => `<div class="uc-row"><span class="uc-model" title="${esc(r.model)}">${esc(short(r.model))}</span><span class="uc-calls">${r.calls}×${r.tokensIn || r.tokensOut ? ` · ${tok(r.tokensIn)} in / ${tok(r.tokensOut)} out` : ''}</span><span class="uc-cache">${cacheTag(r)}</span><span class="uc-cost">${money(r.cost, 5)}</span><span class="uc-bar"><i style="width:${pct(r.cost)}%"></i></span></div>`).join('')}</div>`;
    }).join('') : '<p class="uc-empty">Nothing spent in this chat yet.</p>'}
    <div class="uc-foot">Only you see this. It is never sent to the agent.</div>
  </div>`;
}
// 📊 in the chat header: the live breakdown in a popover, with a button to pin a snapshot into the chat.
function toggleUsage(c) {
  const head = $('.chat-head', c.el.root), pop = $('.usage-pop', head);
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.innerHTML = usageHTML(chatUsage(c)) + '<div class="uc-acts"><button type="button" class="ghost uc-pin">📌 Post in this chat</button></div>';
  pop.hidden = false;
  $('.uc-pin', pop).onclick = () => { pop.hidden = true; postUsage(c); };
  const outside = (e) => { if (!head.contains(e.target)) { pop.hidden = true; document.removeEventListener('pointerdown', outside, true); } };
  document.addEventListener('pointerdown', outside, true);
}
// /usage: a usage card in the conversation. It is the user's note: never part of the agent's history.
function postUsage(c) {
  const m = { role: 'usage', at: Date.now(), usage: chatUsage(c) };
  c.agent.messages.push(m);
  const box = c.el && $('.msgs', c.el.root);
  if (box) { box.querySelector('.hint')?.remove(); box.appendChild(renderMsg(c, m)); c.follow = true; c.toEnd?.(); }
  saveChat(c);
}
// ---------- /review: a reviewer model reads what changed and reports bugs as a card ----------
// The card is the user's (never part of the agent's history); "Send to fix" sends the ticked findings as a message.
const CR_SCOPES = ['reply', 'changes', 'branch'];
async function codeReview(c, arg = '', { auto = false, runId = '' } = {}) {
  if (c.running && !auto) return uiAlert('This chat is still working. Run /review when the reply has finished.');
  const [first = '', ...rest] = String(arg).trim().split(/\s+/);
  const scope = CR_SCOPES.includes(first.toLowerCase()) ? first.toLowerCase() : 'auto';
  const tail = (scope === 'auto' ? [first, ...rest] : rest).join(' ').trim();
  const base = scope === 'branch' && /^[\w./-]+$/.test(tail) ? tail : '';
  const ask = base ? '' : tail;
  const last = runId || [...c.agent.messages].reverse().find((x) => x.role === 'assistant' && x.stats?.changed?.length && !x.undone)?.runId || '';
  const m = { role: 'codereview', at: Date.now(), pending: true, scope, auto };
  c.agent.messages.push(m);
  const box = c.el && $('.msgs', c.el.root);
  if (box) { box.querySelector('.hint')?.remove(); box.appendChild(renderMsg(c, m)); c.follow = true; c.toEnd?.(); }
  const r = await postJ('/api/code-review', { projectId: c.projectId, chatId: c.id, scope, runId: scope === 'auto' || scope === 'reply' ? last : '', base, ask, chatModel: c.agent.setup.model, reviewModel: G.settings.reviewModel || '', reviewTier: G.settings.reviewTier || 'cheap' }).catch((e) => ({ error: e.message }));
  m.pending = false;
  if (!r || r.error) { m.error = r?.error || 'No answer from QuorX.'; m.empty = !!r?.empty; }
  else {
    Object.assign(m, { label: r.label, scope: r.scope, files: r.files, cut: r.cut, skipped: r.skipped, secretFiles: r.secretFiles || [], redacted: r.redacted || 0, dropped: r.dropped, summary: r.summary, model: r.model, cost: r.cost, ms: r.ms, findings: r.findings.map((x) => ({ ...x, pick: x.severity !== 'minor' })) });
    if (r.cost) (c.agent.extraUsage ||= []).push({ kind: 'codereview', model: r.model, cost: r.cost, at: Date.now(), runId: r.id });
  }
  // An automatic review that found nothing (or had nothing to read) leaves no card behind.
  if (auto && (m.error || !m.findings.length)) { c.agent.messages = c.agent.messages.filter((x) => x !== m); m.el?.remove(); }
  else if (m.el) m.el.replaceWith(renderMsg(c, m));
  saveChat(c);
}
const SEV_INFO = { breaks: 'Breaks: a crash, a wrong result or lost data', annoying: 'Annoying: wrong in some cases, or an error a user will hit', minor: 'Minor: worth a look' };
function codeReviewHTML(m) {
  const n = m.files?.length || 0;
  const head = `<div class="cr-head"><b>🔎 Code review</b>${m.label ? `<span class="cr-scope">${esc(m.label)} · ${n} file${n === 1 ? '' : 's'}</span>` : ''}${m.auto ? '<span class="cr-auto" title="Run after a reply that changed code (⚙ Settings → Agent loop → Reviewer)">auto</span>' : ''}${m.model ? `<span class="cr-by" title="${esc(m.model)}">${esc(short(m.model))}${m.ms ? ` · ${secs(m.ms)}` : ''}</span>` : ''}${m.cost ? `<span class="cost cr-cost" title="What this review cost">${money(m.cost, 4)}</span>` : ''}</div>`;
  if (m.pending) return `<div class="cr-card">${head}<div class="cr-wait">Reading the changes…</div></div>`;
  if (m.error) return `<div class="cr-card">${head}<div class="cr-${m.empty ? 'none' : 'err'}">${esc(m.error)}</div></div>`;
  const notes = [m.secretFiles?.length ? `Not sent to the reviewer: ${m.secretFiles.slice(0, 4).join(', ')}${m.secretFiles.length > 4 ? ` +${m.secretFiles.length - 4}` : ''} (looks like a secrets file).` : '', m.redacted ? `${m.redacted} key${m.redacted > 1 ? 's or tokens were' : ' or token was'} removed from the code before it was sent.` : '', m.cut ? 'The diff was cut to fit the reviewer\'s context.' : '', m.skipped ? `${m.skipped} generated or lock file${m.skipped > 1 ? 's' : ''} skipped.` : '', m.dropped ? `${m.dropped} finding${m.dropped > 1 ? 's' : ''} about files that did not change ${m.dropped > 1 ? 'were' : 'was'} dropped.` : ''].filter(Boolean).join(' ');
  if (!m.findings.length) return `<div class="cr-card">${head}<div class="cr-none">✓ No bugs found.${m.summary ? ` ${esc(m.summary)}` : ''}</div>${notes ? `<div class="cr-note">${esc(notes)}</div>` : ''}</div>`;
  const picked = m.findings.filter((x) => x.pick).length;
  return `<div class="cr-card">${head}${m.summary ? `<div class="cr-sum">${esc(m.summary)}</div>` : ''}<ol class="cr-list">${m.findings.map((x, i) => `<li class="cr-item sev-${x.severity}">
      <label class="sq-check cr-pick" title="Include this one when sending to the agent"><input type="checkbox" data-i="${i}" ${x.pick ? 'checked' : ''} ${m.sent ? 'disabled' : ''}></label>
      <div class="cr-main"><div class="cr-top"><span class="cr-sev sev-${x.severity}" title="${esc(SEV_INFO[x.severity])}">${x.severity}</span><button type="button" class="cr-loc" data-i="${i}" title="Open ${esc(x.file)} in the Files tab">${esc(x.file)}${x.line ? `:${x.line}` : ''}</button>${x.title ? `<b class="cr-title">${esc(x.title)}</b>` : ''}</div>
      <div class="cr-why">${esc(x.why)}</div>${x.fix ? `<div class="cr-fix"><span>Fix</span> ${esc(x.fix)}</div>` : ''}</div></li>`).join('')}</ol>
    ${notes ? `<div class="cr-note">${esc(notes)}</div>` : ''}
    <div class="cr-acts">${m.sent ? '<span class="cr-sent">✓ Sent to the agent</span>' : `<button type="button" class="primary cr-send" ${picked ? '' : 'disabled'}>Send ${picked} to the agent to fix</button>`}</div></div>`;
}
function crFixText(m, picked) {
  return `Please fix these bugs found by a code review of ${m.label}:\n${picked.map((x) => `- ${x.file}${x.line ? `:${x.line}` : ''} [${x.severity}] ${x.title ? `${x.title}: ` : ''}${x.why}${x.fix ? ` Fix: ${x.fix}` : ''}`).join('\n')}\nCheck each one in the code first; if one is not a real bug, say so instead of changing it.`;
}
function wireCodeReview(c, m, el) {
  $('.uc-x', el).onclick = () => { c.agent.messages = c.agent.messages.filter((x) => x !== m); el.remove(); saveChat(c); };
  for (const b of el.querySelectorAll('.cr-loc')) b.onclick = () => openProjectFile(c, m.findings[Number(b.dataset.i)].file);
  for (const cb of el.querySelectorAll('.cr-pick input')) cb.onchange = () => {
    m.findings[Number(cb.dataset.i)].pick = cb.checked; saveChat(c);
    const n = m.findings.filter((x) => x.pick).length, send = $('.cr-send', el);
    if (send) { send.disabled = !n; send.textContent = `Send ${n} to the agent to fix`; }
  };
  const send = $('.cr-send', el);
  if (send) send.onclick = () => {
    if (c.running) return uiAlert('This chat is still working. Send these when the reply has finished.');
    const picked = m.findings.filter((x) => x.pick);
    if (!picked.length) return;
    m.sent = true; saveChat(c);
    el.replaceWith(renderMsg(c, m));
    runChat(c, crFixText(m, picked), null, []);
  };
}
// Reasoning effort: a menu in the app's own style (not the system dropdown), aware of what the model supports.
const REASON_INFO = { off: ['Off', 'Answers straight away. Fastest and cheapest.'], low: ['Low', 'A little thinking before answering.'], medium: ['Medium', 'Thinks through multi-step work.'], high: ['High', 'Thinks longest. Slowest and costs the most.'], default: ['Model default', 'Whatever the model does by default.'] };
// Creativity (per chat): how varied the answers are. "Default" sends no temperature, so each model uses its own.
const CREATIVITY_INFO = { default: ['Default', "The model's own setting. Right for most work."], focused: ['Focused', 'Steadier, more predictable answers. Good for fixes and data.'], creative: ['Creative', 'More varied ideas. Good for games, designs and writing.'] };
// Wires every dropdown in the message box (Reasoning, Creativity); each sets its own key on the chat's setup.
// Reasoning and creativity as small level meters: an icon, then one step per option (lit up to the chosen one).
// A for "model default". The option's name and what it does show on hover.
const LVL_REASON = ['off', 'low', 'medium', 'high'], LVL_CREATIVE = ['focused', 'default', 'creative'];
function levelsHTML(s) {
  const m = G.byId.get(s.model), na = m && m.kind === 'chat' && m.reasoning === false, rv = s.reasoning || 'off';
  const cv = CREATIVITY_INFO[s.creativity] ? s.creativity : 'default';
  const noTemp = m && m.kind === 'chat' && m.temp === false;
  const step = (key, info, v, i, lit, on, extra = '') => `<button type="button" class="lvl-b ${lit ? 'lit' : ''} ${on ? 'on' : ''}" role="radio" aria-checked="${on}" data-v="${v}" title="${esc(`${key}: ${info[v][0]}${on ? ' (now)' : ''}\n${info[v][1]}${extra}`)}" aria-label="${key}: ${info[v][0]}"><i style="--h:${i}"></i></button>`;
  const ri = LVL_REASON.indexOf(rv), ci = LVL_CREATIVE.indexOf(cv);
  const rNote = na ? '\nThis model has no reasoning setting; it applies if you switch to one that does.' : '';
  const cNote = noTemp ? '\nThis model has no temperature setting, so this has no effect on it.' : '';
  return `<div class="lvl lvl-reason ${na ? 'na' : ''}" role="radiogroup" aria-label="Reasoning" data-key="reasoning"><span class="lvl-ico" title="Reasoning: how much the model thinks before answering" aria-hidden="true">🧠</span><button type="button" class="lvl-b lvl-auto ${rv === 'default' ? 'on' : ''}" role="radio" aria-checked="${rv === 'default'}" data-v="default" title="${esc(`Reasoning: Model default${rv === 'default' ? ' (now)' : ''}\n${REASON_INFO.default[1]}${rNote}`)}" aria-label="Reasoning: model default">A</button>${LVL_REASON.map((v, i) => step('Reasoning', REASON_INFO, v, i, ri >= 0 && i <= ri && rv !== 'off', v === rv, rNote)).join('')}</div>`
    + `<div class="lvl lvl-creative ${noTemp ? 'na' : ''}" role="radiogroup" aria-label="Creativity" data-key="creativity"><span class="lvl-ico" title="Creativity: how varied the answers are" aria-hidden="true">🎨</span>${LVL_CREATIVE.map((v, i) => step('Creativity', CREATIVITY_INFO, v, i + 1, i <= ci, v === cv, cNote)).join('')}</div>`;
}
// Every tool as one icon toggle (lit when on); the name, what it does and its price show on hover.
function quickToolsHTML(c) {
  const t = { ...DEFAULT_CHAT_TOOLS, ...c.tools };
  const btn = (k, icon, name, lines, on, paid) => `<button type="button" class="qt-b ${on ? 'on' : ''} ${paid ? 'paid' : ''}" data-k="${k}" aria-pressed="${on}" aria-label="${esc(name)}" title="${esc([`${name}: ${on ? 'on' : 'off'}`, ...lines, on ? 'Click to turn it off' : 'Click to turn it on'].join('\n'))}">${icon}</button>`;
  const q = QUALITY_TOOLS.map((k) => { const x = QUALITY_INFO[k]; return btn(k, x.icon, x.name, [x.note, `Cost\t${x.perBuild()}`], !!t[k]); }).join('');
  const media = CHAT_TOOLS.map((k) => { const [, label, note] = CATS.find((x) => x[0] === k); const icon = label.split(' ')[0], name = label.slice(icon.length + 1); return btn(k, icon, name, [note.replace(/^paid;?\s*/, '') || 'Costs money per use', `Model\t${short(G.settings.tools[k]?.models?.[0] || '')}`, 'Paid: stops at the paid media budget'], !!t[k], true); }).join('');
  const micOn = G.settings.tools.listen?.on !== false;
  const mic = btn('listen', '🎤', 'Mic · speech to text', ['Turns what you say into text in the message box', 'All chats; off hides the mic button'], micOn);
  return `<span class="qt-group">${q}</span><span class="qt-sep" aria-hidden="true"></span><span class="qt-group">${media}</span><span class="qt-sep" aria-hidden="true"></span><span class="qt-group">${mic}</span>`;
}
// The quality tools for one reply: on/off from this chat's 🧰, models and strength from ⚙ Settings.
function qualitySettings(c) {
  const t = { ...DEFAULT_CHAT_TOOLS, ...c.tools };
  return {
    review: t.reviewer ? (G.settings.review && G.settings.review !== 'off' ? G.settings.review : 'builds') : 'off',
    freshEyes: t.freshEyes !== false,
    enhancer: t.enhancer !== false,
    deciders: !!t.deciders,
    helpers: !!t.helpers,
  };
}
// The tool settings for one chat: models come from ⚙ Settings, on/off from this chat's 🧰 Tools menu.
function chatTools(c) {
  const T = structuredClone(G.settings.tools);
  T.artifacts = { ...(T.artifacts || {}), on: true };
  T.browser = { ...(T.browser || {}), on: true };
  for (const k of CHAT_TOOLS) if (T[k]) T[k].on = !!c.tools[k];
  return T;
}
// One 🧰 Tools button per chat; its menu switches tools on or off for that chat only.
function renderChatTools(c) {
  if (!c.el) return;
  const box = $('.toolbar', c.el.root);
  const T = G.settings.tools;
  const on = CHAT_TOOLS.filter((k) => c.tools[k]);
  const qOff = QUALITY_TOOLS.filter((k) => c.tools[k] === false);
  const label = (k) => CATS.find((x) => x[0] === k)[1];
  box.innerHTML = `<button type="button" class="tools-btn cmp-tools-btn ${on.length ? 'has' : ''}" aria-haspopup="true" aria-expanded="false" title="Choose which tools this chat may use, and what it may spend on checking its work">🧰 Tools <span class="tools-summary">${on.length ? on.map((k) => label(k).split(' ')[0]).join(' ') : 'media off'}${qOff.length ? ` · ${qOff.map((k) => QUALITY_INFO[k].name.toLowerCase()).join(', ')} off` : ''}</span></button>
    <div class="tools-menu cmp-tools-popover" role="menu" hidden>
      <div class="cmp-tp-header"><span class="cmp-tp-title">Tools for this chat</span><span class="cmp-tp-subtitle">Pages, code &amp; servers and the browser are always on.</span></div>
      <div class="cmp-tp-group">Checking the work <span>· hover a row for what it adds</span></div>
      <div class="cmp-tp-list">
      ${QUALITY_TOOLS.map((k) => {
        const q = QUALITY_INFO[k], m = q.model(), onq = c.tools[k] !== false;
        return `<label class="cmp-tp-row q-row" role="menuitemcheckbox" aria-checked="${onq}" title="${esc(q.tip)}">
          <span class="switch"><input type="checkbox" data-qtool="${k}" ${onq ? 'checked' : ''}><span class="slider"></span></span>
          <span class="cmp-tp-info"><span class="cmp-tp-top"><span class="cmp-tp-name">${q.icon} ${q.name} <span class="q-cost" title="${esc(q.perBuild())}">${esc(q.perBuild().replace(/\s+(a build|a look|a check|a request|when used|each|per \w+).*$/i, ''))}</span></span><button type="button" class="cmp-tp-model q-pick" data-q="${k}" title="${esc(m)} · ${esc(priceOf(m))} (all chats)">${recDot(m, q.kind)} ${esc(short(m))} <small>${esc(shortPrice(m))}</small> <i>▾</i></button></span>
          <span class="cmp-tp-note"><span class="cmp-tp-ntext">${esc(q.note)}</span>${k === 'enhancer' ? `<span class="q-tier" role="group" aria-label="When the prompt enhancer reads">${[['first', 'First', 'First message: reads a chat\'s first message; later replies reuse that reading'], ['every', 'Every', 'Every message: reads each new message (under $0.0001 each)']].map(([v, l, tip]) => `<button type="button" class="q-when-btn ${(G.settings.enhancerWhen || 'first') === v ? 'on' : ''}" data-when="${v}" title="${tip}">${l}</button>`).join('')}</span>` : ''}${k === 'reviewer' || k === 'freshEyes' ? `<span class="q-tier" role="group" aria-label="${q.name} strength">${[['cheap', 'Cheap'], ['strong', 'Strong']].map(([v, l]) => { const tierKey = k === 'reviewer' ? 'reviewTier' : 'freshEyesTier', modelKey = k === 'reviewer' ? 'reviewModel' : 'freshEyesModel'; return `<button type="button" class="q-tier-btn ${!G.settings[modelKey] && (G.settings[tierKey] || 'cheap') === v ? 'on' : ''}" data-q="${k}" data-tier="${v}" title="${v === 'cheap' ? (k === 'reviewer' ? 'gpt-6-luna: about $0.003 a build' : 'the helper model: fast, about $0.001 a look') : 'Claude Sonnet 5.5: stronger, about $0.01–0.02'}">${l}</button>`; }).join('')}</span>` : ''}</span></span></label>`;
      }).join('')}
      </div>
      <div class="cmp-tp-group">Paid media</div>
      <div class="cmp-tp-list">
      ${CHAT_TOOLS.map((k) => {
        const t = T[k] || {}, model = t.models?.length ? (t.pick === 'agent' && t.models.length > 1 ? `agent picks of ${t.models.length}` : short(t.models[0])) : '';
        const note = CATS.find((x) => x[0] === k)[2], paid = /^paid/.test(note);
        return `<label class="cmp-tp-row" role="menuitemcheckbox" aria-checked="${!!c.tools[k]}">
          <span class="switch"><input type="checkbox" data-tool="${k}" ${c.tools[k] ? 'checked' : ''}><span class="slider"></span></span>
          <span class="cmp-tp-info"><span class="cmp-tp-top"><span class="cmp-tp-name">${label(k)}${paid ? ' <span class="paid-badge">paid</span>' : ''}</span><button type="button" class="cmp-tp-model tm-pick" data-k="${k}" title="${esc((t.models || []).join(', ') || 'Choose a model')}">${t.models?.[0] && !(t.pick === 'agent' && t.models.length > 1) ? `${recDot(t.models[0], k)} ` : ''}${esc(model || 'choose')} <i>▾</i></button></span>
          <span class="cmp-tp-note"><span class="cmp-tp-ntext">${esc(note.replace(/^paid;?\s*/, '') || 'costs money per use')}</span></span></span></label>`;
      }).join('')}
        <label class="cmp-tp-row tm-mic" role="menuitemcheckbox" aria-checked="${T.listen?.on !== false}">
          <span class="switch"><input type="checkbox" class="tm-mic-on" ${T.listen?.on !== false ? 'checked' : ''}><span class="slider"></span></span>
          <span class="cmp-tp-info"><span class="cmp-tp-top"><span class="cmp-tp-name">Mic · speech to text</span><button type="button" class="cmp-tp-model tm-pick" data-k="listen" title="${esc((T.listen?.models || []).join(', '))}">${esc(short(T.listen?.models?.[0] || '') || 'choose')} <i>▾</i></button></span>
          <span class="cmp-tp-note">Turns what you say into text in the message box (the mic button). All chats; off hides the button.</span></span>
        </label>
      </div>
      <div class="cmp-tp-foot"><button type="button" class="cmp-tp-settings-link tm-settings">Models and prices in ⚙ Settings →</button></div>
    </div>`;
  const btn = $('.tools-btn', box), menu = $('.tools-menu', box);
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!box.contains(e.target) && !$('#picker').open) close(); };
  btn.onclick = () => { const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) document.addEventListener('pointerdown', outside, true); else close(); };
  if (box.closest('.chat-set')) { btn.hidden = true; menu.hidden = false; btn.onclick = () => {}; }
  for (const cb of menu.querySelectorAll('input[data-tool]')) cb.onchange = () => { c.tools[cb.dataset.tool] = cb.checked; saveChat(c); const keep = !menu.hidden; renderChatTools(c); if (keep) $('.tools-btn', box).click(); };
  // The quality tools: on/off for this chat; their models and the reviewer's strength apply to all chats.
  const reopen = () => { const keep = !menu.hidden; renderToolbars(); if (keep) $('.tools-btn', $('.toolbar', c.el.root))?.click(); };
  for (const cb of menu.querySelectorAll('input[data-qtool]')) cb.onchange = () => { c.tools[cb.dataset.qtool] = cb.checked; saveChat(c); reopen(); };
  for (const b of menu.querySelectorAll('.q-when-btn')) b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); G.settings.enhancerWhen = b.dataset.when; savePrefs(); reopen(); };
  for (const b of menu.querySelectorAll('.q-tier-btn')) b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (b.dataset.q === 'freshEyes') { G.settings.freshEyesTier = b.dataset.tier; G.settings.freshEyesModel = ''; } else { G.settings.reviewTier = b.dataset.tier; G.settings.reviewModel = ''; } savePrefs(); reopen(); };
  for (const b of menu.querySelectorAll('.q-pick')) b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const k = b.dataset.q, q = QUALITY_INFO[k];
    const id = await pickModel(q.kind, q.model(), { context: k === 'enhancer' ? 'Prompt enhancer (all chats): a fast, cheap model is enough' : k === 'freshEyes' ? 'Fresh eyes (all chats): it must use tools' : k === 'reviewer' ? 'Reviewer (all chats): it must use tools and see images' : k === 'deciders' ? 'Decider for screenshot checks (all chats): it must read images' : 'Helper model (all chats): it must use tools' });
    if (id) { if (k === 'enhancer') G.settings.enhancerModel = id; else if (k === 'reviewer') G.settings.reviewModel = id; else if (k === 'freshEyes') G.settings.freshEyesModel = id; else if (k === 'helpers') G.settings.helperModel = id; else G.settings.lookVoters = [id]; savePrefs(); }
    reopen();
  };
  $('.tm-settings', menu).onclick = () => { close(); openSettings(); };
  // The mic is for every chat: off hides its button in each message box.
  $('.tm-mic-on', menu).onchange = (e) => { (G.settings.tools.listen ??= {}).on = e.target.checked; savePrefs(); const keep = !menu.hidden; renderToolbars(); if (keep) $('.tools-btn', $('.toolbar', c.el.root))?.click(); };
  // Pick a tool's model right here: it becomes model 1 for that tool (the others stay as alternatives).
  for (const b of menu.querySelectorAll('.tm-pick')) b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const k = b.dataset.k, t = G.settings.tools[k];
    const id = await pickModel(k, t.models?.[0], { context: `${CATS.find((x) => x[0] === k)?.[1] || k} · model 1 (all chats)` });
    if (id) { t.models = [id, ...(t.models || []).filter((m) => m !== id)].slice(0, 3); savePrefs(); renderToolbars(); }
    $('.tools-btn', $('.toolbar', c.el.root))?.click();
  };
}
// Refresh every open chat's 🧰 Tools button (models may have changed in Settings).
function renderToolbars() {
  for (const c of G.open.values()) renderChatTools(c);
  for (const b of document.querySelectorAll('.chatpane .micBtn')) { const off = G.settings.tools.listen?.on === false; b.hidden = off; b.disabled = off; }
}
// Tools this chat's agent may use without asking (strict mode); click one to take the permission back.
// "Always allowed" tools are part of this chat's permissions, so they live with 🔒 Strict / ⚡ YOLO in the
// message box: a small 🔓 control that lists them and lets you take any back. Nothing sits in the conversation.
function renderAllowed(c) {
  const bar = c.el && $('.cbar', c.el.root);
  if (!bar) return;
  bar.querySelector('.allow-wrap')?.remove();
  const list = c.agent.allowed;
  if (!list.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'allow-wrap';
  wrap.innerHTML = `<button type="button" class="allow-btn" aria-haspopup="true" aria-expanded="false" title="Tools this chat may use without asking (in 🔒 Strict)">🔓 ${list.length} allowed</button>
    <div class="allow-pop" role="dialog" aria-label="Always allowed in this chat" hidden>
      <div class="ap-head">Allowed without asking <small>in this chat, while 🔒 Strict is on</small></div>
      ${list.map((t) => `<div class="ap-row"><span>${esc(TOOL_NAME[t] || t)}</span><button type="button" class="ap-x" data-t="${esc(t)}" title="Ask again before ${esc(TOOL_NAME[t] || t)}">Ask again</button></div>`).join('')}
      <div class="ap-foot"><button type="button" class="ap-all">Ask again for all</button></div>
    </div>`;
  const perm = bar.querySelector('.perm');
  perm ? perm.after(wrap) : bar.appendChild(wrap);
  const btn = $('.allow-btn', wrap), pop = $('.allow-pop', wrap);
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  btn.onclick = () => { if (!pop.hidden) return close(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); document.addEventListener('pointerdown', outside, true); };
  const update = (keep) => { saveChat(c); renderAllowed(c); if (keep && c.agent.allowed.length) $('.cbar .allow-btn', c.el.root).click(); };
  for (const b of pop.querySelectorAll('.ap-x')) b.onclick = () => { c.agent.allowed = c.agent.allowed.filter((t) => t !== b.dataset.t); update(true); };
  $('.ap-all', pop).onclick = () => { c.agent.allowed = []; update(false); };
}
function syncRunState(c) {
  if (!c.el) return;
  const busy = !!c.running;
  $('.sendBtn', c.el.root).disabled = false; // while busy, Send passes a note to the agent
  $('.sendBtn', c.el.root).title = busy ? 'Send a note to the agent: it reads it at its next step and carries on' : 'Send';
  const ta = $('.input', c.el.root);
  if (ta) { ta.dataset.idle ??= ta.placeholder; ta.placeholder = busy ? 'Message the agent while it works: a correction, a question, "use YOLO"…' : ta.dataset.idle; }
  $('.stopBtn', c.el.root).hidden = !busy;
  c.el.root.classList.toggle('busy', busy);
  renderChatHead(c);
}

// ---------- messages ----------
function renderMsg(c, m) {
  const el = document.createElement('div');
  m.el = el;
  if (m.role === 'user') {
    el.className = 'msg user';
    el.innerHTML = `${m.scheduled ? `<div class="u-sched" title="${m.scheduled.missed ? 'QuorX was closed or the computer slept at the planned time, so this ran when it was back' : 'Started by a schedule'}">⏰ ${m.scheduled.missed ? 'Missed run, started late' : 'Scheduled'}: ${esc(m.scheduled.name)}</div>` : ''}<div class="utext"></div>${m.imgs?.length ? `<div class="u-imgs" data-views="${esc(JSON.stringify(m.imgViews || []))}">${m.imgs.map((u, k) => `<img src="${u}" alt="attached picture" data-k="${k}" title="Click to see it large">`).join('')}</div>` : ''}${m.docs?.length ? `<div class="u-docs">${m.docs.map((d) => `<button type="button" class="u-doc" data-doc="${esc(JSON.stringify(d))}" title="${esc(d.name)} · ${esc(docSize(d.size))} · click to preview">${DOC_ICON[d.kind] || '📄'} ${esc(d.name)}</button>`).join('')}</div>` : ''}${m.ctx?.length ? `<div class="ctx-used">${m.ctx.map((t) => `<span>📎 ${esc(t)}</span>`).join('')}</div>` : ''}${m.cmts?.length ? `<div class="ctx-used cmts-used">${m.cmts.map((x) => `<span title="${esc(x.selector)}">💬 ${esc(x.tag)} "${esc(clip(x.text || '', 40))}"${x.note ? `: ${esc(clip(x.note, 60))}` : ''}</span>`).join('')}</div>` : ''}${m.at ? timeTag(m.at) : ''}`;
    $('.utext', el).innerHTML = md(m.content);
    enhance($('.utext', el));
    el.insertAdjacentHTML('beforeend', '<div class="u-reading-slot"></div>');
    drawReading(c, m);
    el.insertAdjacentHTML('beforeend', `<div class="msg-tools u-tools"><button type="button" class="mt-btn mt-rewind" title="Rewind to here: this message and everything after it leave the chat, and it goes back in the box to edit. You choose whether file changes are undone too." aria-label="Rewind to here">${msgIcon('rewind')}</button><button type="button" class="mt-btn mt-copy" title="Copy this message" aria-label="Copy message">${msgIcon('copy')}</button></div>`);
    wireIconCopy($('.mt-copy', el), () => m.content);
    $('.mt-rewind', el).onclick = () => rewindTo(c, m);
    return el;
  }
  if (m.role === 'usage') {
    el.className = 'msg usage';
    el.innerHTML = `${usageHTML(m.usage, m.at)}<button type="button" class="ghost uc-x" title="Remove this card">✕</button>`;
    $('.uc-x', el).onclick = () => { c.agent.messages = c.agent.messages.filter((x) => x !== m); el.remove(); saveChat(c); };
    return el;
  }
  if (m.role === 'codereview') {
    el.className = 'msg usage codereview';
    el.innerHTML = `${codeReviewHTML(m)}<button type="button" class="ghost uc-x" title="Remove this card">✕</button>`;
    wireCodeReview(c, m, el);
    return el;
  }
  el.className = 'msg bot';
  el.innerHTML = `<div class="reply-head"></div><div class="plan-slot"></div><div class="timeline"></div><details class="thinking" hidden><summary></summary><div class="think-body"></div></details><div class="body"></div><div class="approvals"></div><button type="button" class="trace-btn mt-btn" title="Open this reply's steps in the side pane" aria-label="Steps"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg></button><div class="foot"></div>`;
  // Only your own clicks decide whether the thinking stays open; otherwise it opens while thinking and folds after.
  $('.thinking > summary', el).addEventListener('click', () => { m.thinkOpen = !$('.thinking', el).open; });
  updateMsg(c, m);
  return el;
}
// ---------- 📝 the prompt enhancer's reading, under the message it read: correct it or drop it ----------
function drawReading(c, m) {
  const slot = m.el && $('.u-reading-slot', m.el), r = m.reading;
  if (!slot) return;
  if (!r) { slot.innerHTML = ''; return; }
  const a = c.agent, latest = a.messages.filter((x) => x.role === 'user' && x.reading).at(-1) === m;
  const push = (text) => { if (c.running?.runId) postJ(`/api/runs/${c.running.runId}/reading`, { text }).catch(() => {}); };
  if (r.removed) {
    slot.innerHTML = `<div class="u-reading off"><span>📝 Reading dropped: the agent and the deciders go by your words only.</span>${latest ? '<button type="button" class="rd-restore">↺ Use it again</button>' : ''}</div>`;
    const rs = $('.rd-restore', slot);
    if (rs) rs.onclick = () => { r.removed = false; a.reading = { text: r.text, at: Date.now() }; push(r.text); saveChat(c); drawReading(c, m); };
    return;
  }
  if (r.editing) {
    slot.innerHTML = `<div class="u-reading editing"><div class="rd-label">📝 How to read your request <small>The agent builds to this, and the deciders read it beside your message.</small></div>
      <textarea class="rd-text" rows="${Math.min(14, r.text.split('\n').length + 2)}" spellcheck="true">${esc(r.text)}</textarea>
      <div class="acts"><button type="button" class="primary rd-save">Save</button><button type="button" class="rd-cancel">Cancel</button></div></div>`;
    const ta = $('.rd-text', slot); ta.focus();
    $('.rd-cancel', slot).onclick = () => { r.editing = false; drawReading(c, m); };
    $('.rd-save', slot).onclick = () => {
      const text = ta.value.trim();
      r.editing = false;
      if (!text) { r.removed = true; a.reading = null; push(''); } else { r.text = text; r.edited = true; a.reading = { text, at: Date.now(), edited: true }; push(text); }
      saveChat(c); drawReading(c, m);
    };
    return;
  }
  const brief = r.edited ? 'your corrected reading' : r.includes.length ? `implies ${r.includes.slice(0, 3).map((x) => clip(x, 40)).join(', ')}${r.includes.length > 3 ? `, +${r.includes.length - 3} more` : ''}` : 'nothing beyond what you wrote';
  slot.innerHTML = `<details class="u-reading"><summary><span class="rd-sum">📝 Read as<span class="rd-brief">: ${esc(brief)}</span></span>${latest ? '<span class="rd-acts"><button type="button" class="rd-edit" title="Correct how your request is read: the agent and the deciders use your version">✎</button><button type="button" class="rd-drop" title="Don\'t use this reading: go by your words only">✕</button></span>' : ''}</summary>
    <div class="rd-body">${r.edited ? `<div class="rd-plain">${esc(r.text)}</div>` : `<div class="rd-goal"><b>Goal</b> ${esc(r.goal)}</div>${r.includes.length ? `<div class="rd-h">Implied, though unsaid</div><ul>${r.includes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${r.assumptions.length ? `<div class="rd-h">Assumed (defaults)</div><ul class="rd-assumed">${r.assumptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`}
    <div class="rd-by">${r.edited ? 'Corrected by you' : `By ${esc(short(r.model || ''))}${r.cost ? ` · ${money(r.cost, 5)}` : ''}`} · the agent builds to this; in YOLO the deciders read it before approving paid tools</div></div></details>`;
  const ed = $('.rd-edit', slot), dr = $('.rd-drop', slot);
  if (ed) ed.onclick = (e) => { e.preventDefault(); r.editing = true; drawReading(c, m); };
  if (dr) dr.onclick = (e) => { e.preventDefault(); r.removed = true; a.reading = null; push(''); saveChat(c); drawReading(c, m); };
}
// The model's thinking, shown above the reply: open while it thinks, folded once it answers.
function drawThinking(m) {
  const box = $('.thinking', m.el); if (!box) return;
  const tl = $('.timeline', m.el);
  if (tl) { box.hidden = true; liveThinking(m, tl); return; }
  const parts = Object.entries(m.thinking || {}).filter(([, t]) => t.trim());
  box.hidden = !parts.length;
  if (!parts.length) return;
  const text = parts.map(([, t]) => t.trim()).join('\n\n---\n\n');
  const words = text.split(/\s+/).filter(Boolean).length;
  const thinkingNow = m.live && !String(m.content || '').trim();
  $('summary', box).innerHTML = thinkingNow ? `💭 <b>Thinking…</b> <small>${words} words</small>` : `💭 <b>Thought</b> <small>${words} words${parts.length > 1 ? ` · ${parts.length} steps` : ''}</small>`;
  const body = $('.think-body', box);
  box.open = m.thinkOpen ?? thinkingNow;
  // Long thinking is heavy to render: a folded box only updates its count (it draws when opened), and while the
  // model is still thinking only the newest part is drawn.
  if (!box.open) { body.dataset.stale = '1'; if (!box.dataset.lazy) { box.dataset.lazy = '1'; box.addEventListener('toggle', () => { if (box.open && body.dataset.stale) drawThinking(m); }); } return; }
  delete body.dataset.stale;
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  const TAIL = 12000;
  body.innerHTML = thinkingNow && text.length > TAIL ? `<p class="think-more">… ${(text.length - TAIL).toLocaleString()} earlier characters, shown in full when this step is done</p>${md(text.slice(-TAIL))}` : md(text);
  if (stick) body.scrollTop = body.scrollHeight;
}
// #3 The plan the agent made for this reply: a live checklist (newest version from the trace).
function planCardHTML(m) {
  const p = (m.trace || []).findLast((e) => e.t === 'plan');
  if (!p) return '';
  const done = p.items.filter((x) => x.status === 'done').length, pct = Math.round((done / p.items.length) * 100);
  const mark = { done: '✓', doing: '◐', todo: '○' };
  return `<div class="plan-card ${done === p.items.length ? 'complete' : ''}">
    <div class="pc-head"><b>🗺 Plan</b><span class="pc-count">${done} of ${p.items.length} done</span><span class="pc-bar" aria-hidden="true"><i style="width:${pct}%"></i></span></div>
    <ul class="pc-items">${p.items.map((x) => `<li class="${x.status}"><span class="pc-mark" aria-hidden="true">${mark[x.status] || '○'}</span><span>${esc(x.text)}</span>${x.status === 'doing' ? '<em>in progress</em>' : ''}</li>`).join('')}</ul>
    ${p.spec || p.doneWhen?.length ? `<details class="pc-spec"><summary>Spec${p.doneWhen?.length ? ' and done checks' : ''}</summary>${p.spec ? `<div class="pc-spec-body">${md(p.spec)}</div>` : ''}${p.doneWhen?.length ? `<div class="pc-dw"><b>Done when</b><ul>${p.doneWhen.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}</details>` : ''}
  </div>`;
}
// #4 What the separate reviewer found: scores out of 5, the bar, its bugs. One card per review round.
const REVIEW_LABEL = { function: 'Function', craft: 'Craft', design: 'Design', originality: 'Originality', accessibility: 'Accessibility', brand: 'Brand fit' };
function reviewCardHTML(m, r) {
  const tr = m.trace || [], reviews = tr.filter((e) => e.t === 'review'), i = reviews.indexOf(r);
  const sentBack = !r.pass && (i < reviews.length - 1 || tr.some((e) => e.t === 'sent_back' && e.by === 'reviewer' && e.at >= r.at));
  const verdict = r.pass ? 'Passed' : sentBack ? 'Sent back to fix' : 'Not passed';
  return `<div class="review-card ${r.pass ? 'pass' : 'fail'}">
      <div class="rv-head"><b>🧪 Reviewer</b><span class="rv-model" title="A separate model with a fresh context tested this">${esc(short(r.model))}</span><span class="rv-round">round ${r.round}</span><span class="rv-verdict">${verdict}</span><span class="rv-cost" title="What this review cost">${money(r.cost, 4)}</span></div>
      <div class="rv-scores">${Object.keys(r.scores).map((k) => `<div class="rv-score ${r.scores[k] < r.bar ? 'low' : ''}"><span>${esc(REVIEW_LABEL[k] || k)}</span><span class="rv-pips" aria-label="${r.scores[k]} of 5">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= r.scores[k] ? 'on' : ''}${n === r.bar ? ' bar' : ''}"></i>`).join('')}</span><b>${r.scores[k]}/5</b></div>`).join('')}</div>
      ${r.bugs.length ? `<ul class="rv-bugs">${r.bugs.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${r.summary ? `<p class="rv-sum">${esc(r.summary)}</p>` : ''}
    </div>`;
}
// A review that is still testing: shown where it started, until its result replaces it.
function reviewRunningHTML(m, start) {
  const tr = m.trace || [];
  if (!m.live || tr.findLast((e) => e.t === 'review_start' || e.t === 'review') !== start) return '';
  return `<div class="review-card running"><div class="rv-head"><b>🧪 Reviewer</b><span class="rv-model">${esc(short(start.model))}</span><span class="rv-verdict">testing ${esc(start.targets.join(', '))}…</span></div></div>`;
}
// ---------- the reply timeline ----------
// One-line descriptions of tool calls, in the user's terms: one call names its target, several are counted.
const TL_ONE = {
  read_file: (a) => `Read ${a.path}`, write_file: (a) => `Wrote ${a.path}`, append_file: (a) => `Added to ${a.path}`, edit_file: (a) => `Edited ${a.path}`,
  delete_file: (a) => `Deleted ${a.path}`, list_files: () => 'Listed the files', search_files: (a) => `Searched for "${clip(a.query || '', 40)}"`,
  run_command: (a) => `Ran ${clip([a.command, ...(a.args || [])].join(' '), 50)}`, start_server: (a) => `Started the "${a.name}" server`, stop_server: (a) => `Stopped the "${a.name}" server`, launch_config: (a) => a.action === 'save' ? `Saved the "${a.name}" server` : a.action === 'remove' ? `Removed the saved "${a.name}" server` : 'Listed the saved servers',
  preview_site: () => 'Opened the site preview', browser: (a) => (a.action === 'open' ? `Opened ${a.target}` : `Browser: ${a.action}${a.key ? ` ${a.key}` : ''}`),
  look: () => 'Checked the page with the judges', extract_design: (a) => `Read the look of ${clip(a.target || '', 50)}`, decide: (a) => `Asked the deciders ${a.questions?.length || ''} question${a.questions?.length === 1 ? '' : 's'}`.replace('  ', ' '),
  plan: () => 'Updated the plan', delegate: (a) => `Asked a helper: ${clip(a.task || '', 50)}`, imagine: () => 'Made a picture', make_video: () => 'Made a video',
  compose_music: () => 'Composed music', speak: () => 'Made a voice clip', write_artifact: (a) => `Wrote the page "${a.title || a.id}"`, edit_artifact: (a) => `Edited the page ${a.id}`,
  read_artifact: (a) => `Read the page ${a.id}`, use_skill: (a) => `Loaded the ${a.name} skill`, save_skill: (a) => `Saved the ${a.name} skill`, scaffold: (a) => `Used the ${a.template} template`,
  fetch_url: (a) => `Read ${clip(a.url || '', 50)}`, ask_user: () => 'Asked you a question', read_doc: (a) => `Read ${a.doc}`, search_docs: () => 'Searched the documents', list_docs: () => 'Listed the documents',
};
const TL_MANY = {
  read_file: (n) => `Read ${n} files`, write_file: (n) => `Wrote ${n} files`, append_file: (n) => `Added to ${n} files`, edit_file: (n) => `Made ${n} edits`,
  search_files: (n) => `Searched ${n} times`, run_command: (n) => `Ran ${n} commands`, browser: (n) => `Used the browser ${n} times`, look: (n) => `Checked the page ${n} times`,
  decide: (n) => `Asked the deciders ${n} times`, delegate: (n) => `Sent ${n} helpers`, imagine: (n) => `Made ${n} pictures`, plan: () => 'Updated the plan',
  read_artifact: (n) => `Read ${n} pages`, edit_artifact: (n) => `Made ${n} page edits`, read_doc: (n) => `Read ${n} documents`,
};
const tlName = (n) => (TOOL_NAME[n] || n).replace(/^\S+\s/, '');
function callsLabel(calls) {
  const groups = new Map();
  for (const x of calls) { if (!groups.has(x.e.name)) groups.set(x.e.name, []); groups.get(x.e.name).push(x); }
  const parts = [...groups].map(([name, xs]) => (xs.length === 1 ? (TL_ONE[name]?.(xs[0].e.args || {}) ?? tlName(name)) : (TL_MANY[name]?.(xs.length) ?? `${tlName(name)} ×${xs.length}`)));
  return parts.slice(0, 3).map((t, i) => (i ? t[0].toLowerCase() + t.slice(1) : t)).join(', ') + (parts.length > 3 ? ` and ${parts.length - 3} more` : '');
}
// Walks the trace once: steps (thinking, what the agent said, its tool calls with results), reviewer and helper work,
// and the cards and notes in between, all in the order they happened.
function timelineItems(m) {
  const tr = m.trace || [], items = [], helpers = new Map(), seenCards = new Set();
  let blk = null, rv = null;
  const newBlock = (step) => { blk = { kind: 'step', step, calls: [], aside: '', done: false }; items.push(blk); return blk; };
  for (let i = 0; i < tr.length; i++) {
    const e = tr[i];
    if (e.t === 'llm_start') { newBlock(e.step); continue; }
    if (e.t === 'llm_done') { if (blk && blk.step === e.step) { blk.done = true; blk.aside = e.aside || ''; } continue; }
    if (e.t === 'tool') {
      if (e.by === 'reviewer') { if (!rv) { rv = { kind: 'group', key: `rv${i}`, icon: '🧪', label: 'The reviewer tested it', calls: [] }; items.push(rv); } rv.calls.push({ e }); continue; }
      if (e.by === 'helper') {
        let h = helpers.get(e.helper);
        if (!h) { h = { kind: 'group', key: `hp${i}`, icon: '🤝', label: `Helper ${e.helper || ''} explored`, calls: [] }; helpers.set(e.helper, h); items.push(h); }
        h.calls.push({ e, res: '' }); continue;
      }
      (blk || newBlock(-1)).calls.push({ e }); continue;
    }
    if (e.t === 'tool_result') {
      const pool = e.by === 'reviewer' ? rv?.calls : blk?.calls;
      const x = pool && [...pool].reverse().find((y) => y.e.name === e.name && y.res == null);
      if (x) x.res = String(e.result ?? ''); continue;
    }
    if (e.t === 'review_start') { rv = null; items.push({ kind: 'card', pin: true, html: () => reviewRunningHTML(m, e) }); continue; }
    if (e.t === 'review') { items.push({ kind: 'card', pin: true, html: () => reviewCardHTML(m, e) }); continue; }
    // The plan shows where it was first made (just before its Go ahead question), with its latest ticks.
    if (e.t === 'plan') { if (!seenCards.has('plan')) { seenCards.add('plan'); items.push({ kind: 'card', pin: true, html: () => planCardHTML(m) }); } continue; }
    if (e.t === 'fresh_eyes') { items.push({ kind: 'note', text: `👀 Fresh eyes (${short(e.model)}) ${e.ok ? `on a problem that came back: ${clip((e.report || '').split('\n')[0].replace(/^Cause:\s*/i, ''), 220)}` : 'looked but found nothing'}` }); continue; }
    if (e.t === 'helper_done') { const h = helpers.get(e.id); if (h) { h.label = `Helper ${e.id} ${e.ok ? 'reported back' : 'gave no report'} · ${e.steps} step${e.steps === 1 ? '' : 's'} · ${money(e.cost, 4)}`; h.done = true; } continue; }
    if (e.t === 'approval') {
      // One card per approval: a YOLO vote that can't settle announces the same card again when it turns to you.
      if (seenCards.has(e.id)) continue;
      seenCards.add(e.id);
      // Waiting for you: a card where it happened. Answered (or being checked): a badge on the tool call it was about.
      const a = m.approvals?.[e.id], waiting = a && !a.outcome && a.card.mode === 'strict' && m.live;
      const pool = blk?.calls || [];
      const call = !waiting && a && ([...pool].reverse().find((y) => !y.approval && y.e.name === e.tool) || [...pool].reverse().find((y) => !y.approval));
      if (call) { call.approval = e.id; continue; }
      items.push({ kind: 'card', html: () => (m.approvals?.[e.id] ? approvalHTML(m.approvals[e.id], !!m.live) : '') }); continue;
    }
    // Questions stay in view where they were asked (answered ones are one line).
    if (e.t === 'question') { items.push({ kind: 'card', pin: true, html: () => (m.questions?.[e.id] ? questionHTML(m.questions[e.id], !!m.live) : '') }); continue; }
    if (e.t === 'budget_ask') { items.push({ kind: 'card', html: () => (m.budgetAsk ? budgetHTML(m.budgetAsk, !!m.live) : '') }); continue; }
    if (e.t === 'steer') { items.push({ kind: 'steer', e, read: tr.slice(i + 1).some((x) => x.t === 'steer_delivered') }); continue; }
    if (e.t === 'mode') { items.push({ kind: 'note', text: e.approval === 'yolo' ? '⚡ Switched to YOLO' : '🔒 Switched to Strict' }); continue; }
    if (e.t === 'note' && e.level === 'warn') { items.push({ kind: 'note', text: `⚠ ${e.msg}` }); continue; }
  }
  return items;
}
function timelineHTML(m) {
  const open = (m.tlOpen instanceof Set ? m.tlOpen : (m.tlOpen = new Set())); // chats saved before carry it as {}
  const det = (key, cls, summary, inner) => `<details class="${cls}" data-key="${key}" ${open.has(key) ? 'open' : ''}><summary>${summary}<span class="tl-chev" aria-hidden="true">›</span></summary>${inner}</details>`;
  const calls = (list, key) => list.map((x, i) => {
    const err = x.res != null && /^Error/.test(x.res);
    const ap = x.approval && m.approvals?.[x.approval], apB = ap ? approvalBadge(ap, !!m.live) : null;
    return det(`${key}-${i}`, 'tl-call', `<span class="tl-ic">${TOOL_NAME[x.e.name]?.split(' ')[0] || '🔧'}</span><b>${esc(x.e.name)}</b><span class="tl-arg">${esc(clip(argSummary(x.e), 160))}</span>${apB ? apB.badge : ''}${x.res == null && m.live ? '<span class="tl-spin" aria-label="running"></span>' : err ? '<span class="tl-err">error</span>' : ''}`,
      (apB ? apB.detail : '') + (x.res ? `<pre class="tl-out">${esc(clip(x.res, 4000))}</pre>` : '<div class="tl-out tl-none">No output.</div>'));
  }).join('');
  const groupRow = (key, icon, label, list, busy) => {
    const errs = list.filter((x) => x.res != null && /^Error/.test(x.res)).length;
    return det(key, 'tl-row tl-tools', `<span class="tl-ic">${icon}</span><span class="tl-label">${esc(label)}</span>${busy ? '<span class="tl-spin" aria-label="running"></span>' : ''}${errs ? `<span class="tl-err">${errs} error${errs > 1 ? 's' : ''}</span>` : ''}`, `<div class="tl-list">${calls(list, key)}</div>`);
  };
  // Each item becomes pieces: rows (a thinking line, a line of tool calls) or anything else (text, cards, notes).
  const pieces = [];
  const row = (html, key, calls = [], think = 0, busy = false) => pieces.push({ html, row: true, key, calls, think, busy });
  const other = (html) => { if (html) pieces.push({ html, row: false }); };
  const usedAtt = new Set(); // which note's attachments are drawn already (two notes can say the same thing)
  for (const it of timelineItems(m)) {
    if (it.kind === 'step') {
      const think = String(m.thinking?.[it.step] || '').trim();
      if (think) row(det(`t${it.step}`, 'tl-row tl-think', `<span class="tl-ic">💭</span><span class="tl-label">${!it.done && m.live ? 'Thinking' : 'Thought'}</span><small class="tl-words">${think.split(/\s+/).length.toLocaleString()} words</small>`, `<div class="tl-think-body" data-step="${it.step}">${open.has(`t${it.step}`) ? md(think) : ''}</div>`), `t${it.step}`, [], 1, !it.done && m.live);
      if (it.aside) other(`<div class="tl-text">${md(it.aside)}</div>`);
      if (it.calls.length) { const busy = m.live && it.calls.some((x) => x.res == null); row(groupRow(`x${it.step}`, TOOL_NAME[it.calls[0].e.name]?.split(' ')[0] || '🔧', callsLabel(it.calls), it.calls, busy), `x${it.step}`, it.calls, 0, busy); }
      if (!it.done && m.live && !think && !it.calls.length) other('<div class="tl-row tl-wait"><span class="tl-spin"></span><span class="tl-label">Working…</span></div>');
      continue;
    }
    if (it.kind === 'group') { const busy = m.live && !it.done && it.calls.some((x) => x.res == null); row(groupRow(it.key, it.icon, it.label, it.calls, busy), it.key, it.calls, 0, busy); continue; }
    if (it.kind === 'card') { const h = it.html(); if (h) pieces.push({ html: h, row: false, card: true, pin: !!it.pin }); continue; }
    if (it.kind === 'steer') {
      const att = (m.steerAtt || []).find((x) => x.text === it.e.text && !usedAtt.has(x)) || null;
      if (att) usedAtt.add(att);
      pieces.push({ row: false, card: true, html: `<div class="steer-card ${it.read ? 'read' : ''}"><span class="sc-who">You, while it worked</span><p>${esc(it.e.text)}</p>${att?.imgs?.length ? `<div class="u-imgs" data-views="${esc(JSON.stringify(att.imgViews || []))}">${att.imgs.map((u, k) => `<img src="${u}" alt="attached picture" data-k="${k}">`).join('')}</div>` : it.e.images ? `<span class="sc-att">📎 ${it.e.images} picture${it.e.images > 1 ? 's' : ''}</span>` : ''}${att?.docs?.length ? `<div class="u-docs">${att.docs.map((d) => `<button type="button" class="u-doc" data-doc="${esc(JSON.stringify(d))}" title="${esc(d.name)} · ${esc(docSize(d.size))} · click to preview">${DOC_ICON[d.kind] || '📄'} ${esc(d.name)}</button>`).join('')}</div>` : it.e.docs ? `<span class="sc-att">📎 ${it.e.docs} file${it.e.docs > 1 ? 's' : ''}</span>` : ''}<span class="sc-state">${it.read ? '✓ read by the agent' : '… it reads this at its next step'}</span></div>` });
      continue;
    }
    if (it.kind === 'note') other(`<div class="tl-note">${esc(clip(it.text, 220))}</div>`);
  }
  // Four or more lines in a row with nothing said between them fold into one line ("Wrote 7 files, ran 7 commands ·
  // thought 6 times"); open it to see each.
  const bundle = (list) => {
    const out = [];
    for (let k = 0; k < list.length;) {
      if (!list[k].row) { out.push(list[k++].html); continue; }
      let e = k; while (e < list.length && list[e].row) e++;
      const run = list.slice(k, e);
      if (run.length >= 4) {
        const calls = run.flatMap((x) => x.calls), thinks = run.reduce((n, x) => n + x.think, 0);
        const errs = calls.filter((x) => x.res != null && /^Error/.test(x.res)).length;
        const label = [calls.length ? callsLabel(calls) : '', thinks ? `${calls.length ? 'thought' : 'Thought'} ${thinks} time${thinks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
        out.push(det(`b-${run[0].key}`, 'tl-row tl-bundle', `<span class="tl-ic">🗂</span><span class="tl-label">${esc(label)}</span><small class="tl-words">${run.length} steps</small>${run.some((x) => x.busy) ? '<span class="tl-spin" aria-label="running"></span>' : ''}${errs ? `<span class="tl-err">${errs} error${errs > 1 ? 's' : ''}</span>` : ''}`, `<div class="tl-bundle-body">${run.map((x) => x.html).join('')}</div>`));
      } else out.push(...run.map((x) => x.html));
      k = e;
    }
    return out.join('');
  };
  // The reply's work folds into lines you can open (the Steps pane has all of it too). The plan and each review stay
  // out, where they happened, so the work before and after them folds on its own and it all reads in order. While it
  // works, anything waiting for you and what it is doing right now stay out too.
  const live = !!m.live, last = pieces.length - 1;
  const stays = (x, i) => x.pin || (live && (x.card || i === last));
  const foldLine = (seg, n, end) => {
    if (seg.length < 3) return bundle(seg);
    const done = seg.flatMap((x) => x.calls || []), thinks = seg.reduce((k, x) => k + (x.think || 0), 0), steps = seg.filter((x) => x.row).length;
    const errs = done.filter((x) => x.res != null && /^Error/.test(x.res)).length;
    // Says how much work it was; what kind of work shows on hover (and inside).
    const what = [done.length ? callsLabel(done) : '', thinks ? `${done.length ? 'thought' : 'Thought'} ${thinks} time${thinks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    const counts = [done.length ? `${done.length} tool call${done.length === 1 ? '' : 's'}` : '', thinks ? `${thinks} thought${thinks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    return det(n ? `all${n}` : 'all', 'tl-row tl-bundle tl-fold', `<span class="tl-ic">🗂</span><span class="tl-label" title="${esc(what)}">${live && end ? 'Working' : 'Worked'} through ${steps} step${steps === 1 ? '' : 's'}</span><small class="tl-words">${esc(counts)}</small>${errs ? `<span class="tl-err">${errs} error${errs > 1 ? 's' : ''}</span>` : ''}`, bundle(seg));
  };
  let out = '', seg = [], n = 0;
  pieces.forEach((x, i) => { if (stays(x, i)) { out += foldLine(seg, n++, false); seg = []; out += x.html; } else seg.push(x); });
  return out + foldLine(seg, n, true);
}
// Open lines stay open across redraws; a thinking line draws its text only when opened.
function wireTimeline(m, el) {
  const open = (m.tlOpen instanceof Set ? m.tlOpen : (m.tlOpen = new Set())); // chats saved before carry it as {}
  for (const d of el.querySelectorAll('.timeline details[data-key]')) {
    d.addEventListener('toggle', () => {
      if (d.open) open.add(d.dataset.key); else open.delete(d.dataset.key);
      const body = d.open && $(':scope > .tl-think-body', d);
      if (body && !body.innerHTML) { body.innerHTML = md(String(m.thinking?.[body.dataset.step] || '')); enhance(body); }
    });
  }
  enhance($('.timeline', el));
}
// While the model thinks: update the word counts, and the text of an open thinking line. A step whose thinking
// has no line yet (it started after the last redraw) gets one.
function liveThinking(m, tl) {
  for (const [step, text] of Object.entries(m.thinking || {})) {
    if (!String(text).trim()) continue;
    const row = tl.querySelector(`.tl-think[data-key="t${step}"]`);
    if (!row) { tl.innerHTML = timelineHTML(m); wireTimeline(m, m.el); return; }
    const w = $('.tl-words', row); if (w) w.textContent = `${String(text).trim().split(/\s+/).length.toLocaleString()} words`;
    if (row.open) {
      const body = $('.tl-think-body', row), TAIL = 12000, t = String(text);
      const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
      body.innerHTML = m.live && t.length > TAIL ? `<p class="think-more">… ${(t.length - TAIL).toLocaleString()} earlier characters, shown in full when this step is done</p>${md(t.slice(-TAIL))}` : md(t);
      if (stick) body.scrollTop = body.scrollHeight;
    }
  }
}
function updateMsg(c, m, { bodyOnly = false } = {}) {
  const el = m.el;
  if (!el) return;
  const body = $('.body', el);
  body.innerHTML = m.error && !stoppedByYou(m) ? `${md(m.content)}<p class="err">⚠ ${esc(m.error)}</p>` : md(m.content) || (m.live || stoppedByYou(m) ? '' : '<p class="err">(no reply)</p>');
  body.classList.toggle('typing', !!m.live);
  enhance(body);
  drawThinking(m);
  // The card's colour says what state the reply is in: working, waiting for you, or failed.
  const waiting = Object.values(m.approvals || {}).some((a) => !a.outcome);
  el.classList.toggle('is-live', !!m.live && !waiting);
  el.classList.toggle('is-waiting', !!m.live && waiting);
  el.classList.toggle('is-error', !!m.error && !stoppedByYou(m));
  el.classList.toggle('is-stopped', stoppedByYou(m));
  // The badge shows which model wrote this reply.
  const model = (m.trace || []).find((e) => e.t === 'llm_start')?.model || Object.keys(m.stats?.byModel || {}).find((k) => (m.stats.byModel[k].role || 'writer') === 'writer') || c.agent.setup.model;
  el.dataset.who = initials(short(model)).slice(0, 2);
  el.title = '';
  const rh = $('.reply-head', el);
  if (rh) { const h = replyHeadHTML(m, model); if (rh._h !== h) { rh.innerHTML = h; rh._h = h; } }
  if (bodyOnly) return;
  // Everything the agent did reads in order: its thinking (folded), what it said, one line per step's tool calls
  // (click for each call and its result), and any card that asks you something, right where it happened.
  $('.timeline', el).innerHTML = timelineHTML(m);
  wireTimeline(m, el);
  $('.approvals', el).innerHTML = outOfStepsHTML(m);
  const oos = $('.oos-card[data-run]', el); if (oos) wireOutOfSteps(oos, c, m);
  for (const card of el.querySelectorAll('.approval[data-id]:not(.question):not(.budget-card)')) wireApproval(card, m);
  for (const card of el.querySelectorAll('.question[data-id]')) wireQuestion(card, m);
  const bcard = $('.budget-card[data-id]', el); if (bcard) wireBudget(bcard, c, m);
  // One chip per artifact this reply made or changed (edits don't add a second chip).
  // Artifacts are reached from the pane's dropdown and the Files view, not as chips under each reply.
  // Steps: a button under the reply; the list of steps opens in the side pane.
  const tb = $('.trace-btn', el);
  // On every reply, a direct one-step answer too: its steps are the model call and what it cost.
  tb.hidden = !((m.trace || []).length || m.stats || m.live);
  const sum = traceSummary(m);
  // Once the reply has its numbers, hovering shows what it cost (the breakdown card) instead of the steps tip.
  if (m.stats) tb.removeAttribute('title'); else tb.title = traceTip(m);
  tb.setAttribute('aria-label', G.traceRun === m.runId ? 'Close the steps' : `${sum} · open them in the side pane`);
  tb.classList.toggle('live', !!m.live);
  tb.classList.toggle('on', G.traceRun === m.runId);
  // Open → shown in the pane (and listed in its dropdown); open and showing → close it; open but hidden → show it.
  tb.onclick = () => { if (G.traceRun === m.runId && G.view.trace === m.runId && !isPhone()) return closeTrace(); openTrace(c, m); toPreview(); };
  if (G.view.trace === m.runId && focused() === c) renderTracePane(c, m);
  const s = m.stats, when = m.doneAt || m.at;
  const checkTag = s?.verify ? (s.verify.ok ? '<span class="check-ok" title="Before this reply ended, the harness re-checked the changed files and opened what was built: no errors.">✓ Checked</span>'
    : `<span class="check-bad" title="${esc(s.verify.problems.join('\n'))}">⚠ ${s.verify.problems.length} problem${s.verify.problems.length === 1 ? '' : 's'} left</span>`) : '';
  const stopTag = s?.stop === 'steps' ? '<span title="The reply used all its steps (⚙ Settings → Agent loop)">step limit reached</span>'
    : s?.stop === 'budget' ? (s.budgetStop === 'hard' ? '<span title="The reply went past the project budget and its allowance for finishing work (⚙ Settings → Budget & approvals), so it was stopped">stopped past the budget</span>'
      : '<span title="The project budget was used up, so the reply did not start; raise it with the $ next to the project in the sidebar">budget reached</span>') : '';
  let undoRow = $('.f-undo-row', el);
  if (!undoRow) { undoRow = document.createElement('div'); undoRow.className = 'f-undo-row'; }
  $('.foot', el).before(undoRow);
  undoRow.innerHTML = s ? s.changed?.length ? (m.undone ? `<span class="undone undo-undone">↶ ${m.undone === 'partial' ? 'changes undone, except files changed since' : 'changes undone'}</span>` : undoGone(c, m) ? `<span class="undo-gone" title="Undo is kept for the newest ${Number(G.settings?.undoKeep) || 10} replies in a project, for up to ${Number(G.settings?.undoDays) || 7} days (⚙ Settings → Code & servers). Older undo copies are removed.">↶ undo no longer kept</span>` : `<button type="button" class="undo undo-btn" title="Put back the files this reply changed: ${esc(s.changed.filter((f) => !m.undoneFiles?.includes(f)).join(', '))}">↶ Undo changes (${s.changed.length - (m.undoneFiles?.length || 0)})</button>`) : '' : '';
  undoRow.hidden = !undoRow.innerHTML;
  // A reply cut off by a restart may carry partial stats (what it spent before the cut): it can still be resumed.
  $('.foot', el).innerHTML = (!s || s.partial) && m.resumable && !m.live ? '<button type="button" class="resume-btn primary" title="Carry on from the last finished step">▶ Resume where it stopped</button>'
    : !s && m.live && m.liveCost != null ? liveFootHTML(m)
    : s ? `<span class="f-cost" title="What the reply cost">${money(s.cost, 5)}</span>${s.ms ? `<span class="f-dur" title="How long the reply took">${secs(s.ms)}</span>` : ''}${checkTag}${stopTag}` : '';
  // A reply you stopped says so in one small tag down here, not in a box above.
  if (stoppedByYou(m) && !m.live) $('.foot', el).insertAdjacentHTML('afterbegin', '<span class="f-stopped" title="You stopped this reply">■ Stopped</span>');
  // Right side: 🧭 Steps (hover: what it cost; click: the steps, ending with the cost card), then copy and remix.
  const right = document.createElement('span'); right.className = 'f-right';
  $('.f-pop', tb)?.remove(); tb.classList.toggle('has-info', !!s);
  if (s) { const t = document.createElement('template'); t.innerHTML = replyInfoHTML(s, when); const pop = $('.f-pop', t.content); if (pop) tb.append(pop); }
  right.append(tb);
  $('.foot', el).append(right);
  if (s && !m.live && !m.runActive) {
    right.insertAdjacentHTML('beforeend', `<span class="msg-tools"><button type="button" class="mt-btn mt-copy" title="Copy this reply (Markdown)" aria-label="Copy reply">${msgIcon('copy')}</button><button type="button" class="mt-btn mt-remix" title="Remix: a new chat in this project with the conversation up to here. Files are not touched." aria-label="Remix in a new chat">${msgIcon('branch')}</button></span>`);
    wireIconCopy($('.foot .mt-copy', el), () => m.content);
    $('.foot .mt-remix', el).onclick = () => remixFrom(c, m);
  }
  const undo = $('.f-undo-row .undo', el);
  if (undo) undo.onclick = () => undoReply(c, m);
  const resume = $('.foot .resume-btn', el);
  if (resume) resume.onclick = () => { if (c.running) return; m.resumable = false; updateMsg(c, m); saveChat(c); runChat(c, '', null, [], { resumeOf: m.runId }); };
  drawReviewCard(c, m, el);
}
// ---------- Review changes: under a reply that changed files ----------
// Each file with its + / − lines; click one for its diff; ↶ Undo file puts back just that file (the reply's
// version goes to .quorx/trash). The reply's own "Undo changes" then covers the files that are left.
function drawReviewCard(c, m, el) {
  let slot = $('.review-slot', el);
  const n = m.stats?.changed?.length || 0, left = n - (m.undoneFiles?.length || 0);
  if (!n || left <= 0 || m.live || m.undone || undoGone(c, m)) { slot?.remove(); return; }
  if (!slot) { slot = document.createElement('div'); slot.className = 'review-slot'; ($('.f-undo-row', el) || $('.foot', el)).before(slot); }
  const key = `${m.runId}:${left}`;
  if (slot.dataset.key === key) return; // keeps it open, with its diffs, while the reply redraws
  slot.dataset.key = key;
  slot.innerHTML = `<details class="rv-card"><summary><span class="rv-title">Review changes</span><span class="rv-count">${left} file${left === 1 ? '' : 's'}</span><span class="rv-tot"></span></summary><div class="rv-list"><div class="rv-wait">Loading…</div></div></details>`;
  const det = $('details', slot);
  det.addEventListener('toggle', () => {
    (G.reviewOpen ||= new Set())[det.open ? 'add' : 'delete'](m.runId);
    if (det.open && !det.dataset.loaded) loadReview(c, m, slot);
  });
  if (G.reviewOpen?.has(m.runId)) det.open = true;
}
const RV_STATUS = { added: ['add', 'A', 'New file'], modified: ['mod', 'M', 'Changed'], deleted: ['rem', 'D', 'Deleted'], 'added then removed': ['rem', 'A', 'Made, then removed'] };
function rvDiffHTML(d) {
  if (d.error) return `<div class="rv-wait bad">⚠ ${esc(d.error)}</div>`;
  if (d.binary) return '<div class="rv-wait">Binary file: there are no lines to compare.</div>';
  if (d.large) return '<div class="rv-wait">Too large to compare here (over 400 KB). Open it from Files.</div>';
  if (!d.hunks.length) return '<div class="rv-wait">No line changes.</div>';
  return d.hunks.map((h) => `<div class="rv-hunk">${h.lines.map(([t, o, nn, s]) => `<div class="rv-l ${t === '+' ? 'add' : t === '-' ? 'rem' : ''}"><span class="rv-ln">${o ?? ''}</span><span class="rv-ln">${nn ?? ''}</span><span class="rv-sg">${t}</span><span class="rv-tx">${esc(s) || ' '}</span></div>`).join('')}</div>`).join('<div class="rv-gap" aria-hidden="true">⋯</div>')
    + (d.cut ? '<div class="rv-wait">The diff stops after 1,500 lines.</div>' : '');
}
async function loadReview(c, m, slot) {
  const det = $('details', slot), list = $('.rv-list', slot), runId = m.stats?.undoId || m.runId, q = `project=${encodeURIComponent(c.projectId)}&run=${encodeURIComponent(runId)}`;
  det.dataset.loaded = '1';
  const r = await getJ(`/api/review?${q}`);
  if (r.error) { list.innerHTML = `<div class="rv-wait bad">⚠ ${esc(r.error)}</div>`; return; }
  const sum = (k) => r.files.reduce((a, f) => a + (f[k] || 0), 0);
  // Your project's files first; the agent's own working files (.quorx, .agent) after them.
  const own = (p) => /^\.(quorx|agent)\//.test(p);
  r.files.sort((a, b) => own(a.path) - own(b.path));
  $('.rv-tot', slot).innerHTML = `<b class="rv-add">+${sum('added')}</b><b class="rv-rem">−${sum('removed')}</b>`;
  list.innerHTML = r.files.map((f) => {
    const [cls, letter, word] = RV_STATUS[f.status] || RV_STATUS.modified;
    return `<div class="rv-file" data-path="${esc(f.path)}">
      <div class="rv-top">
        <button type="button" class="rv-row" aria-expanded="false" title="Show what changed in ${esc(f.path)}"><span class="rv-st ${cls}" title="${word}">${letter}</span><code class="rv-path">${esc(f.path)}</code>${f.changedSince ? '<span class="rv-since" title="Changed again after this reply, by a later reply or by you. The diff includes those changes.">changed since</span>' : ''}<span class="rv-n">${f.binary ? 'binary' : f.large ? 'large' : f.status === 'added then removed' ? 'gone now' : !f.added && !f.removed ? 'no line changes' : `<b class="rv-add">+${f.added}</b><b class="rv-rem">−${f.removed}</b>`}</span></button>
        <button type="button" class="rv-undo" title="Put back ${esc(f.path)} as it was before this reply">↶ Undo file</button>
      </div>
      <div class="rv-diff no-ico" hidden></div></div>`;
  }).join('') + (r.undone.length ? `<div class="rv-wait">Already undone: ${r.undone.map((x) => `<code>${esc(x)}</code>`).join(', ')}</div>` : '');
  for (const fe of list.querySelectorAll('.rv-file')) {
    const rel = fe.dataset.path, row = $('.rv-row', fe), diff = $('.rv-diff', fe);
    row.onclick = async () => {
      const open = diff.hidden; diff.hidden = !open; row.setAttribute('aria-expanded', String(open));
      if (open && !diff.dataset.loaded) { diff.dataset.loaded = '1'; diff.innerHTML = '<div class="rv-wait">Loading…</div>'; diff.innerHTML = rvDiffHTML(await getJ(`/api/review?${q}&path=${encodeURIComponent(rel)}`)); }
    };
    $('.rv-undo', fe).onclick = async () => {
      if (!await uiConfirm(`Undo ${rel}?\n\nIt goes back to how it was before this reply. The reply's version moves to .quorx/trash.`)) return;
      const call = (force) => postJ('/api/review/undo', { projectId: c.projectId, runId, path: rel, force });
      let x = await call(false);
      if (x.conflict) {
        if (!await uiConfirm(`${rel} changed again after this reply (a later reply or you).\n\nUndo it anyway? The newer version moves to .quorx/trash.`)) return;
        x = await call(true);
      }
      if (x.error) return uiAlert(`Could not undo ${rel}: ${x.error}`);
      (m.undoneFiles ||= []).push(rel);
      if (!x.left) m.undone = true;
      saveChat(c); updateMsg(c, m); refreshUndoable(c.projectId);
      const f = $('#paneBody iframe'); if (f && !f.srcdoc) f.src = f.src;
    };
  }
}
// Above each reply: the exact OpenRouter model id (copy it, or open its OpenRouter page) and the provider that ran
// it. When a router answered (openrouter/free, openrouter/auto…), the model it picked follows the arrow.
const orBase = (id) => String(id || '').replace(/:(free|beta|extended|thinking|online|nitro|floor|exacto)$/, '');
function replyHeadHTML(m, fallback) {
  const calls = (m.trace || []).filter((e) => e.t === 'llm_done' && (e.model || e.provider));
  const last = calls[calls.length - 1];
  const model = last?.model || fallback;
  if (!model) return '';
  const actual = last?.actual && orBase(last.actual) !== orBase(model) && !last.actual.startsWith(orBase(model)) ? last.actual : '';
  const models = [...new Set(calls.map((e) => e.actual && !e.actual.startsWith(orBase(e.model)) ? e.actual : e.model).filter(Boolean))];
  const providers = [...new Set(calls.map((e) => e.provider).filter(Boolean))];
  const idChip = (id, cls, tip) => `<span class="rh-id ${cls}" title="${esc(tip)}">${esc(id)}</span><button type="button" class="rh-btn rh-copy" data-copy="${esc(id)}" title="Copy ${esc(id)}" aria-label="Copy the model id">${msgIcon('copy')}</button><button type="button" class="rh-btn rh-open" data-or="${esc(orBase(id))}" title="Open ${esc(orBase(id))} on openrouter.ai" aria-label="Open on OpenRouter"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></button>`;
  return `${idChip(model, 'rh-model', models.length > 1 ? `Models in this reply: ${models.join(', ')}` : 'The OpenRouter model id')}${models.length > 1 ? `<small class="rh-more" title="${esc(models.join('\n'))}">+${models.length - 1}</small>` : ''}`
    + (actual ? `<span class="rh-arrow" aria-hidden="true">→</span>${idChip(actual, 'rh-actual', `${model} picked this model to answer`)}` : '')
    + (providers.length ? `<span class="rh-via" title="The provider OpenRouter routed this reply to">via ${esc(providers.join(', '))}</span>` : '');
}
// Copy / open on OpenRouter, for the model ids above replies (one listener for the whole page).
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.reply-head .rh-btn');
  if (!b) return;
  if (b.dataset.copy) { navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.classList.add('done'); flashTip(b, 'Copied'); setTimeout(() => b.classList.remove('done'), 1200); }).catch(() => uiPrompt('Copy the model id', b.dataset.copy, { ok: 'Done', cancel: 'Close' })); }
  if (b.dataset.or) { const url = `https://openrouter.ai/${b.dataset.or}`; if (DESK) window.ohDesktop.openExternal(url); else window.open(url, '_blank', 'noopener'); }
});
// ? on a reply: hover (or focus) shows what went into it: when, how long, the cost and tokens, model calls by model,
// decider questions, the plan, files changed and media.
// Every model call the reply made (the writer's, and the deciders', reviewers' and helpers'), split by role.
function callsLine(s) {
  const by = {};
  for (const v of Object.values(s.byModel || {})) by[v.role || 'writer'] = (by[v.role || 'writer'] || 0) + (v.calls || 0);
  const total = Object.values(by).reduce((n, x) => n + x, 0);
  if (!total) return String(s.llmCalls || 0);
  const parts = Object.entries(by).sort((a, b) => (a[0] === 'writer' ? -1 : b[0] === 'writer' ? 1 : b[1] - a[1])).map(([r, n]) => `${n} ${r}${n === 1 ? '' : 's'}`);
  return parts.length > 1 ? `${total} <small>(${esc(parts.join(', '))})</small>` : String(total);
}
function replyInfoHTML(s, when) {
  const k = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0);
  const row = (label, value) => `<span class="fi-row"><span>${label}</span><b>${value}</b></span>`;
  const models = Object.entries(s.byModel || {}).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  return `<span class="f-info mt-btn" tabindex="0" role="button" aria-label="Reply details"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg><span class="f-pop" role="tooltip">
    <span class="fi-total"><span>Total cost${s.partial ? ' <i>so far: the reply ended early</i>' : ''}</span><b>${money(s.cost, 5)}</b></span>
    ${when ? row('When', esc(new Date(when).toLocaleString())) : ''}
    ${row('Took', secs(s.ms))}
    ${row('Model calls', callsLine(s))}
    ${s.tokensIn || s.tokensOut ? `<span class="fi-row tok-in"><span><i class="tok-dot"></i>Tokens in</span><b>${k(s.tokensIn)}</b></span><span class="fi-row tok-out"><span><i class="tok-dot"></i>Tokens out</span><b>${k(s.tokensOut)}</b></span>` : ''}
    ${s.decide?.calls ? row('Decider questions', `${s.decide.questions} in ${s.decide.calls} call${s.decide.calls === 1 ? '' : 's'}`) : ''}
    ${s.plan?.of ? row('Plan', `${s.plan.done} of ${s.plan.of} done`) : ''}
    ${s.changed?.length ? row('Files changed', s.changed.length) : ''}
    ${s.mediaSpent ? row('Media', money(s.mediaSpent, 4)) : ''}
    ${models.length ? `<span class="fi-h">By model</span>${models.map(([m, v]) => `<span class="fi-row fi-model"><span>${esc(short(m))}${v.role && v.role !== 'writer' ? ` <i>${esc(v.role)}</i>` : ''}</span><b>${v.calls}× · ${money(v.cost || 0, 5)}</b></span>`).join('')}` : ''}
  </span></span>`;
}
// The breakdown opens above its ? and stays inside the window. It's drawn in one floating box on the page itself:
// the chat column is a CSS container, which would clip it.
function replyInfoBox() {
  let box = $('#replyInfoPop');
  if (!box) { box = document.createElement('div'); box.id = 'replyInfoPop'; box.className = 'f-pop-float'; box.setAttribute('role', 'tooltip'); box.hidden = true; document.body.appendChild(box); }
  return box;
}
function showReplyInfo(e) {
  const f = e.target.closest?.('.f-info, .has-info'); if (!f) return;
  const src = $('.f-pop', f); if (!src) return;
  const box = replyInfoBox(), r = f.getBoundingClientRect();
  box.innerHTML = src.innerHTML; box.hidden = false;
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  box.style.top = `${r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(innerHeight - h - 8, r.bottom + 8)}px`;
  avoidDesk(box);
}
function hideReplyInfo(e) {
  const f = e.target.closest?.('.f-info, .has-info'); if (!f || f.contains(e.relatedTarget)) return;
  const box = $('#replyInfoPop'); if (box) box.hidden = true;
}
document.addEventListener('pointerover', showReplyInfo);
document.addEventListener('focusin', showReplyInfo);
document.addEventListener('pointerout', hideReplyInfo);
document.addEventListener('focusout', hideReplyInfo);
// Undo puts back every file this reply changed (files it created move to .quorx/trash). If some of
// those files changed again since (a later reply or you), it asks first: undo everything, or only the rest.
async function undoReply(c, m) {
  const runId = m.stats?.undoId || m.runId, files = m.stats.changed.filter((f) => !m.undoneFiles?.includes(f)); // minus files undone one by one
  if (!await uiConfirm(`Undo this reply's changes?\n\n${files.join('\n')}`)) return;
  const call = (mode) => postJ('/api/checkpoints/restore', { projectId: c.projectId, runId, ...(mode ? { mode } : {}) });
  let r = await call();
  if (r.conflicts?.length && !r.restored) {
    const mode = await undoChoice(files, r.conflicts);
    if (!mode) return;
    r = await call(mode);
  }
  if (r.error) {
    if (/cleared|nothing to undo/i.test(r.error)) { refreshUndoable(c.projectId); }
    return uiAlert(`Could not undo: ${r.error}`);
  }
  m.undone = r.conflicts?.length && r.restored?.some((x) => x.endsWith('(kept: changed since)')) ? 'partial' : true;
  saveChat(c); updateMsg(c, m); refreshUndoable(c.projectId);
  const f = $('#paneBody iframe'); if (f && !f.srcdoc) f.src = f.src;
}
function undoChoice(all, changed) {
  return new Promise((resolve) => {
    const rest = all.filter((x) => !changed.includes(x));
    const dlg = document.createElement('dialog');
    dlg.className = 'pf-dialog';
    dlg.innerHTML = `<form class="pf" method="dialog">
      <h3>Some of these files changed after this reply</h3>
      <p class="pf-warn">⚠ ${changed.length} file${changed.length > 1 ? 's were' : ' was'} changed again later, by another reply or by you. Undoing ${changed.length > 1 ? 'them' : 'it'} would throw those newer changes away:</p>
      <ul class="undo-list">${changed.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>
      <div class="pf-acts undo-acts">
        <button type="button" data-v="">Cancel</button>
        ${rest.length ? `<button type="button" data-v="rest" title="${esc(rest.join(', '))}">Undo only the other ${rest.length} file${rest.length > 1 ? 's' : ''}</button>` : ''}
        <button type="button" class="danger" data-v="all">Undo everything, overwrite newer changes</button>
      </div></form>`;
    document.body.appendChild(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v || null); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    for (const b of dlg.querySelectorAll('[data-v]')) b.onclick = () => done(b.dataset.v);
    dlg.showModal();
  });
}
// Which replies in a project still have their undo copy (the newest ones only).
async function refreshUndoable(projectId) {
  if (!projectId) return;
  const list = await getJ(`/api/checkpoints?project=${encodeURIComponent(projectId)}`);
  if (!Array.isArray(list)) return;
  (G.undoable ||= {})[projectId] = new Set(list.map((x) => x.runId));
  for (const c of G.open.values()) if (c.projectId === projectId && c.el) for (const m of c.agent.messages) if (m.stats?.changed?.length && !m.undone) updateMsg(c, m);
}
const undoGone = (c, m) => { const set = G.undoable?.[c.projectId]; return !!set && !set.has(m.stats?.undoId || m.runId); };

// 📂: the project's folder in the computer's own file manager (File Explorer on Windows).
async function openFolder(projectId, path) {
  const r = await fetch('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, path }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  if (r.error) uiAlert(`Could not open the folder: ${r.error}`);
}
// Files → right-click a file or folder: show it in File Explorer, or copy its path.
// A small right-click menu: items are [label, action] (null for a line between groups).
function popMenu(e, items) {
  e.preventDefault(); e.stopPropagation();
  document.querySelector('.exp-menu')?.remove();
  const m = document.createElement('div'); m.className = 'exp-menu fx-menu'; m.setAttribute('role', 'menu');
  const acts = items.filter(Boolean);
  m.innerHTML = items.map((x) => (x ? `<button type="button" role="menuitem" data-i="${acts.indexOf(x)}">${esc(x[0])}</button>` : '<hr class="fx-sep">')).join('');
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`; m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  const away = (ev) => { if (!m.contains(ev.target)) close(); };
  const key = (ev) => { if (ev.key === 'Escape') close(); };
  const close = () => { m.remove(); removeEventListener('pointerdown', away, true); removeEventListener('keydown', key, true); };
  addEventListener('pointerdown', away, true); addEventListener('keydown', key, true);
  m.onclick = (ev) => { const b = ev.target.closest('[data-i]'); if (!b) return; close(); acts[Number(b.dataset.i)][1](); };
  m.querySelector('button')?.focus();
}
// Files → right-click a file or folder: add a file to the chat, show it in File Explorer, or copy its path.
function filesMenu(e, projectId, rel, full, isFile = true) {
  popMenu(e, [
    ...(isFile ? [['💬 Add to chat', () => addFileToChat(projectId, rel, e.currentTarget || e.target)], null] : []),
    ['📂 Show in File Explorer', () => openFolder(projectId, rel)],
    ['📋 Copy full path', () => navigator.clipboard?.writeText(full).catch(() => {})],
    ['📋 Copy relative path', () => navigator.clipboard?.writeText(rel).catch(() => {})],
  ]);
}
// A project file goes with your next message in the chat you are in (as with @file).
function addFileToChat(projectId, rel, from) {
  const c = focused();
  if (!c?.el) return uiAlert('Open a chat first: the file goes with your next message there.');
  if (!c.ctx.some((x) => x.type === 'file' && x.projectId === projectId && x.path === rel)) c.ctx.push({ type: 'file', projectId, path: rel, title: rel });
  renderAttachments(c);
  flashTip(from && from.isConnected ? from : $('.input', c.el.root), 'Added to your next message');
}
// The trace opens in the artifact pane area only when asked, and leaves it when closed.
const clip = (t, n) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));
const TRACE_KINDS = [['think', '🧠 Model'], ['tool', '🔧 Tool'], ['res', '↳ Result'], ['file', '📝 File'], ['cmd', '⌨️ Command'], ['browser', '📸 Browser'], ['decide', '⚖️ Deciders'], ['ask', '✋ Approval'], ['ok', '✅ Approved'], ['err', '⛔ Error'], ['warn', '⚠ Warning'], ['note', 'ℹ Note']];
function openTrace(c, m) {
  const i = G.panes.indexOf(c.id);
  if (i >= 0 && G.focus !== i) { G.focus = i; for (const p of document.querySelectorAll('.chatpane')) p.classList.toggle('focus', Number(p.dataset.pane) === i); }
  // One trace at a time: it becomes an entry in the artifact dropdown (a new one takes its place).
  G.traceRun = m.runId;
  c.paneHidden = false;
  G.view = { id: G.view.id, src: false, files: false, trace: m.runId };
  syncLayout(); renderPane(); refreshTraceButtons();
}
function closeTrace() { G.traceRun = null; G.view.trace = null; syncLayout(); renderPane(); refreshTraceButtons(); }
function refreshTraceButtons() { for (const b of document.querySelectorAll('.trace-btn')) b.classList.remove('on'); const c = focused(); const m = c?.agent.messages.find((x) => x.runId === G.traceRun); if (m?.el) $('.trace-btn', m.el)?.classList.add('on'); }
function renderTracePane(c, m) {
  if (G.replay?.run === m.runId) return renderReplay(c, m);
  const body = $('#paneBody'), bar = $('#appBar');
  bar.hidden = false;
  bar.innerHTML = `🧭 <b>Steps</b> <span class="dim">${esc(traceSummary(m).replace(/^Steps · /, ''))}</span>${!m.live && m.runId ? '<button type="button" class="tp-replay" title="Watch this reply again, step by step, with a scrubber">⏵ Replay</button>' : ''} <button type="button" class="back" title="Close the trace">✕ Close</button>`;
  $('.back', bar).onclick = closeTrace;
  const rp = $('.tp-replay', bar); if (rp) rp.onclick = () => startReplay(c, m);
  // Opening a trace starts at its latest step; redrawing the same one keeps your place (and follows new steps while you're at the end).
  const old = $('.trace-pane', body), same = !!old && old.dataset.run === m.runId;
  const top = same ? old.scrollTop : 0, atEnd = !same || old.scrollHeight - old.scrollTop - old.clientHeight < 40;
  const kinds = [...new Set((traceHTML(m).match(/data-k="(\w+)"/g) || []).map((x) => x.slice(8, -1)))];
  // The legend highlights: picked kinds stay bright and everything else dims, so the order and timing stay readable.
  const F = (G.traceFocus ??= new Set());
  for (const k of [...F]) if (!kinds.includes(k)) F.delete(k);
  const legend = TRACE_KINDS.filter(([k]) => kinds.includes(k)).map(([k, label]) => `<button type="button" class="tl-chip k-${k} ${F.has(k) ? 'on' : ''}" data-k="${k}" aria-pressed="${F.has(k)}" title="Highlight these steps (the rest dims)">${label}</button>`).join('')
    + (F.size ? '<button type="button" class="tl-all">Show all</button>' : '');
  body.innerHTML = `<div class="trace trace-pane ${F.size ? 'focusing' : ''} ${[...F].map((k) => `f-${k}`).join(' ')}" data-run="${esc(m.runId)}"><div class="tp-legend">${legend}</div><div class="tp-q">${esc(clip(c.agent.messages[c.agent.messages.indexOf(m) - 1]?.content || '', 220))}</div><div class="steps">${traceHTML(m)}</div>${traceCostHTML(c, m)}</div>`;
  const now = $('.trace-pane', body);
  // Opening the steps starts at the latest one and follows new ones (and pictures that load late) while you stay at
  // the end; scrolling up stops following until you scroll back down or press ↓ Latest.
  const T = (G.traceFollow ||= {});
  if (!same) T[m.runId] = true; else if (atEnd) T[m.runId] = true;
  const toEnd = () => { if (T[m.runId] && now.isConnected) now.scrollTop = now.scrollHeight; };
  now.scrollTop = T[m.runId] ? now.scrollHeight : top;
  requestAnimationFrame(toEnd); setTimeout(toEnd, 250); setTimeout(toEnd, 900);
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(toEnd); for (const k of now.children) ro.observe(k); }
  const jump = document.createElement('button');
  jump.type = 'button'; jump.className = 'jump-latest tp-jump'; jump.textContent = '↓ Latest'; jump.title = 'Go to the latest step and keep following';
  jump.hidden = !!T[m.runId];
  jump.onclick = () => { T[m.runId] = true; jump.hidden = true; now.scrollTop = now.scrollHeight; };
  body.appendChild(jump);
  followScroll(now, { get: () => !!T[m.runId], set: (v) => { T[m.runId] = v; }, onChange: (v) => { jump.hidden = v; } });
  for (const b of now.querySelectorAll('.tl-chip')) b.onclick = () => { F.has(b.dataset.k) ? F.delete(b.dataset.k) : F.add(b.dataset.k); renderTracePane(c, m); };
  const all = $('.tl-all', now); if (all) all.onclick = () => { F.clear(); renderTracePane(c, m); };
}
// ⏵ Replay: a finished reply's steps again, from the start, one event at a time with its real timing (sped up), with a
// scrubber. J/K or ←/→ jump to the previous/next step, Space plays and pauses, Home/End go to the ends.
const REPLAY_MARK = new Set(['llm_start', 'tool', 'review', 'review_start', 'verify', 'question', 'answer', 'approval', 'sent_back', 'check', 'lint', 'decide_start', 'done', 'error']);
async function startReplay(c, m) {
  let trace = m.trace || [];
  // A reply whose steps the page never saw (started over MCP, or while the page was closed): QuorX's own log.
  if (!trace.length && m.runId) { const r = await fetch(`/api/runs/${encodeURIComponent(m.runId)}/log`).then((x) => x.json()).catch(() => null); trace = r?.events || []; }
  if (!trace.length) return uiAlert('This reply has no recorded steps to replay.');
  stopReplay();
  G.replay = { run: m.runId, trace, i: 0, playing: true, speed: 4, timer: null };
  renderTracePane(c, m);
  G.replay.keys = (e) => {
    const R = G.replay; if (!R || R.run !== m.runId || /input|textarea|select/i.test(e.target?.tagName || '')) return;
    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowLeft') { e.preventDefault(); replayStep(c, m, -1); }
    else if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowRight') { e.preventDefault(); replayStep(c, m, 1); }
    else if (e.key === ' ') { e.preventDefault(); R.playing = !R.playing; replayTick(c, m); renderReplay(c, m); }
    else if (e.key === 'Home') { e.preventDefault(); R.i = 0; R.playing = false; renderReplay(c, m); }
    else if (e.key === 'End') { e.preventDefault(); R.i = R.trace.length; R.playing = false; renderReplay(c, m); }
    else if (e.key === 'Escape') { stopReplay(); renderTracePane(c, m); }
  };
  document.addEventListener('keydown', G.replay.keys);
  replayTick(c, m);
}
function stopReplay() {
  const R = G.replay; if (!R) return;
  clearTimeout(R.timer); if (R.keys) document.removeEventListener('keydown', R.keys);
  G.replay = null;
}
function replayStep(c, m, dir) {
  const R = G.replay; R.playing = false; clearTimeout(R.timer);
  let i = R.i + dir;
  while (i > 0 && i < R.trace.length && !REPLAY_MARK.has(R.trace[i - 1]?.t)) i += dir;
  R.i = Math.max(0, Math.min(R.trace.length, i));
  renderReplay(c, m);
}
function replayTick(c, m) {
  const R = G.replay; if (!R) return;
  clearTimeout(R.timer);
  if (!R.playing) return;
  if (R.i >= R.trace.length) { R.playing = false; return renderReplay(c, m); }
  const gap = R.i ? Math.max(0, (R.trace[R.i]?.at || 0) - (R.trace[R.i - 1]?.at || 0)) : 0;
  R.timer = setTimeout(() => { if (G.replay !== R) return; R.i++; renderReplay(c, m); replayTick(c, m); }, Math.max(25, Math.min(1500, gap / R.speed)));
}
function renderReplay(c, m) {
  const R = G.replay, body = $('#paneBody'), bar = $('#appBar');
  if (!body || G.traceRun !== m.runId) { stopReplay(); return; }
  const n = R.trace.length, shown = R.trace.slice(0, R.i), at = shown.at(-1)?.at || 0, end = R.trace.at(-1)?.at || 0;
  const marks = R.trace.map((e, k) => (REPLAY_MARK.has(e.t) ? k + 1 : null)).filter(Boolean);
  const stepNo = marks.filter((k) => k <= R.i).length;
  bar.hidden = false;
  bar.innerHTML = `⏵ <b>Replay</b> <span class="dim">step ${stepNo} of ${marks.length} · ${secs(at)} of ${secs(end)}</span> <button type="button" class="back rp-exit" title="Back to all the steps (Esc)">✕ Exit replay</button>`;
  $('.rp-exit', bar).onclick = () => { stopReplay(); renderTracePane(c, m); };
  const old = $('.replay-pane', body);
  if (!old) {
    body.innerHTML = `<div class="replay-pane"><div class="rp-bar" role="toolbar" aria-label="Replay controls">
      <button type="button" class="rp-btn" data-go="start" title="Back to the start (Home)" aria-label="Back to the start">⏮</button>
      <button type="button" class="rp-btn" data-go="prev" title="Previous step (J or ←)" aria-label="Previous step">◀</button>
      <button type="button" class="rp-btn rp-play" data-go="play" title="Play or pause (Space)" aria-label="Play or pause"></button>
      <button type="button" class="rp-btn" data-go="next" title="Next step (K or →)" aria-label="Next step">▶</button>
      <button type="button" class="rp-btn" data-go="end" title="To the end (End)" aria-label="To the end">⏭</button>
      <input type="range" class="rp-range" min="0" max="${n}" step="1" aria-label="Position in the reply">
      <div class="rp-speed" role="radiogroup" aria-label="Speed">${[1, 4, 16].map((s) => `<button type="button" class="rp-sp" data-sp="${s}" role="radio">${s}×</button>`).join('')}</div>
    </div><div class="trace trace-pane rp-trace" data-run="${esc(m.runId)}"></div></div>`;
    const p = $('.replay-pane', body);
    for (const b of p.querySelectorAll('[data-go]')) b.onclick = () => {
      const g = b.dataset.go;
      if (g === 'prev') return replayStep(c, m, -1);
      if (g === 'next') return replayStep(c, m, 1);
      if (g === 'start') { G.replay.i = 0; G.replay.playing = false; }
      if (g === 'end') { G.replay.i = G.replay.trace.length; G.replay.playing = false; }
      if (g === 'play') { if (G.replay.i >= G.replay.trace.length) G.replay.i = 0; G.replay.playing = !G.replay.playing; }
      renderReplay(c, m); replayTick(c, m);
    };
    $('.rp-range', p).oninput = (e) => { G.replay.i = Number(e.target.value); G.replay.playing = false; clearTimeout(G.replay.timer); renderReplay(c, m); };
    for (const b of p.querySelectorAll('.rp-sp')) b.onclick = () => { G.replay.speed = Number(b.dataset.sp); renderReplay(c, m); replayTick(c, m); };
  }
  const p = $('.replay-pane', body);
  $('.rp-play', p).textContent = R.playing ? '⏸' : '⏵';
  const rg = $('.rp-range', p); rg.max = n; rg.value = R.i;
  rg.style.setProperty('--pos', `${n ? (R.i / n) * 100 : 0}%`);
  for (const b of p.querySelectorAll('.rp-sp')) { const on = Number(b.dataset.sp) === R.speed; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
  const tp = $('.rp-trace', p);
  tp.innerHTML = shown.length ? traceHTML({ ...m, trace: shown, live: R.i < n }) : '<div class="rp-empty">The reply starts here. Press ⏵ or K.</div>';
  tp.scrollTop = tp.scrollHeight;
}
// The 🧭 Steps tip: what the reply did, as rows.
function traceTip(m) {
  const s = m.stats, tr = m.trace || [];
  const decs = tr.filter((e) => e.t === 'decide_done');
  const flips = decs.flatMap((d) => d.results || []).filter((r) => r.bucket === 'flipped').length;
  const tools = tr.filter((e) => e.t === 'tool').length;
  return ['Steps', `Tool calls\t${tools}`, ...(decs.length ? [`Decider rounds\t${decs.length}${flips ? ` · ${flips} changed` : ''}`] : []), s ? `Took\t${secs(s.ms)}` : m.live ? 'Running…' : '',
    G.traceRun === m.runId ? 'Click to close them' : 'Click to open them in the side pane'].filter(Boolean).join('\n');
}
function traceSummary(m) {
  const s = m.stats;
  const decs = (m.trace || []).filter((e) => e.t === 'decide_done');
  const flips = decs.flatMap((d) => d.results).filter((r) => r.bucket === 'flipped').length;
  const tools = (m.trace || []).filter((e) => e.t === 'tool').length;
  return `Steps · ${tools} tool call${tools === 1 ? '' : 's'}${decs.length ? ` · ${decs.length} decision round${decs.length === 1 ? '' : 's'}, ${flips} answer${flips === 1 ? '' : 's'} changed` : ''}${s ? ` · ${secs(s.ms)}` : m.live ? ' · running…' : ''}`;
}
// Web addresses in escaped text (tool results, notes, screens) as Ctrl+click links to the Browser tab.
const linkUrls = (html) => String(html).replace(/(^|[\s(>]|&quot;|&#39;|&lt;)(https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<)"])+?)(?=[.,;:!?]?(?:[\s<)"]|&quot;|&#39;|&lt;|&gt;|$))/g, (_, pre, url) => `${pre}<a href="${url}" rel="noopener noreferrer" data-cl="1">${url}</a>`);
function traceHTML(m) {
  const out = [], rounds = {};
  let mediaStatus = null;
  // Each step carries its kind, so the trace can colour it and the legend can show or hide it.
  const row = (at, what, kind = 'note') => out.push(`<div class="step k-${kind}" data-k="${kind}"><div class="when">${kind === 'res' ? '' : secs(at)}</div><div class="what">${what}</div></div>`);
  for (const e of m.trace || []) {
    if (e.t === 'llm_start') row(e.at, `🧠 <b>${esc(short(e.model))}</b> thinks<span class="sub" data-llm="${e.step}"></span>${m.thinking?.[e.step]?.trim() ? `<details class="think-trace"><summary>💭 Thinking · ${m.thinking[e.step].split(/\s+/).filter(Boolean).length} words</summary><div class="tt-body">${md(m.thinking[e.step])}</div></details>` : ''}`, 'think');
    else if (e.t === 'llm_done') {
      const i = out.findLastIndex((h) => h.includes(`data-llm="${e.step}"`));
      if (i >= 0) out[i] = out[i].replace(`<span class="sub" data-llm="${e.step}"></span>`, `<div class="sub">${secs(e.ms)} · <span class="tok-out">${e.tokensOut} tokens out</span> · ${money(e.cost, 5)}${e.provider ? ` · via <span class="tr-prov" title="The provider OpenRouter routed this call to">${esc(e.provider)}</span>` : ''}${e.model && e.model !== m.trace.find((x) => x.t === 'llm_start' && x.step === e.step)?.model ? ` · <b class="tr-fallback" title="The chat's model was unavailable, so OpenRouter used the fallback model">fallback ${esc(short(e.model))}</b>` : ''}${e.toolCalls.length ? ` · then ${e.toolCalls.join(', ')}` : ''}</div>${e.aside ? `<div class="aside">💬 ${esc(e.aside)}</div>` : ''}`);
    } else if (e.t === 'tool' && e.name !== 'decide') row(e.at, `${e.by === 'reviewer' ? '🧪 <span class="tr-rv">reviewer</span> ' : e.by === 'helper' ? `🤝 <span class="tr-hp">helper ${e.helper || ''}</span> ` : ''}${TOOL_NAME[e.name]?.split(' ')[0] || '🔧'} <b>${esc(e.name)}</b><div class="sub">${esc(argSummary(e))}</div>`, e.by === 'reviewer' ? 'browser' : 'tool');
    else if (e.t === 'reading') row(e.at, `📝 <b>Prompt enhancer</b> ${esc(short(e.model))} read the request${e.late ? ' (too late for the first step; the deciders still use it)' : ''} · ${secs(e.ms)} · ${money(e.cost, 5)}<div class="sub" style="white-space:pre-wrap">${linkUrls(esc(e.text))}</div>`, 'note');
    else if (e.t === 'reading_edit') row(e.at, e.text ? `📝 You corrected the reading<div class="sub" style="white-space:pre-wrap">${esc(e.text)}</div>` : '📝 You dropped the reading', 'note');
    else if (e.t === 'fresh_eyes_start') row(e.at, `👀 <b>Fresh eyes</b> ${esc(short(e.model))}: a problem came back, so a clean-context model takes a look<div class="sub">${(e.problems || []).map(esc).join('<br>')}</div>`, 'note');
    else if (e.t === 'fresh_eyes') row(e.at, `👀 Fresh eyes ${e.ok ? 'diagnosed it' : 'found nothing'}${e.report ? `<div class="sub" style="white-space:pre-wrap">${linkUrls(esc(e.report))}</div>` : ''}`, e.ok ? 'ok' : 'warn');
    else if (e.t === 'helper_start' && e.fresh) continue;
    else if (e.t === 'helper_start') row(e.at, `🤝 <b>Helper ${e.id}</b> ${esc(short(e.model))} starts, with a clean context<div class="sub">${esc(e.task)}</div>`, 'note');
    else if (e.t === 'helper_done') row(e.at, `🤝 Helper ${e.id} ${e.ok ? 'reported back' : 'gave no report'} · ${e.steps} step${e.steps === 1 ? '' : 's'} · ${secs(e.ms)} · ${money(e.cost, 4)}${e.chars ? ` · ${e.chars} characters returned` : ''}`, e.ok ? 'ok' : 'warn');
    else if (e.t === 'steer') row(e.at, `✉ <b>You</b> while it worked: ${esc(clip(e.text, 200))}`, 'ask');
    else if (e.t === 'steer_delivered') row(e.at, `✓ The agent read your note${e.count > 1 ? 's' : ''} before step ${e.step + 1}`, 'note');
    else if (e.t === 'mode') row(e.at, `${e.approval === 'yolo' ? '⚡ Switched to YOLO: it stops asking (budget caps still apply)' : '🔒 Switched to Strict: it asks before each tool'}`, 'note');
    else if (e.t === 'plan') row(e.at, `🗺 <b>Plan</b> · ${e.items.filter((x) => x.status === 'done').length} of ${e.items.length} done<div class="sub">${esc(e.items.map((x) => `${x.status === 'done' ? '✓' : x.status === 'doing' ? '◐' : '○'} ${x.text}`).join('  '))}</div>`, 'note');
    else if (e.t === 'review_start') row(e.at, `🧪 <b>Reviewer</b> ${esc(short(e.model))} starts testing ${esc(e.targets.join(', '))} <span class="sub">(round ${e.round}, fresh context)</span>`, 'browser');
    else if (e.t === 'review') row(e.at, `🧪 Reviewer: <b>${e.pass ? 'passed' : 'not passed'}</b> · ${Object.entries(e.scores).map(([k, v]) => `${k} ${v}/5`).join(', ')} (bar ${e.bar}) · ${money(e.cost, 4)}${e.bugs.length ? `<div class="sub">${esc(e.bugs.join(' · '))}</div>` : ''}`, e.pass ? 'ok' : 'warn');
    else if (e.t === 'tool_result' && e.name !== 'decide') row(e.at, `<div class="sub">↳ ${linkUrls(esc(e.result.slice(0, 220)))}</div>`, /^Error/.test(e.result) ? 'err' : 'res');
    else if (e.t === 'decide_start') { rounds[e.round] = { start: e, votes: [], done: null }; row(e.at, `<span data-round="${e.round}"></span>`, 'decide'); }
    else if (e.t === 'decide_vote') rounds[e.round]?.votes.push(e);
    else if (e.t === 'decide_done') { if (rounds[e.round]) rounds[e.round].done = e; }
    else if (e.t === 'approval') row(e.at, e.free ? `✋ asks to use <b>${esc(e.tool)}</b>` : `💳 <b>${esc(e.tool)}</b> wants approval · ${money(e.est, 3)} (${esc(e.basis || 'estimated')})`, 'ask');
    else if (e.t === 'card_held') row(e.at, '⏸ You stopped the clock: the card waits for you', 'note');
    else if (e.t === 'approval_done') row(e.at, `${e.approve ? '✅ approved' : '⛔ declined'} by ${byName(e.by)}${e.reason ? `<div class="sub">${esc(e.reason)}</div>` : ''}`, e.approve ? 'ok' : 'err');
    else if (e.t === 'media_status') mediaStatus = e;
    else if (e.t === 'screenshot') row(e.at, `📸 browser ${esc(e.action)}${e.target ? ` ${esc(e.target)}` : ''}<div class="sub">${linkUrls(esc(e.url || ''))}</div><img class="shot" src="${e.image}" alt="screenshot" loading="lazy">`, 'browser');
    else if (e.t === 'command' && e.background) row(e.at, `⏳ <code>${esc(e.command)}</code> → background job <b>${esc(e.background)}</b> · ${esc(e.why || '')}<div class="sub">It keeps running; its output goes to ${esc(e.log || 'its log')}. Stop it from the terminal, or the agent stops it with job_stop.</div>`, 'cmd');
    else if (e.t === 'terminal') row(e.at, `🖥 terminal ${esc(e.id)} · ${esc(e.action)}${e.command ? ` <code>${esc(clip(e.command, 120))}</code>` : ''}${e.running === false ? ' · ended' : ''}${e.screen ? `<details class="out"><summary>screen</summary><pre>${linkUrls(esc(e.screen))}</pre></details>` : ''}`, 'cmd');
    else if (e.t === 'debug') row(e.at, `🐞 debugger ${esc(e.id || '')} · ${esc(e.action)}${e.file ? ` <code>${esc(e.file)}</code>` : ''}${e.text ? `<details class="out"><summary>where it is</summary><pre>${esc(e.text)}</pre></details>` : ''}`, 'cmd');
    else if (e.t === 'android') row(e.at, `📱 android ${esc(e.device)} · ${esc(e.action)}`, 'browser');
    else if (e.t === 'packages') row(e.at, `📦 checked ${e.packages.length} package${e.packages.length === 1 ? '' : 's'} for <code>${esc(clip(e.command, 80))}</code><div class="sub">${e.packages.map((p) => `${esc(p.name)} (${esc(p.eco)}): ${p.verdict === 'ok' ? `exists${p.ageDays != null ? `, ${Math.round(p.ageDays / 36.5) / 10} years old` : ''}${p.weekly != null ? `, ${p.weekly.toLocaleString()}/week` : ''}` : esc(p.note)}`).join('<br>')}</div>`, e.packages.some((p) => p.verdict === 'missing') ? 'err' : 'cmd');
    else if (e.t === 'desktop') row(e.at, `🪟 desktop app ${esc(e.job)} · ${esc(e.action)}${e.did ? `: ${esc(e.did)}` : ''}`, 'browser');
    else if (e.t === 'command') {
      const ch = e.changes, n = ch ? ch.added.length + ch.modified.length + ch.deleted.length : 0;
      const by = !e.decidedBy ? '' : e.decidedBy === 'you' ? 'you allowed it' : e.decidedBy === 'deciders' ? 'the deciders allowed it' : e.decidedBy.startsWith('rule:') ? `your rule (${esc(e.decidedBy.slice(5))}) allowed it` : `runs without asking (${esc(e.decidedBy.replace(/^class:/, ''))})`;
      const undo = n ? `changed ${n} file${n > 1 ? 's' : ''} · Undo covers project files` : e.snap?.off && e.snap.off !== 'read-only' ? `no snapshot (${esc(e.snap.off)}): Undo can't restore what it changed` : '';
      const stop = e.stopped ? (e.stopped.left ? `⚠ ${e.stopped.left} process${e.stopped.left > 1 ? 'es' : ''} did not stop: ${esc((e.stopped.names || []).join(', '))}` : `■ stopped · 0 processes left${e.stopped.mode === 'basic' ? ' (basic mode)' : ''}`) : e.timedOut ? 'stopped at the time limit' : '';
      row(e.at, `⌨️ <code>${esc(e.command)}</code> → exit ${e.code ?? '–'} · ${secs(e.ms)}<div class="sub">${[by, undo, stop, e.leftovers?.ended?.length ? `ended ${e.leftovers.ended.length} process${e.leftovers.ended.length > 1 ? 'es' : ''} it left running` : '', 'not covered: files outside the project, ignored folders (node_modules, target), pushes, installs, databases'].filter(Boolean).join(' · ')}</div>${ch && n ? `<details class="out"><summary>files</summary><pre>${esc([...ch.added.map((f) => `+ ${f}`), ...ch.modified.map((f) => `~ ${f}`), ...ch.deleted.map((f) => `- ${f}`)].join('\n'))}</pre></details>` : ''}${e.out ? `<details class="out"><summary>output</summary><pre>${esc(e.out)}</pre>${e.log ? `<div class="sub">Full log: ${esc(e.log)}</div>` : ''}</details>` : ''}`, e.code || e.stopped?.left ? 'err' : 'cmd');
    }
    else if (e.t === 'hook') row(e.at, `🪝 hook <code>${esc(clip(e.command, 160))}</code> ${e.skipped ? 'did not run' : `→ ${e.ok ? 'ok' : e.timedOut ? 'stopped at its time limit' : `exit ${e.code ?? '–'}`} · ${secs(e.ms)}`}<div class="sub">${esc(HOOK_WHEN[e.event] || e.event)}${e.file ? `: ${esc(e.file)}` : ''}${e.skipped ? ` · ${esc(e.why || '')}` : e.told ? (e.event === 'before_command' ? ' · the command did not run; the agent sees why' : ' · the agent sees its output') : ''}</div>${e.out ? `<details class="out"${e.ok ? '' : ' open'}><summary>output</summary><pre>${esc(e.out)}</pre></details>` : ''}`, e.ok ? 'cmd' : 'err');
    else if (e.t === 'memory_saved') row(e.at, `📌 saved to memory: “${esc(e.text)}”<div class="sub">Every chat gets it from now on · ⚙ Settings → Memory</div>`, 'ok');
    else if (e.t === 'tripwire') row(e.at, `🚨 tripwire stopped <code>${esc(e.command)}</code>: ${e.count} files vanished outside the project<div class="sub">${(e.sample || []).map(esc).join('<br>')}<br>Look in the Recycle Bin, or right-click the folder → Properties → Previous Versions.</div>`, 'err');
    else if (e.t === 'command_blocked') row(e.at, `⛔ blocked <code>${esc(e.command)}</code><div class="sub">${esc(e.policy?.why || '')}${e.policy?.hint ? ` · ${esc(e.policy.hint)}` : ''}</div>`, 'err');
    else if (e.t === 'cmd_rule') row(e.at, `📏 rule saved: allow <code>${esc(e.rule.match)}</code> · ${esc({ chat: 'this chat', project: 'this project', everywhere: 'everywhere' }[e.rule.scope] || e.rule.scope)}`, 'ok');
    else if (e.t === 'file') row(e.at, `${e.deleted ? '🗑' : '📝'} ${esc(e.path)}${e.deleted ? ' · moved to trash' : e.bytes != null ? ` · ${e.bytes} bytes` : ' · edited'}`, 'file');
    else if (e.t === 'compacted') row(e.at, `🗜 Earlier turns summarised to keep the context small<details class="out"><summary>summary</summary><pre>${esc(e.summary)}</pre></details>`, 'note');
    else if (e.t === 'note') row(e.at, `<span class="${e.level === 'info' ? '' : 'warn'}">${e.level === 'info' ? 'ℹ' : '⚠'} ${esc(e.msg)}</span>`, e.level === 'info' ? 'note' : 'warn');
    else if (e.t === 'llm_retry') row(e.at, `<span class="warn">↻ The model call failed (${esc(e.msg)}); retry ${e.attempt} of ${e.of} after ${secs(e.wait)}</span>`, 'warn');
    else if (e.t === 'parallel') row(e.at, `⇉ ${e.names.length} look-ups at the same time: ${esc(e.names.join(', '))}`, 'tool');
    else if (e.t === 'lint') row(e.at, `🎨 Design lint: ${e.hits.length} note${e.hits.length === 1 ? '' : 's'} on ${esc(e.path)}<div class="sub">${e.hits.map((h) => `<b>${h.level === 'fix' ? 'fix' : 'consider'}</b> · ${esc(h.msg)}`).join('<br>')}</div>`);
    else if (e.t === 'check') row(e.at, `<span class="warn">🔎 Check found ${e.problems.length} problem${e.problems.length === 1 ? '' : 's'} in ${esc(e.path)}</span><div class="sub">${e.problems.map(esc).join('<br>')}</div>`, 'warn');
    else if (e.t === 'trimmed') row(e.at, `✂ Trimmed ${Math.round(e.saved / 1000)}k characters of old file contents from this reply (${Math.round(e.size / 1000)}k left)`, 'note');
    else if (e.t === 'compacted_run') row(e.at, `🗜 Summarised the earlier part of this reply (${Math.round(e.size / 1000)}k characters left)`, 'note');
    else if (e.t === 'verify_start') row(e.at, `🔍 Checking the work before the final reply${e.files ? ` · ${e.files} changed file${e.files === 1 ? '' : 's'}` : ''}`, 'browser');
    else if (e.t === 'verify') row(e.at, `${e.ok ? '✅ Checks passed' : `<span class="warn">⚠ Checks found ${e.problems.length} problem${e.problems.length === 1 ? '' : 's'}</span>`}${e.problems.length ? `<div class="sub">${e.problems.map(esc).join('<br>')}</div>` : ''}${e.lint && (e.lint.fix || e.lint.consider) ? `<div class="sub">🎨 design lint still notes ${e.lint.fix} to fix, ${e.lint.consider} to consider (${esc(e.lint.ids.join(', '))})</div>` : ''}${e.note ? `<div class="sub">ℹ ${esc(e.note)}</div>` : ''}${(e.pages || []).map((p) => `<div class="sub">opened ${esc(p.target)} · ${p.problems ? `${p.problems} problem${p.problems === 1 ? '' : 's'}` : 'no errors'}</div>${p.image ? `<img class="shot" src="${p.image}" alt="what the check saw" loading="lazy">` : ''}`).join('')}`, e.ok ? 'ok' : 'warn');
    else if (e.t === 'sent_back') row(e.at, `↩ ${e.by === 'reviewer' ? 'The reviewer sent it back' : 'Sent back'} to fix ${e.problems} problem${e.problems === 1 ? '' : 's'} (round ${e.round})${e.aside ? `<div class="aside">💬 ${esc(e.aside)}</div>` : ''}`, 'warn');
    else if (e.t === 'question' && e.secret) row(e.at, `🔑 Asked you for <b>${esc(e.secret.name)}</b>${e.secret.why ? `<div class="sub">${esc(e.secret.why)}</div>` : ''}`, 'ask');
    else if (e.t === 'question') row(e.at, `❓ ${e.auto ? 'Asked (⚡ YOLO: the deciders answer for you)' : 'Asked you'}: <b>${esc(e.question)}</b><div class="sub">${e.questions ? e.questions.map((q, i) => `${i + 1}. ${esc(q.question)} (${q.options.map(esc).join(' · ')})`).join('<br>') : e.options.map(esc).join(' · ')}</div>`, 'ask');
    else if (e.t === 'answer' && e.secret) row(e.at, `🔑 ${esc(e.text || '')}`, e.secret.set ? 'ok' : 'warn');
    else if (e.t === 'answer') row(e.at, e.by === 'deciders' ? `⚖️ The deciders answered for you: <b>${esc(e.label || e.text || '')}</b>${e.confidence != null ? ` · ${Math.round(e.confidence * 100)}% sure` : ''}` : `💬 You answered: ${esc(e.label || e.text || '')}`, 'ok');
    else if (e.t === 'checks' && e.kind === 'gap') row(e.at, `🧭 <b>Gap check</b> · ${e.build ? 'a build' : 'not a build, so nothing to ask'}${e.build ? `<div class="sub">${e.rows.filter((r) => r.label).map((r) => `<span class="chk ${r.missing ? 'miss' : 'ok'}">${r.missing ? '✗ not said' : '✓'} ${esc(r.label)}</span>`).join(' ')}</div>` : ''}<div class="sub">Fixed harness questions about your message, answered by the deciders${e.ms ? ` in ${secs(e.ms)}` : ''}.</div>`, e.rows.some((r) => r.missing) ? 'warn' : 'ok');
    else if (e.t === 'checks' && e.kind === 'page') { const bad = e.rows.filter((r) => r.fail); row(e.at, `🔎 <b>Harness checks</b> on ${esc(e.target)} (${e.when === 'verify' ? 'before the final reply' : 'after the preview'}) · ${bad.length ? `<span class="warn">${bad.length} problem${bad.length > 1 ? 's' : ''}</span>` : `${e.rows.length} passed`}<div class="sub">${e.rows.map((r) => `<span class="chk ${r.fail ? 'miss' : 'ok'}" title="${r.p == null ? 'no answer' : `${Math.round(r.p * 100)}% fine`}">${r.fail ? '✗' : '✓'} ${esc(r.fail ? r.label : r.id)}</span>`).join(' ')}</div>${e.clicked ? `<div class="sub">clicked “${esc(e.clicked)}” to see whether it responds</div>` : ''}${e.image ? `<img class="shot" src="${e.image}" alt="what the checks saw" loading="lazy">` : ''}${e.after ? `<img class="shot" src="${e.after}" alt="after the click" loading="lazy">` : ''}`, bad.length ? 'warn' : 'ok'); }
    else if (e.t === 'budget_ask') row(e.at, `💵 The project budget is used up (${money(e.spent, 3)} of ${money(e.budget, 2)}); asked you to raise it or wrap up`, 'ask');
    else if (e.t === 'budget_done') row(e.at, e.raised ? `✅ Budget raised to ${e.budget == null ? 'no limit' : money(e.budget, 2)}; carrying on` : '⛔ Wrapped up at the budget', e.raised ? 'ok' : 'warn');
    else if (e.t === 'resumed') row(e.at || 0, '<span class="warn">▶ Resumed from the last finished step</span>', 'warn');
    else if (e.t === 'interrupted') row(e.at || 0,`<span class="warn">⚠ The harness restarted while this reply was running${e.resumable ? '. It can be resumed.' : '.'}</span>`, 'warn');
  }
  if (mediaStatus && m.live) row(mediaStatus.at, `⏳ ${esc(mediaStatus.tool)}: ${esc(mediaStatus.status)} · ${secs(mediaStatus.ms)}`, 'tool');
  return out.map((h) => h.replace(/<span data-round="(\d+)"><\/span>/, (_, r) => decideCard(rounds[r]))).join('');
}
function argSummary(e) {
  const a = e.args || {};
  if (e.name === 'write_artifact') return `${a.id ? `replace ${a.id}` : 'new'} · "${a.title}" · ${a.markdown && !/^\(0 /.test(String(a.html)) ? `${a.markdown} of Markdown` : a.html}`;
  if (e.name === 'edit_artifact') return `${a.id}: replace ${JSON.stringify(String(a.find || '').slice(0, 60))} → ${JSON.stringify(String(a.replace || '').slice(0, 60))}`;
  if (e.name === 'read_artifact') return a.id;
  if (e.name === 'search_docs') return `"${a.query || ''}"${a.docs?.length ? ` in ${a.docs.join(', ')}` : ''}`;
  if (e.name === 'read_doc') return `${a.doc} from line ${a.offset || 1}`;
  if (e.name === 'run_command' || e.name === 'start_server') return `${e.name === 'start_server' ? `"${a.name}": ` : ''}${[a.command, ...(a.args || [])].join(' ')}`;
  if (['write_file', 'read_file', 'edit_file', 'append_file', 'delete_file'].includes(e.name)) return a.path;
  if (e.name === 'search_files') return `"${a.query}"${a.glob ? ` in ${a.glob}` : ''}`;
  if (e.name === 'use_skill' || e.name === 'save_skill') return a.name;
  if (e.name === 'scaffold') return a.template;
  if (e.name === 'fetch_url') return a.url;
  if (e.name === 'browser') return `${a.action}${a.target ? ` ${a.target}` : ''}${a.text ? ` "${a.text}"` : ''}${a.selector ? ` ${a.selector}` : ''}${a.key ? ` ${a.key}` : ''}`;
  if (e.name === 'look') return (a.checks || []).map((x) => x.ask).join(' · ');
  return a.why || a.prompt || a.text || JSON.stringify(a).slice(0, 160);
}
function decideCard(r) {
  if (!r) return '';
  const { start, votes, done } = r;
  const res = Object.fromEntries((done?.results || []).map((x) => [x.id, x]));
  const qs = start.questions.map((q) => {
    const x = res[q.id];
    const [bl, bt] = BUCKET[x?.bucket] || ['…', ''];
    const top = x ? Object.entries(x.dist).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
    return `<div class="dq">
      <div class="ask">${esc(q.ask)}</div>
      <div class="vs">
        <span>agent guessed</span><span>${esc(q.guess || '—')} · ${pct(q.guessConf)} sure</span>
        <span>deciders said</span><span>${x ? `<b>${esc(x.pick)}</b> · ${pct(x.confidence)} confident · ${x.agree}/${x.n} agree · ${esc(x.verdict)}` : 'asking…'}</span>
        ${top.length > 1 ? `<span>spread</span><span>${top.map(([k, p]) => `${esc(k)} ${p.toFixed(2)}`).join(' · ')}</span>` : ''}
      </div>
      ${x ? `<div><span class="badge ${x.bucket}" title="${esc(bt)}">${esc(bl)}</span></div>` : ''}
    </div>`;
  }).join('');
  const vs = start.voters.map((model, vi) => {
    const v = votes.find((x) => x.vi === vi);
    return `<span class="voter ${v?.error ? 'err' : ''}" title="${esc(v?.error || model)}">${esc(short(model))}${v ? (v.error ? ' ✕' : ` ${v.ms}ms`) : ' …'}</span>`;
  }).join('');
  return `${start.look ? '👁 <b>Looked at the result</b>' : '⚖️ <b>Asked the deciders</b>'} (round ${start.round})${done ? ` · ${secs(done.ms)}` : ''}${start.images > 1 ? ` · ${start.images} images` : ''}
    <div class="dcard"><div class="state">${start.image ? `<img class="shot" src="${start.image}" alt="what the judges saw">` : ''}${esc(start.look ? start.state : `State: ${start.state}`)}<div class="voters">${vs}</div></div>${qs}</div>`;
}

// ---------- approvals ----------
// Cards can only be answered while their reply runs; older ones without an answer show as closed.
// An answered approval, shown on the tool call it was about: ✓ / ⛔ / ⚡ and the price on the row, who and why inside.
function approvalBadge(a, live) {
  const c = a.card, o = a.outcome;
  const state = o ? (o.approve ? 'yes' : 'no') : live ? 'wait' : 'none';
  const who = o ? `${o.approve ? 'Allowed' : 'Declined'} by ${byName(o.by)}${o.always ? ' · always allowed from now on' : ''}${o.approve && o.model && o.model !== c.model ? ` · switched to ${esc(short(o.model))}` : ''}${o.reason ? ` · ${esc(o.reason)}` : ''}`
    : live ? (c.tool === 'shell' ? 'The deciders are voting on this command…' : 'The deciders are checking whether this is needed and worth the price…') : 'Not answered: the reply ended';
  const mark = { yes: '✓', no: '⛔', wait: '⚡', none: '·' }[state];
  const price = c.free ? '' : money(c.est, 3);
  return {
    badge: `<span class="tl-ap ${state}" title="${esc(who.replace(/<[^>]+>/g, ''))}">${mark}${price ? ` ${price}` : ''}</span>`,
    detail: `<div class="tl-ap-detail ${state}">${who}${!c.free ? ` · ${esc(short(o?.model || c.model))}${c.detail ? ` · ${esc(c.detail)}` : ''}` : ''}${c.why ? `<div class="dim">Why: ${esc(c.why)}</div>` : ''}</div>`,
  };
}
// ---------- a command waiting for you: what it is, what it touches, why it asks, and how wide a rule to save ----------
const CMD_CLASS = { read: 'reads only', net: 'reads the web', write: 'writes in the project', build: 'runs project code', install: 'installs packages', external: 'leaves this computer',
  opaque: 'can’t be checked', delete: 'deletes', discard: 'throws away work', never: 'never allowed', unknown: 'no rule covers it' };
const CMD_ZONE = { inside: 'in the project', outside: 'outside the project', unknown: 'can’t be resolved', blocked: 'blocked', protected: 'protected' };
const byName = (by) => (by === 'user' ? 'you' : by === 'timeout' ? 'no answer in time' : by === 'plan' ? 'the approved production plan' : esc(by));
// ⚡ YOLO cards that wait for you a few seconds: a countdown, what happens when it ends, and "Wait for me".
function waitHTML(card) {
  const w = card.wait;
  if (!w) return '';
  if (w.held) return '<div class="aw held"><span class="aw-text">⏸ Waiting for you: nothing happens until you answer.</span></div>';
  const then = { deciders: 'the deciders answer for you', run: 'it runs (the deciders saw little risk)', skip: 'it is skipped (the deciders weren\'t sure it is harmless)' }[w.then] || 'the reply carries on';
  const left = Math.max(0, Math.ceil((w.until - Date.now()) / 1000));
  return `<div class="aw" data-until="${w.until}" data-secs="${w.secs}" data-run="${esc(w.runId || '')}" data-id="${esc(card.id)}"><span class="aw-bar" aria-hidden="true"><i style="width:${Math.min(100, (left / (w.secs || 1)) * 100)}%"></i></span><span class="aw-text">⚡ No answer in <b class="aw-n">${left}</b>s and ${then}.</span><button type="button" class="aw-hold" title="Stop the clock: the card waits until you answer">Wait for me</button></div>`;
}
// One clock for every countdown on the page; "Wait for me", or starting to type in the card, stops it.
setInterval(() => {
  for (const el of document.querySelectorAll('.aw[data-until]')) {
    const ms = Number(el.dataset.until) - Date.now(), n = $('.aw-n', el), bar = $('.aw-bar i', el);
    if (n) n.textContent = String(Math.max(0, Math.ceil(ms / 1000)));
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (ms / 1000 / (Number(el.dataset.secs) || 1)) * 100))}%`;
    if (ms <= 0) { el.classList.add('done'); const t = $('.aw-text', el); if (t && !el.dataset.out) { el.dataset.out = '1'; t.textContent = '⚡ No answer in time: carrying on…'; } }
  }
}, 250);
function holdWait(aw) {
  if (!aw || aw.dataset.holding || !aw.dataset.until || Number(aw.dataset.until) <= Date.now()) return;
  aw.dataset.holding = '1';
  aw.classList.add('held');
  aw.innerHTML = '<span class="aw-text">⏸ Waiting for you: nothing happens until you answer.</span>';
  postJ(`/api/runs/${aw.dataset.run}/hold`, { id: aw.dataset.id }).catch(() => {});
}
document.addEventListener('click', (e) => { const b = e.target.closest?.('.aw-hold'); if (b) holdWait(b.closest('.aw')); });
document.addEventListener('focusin', (e) => {
  if (!e.target.matches?.('textarea, input[type="text"]')) return;
  const card = e.target.closest('.approval');
  if (card) holdWait($('.aw[data-until]', card));
});
function shellCardHTML(a) {
  const c = a.card, p = c.policy || {};
  const segs = (p.segments || []).map((s) => `<div class="sc-seg"><code>${esc(clip(s.text, 200))}</code><span class="sc-cls" data-cls="${esc(s.cls)}">${esc(CMD_CLASS[s.cls] || s.cls)}${s.global ? ' · whole computer' : ''}${s.via ? ` · run by ${esc(s.via)}` : ''}</span>${(s.paths || []).map((x) => `<span class="sc-path" data-zone="${esc(x.zone)}">${esc(CMD_ZONE[x.zone] || x.zone)} · ${esc(clip(x.path, 90))}</span>`).join('')}</div>`).join('');
  const sug = (p.segments || []).find((s) => s.verdict !== 'allow')?.suggest || p.segments?.[0]?.suggest || { exact: c.what, prefix: c.what, program: c.what };
  const seg = (group, opts) => `<div class="seg sc-pick" data-group="${group}">${opts.map(([v, l], i) => `<button type="button" data-v="${esc(v)}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const risk = c.risk === 'danger' ? '<div class="sc-risk" data-risk="danger">⛔ This reads your keys or sign-ins. Only say yes if you asked for exactly this.</div>'
    : c.risk === 'warn' ? '<div class="sc-risk" data-risk="warn">⚠ This reaches past the project: a deploy, a push, a whole-computer install, or files outside the project.</div>' : '';
  return `<div class="approval shell-card" data-id="${esc(c.id)}" data-tool="shell"${c.risk ? ` data-risk="${esc(c.risk)}"` : ''}>
    <h4>⌨️ Run a command <small>(free${p.shell ? ` · ${esc(p.shell)}` : ''})</small></h4>${risk}
    <pre class="sc-line">${esc(c.what)}</pre>
    ${segs ? `<div class="sc-segs">${segs}</div>` : ''}
    ${(p.packages || []).length ? `<div class="sc-segs">${p.packages.map((k) => `<span class="sc-path" data-zone="${k.verdict === 'ok' ? 'inside' : k.verdict === 'missing' ? 'blocked' : 'unknown'}">📦 ${esc(k.name)} · ${esc(k.eco)} · ${k.verdict === 'ok' ? `${k.ageDays != null ? `${Math.round(k.ageDays / 365 * 10) / 10} years old` : 'exists'}${k.weekly != null ? ` · ${k.weekly.toLocaleString()}/week` : ''}` : esc(k.note)}</span>`).join('')}</div>` : ''}
    ${c.why ? `<div class="what">Why it asks: ${esc(c.why)}</div>` : ''}
    ${waitHTML(c)}
    <textarea rows="1" placeholder="To deny it, you can add a note: why, or what to do instead. Enter denies and sends it."></textarea>
    <div class="acts"><button type="button" class="primary yes">Run once</button>${c.noAlways ? '' : '<button type="button" class="sc-always" aria-expanded="false">Always allow…</button>'}<button type="button" class="no">Deny</button></div>
    ${c.noAlways ? '<div class="sc-note">A button can’t make a rule for this kind of command. If you’re sure, type one yourself in ⚙ Settings → Safety & commands.</div>'
      : `<div class="sc-rule" hidden>
        <div class="sc-row"><span class="sc-k">What</span>${seg('match', [[sug.exact, 'This exact command'], [sug.prefix, `Starting with <code>${esc(sug.prefix.replace(/\*$/, ''))}</code>`], [sug.program, `Any <code>${esc(sug.program.replace(/\*$/, ''))}</code> command`]])}</div>
        <div class="sc-row"><span class="sc-k">Where</span>${seg('scope', [['chat', 'This chat'], ['project', 'This project'], ['everywhere', 'Everywhere']])}</div>
        <div class="sc-row"><span class="sc-k">Rule</span><code class="sc-preview">allow ${esc(sug.exact)}</code><button type="button" class="primary sc-save">Allow and save</button></div>
        <div class="sc-warn" hidden>“Any” lets every use of this program run without asking, including ones that run other code.</div>
      </div>`}
  </div>`;
}
// The note on an approval card goes with a "no": once there is one, the no button says so and Enter sends it.
function noteLeadsToNo(card, label, no) {
  const ta = $('textarea', card), b = $('.acts .no', card);
  if (!ta || !b) return;
  const sync = () => { const has = !!ta.value.trim(); b.textContent = has ? `${label} and send note` : label; b.classList.toggle('with-note', has); };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (ta.value.trim() && !b.disabled) no(); } });
  sync();
}
function wireShellCard(card, m) {
  const id = card.dataset.id;
  const answer = async (approve, rule) => {
    card.querySelectorAll('button, textarea').forEach((b) => (b.disabled = true));
    const reason = $('textarea', card)?.value.trim() || '';
    await fetch('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m.runId, id, approve, reason, ...(rule ? { rule } : {}) }) }).catch(() => {});
  };
  $('.yes', card).onclick = () => answer(true);
  $('.no', card).onclick = () => answer(false);
  noteLeadsToNo(card, 'Deny', () => answer(false));
  const panel = $('.sc-rule', card), btn = $('.sc-always', card);
  if (!panel || !btn) return;
  const pick = (g) => $(`.sc-pick[data-group="${g}"] button.on`, card)?.dataset.v;
  const show = () => {
    $('.sc-preview', card).textContent = `allow ${pick('match')} · ${{ chat: 'in this chat', project: 'in this project', everywhere: 'everywhere' }[pick('scope')]}`;
    $('.sc-warn', card).hidden = $('.sc-pick[data-group="match"] button:last-child', card) !== $('.sc-pick[data-group="match"] button.on', card);
  };
  btn.onclick = () => { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); show(); };
  for (const b of card.querySelectorAll('.sc-pick button')) b.onclick = () => { for (const x of b.parentElement.children) x.classList.toggle('on', x === b); show(); };
  $('.sc-save', card).onclick = () => answer(true, { match: pick('match'), scope: pick('scope') });
}
function approvalHTML(a, live = true) {
  const c = a.card, o = a.outcome;
  const waiting = !o && c.mode === 'strict' && live;
  if (waiting && c.tool === 'shell' && c.policy) return shellCardHTML(a);
  const opts = c.options || [];
  const finalModel = o?.model || c.model;
  const name = TOOL_NAME[c.tool] || esc(c.tool);
  const head = c.free ? `<h4>${name} <small>(free)</small></h4>` : `<h4>${name} · <span class="cost">${money(c.est, 3)}</span> <small>(${esc(c.basis || 'estimated')})</small></h4>`;
  // A production plan (media_plan): one row per kind of paid call, approved together.
  const planRows = c.items ? `<ul class="ap-plan">${c.items.map((x) => `<li><b>${x.count} ×</b> ${esc({ image: '🖼 picture', video: '🎬 clip', music: '🎵 music', speech: '🗣 voice' }[x.kind] || x.kind)} · ${esc(short(x.model))}${x.detail ? ` · ${esc(x.detail)}` : ''}<span class="cost">${money(x.each * x.count, 3)}</span>${x.what ? `<div class="dim">${esc(x.what)}</div>` : ''}</li>`).join('')}</ul>` : '';
  const model = c.free ? '' : c.items ? planRows : waiting && opts.length > 1
    ? `<label class="what">Model <select class="pickModel">${opts.map((x) => `<option value="${esc(x.model)}" data-est="${x.est}" ${x.model === c.model ? 'selected' : ''}>${esc(short(x.model))} · ${money(x.est, 3)} · ${esc(x.detail)}${x.model === c.model ? (c.pickedBy === 'agent' ? ' (agent’s choice)' : ' (your default)') : ''}</option>`).join('')}</select></label>`
    : `<div class="what">${esc(short(finalModel))} · ${esc(c.detail)}${c.pickedBy === 'agent' && finalModel === c.model ? ' · chosen by the agent' : ''}</div>`;
  // Answered (or no longer waiting): one line, ✓/⛔ + the tool + what it did + the price; click it for the details.
  if (!waiting) {
    const state = o ? (o.approve ? 'yes' : 'no') : live ? 'wait' : 'none';
    const mark = { yes: '✓', no: '⛔', wait: '⚡', none: '·' }[state];
    const who = o ? `${o.approve ? 'Allowed' : 'Declined'} by ${byName(o.by)}${o.always ? ' · always allowed from now on' : ''}${o.approve && o.model && o.model !== c.model ? ` · switched to ${esc(short(o.model))}` : ''}${o.reason ? ` · ${esc(o.reason)}` : ''}`
      : live ? (c.tool === 'shell' ? 'The deciders are voting on this command…' : 'Deciders are checking whether this is needed and worth the price…') : 'Not answered: the reply ended';
    return `<details class="approval-line ${state}"><summary title="${esc(who)}"><span class="al-mark">${mark}</span><b>${name}</b><span class="al-what">${esc(c.what)}</span><span class="al-price">${c.free ? 'free' : money(c.est, 3)}</span></summary>
      <div class="al-detail">${c.items ? planRows : `${c.free ? '' : `<div>${esc(short(finalModel))} · ${esc(c.detail || '')}</div>`}<div>${esc(c.what)}</div>`}${c.why ? `<div>Why: ${esc(c.why)}</div>` : ''}<div class="al-who ${state}">${who}</div></div></details>`;
  }
  // A card that acts in the user's own account (a lent tab: send, delete, buy…) is red, and says so.
  const danger = c.risk === 'danger' && waiting ? '<div class="sc-risk" data-risk="danger">⛔ This acts in your own account. Only say yes if you want exactly this.</div>' : '';
  return `<div class="approval ${o ? 'done' : ''} ${c.free ? 'free' : ''}" ${waiting ? `data-id="${esc(c.id)}" data-tool="${esc(c.tool)}"` : ''}${c.risk ? ` data-risk="${esc(c.risk)}"` : ''}>
    ${head}${model}${danger}
    ${c.items ? '' : `<div class="what">${c.free ? esc(c.what) : `“${esc(c.what)}”`}</div>`}
    ${c.why ? `<div class="what">Why: ${esc(c.why)}</div>` : ''}${c.items && waiting ? '<div class="what dim">Calls that match this plan then run without asking again; anything else asks on its own.</div>' : ''}
    ${waiting ? `${waitHTML(c)}<textarea rows="1" placeholder="To decline, you can add a note: why, or what to do instead. Enter declines and sends it."></textarea>
      <div class="acts"><button type="button" class="primary yes">${c.tool === 'remember' ? 'Save to memory' : c.free ? 'Allow once' : `Approve ${money(c.est, 3)}`}</button>${c.noAlways ? '' : '<button type="button" class="always" title="Stop asking for this tool in this chat">Always allow</button>'}<button type="button" class="no">${c.tool === 'remember' ? "Don't save" : 'Decline'}</button></div>`
      : o ? `<div class="outcome ${o.approve ? 'yes' : 'no'}">${o.approve ? '✅ Allowed' : '⛔ Declined'} by ${byName(o.by)}${o.always ? ' · always allowed from now on' : ''}${o.approve && o.model && o.model !== c.model ? ` · switched to ${esc(short(o.model))}` : ''}${o.reason ? ` · ${esc(o.reason)}` : ''}</div>`
      : !live ? '<div class="outcome">Not answered: the reply ended</div>' : `<div class="outcome">⚡ ${c.tool === 'shell' ? 'The deciders are voting on this command…' : 'Deciders are checking whether this is needed and worth the price…'}</div>`}
  </div>`;
}
function wireApproval(card, m) {
  if (card.classList.contains('shell-card')) return wireShellCard(card, m);
  const id = card.dataset.id;
  const sel = $('.pickModel', card);
  if (sel) sel.onchange = () => { $('.yes', card).textContent = `Approve ${money(Number(sel.selectedOptions[0].dataset.est), 3)}`; };
  const answer = async (approve, always = false) => {
    card.querySelectorAll('button, select').forEach((b) => (b.disabled = true));
    const reason = $('textarea', card)?.value.trim() || '';
    await fetch('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m.runId, id, approve, always, reason, model: sel?.value }) }).catch(() => {});
  };
  $('.yes', card).onclick = () => answer(true);
  const always = $('.always', card); if (always) always.onclick = () => answer(true, true);
  $('.no', card).onclick = () => answer(false);
  noteLeadsToNo(card, 'Decline', () => $('.no', card).click());
}

// ---------- the project budget card (🔒 Strict, when a reply reaches the budget) ----------
// ---------- out of steps: keep going, keep going with another model, or a fresh chat from a brief ----------
function outOfStepsHTML(m) {
  const e = (m.trace || []).find((x) => x.t === 'out_of_steps');
  if (!e || m.live) return '';
  const used = m.oosUsed;
  const rec = (k) => (e.recommend === k ? ' primary' : '');
  const star = (k) => (e.recommend === k ? ' <span class="oos-rec">recommended</span>' : '');
  return `<div class="approval oos-card ${used ? 'done' : ''}" ${used ? '' : `data-run="${esc(e.runId || m.runId)}"`}>
    <h4>⏱ Out of steps · <span class="cost">${e.steps} steps · ${money(e.cost, 3)}</span></h4>
    <div class="what">${e.plan ? `Plan ${e.plan.done} of ${e.plan.of} done${e.plan.open.length ? `; left: ${e.plan.open.map(esc).join(' · ')}` : ''}. ` : ''}${esc(e.why || '')}</div>
    ${used ? `<div class="outcome yes">${used === 'more' ? '▶ Kept going with more steps' : used === 'fresh' ? '✦ Opened a fresh chat from a brief' : `⇄ Kept going with ${esc(short(used.slice(6)))}`}</div>`
      : `<div class="acts oos-acts">
        <button type="button" class="oos-more${rec('more')}" title="Same model, same context: carries on from where it stopped">▶ Keep going <small>+${e.more} steps · ≈ ${money(e.estimate, 3)}</small>${star('more')}</button>
        <button type="button" class="oos-model${rec('model')}" title="Same context with a model you pick (🟢 = did well in our tests)">⇄ Another model…${star('model')}</button>
        <button type="button" class="oos-fresh${rec('fresh')}" title="A cheap model writes a short handover brief (goal, files, what works, what's left, known bugs) into a new chat with a model you pick. A clean context makes every step cheaper.">✦ Fresh chat from a summary…${star('fresh')}</button>
      </div><div class="what err" hidden></div>`}
  </div>`;
}
// A new chat in the same project, on the model picked, with the brief in its message box (you check it, then send).
function openFreshChat(c, brief, model) {
  const n = blankChat(c.projectId);
  n.title = `Continue: ${c.title}`.slice(0, 60);
  n.approval = c.approval;
  n.tools = JSON.parse(JSON.stringify(c.tools || {}));
  n.agent.setup = { ...JSON.parse(JSON.stringify(c.agent.setup)), model };
  n.remixOf = { chatId: c.id, title: c.title, at: Date.now() };
  G.open.set(n.id, n); G.panes = [n.id]; G.focus = 0;
  G.view = { id: null, src: false, files: false }; G.traceRun = null;
  renderPanes(); saveChat(n, true); savePrefs(); renderSidebar();
  const ta = $('.input', n.el.root);
  if (ta) { ta.value = `Carry on with this work. Handover from the chat "${c.title}":\n\n${brief}`; ta.focus(); ta.dispatchEvent(new Event('input')); }
}
// /fresh [model]: a brief of this whole chat, then a new chat with it.
async function freshFromChat(c, arg) {
  if (c.running) return uiAlert('This chat is still working. Stop it first, or wait for the reply.');
  if (!c.agent.messages.length) return uiAlert('This chat has nothing to carry over yet.');
  const id = arg ? findModel(c, arg) : await pickModel('chat', c.agent.setup.model, { context: 'Model for the fresh chat' });
  if (!id) return arg ? uiAlert(`No model matches "${arg}".`) : null;
  await saveChat(c, true);
  const r = await postJ(`/api/chats/${c.id}/brief`, {});
  if (!r || r.error) return uiAlert(`The brief could not be written: ${r?.error || 'no answer'}`);
  if (r.cost) { (c.agent.extraUsage ||= []).push({ kind: 'summary', model: r.model, cost: r.cost, at: Date.now() }); saveChat(c); }
  openFreshChat(c, r.brief, id);
}
// /continue [steps]: the last reply here that ran out of steps carries on (the ⏱ card's Keep going).
function continueLast(c, arg) {
  if (c.running) return uiAlert('This chat is already working.');
  const m = [...c.agent.messages].reverse().find((x) => x.role === 'assistant' && (x.trace || []).some((e) => e.t === 'out_of_steps'));
  if (!m) return uiAlert('No reply in this chat ran out of steps, so there is nothing to continue. Just send a message to keep working.');
  if (m.oosUsed) return uiAlert('That reply was already continued (or moved to a fresh chat).');
  const e = m.trace.find((x) => x.t === 'out_of_steps');
  const more = Math.max(5, Math.min(200, Number(arg) || e.more || 30));
  m.oosUsed = 'more'; updateMsg(c, m); saveChat(c);
  runChat(c, '', null, [], { resumeOf: e.runId || m.runId, more });
}
function wireOutOfSteps(card, c, m) {
  const e = (m.trace || []).find((x) => x.t === 'out_of_steps'), err = $('.err', card);
  const fail = (t) => { err.hidden = false; err.textContent = t; };
  const go = (opts, mark) => { if (c.running) return fail('A reply is already running in this chat.'); m.oosUsed = mark; updateMsg(c, m); saveChat(c); runChat(c, '', null, [], { resumeOf: card.dataset.run, more: e.more, ...opts }); };
  $('.oos-more', card).onclick = () => go({}, 'more');
  $('.oos-model', card).onclick = async () => {
    const id = await pickModel('chat', c.agent.setup.model, { context: 'Keep going with another model (same context)' });
    if (!id) return;
    c.agent.setup.model = id; saveChat(c); renderComposerBar(c);
    go({ model: id }, `model:${id}`);
  };
  $('.oos-fresh', card).onclick = async () => {
    const id = await pickModel('chat', c.agent.setup.model, { context: 'Model for the fresh chat' });
    if (!id) return;
    const b = $('.oos-fresh', card); b.disabled = true; b.textContent = 'Writing the brief…';
    const r = await postJ(`/api/runs/${card.dataset.run}/brief`, {});
    if (!r || r.error) { b.disabled = false; b.textContent = '✦ Fresh chat from a summary…'; return fail(r?.error || 'The brief could not be written.'); }
    (c.agent.extraUsage ||= []).push({ kind: 'summary', model: r.model, cost: r.cost, at: Date.now() });
    m.oosUsed = 'fresh'; saveChat(c); updateMsg(c, m);
    openFreshChat(c, r.brief, id);
  };
}
function budgetHTML(b, live = true) {
  const c = b.card, o = b.outcome, open = !o && live;
  const next = Math.ceil(Math.max(c.budget * 2, c.spent * 1.5) * 100) / 100;
  // kind: 'reply' (this reply's cap), 'day' (today's cap across projects), or the project budget.
  const title = c.kind === 'reply' ? 'This reply’s cap reached' : c.kind === 'day' ? 'Today’s cap reached' : 'Project budget reached';
  const what = c.kind === 'reply' ? 'Every model this reply used counts (the agent, deciders, helpers, checks, media). Raise its cap to let it carry on, or wrap up here. Your default cap is in ⚙ Settings → Budget & approvals.'
    : c.kind === 'day' ? 'Today’s spending across all your projects reached your daily cap. Raise it for today to let this reply carry on, or wrap up here.'
    : 'All chats in this project together have used up its budget. Raise it to let this reply carry on, or wrap up here.';
  return `<div class="approval budget-card ${open ? '' : 'done'}" ${open ? `data-id="${esc(c.id)}" data-kind="${esc(c.kind || 'project')}"` : ''}>
    <h4>💵 ${title} · <span class="cost">${money(c.spent, 3)} of ${money(c.budget, 2)}</span></h4>
    <div class="what">${what}</div>
    ${open ? `<div class="acts own-row"><label class="what">Raise to $ <input type="number" class="own raise-to" min="${(Math.ceil(c.spent * 100) / 100).toFixed(2)}" step="0.5" value="${next.toFixed(2)}" aria-label="New budget in dollars"></label></div>
      <div class="acts"><button type="button" class="primary raise">Raise and carry on</button><button type="button" class="stop-here">Wrap up</button></div><div class="what err" hidden></div>`
      : `<div class="outcome ${o?.raised ? 'yes' : 'no'}">${o ? (o.raised ? `✅ Budget raised to ${o.budget == null ? 'no limit' : money(o.budget, 2)}; the reply carried on` : '⛔ Wrapped up at the budget') : 'Not answered: the reply ended'}</div>`}
  </div>`;
}
function wireBudget(card, c, m) {
  const err = $('.err', card), input = $('.raise-to', card);
  $('.raise', card).onclick = async () => {
    if (card.dataset.kind === 'reply' || card.dataset.kind === 'day') {
      const to = Number(input.value);
      if (!(to > Number(input.min))) { err.textContent = `Raise it above ${money(Number(input.min), 2)}.`; err.hidden = false; return; }
      card.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
      await fetch('/api/raise-cap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m.runId, id: card.dataset.id, to }) }).catch(() => {});
      return;
    }
    const p = G.projects.find((x) => x.id === c.projectId);
    const r = await fetch(`/api/projects/${c.projectId}/budget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budget: Number(input.value), fromCard: true }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) { err.textContent = `Could not raise it: ${r.error}.`; err.hidden = false; return; }
    card.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
    if (p) Object.assign(p, { budget: r.budget, spent: r.spent });
    refreshSidebar();
  };
  $('.stop-here', card).onclick = () => {
    card.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
    fetch('/api/budget-stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m.runId, id: card.dataset.id }) }).catch(() => {});
  };
}

// ---------- questions the agent asks (ask_user) ----------
// An answered question folds to one line (what was asked, what you chose); open it for the whole card.
function questionHTML(q, live = true) {
  const c = q.card, a = q.answer || (live ? null : { label: '(not answered: the reply ended)' });
  const full = questionCardHTML(q, live);
  if (!a || c.secret) return full;
  const n = c.questions?.length || 1, key = `q-${c.id}`;
  const label = n > 1 ? `Asked you ${n} questions` : c.gate === 'plan' ? 'Plan first' : c.auto ? 'The deciders answered' : 'Asked you';
  const said = clip(String(a.label || a.text || '').replace(/^Your answer: /, ''), 160);
  return `<details class="q-fold" data-qkey="${esc(key)}" ${G.qOpen?.has(key) ? 'open' : ''}><summary><span class="q-fold-ic" aria-hidden="true">✓</span><span class="q-fold-l">${esc(label)}${n === 1 && c.question ? `: <span class="q-fold-q">${esc(clip(c.question, 90))}</span>` : ''}</span><span class="q-fold-a">${esc(said)}</span><span class="tl-chev" aria-hidden="true">›</span></summary>${full}</details>`;
}
// Folded answers stay open or closed across redraws.
document.addEventListener('toggle', (e) => { const d = e.target; if (d.matches?.('details.q-fold')) (G.qOpen ||= new Set())[d.open ? 'add' : 'delete'](d.dataset.qkey); }, true);
function questionCardHTML(q, live = true) {
  const c = q.card, a = q.answer || (live ? null : { label: '(not answered: the reply ended)' });
  const picked = a && a.choice != null ? Number(a.choice) : null, missed = a && /^\(not answered/.test(a.label || '');
  // The question reads first, on the left; each answer is its own full-width row, numbered (press 1–9 to pick).
  if (c.auto) {
    const pk = a && a.choice != null ? Number(a.choice) : null;
    return `<div class="approval question qbox done auto">
    <div class="q-head"><span class="q-badge">⚡ YOLO · the deciders answer</span><p class="q-text">${esc(c.question)}</p></div>
    <div class="q-opts answered">${c.options.map((o, i) => `<div class="q-opt ${i === pk ? 'picked' : 'faded'}"><span class="q-key">${i === pk ? '✓' : i + 1}</span><span class="q-label">${esc(o)}</span></div>`).join('')}
      ${a ? `<div class="q-opt ${pk == null ? 'missed' : 'picked'} by-deciders"><span class="q-key">⚖</span><span class="q-label">${pk == null ? 'The deciders could not settle it, so the agent decides' : `The deciders picked this for you${a.confidence != null ? ` · ${Math.round(a.confidence * 100)}% sure` : ''}`}</span></div>` : '<div class="q-opt faded"><span class="q-key">…</span><span class="q-label">Asking the deciders…</span></div>'}</div>
  </div>`;
  }
  if (c.questions?.length) return questionsHTML(c, a);
  if (c.secret) return secretHTML(c, a);
  return `<div class="approval question qbox ${a ? 'done' : ''}" ${a ? '' : `data-id="${esc(c.id)}" tabindex="-1"`}>
    <div class="q-head"><span class="q-badge">${c.gate === 'plan' ? 'Plan first' : 'Question'}</span><p class="q-text">${esc(c.question)}</p></div>
    ${a ? `<div class="q-opts answered">${c.options.map((o, i) => `<div class="q-opt ${i === picked ? 'picked' : 'faded'}"><span class="q-key">${i === picked ? '✓' : i + 1}</span><span class="q-label">${esc(o)}</span></div>`).join('')}
        ${a.by === 'deciders' ? `<div class="q-opt ${picked == null ? 'missed' : 'picked'} by-deciders"><span class="q-key">⚖</span><span class="q-label">No answer in time: ${picked == null ? `${esc((a.text || 'the deciders could not settle it').replace(/^\w/, (x) => x.toLowerCase()))}, so the agent decides` : `the deciders picked this${a.confidence != null ? ` · ${Math.round(a.confidence * 100)}% sure` : ''}`}</span></div>`
          : picked == null ? `<div class="q-opt ${missed ? 'missed' : 'picked'}"><span class="q-key">${missed ? '–' : '✓'}</span><span class="q-label">${missed ? 'Not answered: the reply ended' : `Your answer: ${esc(a.label || a.text || '')}`}</span></div>` : ''}</div>`
      : `${waitHTML(c)}<div class="q-opts" role="group" aria-label="Answers">${c.options.map((o, i) => `<button type="button" class="opt q-opt" data-i="${i}"><span class="q-key">${i + 1}</span><span class="q-label">${esc(o)}</span></button>`).join('')}</div>
      <div class="own-row q-own"><input type="text" class="own" placeholder="${c.gate === 'plan' ? 'Or say what to change in the plan' : 'Or answer in your own words'}" aria-label="${c.gate === 'plan' ? 'What to change in the plan' : 'Your own answer'}"><button type="button" class="send-own">Send</button></div>`}
  </div>`;
}
// request_secret: the agent asks for a secret by name. The value goes from this box into the project's .env; the
// agent only hears that it is set, and the chat never keeps it.
function secretHTML(c, a) {
  const s = c.secret, missed = a && /^\(not answered/.test(a.label || '');
  if (a) return `<div class="approval question qbox secretq done">
    <div class="q-head"><span class="q-badge">Secret</span><p class="q-text">The agent needs <code>${esc(s.name)}</code>${s.why ? `: ${esc(s.why)}` : ''}</p></div>
    <div class="q-opts answered"><div class="q-opt ${a.secret?.set ? 'picked' : 'missed'}"><span class="q-key">${a.secret?.set ? '✓' : '–'}</span><span class="q-label">${missed ? 'Not answered: the reply ended' : esc(a.text || a.label || '')}</span></div></div>
  </div>`;
  return `<div class="approval question qbox secretq" data-id="${esc(c.id)}" tabindex="-1">
    <div class="q-head"><span class="q-badge">Secret</span><p class="q-text">The agent needs <code>${esc(s.name)}</code>${s.why ? `: ${esc(s.why)}` : ''}</p></div>
    <div class="own-row q-own"><input type="password" class="own secret-val" autocomplete="off" spellcheck="false" placeholder="Paste the value" aria-label="Value for ${esc(s.name)}"><label class="sq-check secret-show"><input type="checkbox" class="reveal"><span>Show</span></label></div>
    <p class="secret-note">Saved to this project's .env, never sent to the model: the agent only learns that ${esc(s.name)} is set.</p>
    <div class="acts"><button type="button" class="primary save-secret" disabled>Save</button><button type="button" class="skip-secret">Skip</button></div>
  </div>`;
}
function wireSecret(card, m) {
  const id = card.dataset.id, box = $('.secret-val', card), save = $('.save-secret', card);
  const send = (body) => {
    card.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
    box.value = '';
    fetch('/api/secret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m.runId, id, ...body }) }).catch(() => {});
  };
  box.oninput = () => { save.disabled = !box.value.trim(); };
  box.onkeydown = (e) => { if (e.key === 'Enter' && box.value.trim()) { e.preventDefault(); save.click(); } };
  $('.reveal', card).onchange = (e) => { box.type = e.target.checked ? 'text' : 'password'; };
  save.onclick = () => { if (box.value.trim()) send({ value: box.value }); };
  $('.skip-secret', card).onclick = () => send({ skip: true });
}
// Several questions in one card: pick per question (the agent's recommendation is preselected), or type your own words.
function questionsHTML(c, a) {
  const qs = c.questions;
  if (a) {
    const got = a.answers || [];
    return `<div class="approval question qbox qmulti done">
    <div class="q-head"><span class="q-badge">Questions · ${qs.length}</span><p class="q-text">${a.by === 'deciders' ? 'No answer in time: the deciders answered (the agent decides the rest)' : a.defaults ? 'You took the agent\'s recommendations' : a.answers ? 'Your answers' : 'Not answered: the reply ended'}</p></div>
    ${qs.map((q, i) => { const g = got[i] || {}; const said = g.choice != null ? q.options[g.choice] : a.by === 'deciders' ? 'The agent decides' : g.text ? `Your answer: ${g.text}` : 'No answer: the agent decides'; return `<div class="qm-item"><p class="qm-q"><span class="q-key">${i + 1}</span>${esc(q.question)}</p><div class="q-opt ${g.choice != null || g.text ? 'picked' : 'missed'}"><span class="q-key">${g.choice != null || g.text ? '✓' : '–'}</span><span class="q-label">${esc(said)}</span></div></div>`; }).join('')}
  </div>`;
  }
  return `<div class="approval question qbox qmulti" data-id="${esc(c.id)}" tabindex="-1">
    <div class="q-head"><span class="q-badge">Questions · ${qs.length}</span><p class="q-text">A few things to settle before the agent goes on. Its recommendation is selected; change what you like.</p></div>
    ${waitHTML(c)}
    ${qs.map((q, i) => `<div class="qm-item" data-q="${i}">
      <p class="qm-q"><span class="q-key">${i + 1}</span>${esc(q.question)}</p>
      <div class="q-opts" role="radiogroup" aria-label="${esc(q.question)}">${q.options.map((o, j) => `<button type="button" class="opt q-opt ${j === q.recommended ? 'chosen' : ''}" role="radio" aria-checked="${j === q.recommended}" data-i="${j}"><span class="q-label">${esc(o)}</span>${j === q.recommended ? '<span class="qm-rec">recommended</span>' : ''}</button>`).join('')}</div>
      <input type="text" class="own" placeholder="Or your own words" aria-label="Your own answer to question ${i + 1}">
    </div>`).join('')}
    <div class="acts"><button type="button" class="primary send-all">Send answers</button><button type="button" class="use-rec">Use the recommendations</button></div>
  </div>`;
}
function wireQuestions(card, m) {
  const id = card.dataset.id;
  const items = [...card.querySelectorAll('.qm-item')];
  const pick = (item, b) => item.querySelectorAll('.opt').forEach((x) => { const on = x === b; x.classList.toggle('chosen', on); x.setAttribute('aria-checked', String(on)); });
  for (const item of items) {
    const own = $('.own', item);
    for (const b of item.querySelectorAll('.opt')) b.onclick = () => { pick(item, b); own.value = ''; };
    own.oninput = () => { if (own.value.trim()) pick(item, null); };
    own.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('.send-all', card).click(); } };
  }
  const send = (body) => {
    card.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
    fetch('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m.runId, id, ...body }) }).catch(() => {});
  };
  $('.send-all', card).onclick = () => send({ answers: items.map((item) => {
    const text = $('.own', item).value.trim(), b = $('.opt.chosen', item);
    return text ? { text } : b ? { choice: Number(b.dataset.i) } : { text: '' };
  }) });
  const qs = m.questions?.[id]?.card?.questions || [];
  $('.use-rec', card).onclick = () => send({ defaults: true, answers: items.map((_, i) => (qs[i]?.recommended != null ? { choice: qs[i].recommended } : { text: '' })) });
}
function wireQuestion(card, m) {
  if (card.classList.contains('qmulti')) return wireQuestions(card, m);
  if (card.classList.contains('secretq')) return wireSecret(card, m);
  const id = card.dataset.id, own = $('.own', card);
  const answer = (body) => {
    card.querySelectorAll('button, input').forEach((b) => (b.disabled = true));
    fetch('/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m.runId, id, ...body }) }).catch(() => {});
  };
  for (const b of card.querySelectorAll('.opt')) b.onclick = () => answer({ choice: Number(b.dataset.i) });
  $('.send-own', card).onclick = () => { if (own.value.trim()) answer({ text: own.value.trim() }); };
  own.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('.send-own', card).click(); } };
  // 1–9 picks that answer while the card (not the text box) has focus.
  card.addEventListener('keydown', (e) => { if (e.target === own || !/^[1-9]$/.test(e.key)) return; const b = card.querySelectorAll('.opt')[Number(e.key) - 1]; if (b && !b.disabled) { e.preventDefault(); b.click(); } });
}

// ---------- running (each chat runs independently, so chats work in parallel) ----------
// While the agent works, what you send goes to it as a note it reads at its next step (it doesn't stop).
async function steer(c, text) {
  if ((c.docs || []).some((d) => d.busy)) { const ta = $('.input', c.el.root); if (ta && !ta.value) ta.value = text; uiAlert('Some attached files are still being read. Send when their chips say they are ready.'); return; }
  // Pictures, files and context go with the note, the same way they go with a message.
  const cmts = (c.comments || []).splice(0);
  const imgs = [...c.images.splice(0), ...cmts.filter((x) => x.crop).map((x) => ({ thumb: x.crop, full: x.crop }))], docs = (c.docs || []).splice(0).filter((d) => d.id && !d.busy), ctxItems = c.ctx.splice(0);
  renderAttachments(c);
  const pointed = cmts.length ? `The user pointed at on the page: ${cmts.map((x) => `${x.tag} "${x.text}" (${x.selector})${x.note ? `: ${x.note}` : ''}`).join('; ')}` : '';
  const context = [pointed, ctxItems.length ? await contextText(ctxItems).catch(() => '') : ''].filter(Boolean).join('\n\n');
  const r = await postJ(`/api/runs/${c.running.runId}/steer`, { text, images: imgs.map((x) => x.full), docs: docs.map((d) => d.id), context }).catch((e) => ({ error: e.message }));
  if (!r?.ok) {
    // Nothing is lost: the text and the attachments go back into the box.
    const ta = $('.input', c.el.root); if (ta && !ta.value) ta.value = text;
    c.images.unshift(...imgs.filter((x) => !cmts.some((k) => k.crop === x.full))); (c.docs ||= []).unshift(...docs); c.ctx.unshift(...ctxItems); (c.comments ||= []).unshift(...cmts); renderAttachments(c);
    uiAlert(`The note didn't reach the agent${r?.error ? `: ${r.error}` : ''}. It's back in the box.`);
    return;
  }
  // Keep the pictures with the note so the reply can show them (and they open large when clicked).
  const m = [...c.agent.messages].reverse().find((x) => x.role === 'assistant' && x.runId === c.running?.runId);
  if (m && (imgs.length || docs.length)) { (m.steerAtt ||= []).push({ text, imgs: imgs.map((x) => x.thumb), imgViews: imgs.map((x) => x.view || x.full), docs: docs.map(({ id, name, kind, size, rel }) => ({ id, name, kind, size, rel })) }); saveChat(c); }
}
// Anything waiting in the box besides text: pictures, files, @ context, or elements picked on the page.
const hasAttachments = (c) => !!(c.images.length || (c.docs || []).length || c.ctx.length || (c.comments || []).length);
// ✨ Enhance: the draft in the box, rewritten clearer and fuller by the prompt enhancer's model, before you send it.
// Press it again to go further, ↶ for your words back. Any chat, any time; nothing is sent until you send it.
async function enhanceDraft(c) {
  const ta = $('.input', c.el.root), btn = $('.enhBtn', c.el.root);
  const draft = ta.value.trim();
  if (!draft) return flashTip(btn, 'Write your message first, then ✨ makes it clearer');
  btn.disabled = true; btn.classList.add('busy');
  const earlier = c.agent.messages.filter((m) => m.role === 'user').slice(-3).map((m) => String(m.content || '').slice(0, 400));
  const r = await postJ('/api/enhance-prompt', { text: draft, earlier, model: enhancerModel() }).catch((e) => ({ error: e.message }));
  btn.disabled = false; btn.classList.remove('busy');
  if (r.error || !r.text) return flashTip(btn, `Could not enhance it: ${r.error || 'no answer'}`);
  (c.enhUndo ||= []).push(ta.value);
  ta.value = r.text; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
  if (r.cost) { (c.agent.extraUsage ||= []).push({ kind: 'enhancer', model: r.model, cost: r.cost, at: Date.now() }); saveChat(c); }
  renderEnhUndo(c);
}
function undoEnhance(c) {
  const ta = $('.input', c.el.root), prev = c.enhUndo?.pop();
  if (prev == null) return;
  ta.value = prev; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
  renderEnhUndo(c);
}
function renderEnhUndo(c) { const u = c.el && $('.enhUndo', c.el.root); if (u) u.hidden = !c.enhUndo?.length; }
async function send(c, text) {
  text = text.trim();
  // A picture, a file or context on its own is a message too.
  if (c.running || (!text && !c.images.length && !(c.docs || []).some((d) => d.id && !d.busy) && !c.ctx.length && !c.comments?.length)) return;
  c.enhUndo = []; renderEnhUndo(c);
  askNotifyPermission();
  const ctx =c.ctx.length ? { titles: c.ctx.map((x) => x.title), text: await contextText(c.ctx) } : null;
  const comments = (c.comments || []).splice(0);
  const imgs = [...c.images.splice(0), ...comments.filter((x) => x.crop).map((x) => ({ thumb: x.crop, full: x.crop }))];
  const docs = (c.docs || []).splice(0).filter((d) => d.id && !d.busy);
  c.ctx = []; renderAttachments(c);
  if ((!c.title || c.title === 'New chat') && text) { c.title = text.replace(/\s+/g, ' ').slice(0, 60); if (c.el) { $('.ch-name', c.el.root).value = c.title; } }
  runChat(c, text, ctx, imgs, { docs, comments });
}
async function runChat(c, text, ctx, imgs, { resumeOf, docs = [], more = 0, model = '', comments = [] } = {}) {
  const cmts = comments.map(({ selector, tag, text: t, section, rect, url, note, crop }) => ({ selector, tag, text: t, section, rect, url, note, crop: !!crop }));
  const a = c.agent;
  // After a compaction only the turns since the summary are sent, together with the summary.
  const history = a.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error && (!a.summaryAt || (m.at || 0) >= a.summaryAt)).map((m) => ({ role: m.role, at: m.at, content: m.role === 'assistant' ? `${m.content}${m.note || ''}` : `${m.cmts?.length ? `[pointed at on the page: ${m.cmts.map((x) => `${x.tag} "${x.text}" (${x.selector})${x.note ? `: ${x.note}` : ''}`).join('; ')}] ` : ''}${m.ctx?.length ? `[attached context: ${m.ctx.join(', ')}] ` : ''}${m.docs?.length ? `[attached files: ${m.docs.map((d) => d.name).join(', ')}; read them with read_doc / search_docs] ` : ''}${m.content}` }));
  const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Resuming after a restart carries on in the reply that was cut off (its steps so far stay above the new ones);
  // "Keep going" after running out of steps is a reply of its own.
  const cut = resumeOf && !more ? a.messages.find((x) => x.role === 'assistant' && x.runId === resumeOf) : null;
  const m = cut || { role: 'assistant', content: '', at: Date.now(), trace: [], approvals: {}, questions: {}, arts: [], runId, live: true, runActive: true };
  if (cut) {
    Object.assign(m, { runId, live: true, runActive: true, resumedFrom: [...(m.resumedFrom || []), resumeOf], error: undefined, resumable: false });
    if (m.stats?.partial) delete m.stats; // the resumed run's totals include what the cut-off part spent
    m.trace.push({ t: 'resumed', from: resumeOf, at: (m.trace.at(-1)?.at || 0) });
  }
  const user = resumeOf ? null : { role: 'user', content: text, at: Date.now(), ...(cmts.length ? { cmts: cmts.map(({ crop, ...x }) => x) } : {}), ...(ctx ? { ctx: ctx.titles } : {}), ...(imgs.length ? { imgs: imgs.map((x) => x.thumb), imgViews: imgs.map((x) => x.view || x.full) } : {}), ...(docs.length ? { docs: docs.map(({ id, name, kind, size, status, rel }) => ({ rel, id, name, kind, size, status })) } : {}) };
  if (!cut) a.messages.push(...(user ? [user] : []), m);
  const box = c.el && G.panes.includes(c.id) ? $('.msgs', c.el.root) : null;
  if (box && cut) { updateMsg(c, m); c.follow = true; c.toEnd?.(); }
  else if (box) { if (box.querySelector('.hint')) box.innerHTML = ''; if (user) box.appendChild(renderMsg(c, user)); box.appendChild(renderMsg(c, m)); c.follow = true; c.toEnd?.(); }
  const artifacts = Object.fromEntries(Object.entries(a.artifacts).map(([id, x]) => [id, x.kind === 'html' ? { kind: 'html', title: x.title, html: x.html, v: 1 } : x.kind === 'md' ? { kind: 'md', title: x.title, md: x.md || '', v: 1 } : { kind: x.kind, title: x.title, url: x.url?.startsWith('data:') ? undefined : x.url, v: 1 }]));
  const settings = { ...G.settings, approval: c.approval, tools: chatTools(c), ...qualitySettings(c), chromeAccess: !!c.tools?.chrome };
  const body = resumeOf ? { runId: m.runId, chatId: c.id, resume: resumeOf, settings, allowed: a.allowed, cmdRules: a.cmdRules || [], reading: a.reading?.text || '', ...(more ? { continue: more, ...(model ? { model } : {}) } : {}) }
    : { runId: m.runId, chatId: c.id, projectId: c.projectId, chatTitle: c.title, setup: a.setup, settings, allowed: a.allowed, cmdRules: a.cmdRules || [], history, summary: a.summary || '', reading: a.reading?.text || '', text, artifacts, context: ctx?.text || '', images: imgs.map((x) => x.full), docs: docs.map((d) => d.id), ...(cmts.length ? { comments: cmts } : {}) };
  // Saved straight away, so a reload finds the running reply and reattaches to it.
  saveChat(c, true);
  return followRun(c, m, (signal) => fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body) }));
}
// After a page reload: replies that were still running pick up again (everything so far is
// replayed), finished ones get their result, and ones a harness restart cut off offer ▶ Resume.
const following = new Set(); // replies this page is following now (never twice)
// A reply that ended with nothing saved (no text, totals or error): its result is still in the run's log.
const lostResult = (m) => m.role === 'assistant' && m.runId && !m.runActive && !m.live && !m.content && !m.stats && !m.error;
async function reattachRuns(c) {
  for (const m of c.agent.messages) {
    const lost = lostResult(m);
    if (m.role !== 'assistant' || !(m.runActive || lost) || c.running || following.has(m.runId)) continue;
    following.add(m.runId);
    const st = await fetch(`/api/runs/${m.runId}`).then((r) => r.json()).catch(() => ({ status: 'unknown' }));
    if (st.status === 'unknown') { following.delete(m.runId); if (lost) continue; m.runActive = false; m.error ||= 'This reply was interrupted.'; saveChat(c); continue; }
    // Another QuorX on the same data folder is running it right now: leave it be (it saves its own result), and
    // look again later in case that QuorX stops.
    if (st.status === 'elsewhere') { following.delete(m.runId); setTimeout(() => { if (G.open.get(c.id) === c) reattachRuns(c); }, 30e3); continue; }
    // Interrupted by a restart: offer Resume instead of replaying its whole log (it never ends, so it looped).
    // A reply that is running, or that finished while no one watched, is replayed to its end as before.
    if (st.status === 'interrupted') {
      following.delete(m.runId); m.runActive = false; m.live = false;
      m.error = 'The harness restarted while this reply was running.'; m.resumable = !!st.resumable;
      if (m.el) updateMsg(c, m);
      syncRunState(c); saveChat(c); continue;
    }
    // A replay starts from the first event, so the thinking starts empty too (it used to be appended again).
    // A resumed reply keeps the steps from before the restart: the log replayed is only the resumed part's.
    const mark = m.resumedFrom?.length ? m.trace.findLastIndex((e) => e.t === 'resumed') : -1;
    const kept = mark >= 0 ? m.trace.slice(0, mark + 1) : [];
    const keptSteps = new Set(kept.filter((e) => e.t === 'llm_start').map((e) => String(e.step)));
    const thinking = Object.fromEntries(Object.entries(m.thinking || {}).filter(([k]) => keptSteps.has(k)));
    Object.assign(m, { content: '', trace: kept, approvals: mark >= 0 ? m.approvals || {} : {}, questions: mark >= 0 ? m.questions || {} : {}, thinking, error: undefined, live: true, runActive: true });
    if (m.el) updateMsg(c, m);
    followRun(c, m, (signal) => fetch(`/api/runs/${m.runId}/events`, { signal }));
  }
}
// ---------- notifications: a reply needs you, or ended, while QuorX is in the background ----------
// ⚙ Appearance → Notifications. One notification per chat at a time (tag), so a busy chat doesn't pile them up.
const NOTIFY_TITLE = { approval: 'Needs your approval', answer: 'Question for you', budget: 'Project budget reached', done: 'Reply finished', error: 'Reply stopped' };
const NOTIFY_MARK = { approval: '⏸', answer: '❓', budget: '💲', done: '✓', error: '✕' };
function notifyRun(c, kind, body = '', meta = '') {
  const pref = uiOf(G.settings).notify;
  if (pref === 'off' || (pref === 'needs' && (kind === 'done' || kind === 'error'))) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  // Compact: the status (with how long and what it cost when done), then project · chat, then one short line.
  const project = G.projects.find((p) => p.id === c.projectId)?.name || c.projectId || '';
  const title = `${NOTIFY_MARK[kind] || '•'} ${NOTIFY_TITLE[kind] || 'QuorX'}${meta ? ` · ${meta}` : ''}`;
  const line = String(body).replace(/\s+/g, ' ').trim();
  const text = `${project ? `${project} · ` : ''}${c.title || 'Chat'}${line ? `
${line.length > 110 ? `${line.slice(0, 109)}…` : line}` : ''}`;
  // In the desktop app it comes from the app itself: QuorX's name and logo, and a click opens the chat.
  if (window.ohDesktop?.notify) { window.ohDesktop.notify({ title, body: text, chatId: c.id, silent: kind === 'done' }).catch(() => {}); return; }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body: text, icon: 'brand/quorx-192.png', tag: `oh-${c.id}`, silent: kind === 'done' });
    n.onclick = () => { window.ohDesktop?.focusWindow?.(); window.focus(); if (!G.panes.includes(c.id)) showChat(c.id); n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}
// Asked once, from the first Send (browsers only ask after a click).
function askNotifyPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default' || uiOf(G.settings).notify === 'off') return;
  Notification.requestPermission().catch(() => {});
}
// Follows one run's events. Closing the page only stops following; ■ Stop asks the server to stop.
// Set while the page unloads: a reply's stream closing then is not a lost connection.
let leaving = false;
addEventListener('pagehide', () => { leaving = true; });
async function followRun(c, m, open) {
  const a = c.agent;
  const ac = new AbortController();
  following.add(m.runId);
  c.running = { runId: m.runId, abort: () => { fetch(`/api/runs/${m.runId}/stop`, { method: 'POST' }).catch(() => ac.abort()); } };
  syncRunState(c); renderSidebar();
  let lastStep = -1, stepStart = 0, raf = 0;
  // After a reload the server replays a run's events in one burst: those are old news, so no notifications for them.
  const followT0 = Date.now(), note = (...x) => { if (Date.now() - followT0 > 1500) notifyRun(c, ...x); };
  const msgsEl =() => c.el && G.panes.includes(c.id) ? $('.msgs', c.el.root) : null;
  const stick = () => { if (msgsEl()) c.toEnd?.(); };
  const redraw = (bodyOnly) => {
    if (bodyOnly) { if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateMsg(c, m, { bodyOnly: true }); stick(); }); return; }
    updateMsg(c, m); stick();
  };
  // Text streamed in a step that turned out not to be the answer moves into the trace.
  const moveAside = (e) => { if (e.step === lastStep && m.content.length > stepStart) { e.aside = m.content.slice(stepStart).trim(); m.content = m.content.slice(0, stepStart).trimEnd(); } };
  let lost = false;
  try {
    const res = await open(ac.signal);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith('data:')) continue;
        let e; try { e = JSON.parse(chunk.slice(5)); } catch { continue; }
        if (e.t === 'think') { (m.thinking ??= {})[e.step] = (m.thinking[e.step] || '') + e.text; redraw(true); continue; }
        if (e.t === 'spend') { m.liveCost = e.cost; m.liveCalls = e.calls; m.liveTokens = [e.tokensIn, e.tokensOut]; m.liveByModel = e.byModel || m.liveByModel; liveSpend(c, m); continue; }
        if (e.t === 'token') {
          if (e.step !== lastStep && m.content) m.content += '\n\n';
          if (e.step !== lastStep) stepStart = m.content.length;
          lastStep = e.step; m.content += e.text; redraw(true); continue;
        }
        // A step that ended in tool calls was working out loud: move its text into the trace.
        if (e.t === 'llm_done' && e.toolCalls.length) moveAside(e);
        // A retried call starts its text again; a reply sent back to fix problems was not the answer.
        if (e.t === 'llm_retry' || e.t === 'sent_back') { moveAside(e); lastStep = -1; }
        if (e.t === 'artifact') { addArtifact(c, m, e.artifact); continue; }
        if (e.t === 'server') { serverUp(c, e); continue; }
        if (e.t === 'file' && G.watch?.chat === c.id) setTimeout(reloadPreview, 300);
        if (e.t === 'mode' && c.approval !== e.approval) { c.approval = e.approval; saveChat(c); renderComposerBar(c); }
        if (e.t === 'allow_always') { if (!a.allowed.includes(e.tool)) a.allowed.push(e.tool); renderAllowed(c); saveChat(c); }
        if (e.t === 'cmd_rule' && e.rule?.scope === 'chat') { (a.cmdRules ??= []).push(e.rule); saveChat(c); }
        if (e.t === 'approval') { m.approvals[e.id] = { card: e }; if (e.mode === 'strict') { c.waiting = true; renderSidebar(); renderChatHead(c); note('approval', e.what || e.tool); } }
        if (e.t === 'card_held') { const x = m.approvals?.[e.id] || m.questions?.[e.id]; if (x?.card?.wait) x.card.wait.held = true; }
        if (e.t === 'approval_done' && m.approvals[e.id]) { m.approvals[e.id].outcome = e; c.waiting = false; renderSidebar(); renderChatHead(c); }
        if (e.t === 'question') { m.questions[e.id] = { card: e }; if (!e.auto) { c.waiting = 'answer'; renderSidebar(); renderChatHead(c); note('answer', e.question); } }
        if (e.t === 'budget_ask') { m.budgetAsk = { card: e }; c.waiting = 'budget'; renderSidebar(); renderChatHead(c); note('budget', 'Raise the budget to carry on, or wrap up.'); }
        if (e.t === 'budget_done' && m.budgetAsk) { m.budgetAsk.outcome = e; c.waiting = false; refreshSidebar(); renderChatHead(c); }
        if (e.t === 'answer' && m.questions[e.id]) { const qc = m.questions[e.id].card; e.label = e.answers ? (e.defaults ? 'the recommended answers' : e.answers.map((x, i) => (x.choice != null ? qc.questions?.[i]?.options[x.choice] : x.text || '–')).join(' · ')) : e.choice != null ? qc.options[e.choice] : e.text; m.questions[e.id].answer = e; c.waiting = false; renderSidebar(); renderChatHead(c); }
        if (e.t === 'done') { m.doneAt = Date.now(); m.content = e.reply; m.note = e.historyNote; m.stats = e.stats; G.sessionCost += e.stats.cost; renderSpend(); loadScores(); }
        if (e.t === 'error') { m.error = e.msg; if (e.stats && !m.stats) { m.stats = { ...e.stats, partial: true }; G.sessionCost += e.stats.cost || 0; renderSpend(); } }
        if (e.t === 'interrupted') { m.error = 'The harness restarted while this reply was running.'; m.resumable = !!e.resumable; }
        if (e.t === 'compacted') { a.summary = e.summary; a.summaryAt = e.cutoffAt; }
        if (e.t === 'reading') {
          const u = a.messages[a.messages.indexOf(m) - 1];
          a.reading = { text: e.text, at: Date.now() };
          if (u?.role === 'user') { u.reading = { goal: e.goal, includes: e.includes || [], assumptions: e.assumptions || [], text: e.text, model: e.model, cost: e.cost }; drawReading(c, u); }
          saveChat(c);
        }
        if (e.t !== 'start') m.trace.push(e);
        if (isShot(e)) onAgentBrowse(c, m);
        if (e.t === 'tool' && !e.by && (e.name === 'shell' || e.name === 'run_command')) onAgentCommand(c);
        redraw(false);
      }
    }
    if (!m.stats && !m.error) lost = true;
  } catch (err) {
    if (ac.signal.aborted) m.error = 'Stopped.'; else lost = true;
  } finally {
    following.delete(m.runId);
    if (leaving) return; // the reply goes on; the next page load reattaches to it
    m.live = false; c.running = null; c.waiting = false;
    // The harness went away mid-reply (restarted or closed): wait for it, then reattach or offer Resume.
    if (lost) { m.error = 'Lost the connection to the harness; reconnecting…'; reconnect(c, m); }
    else if (!m.stats) partialSpend(m);
    else {
      m.runActive = false;
      // A card or question still open when the reply ended can no longer be answered.
      for (const x of Object.values(m.approvals || {})) if (!x.outcome && x.card.mode === 'strict') x.outcome = { approve: false, by: 'the reply ending' };
      for (const q of Object.values(m.questions || {})) if (!q.answer) q.answer = { label: '(not answered: the reply ended)' };
    }
    if (!lost && m.error !== 'Stopped.') {
      const took = m.stats?.ms ?? (m.doneAt && m.at ? m.doneAt - m.at : 0);
      const cost = m.stats && !uiOf(G.settings).maskAmounts ? ` · ${money(m.stats.cost, 3)}` : '';
      if (m.error) note('error', m.error);
      else note('done', String(m.content || '').replace(/[#*_`>|]/g, '').slice(0, 200), `${took ? secs(took) : ''}${cost}`.replace(/^ · /, ''));
    }
    updateMsg(c, m); syncRunState(c); saveChat(c, true); refreshSidebar(); checkSpace(c, true); refreshUndoable(c.projectId); if (G.view.browser && focused() === c) renderPane();
    refreshBalance();
    // ⚙ Reviewer → "Review code changes": after a reply that changed code, a code review card (only when it finds something).
    if (G.settings.codeReview === 'auto' && m.stats && !m.error && (m.stats.changed || []).some((f) => CODE_FILE.test(f))) codeReview(c, 'reply', { auto: true, runId: m.runId });
  }
}
async function reconnect(c, m) {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await fetch(`/api/runs/${m.runId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (st) { if (m.runActive && !c.running) reattachRuns(c); return; } // reattachRuns follows it only if it is still running
  }
  m.runActive = false; m.error = 'Lost the connection to the harness.'; updateMsg(c, m); saveChat(c);
}
// Artifacts have no versions: a new one is added, an edited one is replaced in place.
function addArtifact(c, m, x) {
  c.agent.artifacts[x.id] = { id: x.id, kind: x.kind, title: x.title, html: x.html, md: x.md, url: x.url, cost: x.cost, ms: x.ms, model: x.model, cmd: x.cmd, args: x.args, name: x.name, command: x.command, updated: Date.now() };
  if (!m.arts.some((y) => y.id === x.id)) m.arts.push({ id: x.id, kind: x.kind, title: x.title });
  if (c.paneHidden === true) c.paneHidden = false; // something was built: show it
  if (G.panes[G.focus] === c.id) openArtifact(c, x.id);
  if (isPhone() && G.mview !== 'preview') $('#mnav .mn-dot').hidden = false;
  updateMsg(c, m);
}

// ---------- artifact pane (shown only when the focused chat has something to show) ----------
// The Artifact tab is for plans: Markdown and HTML documents the agent wrote to plan and explain. What it builds
// runs as a server (the launch file) and opens in the Browser tab; pictures and media are in Files.
const planArts = (c) => Object.values(c?.agent?.artifacts || {}).filter((a) => a.kind === 'html' || a.kind === 'md');
// A live site or app opens in a Browser tab of its own (one per address; a restart reuses it).
function openInBrowser(c, url) {
  if (!c || !url) return;
  let origin = url; try { origin = new URL(url, location.href).origin; } catch { /* keep as is */ }
  const t = (G.btabs ||= []).find((x) => { try { return x.url && new URL(x.url, location.href).origin === origin; } catch { return false; } });
  if (t) { Object.assign(t, { url, opened: null, shot: null }); G.bActive = t.sid; } else newBTab(url);
  G.view = { id: G.view.id, src: false, files: false, browser: true };
  c.paneHidden = false; syncLayout(); renderPane();
}
// The agent started (or restarted) a server: show it, and update the 🖥 count.
function serverUp(c, e) {
  pollDev();
  if (focused() === c && G.followAgent !== false && e.url) openInBrowser(c, e.url);
}
function openArtifact(c, id) {
  const i = G.panes.indexOf(c.id);
  if (i >= 0 && i !== G.focus) { G.focus = i; for (const p of document.querySelectorAll('.chatpane')) p.classList.toggle('focus', Number(p.dataset.pane) === i); }
  G.view = { id, src: false, files: false };
  c.paneHidden = false;
  syncLayout(); renderPane();
}
// The side panel hidden (chat only), from its own button; the panel button at the top of a chat brings it back.
// Remembered. Asking for something in it (🧭 Steps, a file, a preview) shows it again.
// The side panel's toggle sits in each chat's header, next to rename: lit while the panel is open.
function syncPaneToggles() {
  for (const b of document.querySelectorAll('.ch-panel')) { b.classList.toggle('on', !G.paneHidden); b.setAttribute('aria-pressed', String(!G.paneHidden)); }
}
function setPaneHidden(on, quiet) {
  G.paneHidden = !!on;
  syncPaneToggles();
  $('.layout')?.classList.toggle('pane-hidden', G.paneHidden);
  try { localStorage.setItem('oh-pane-hidden', G.paneHidden ? '1' : '0'); } catch { /* this session only */ }
  if (!quiet) { syncLayout?.(); deskPlace?.(true); window.dispatchEvent(new Event('resize')); }
}
function paneVisible() {
  const c = focused();
  if (!c) return false;
  if (!isPhone()) return !G.paneHidden; // always there on a desktop: drag the divider to resize, ⤢ to make it full width
  // ◧ always wins: hidden means hidden, even with the explorer or a trace open (they come back with it).
  if (c.paneHidden === true) return false;
  if (G.view.files || G.view.trace || G.view.term || G.view.run || G.view.browser) return true;
  if (c.paneHidden === false) return true; // shown with ◧, even with nothing built yet
  const mode = G.settings.ui?.paneMode || 'auto';
  if (mode === 'never' && c.paneHidden !== false) return false;
  if (mode === 'always') return true;
  return Object.keys(c.agent.artifacts).length > 0;
}
// The pane's dropdown lists this chat's artifacts plus the one open "Steps" (if any).
// Page artifacts are hosted by the server (/art/<chat>/<id>), so the preview is always the newest version;
// sites and apps reload by themselves when files in the project folder change.
function renderPane() {
  const c = focused();
  const sel = $('#artSelect'), body = $('#paneBody'), bar = $('#appBar');
  bar.hidden = true;
  stopWatch();
  renderPaneTabs(c);
  if (!c) return;
  if (G.view.term) { setUrlBar(null); return renderTerm(c); }
  closeTermStream();
  if (G.view.files) { setUrlBar(null); return renderFiles(c); }
  if (G.view.browser) return renderBrowser(c);
  if (G.view.trace) {
    setUrlBar(null);
    const tm = c.agent.messages.find((x) => x.runId === G.view.trace);
    if (tm) return renderTracePane(c, tm);
    G.traceRun = null;
    body.innerHTML = '<div class="empty">No replies in this chat yet. Every step of a reply shows here.</div>';
    return;
  }
  const all = planArts(c).sort((a, b) => (a.updated || 0) - (b.updated || 0));
  sel.innerHTML = all.map((a) => `<option value="${esc(a.id)}">${ICON[a.kind] || '📄'} ${esc(a.title)}</option>`).join('') || '<option>No plans yet</option>';
  sel.disabled = !all.length;
  const a = all.find((x) => x.id === G.view.id) || all.at(-1);
  if (!a) { setUrlBar(null, { art: true }); body.innerHTML = '<div class="empty">No plans in this chat yet. Plans, specs and reports the agent writes show here; what it builds runs in the Browser tab (and under 🖥 servers).</div>'; return; }
  sel.value = a.id;
  setUrlBar(artifactUrl(c, a), { art: true });
  G.lastArt = a.id; // 🗂 opens on this one
  const frame = (src, sandboxed) => {
    body.innerHTML = '';
    const f = document.createElement('iframe');
    src = pageUrl(src);
    if (sandboxed) f.setAttribute('sandbox', pageSandbox(src));
    // Until the page has loaded, the pane shows a themed placeholder instead of the frame's blank white (motion.css).
    body.classList.add('art-loading');
    const done = () => body.classList.remove('art-loading');
    f.addEventListener('load', done, { once: true }); setTimeout(done, 5000);
    f.title = a.title; f.src = src; body.appendChild(f);
    return f;
  };
  if (a.kind === 'html' || a.kind === 'md') {
    frame(`/art/${encodeURIComponent(c.id)}/${encodeURIComponent(a.id)}?v=${a.updated || 0}`, true);
  } else if (a.kind === 'site') {
    bar.hidden = false;
    bar.innerHTML = `🌐 <b>Site</b> <span class="dim">served from the project folder</span> <span class="dim live-note">● live: reloads when project files change</span>`;
    frame(a.url); watchFolder(c);
  } else if (a.kind === 'app') {
    renderAppBar(c, a); frame(a.url); watchFolder(c);
  } else if (!a.url) {
    body.innerHTML = `<div class="empty">This ${a.kind} is no longer available.</div>`;
  } else {
    const cap = `<div class="cap">${esc(a.title)}${a.model ? ` · ${esc(short(a.model))}` : ''}${a.cost != null ? ` · ${money(a.cost, 4)}` : ''}${a.ms ? ` · ${secs(a.ms)}` : ''}</div>`;
    const u = esc(a.url || '');
    const player = a.kind === 'image' ? `<img src="${u}" alt="${esc(a.title)}">`
      : a.kind === 'video' ? `<video controls src="${u}"></video><a href="${u}" download="${esc(a.id)}.mp4">Download</a>`
      : `<audio controls src="${u}"></audio><a href="${u}" download="${esc(a.id)}">Download</a>`;
    body.innerHTML = `<div class="media">${player}${cap}</div>`;
  }
}
// Sites and apps: check the project folder every 2.5 s while shown; reload the preview when it changed.
function watchFolder(c) {
  stopWatch();
  let last = null;
  const tick = async () => {
    const r = await fetch(`/api/files/stamp?project=${encodeURIComponent(c.projectId)}`).then((x) => x.json()).catch(() => null);
    if (!r || G.watch?.chat !== c.id) return;
    if (last != null && r.stamp !== last) reloadPreview();
    last = r.stamp;
  };
  G.watch = { chat: c.id, timer: setInterval(tick, 2500) };
  tick();
}
function stopWatch() { if (G.watch) { clearInterval(G.watch.timer); G.watch = null; } }
function reloadPreview() {
  const f = $('#paneBody iframe'); if (!f) return;
  try { f.contentWindow?.location.reload(); } catch { f.src = f.src; } // cross-origin frames: reset src
}
async function renderAppBar(c, a) {
  const bar = $('#appBar');
  bar.hidden = false;
  const list = await fetch(`/api/servers?project=${c.projectId}`).then((r) => r.json()).catch(() => []);
  const sv = list.find((x) => x.url === a.url) || list.find((x) => x.name === a.name);
  const running = sv?.status === 'running';
  bar.innerHTML = `<span class="dot ${running ? 'ok' : 'off'}"></span><b>${esc(a.name || 'app')}</b> <code>${esc(a.command || [a.cmd, ...(a.args || [])].join(' '))}</code>
    <span class="dim">${running ? esc(sv.url) : sv ? sv.status : 'not running'}</span>
    ${running ? '<button type="button" class="stop">■ Stop</button>' : '<button type="button" class="start">▶ Start</button>'}
    <button type="button" class="logs">📜 Logs</button><pre class="log" hidden></pre>`;
  const start = $('.start', bar), stop = $('.stop', bar);
  if (stop) stop.onclick = async () => { await fetch('/api/servers/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: sv.key }) }); setTimeout(() => renderAppBar(c, a), 600); };
  if (start) start.onclick = async () => {
    start.disabled = true; start.textContent = 'Starting…';
    const r = await fetch('/api/servers/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: c.projectId, name: a.name, cmd: a.cmd, args: a.args }) }).then((x) => x.json());
    if (r.error) { uiAlert(r.error); return renderAppBar(c, a); }
    a.url = r.url; saveChat(c); renderPane();
  };
  $('.logs', bar).onclick = async () => {
    const pre = $('.log', bar);
    if (!pre.hidden) { pre.hidden = true; return; }
    pre.textContent = sv ? (await fetch(`/api/servers/log?key=${encodeURIComponent(sv.key)}`).then((r) => r.json())).log || '(no output yet)' : '(not running)';
    pre.hidden = false;
  };
}
// ---------- Files: previews like an editor's — pictures, video, audio, PDF, office documents, tables, fonts, pages ----------
const fileExt = (n) => (String(n || '').match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const PREVIEW_KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp'], video: ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac'], pdf: ['pdf'], office: ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub'],
  table: ['csv', 'tsv'], font: ['ttf', 'otf', 'woff', 'woff2'], md: ['md', 'markdown'], html: ['html', 'htm'],
  binary: ['wasm', 'glb', 'zip', 'gz', 'tar', '7z', 'exe', 'dll', 'bin', 'so', 'dylib', 'class', 'jar', 'pyc'],
};
const previewKind = (name) => Object.keys(PREVIEW_KINDS).find((k) => PREVIEW_KINDS[k].includes(fileExt(name))) || 'text';
const PV_ICON = { image: '🖼', video: '🎬', audio: '🎵', pdf: '📕', office: '📘', table: '📊', font: '🔤', md: '📝', html: '🌐', binary: '📦', text: '📄' };
const sizeText = (b) => (b == null ? '' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const durText = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
// A small CSV / TSV reader (quotes and doubled quotes), enough for a preview.
function parseDelimited(text, sep) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length && rows.length < 501; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"' && !cell) q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
/**
 * Show one file or artifact in the Files view. `src` is where the browser can load it; `text` (when known) is its
 * source; `full` is the path on disk (for Copy path). Pages and Markdown get Preview / Source.
 */
async function previewFile(view, { name, src, size, full, text, kind = previewKind(name), live = true }) {
  const head = (info, extra = '') => `<div class="pv-head"><span class="pv-ico" aria-hidden="true">${PV_ICON[kind] || '📄'}</span><b class="pv-name" title="${esc(full || name)}">${esc(name)}</b><span class="pv-info">${info}</span><span class="pv-acts">${extra}${full ? '<button type="button" class="pv-btn pv-copy" title="Copy the path">Copy path</button>' : ''}${src && !src.startsWith('data:') ? '<button type="button" class="pv-btn pv-ext" title="Open it in its own window">Open ↗</button>' : ''}</span></div>`;
  const wire = () => {
    const cp = $('.pv-copy', view); if (cp) cp.onclick = () => navigator.clipboard?.writeText(full).then(() => flashTip(cp, 'Copied')).catch(() => flashTip(cp, 'Could not copy'));
    const ex = $('.pv-ext', view); if (ex) ex.onclick = () => { const u = absUrl(src); if (DESK) window.ohDesktop.openExternal(u); else window.open(u, '_blank', 'noopener'); };
  };
  const label = { image: fileExt(name) === 'svg' ? 'SVG picture' : 'Picture', video: 'Video', audio: 'Audio', pdf: 'PDF', table: 'Table', font: 'Font', md: 'Markdown', html: 'HTML page', binary: 'Binary file' }[kind]
    || (fileExt(name).toUpperCase() || 'Text');
  const meta = [label, sizeText(size)].filter(Boolean).join(' · ');
  // Preview / Source for pages, Markdown and SVG.
  const twoWay = async (drawPreview) => {
    const mode = (G.pvMode ||= {})[kind] || 'preview';
    view.innerHTML = head(meta, `<span class="pv-seg" role="tablist"><button type="button" data-m="preview" class="${mode === 'preview' ? 'on' : ''}">Preview</button><button type="button" data-m="source" class="${mode === 'source' ? 'on' : ''}">Source</button></span>`) + '<div class="pv-body"></div>';
    wire();
    const body = $('.pv-body', view);
    for (const b of view.querySelectorAll('.pv-seg button')) b.onclick = () => { G.pvMode[kind] = b.dataset.m; previewFile(view, { name, src, size, full, text, kind, live }); };
    if (mode === 'source') { const t = text ?? await fetch(src).then((r) => r.text()); return mountCode(body, t.length > 600000 ? t.slice(0, 600000) : t, kind === 'image' ? 'html' : langOf(name) || kind, { name }); }
    return drawPreview(body);
  };
  if (kind === 'image' && fileExt(name) === 'svg') return twoWay((body) => { body.innerHTML = `<div class="pv-stage pv-checker"><img src="${esc(src)}" alt="${esc(name)}"></div>`; });
  if (kind === 'image') {
    view.innerHTML = head(meta) + `<div class="pv-stage pv-checker" title="Click for actual size"><img src="${esc(src)}" alt="${esc(name)}"></div>`; wire();
    const img = $('img', view), stage = $('.pv-stage', view);
    img.onload = () => { $('.pv-info', view).textContent = `${meta} · ${img.naturalWidth}×${img.naturalHeight}`; };
    stage.onclick = () => stage.classList.toggle('actual');
    return;
  }
  if (kind === 'video' || kind === 'audio') {
    view.innerHTML = head(meta) + (kind === 'video' ? `<div class="pv-stage"><video controls preload="metadata" src="${esc(src)}"></video></div>` : `<div class="pv-stage pv-audio"><div class="pv-disc" aria-hidden="true">🎵</div><audio controls preload="metadata" src="${esc(src)}"></audio></div>`);
    wire();
    const el = $(kind, view);
    el.onloadedmetadata = () => { $('.pv-info', view).textContent = [meta, durText(el.duration), kind === 'video' && el.videoWidth ? `${el.videoWidth}×${el.videoHeight}` : ''].filter(Boolean).join(' · '); };
    el.onerror = () => { $('.pv-stage', view).insertAdjacentHTML('beforeend', '<p class="pv-note">This format does not play in the app (it may need its own player). Use Open ↗.</p>'); };
    return;
  }
  if (kind === 'pdf') { view.innerHTML = head(meta) + `<iframe class="pv-frame" src="${esc(src)}" title="${esc(name)}"></iframe>`; wire(); return; }
  if (kind === 'office') {
    view.innerHTML = head(meta) + '<div class="pv-doc"><div class="fx-empty">Reading…</div></div>'; wire();
    const r = await getJ(`/api/files/text?project=${encodeURIComponent(G.filesProject)}&path=${encodeURIComponent(name)}`).catch((e) => ({ error: e.message }));
    const doc = $('.pv-doc', view); if (!doc) return;
    doc.innerHTML = r?.error ? `<div class="fx-empty">Could not read it: ${esc(r.error)}</div>` : `<p class="pv-note">The text of the document (no layout or pictures). Open ↗ shows it as it looks.</p><div class="pv-text">${esc(r.text || '(no text)')}</div>`;
    return;
  }
  if (kind === 'table') {
    const t = text ?? await fetch(src).then((r) => r.text());
    const rows = parseDelimited(t, fileExt(name) === 'tsv' ? '\t' : ',');
    view.innerHTML = head(`${meta} · ${rows.length > 500 ? 'first 500' : rows.length} rows`, '') + `<div class="pv-table"><table><thead><tr>${(rows[0] || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1, 500).map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    wire(); return;
  }
  if (kind === 'font') {
    view.innerHTML = head(meta) + '<div class="pv-font"><div class="fx-empty">Loading the font…</div></div>'; wire();
    try {
      const fam = `pv-${Date.now().toString(36)}`, face = new FontFace(fam, `url("${src}")`);
      await face.load(); document.fonts.add(face);
      $('.pv-font', view).innerHTML = [40, 28, 18, 13].map((px) => `<p style="font-family:'${fam}';font-size:${px}px">The quick brown fox jumps over the lazy dog 0123456789</p>`).join('') + `<p style="font-family:'${fam}';font-size:22px">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz !?&amp;@#</p>`;
    } catch (e) { $('.pv-font', view).innerHTML = `<div class="fx-empty">This font could not be loaded: ${esc(e.message)}</div>`; }
    return;
  }
  if (kind === 'md') return twoWay(async (body) => { const t = text ?? await fetch(src).then((r) => r.text()); body.innerHTML = `<div class="pv-md msg-md">${md(t)}</div>`; enhance(body); });
  if (kind === 'html') return twoWay((body) => { const u = pageUrl(src); body.innerHTML = `<iframe class="pv-frame" sandbox="${pageSandbox(u)}" src="${esc(u)}" title="${esc(name)}"></iframe>`; });
  if (kind === 'binary') { view.innerHTML = head(meta) + `<div class="fx-empty big">${esc(name)}<br><small>A binary file: no preview. Open ↗ or open the folder to use it.</small></div>`; wire(); return; }
  // Text and code: the code viewer.
  const t = text ?? await fetch(src).then((r) => r.text());
  view.innerHTML = head(meta) + '<div class="pv-body"></div>'; wire();
  mountCode($('.pv-body', view), t.length > 600000 ? t.slice(0, 600000) : t, langOf(name), { name });
}
async function renderFiles(c) {
  const body = $('#paneBody'), bar = $('#appBar');
  const p = G.projects.find((x) => x.id === c.projectId);
  bar.hidden = false;
  bar.innerHTML = `🗂 <b>Explorer</b> <span class="dim">${esc(p?.name || c.projectId)}</span> <code title="${esc(p?.dir || '')}">${esc(p?.dir || '')}</code> <button type="button" class="os-open" title="Open this folder in File Explorer">📂 Open in File Explorer</button> <button type="button" class="back">✕ Close</button>`;
  $('.os-open', bar).onclick = () => openFolder(c.projectId);
  $('.back', bar).onclick = () => { G.view.files = false; syncLayout(); renderPane(); };
  const files = await fetch(`/api/files?project=${c.projectId}`).then((r) => r.json()).catch(() => []);
  const arts = Object.values(c.agent.artifacts).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  // A folder tree from the flat list (folders first, open by default near the top).
  const tree = {};
  for (const f of files) {
    const parts = f.path.replace(/\/ \((another project, )?skipped\)$/, '/').split('/').filter(Boolean);
    let node = tree;
    parts.forEach((part, k) => { if (k === parts.length - 1 && !/skipped\)$/.test(f.path)) (node.__files ||= []).push({ name: part, ...f }); else node = (node[part] ||= {}); });
    if (/skipped\)$/.test(f.path)) node.__skipped = true;
  }
  const fileIcon = (n) => ({ html: '🌐', css: '🎨', js: '📜', json: '🧾', py: '🐍', md: '📝', sh: '⌨️' }[langOf(n)] || (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(n) ? '🖼' : /\.(mp3|wav|ogg)$/i.test(n) ? '🎵' : /\.(mp4|webm)$/i.test(n) ? '🎬' : '📄'));
  // A tree you can read: guide lines per level, folders that open and close (▸ ▾, remembered) with how
  // many files they hold, and long names shortened in the middle so the end (and extension) stays visible.
  const openDirs = (G.fxOpen ||= {})[c.projectId] ||= new Set(['']);
  const countFiles = (node) => (node.__files || []).length + Object.keys(node).filter((k) => !k.startsWith('__')).reduce((n, k) => n + countFiles(node[k]), 0);
  const nameHTML = (n) => { const cut = Math.max(0, n.length - 9); return n.length > 18 ? `<span class="fl-name"><span class="n1">${esc(n.slice(0, cut))}</span><span class="n2">${esc(n.slice(cut))}</span></span>` : `<span class="fl-name"><span class="n1">${esc(n)}</span></span>`; };
  const drawTree = (node, depth, base = '') => Object.keys(node).filter((k) => !k.startsWith('__')).sort().map((dir) => {
      const path = base ? `${base}/${dir}` : dir, kid = node[dir], n = countFiles(kid);
      const open = openDirs.has(path) || (depth < 1 && !openDirs.has(`!${path}`) && !kid.__skipped); // top level starts open, deeper ones closed
      return `<details class="fx-dir" data-dir="${esc(path)}" ${open ? 'open' : ''}><summary style="--d:${depth}" title="${esc(path)}/"><span class="fx-chev" aria-hidden="true">▸</span>📁 ${nameHTML(dir)}${kid.__skipped ? '<small class="fx-note">not listed</small>' : `<small class="fx-count" title="${n} file${n === 1 ? '' : 's'} inside">${n}</small>`}</summary>${drawTree(kid, depth + 1, path)}</details>`;
    }).join('')
    + (node.__files || []).sort((a, b) => a.name.localeCompare(b.name)).map((f) => `<button type="button" class="fl" data-p="${esc(f.path)}" style="--d:${depth}" title="${esc(f.path)}${f.size ? ` · ${(f.size / 1024).toFixed(1)} KB` : ''}">${fileIcon(f.name)} ${nameHTML(f.name)}<small>${f.size ? `${f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${(f.size / 1024).toFixed(1)} KB`}` : ''}</small></button>`).join('');
  body.innerHTML = `<div class="files">
    <div class="tree">
      <div class="fx-h">This chat's artifacts <small>${arts.length}</small></div>
      ${arts.length ? arts.map((a) => `<button type="button" class="fl fx-art" data-art="${esc(a.id)}" style="--d:0" title="${esc(a.title)}">${ICON[a.kind] || '📄'} <span>${esc(a.title)}</span><small>${esc(a.kind)}</small></button>`).join('') : '<div class="fx-empty">Nothing built in this chat yet.</div>'}
      <div class="fx-h">Project files <small>${files.length}</small></div>
      ${files.length ? drawTree(tree, 0) : '<div class="fx-empty">No files in the project folder yet. Pages the agent writes as artifacts live with the chat (above); code it writes with write_file appears here.</div>'}
    </div>
    <div class="fx-split" role="separator" aria-orientation="vertical" aria-label="Resize the file list" title="Drag to resize · double-click to reset"></div>
    <div class="fview"><div class="fx-empty big">Pick an artifact or a file to view it.</div></div>
  </div>`;
  // Folders remember being opened or closed; the file list can be made wider (remembered too).
  for (const d of body.querySelectorAll('.fx-dir')) d.addEventListener('toggle', () => { const k = d.dataset.dir; openDirs.delete(k); openDirs.delete(`!${k}`); openDirs.add(d.open ? k : `!${k}`); });
  const filesBox = $('.files', body), split = $('.fx-split', body);
  let treeW = null; try { treeW = Number(localStorage.getItem('oh-tree-w')) || null; } catch { /* storage off */ }
  if (treeW) filesBox.style.setProperty('--tree-w', `${treeW}px`);
  split.onpointerdown = (e) => {
    e.preventDefault(); split.setPointerCapture(e.pointerId);
    const left = filesBox.getBoundingClientRect().left, max = filesBox.getBoundingClientRect().width - 160;
    split.onpointermove = (ev) => { treeW = Math.round(Math.max(150, Math.min(max, ev.clientX - left))); filesBox.style.setProperty('--tree-w', `${treeW}px`); };
    split.onpointerup = () => { split.onpointermove = null; try { localStorage.setItem('oh-tree-w', String(treeW)); } catch { /* storage off */ } };
  };
  split.ondblclick = () => { filesBox.style.removeProperty('--tree-w'); try { localStorage.removeItem('oh-tree-w'); } catch { /* storage off */ } };
  const view = $('.fview', body);
  const sep = p?.dir?.includes('\\') ? '\\' : '/';
  const fullOf = (rel) => (p?.dir ? `${p.dir}${sep}${rel.replaceAll('/', sep)}` : rel);
  const select = (b) => { for (const x of body.querySelectorAll('.fl')) x.classList.toggle('on', x === b); };
  for (const b of body.querySelectorAll('.fx-art')) b.onclick = () => {
    select(b);
    const a = c.agent.artifacts[b.dataset.art];
    if (a.kind === 'html') return previewFile(view, { name: `${a.title}.html`, src: `/art/${encodeURIComponent(c.id)}/${encodeURIComponent(a.id)}?v=${a.updated || 0}`, text: a.html || '', kind: 'html' });
    if (a.kind === 'md') return previewFile(view, { name: `${a.title}.md`, src: `/art/${encodeURIComponent(c.id)}/${encodeURIComponent(a.id)}?v=${a.updated || 0}`, text: a.md || '', kind: 'md' });
    const mk = a.kind === 'image' ? 'image' : a.kind === 'video' ? 'video' : ['audio', 'music', 'speech', 'voice'].includes(a.kind) ? 'audio' : null;
    if (mk && a.url) return previewFile(view, { name: a.title, src: a.url, kind: mk });
    view.innerHTML = `<div class="fx-meta"><b>${esc(a.title)}</b> · ${esc(a.kind)}${a.url || a.kind === 'html' || a.kind === 'md' ? ` · <code>${esc(absUrl(artifactUrl(c, a)) || 'embedded in the chat')}</code>` : ''}<p><button type="button" class="fx-open">Open in the pane</button></p></div>`;
    $('.fx-open', view).onclick = () => openArtifact(c, a.id);
  };
  const start = G.lastArt && body.querySelector(`.fx-art[data-art="${CSS.escape(G.lastArt)}"]`);
  if (start) setTimeout(() => start.click(), 0);
  for (const b of body.querySelectorAll('.fl[data-p]')) b.onclick = async () => {
    select(b);
    const path = b.dataset.p, src = `/ws/${c.projectId}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const f = files.find((x) => x.path === path);
    G.filesProject = c.projectId;
    previewFile(view, { name: path, src, size: f?.size, full: fullOf(path) });
  };
  for (const b of body.querySelectorAll('.fl[data-p]')) {
    b.oncontextmenu = (e) => filesMenu(e, c.projectId, b.dataset.p, fullOf(b.dataset.p));
    // Drag a file onto the chat: it goes with your next message.
    b.draggable = true;
    b.ondragstart = (e) => { e.dataTransfer.setData('application/x-quorx-file', JSON.stringify({ projectId: c.projectId, path: b.dataset.p })); e.dataTransfer.effectAllowed = 'copy'; };
  }
  for (const d of body.querySelectorAll('.fx-dir')) $('summary', d).oncontextmenu = (e) => { e.stopPropagation(); filesMenu(e, c.projectId, d.dataset.dir, fullOf(d.dataset.dir), false); };
}

// ---------- spend: private balance, page total, costs view ----------
async function refreshBalance() {
  $('#spend').classList.add('busy');
  try { const b = await fetch('/api/balance').then((r) => r.json()); if (!b.error) G.balance = b; } catch { /* offline */ }
  $('#spend').classList.remove('busy');
  renderSpend();
}
// The 💲 card (only when turned on in Settings → Privacy): opens and closes on click, recent spend as tiles, totals masked until 👁.
function renderSpend() {
  const b = G.balance, el = $('#spend');
  const masking = G.settings.ui?.maskAmounts !== false, show = !masking || G.balanceShown;
  const amt = (v) => (v == null ? '—' : money(v, 2));
  const tile = (label, v) => `<div class="bc-tile"><span>${label}</span><b>${amt(v)}</b></div>`;
  const line = (label, v) => `<div class="bc-line"><span>${label}</span><b class="${show ? '' : 'masked'}">${show ? amt(v) : '•••••'}</b></div>`;
  el.innerHTML = `<button type="button" class="sp-icon top-balance-btn" aria-controls="spTip" aria-expanded="${!!G.balanceOpen}" aria-label="OpenRouter spend: click to open or close">💲</button>
    <div class="sp-tip bal-tooltip bal-card" id="spTip" role="dialog" aria-label="OpenRouter key spend">
      <div class="bc-head"><span class="bc-dot ${b ? 'ok' : ''}"></span><b>OpenRouter key</b><span class="bc-sp"></span>
        ${masking ? `<button type="button" class="bc-icon sp-eye" title="${G.balanceShown ? 'Hide amounts' : 'Show amounts'}" aria-label="${G.balanceShown ? 'Hide amounts' : 'Show amounts'}">${G.balanceShown ? '🙈' : '👁'}</button>` : ''}
        <button type="button" class="bc-icon sp-refresh" title="Refresh" aria-label="Refresh">↻</button></div>
      ${b ? `<div class="bc-tiles">${tile('Last hour', b.windows?.h1?.value ?? 0)}${tile('Today', b.today ?? 0)}${tile('This week', b.week)}</div>
        <div class="bc-lines">${line('All time', b.usage ?? 0)}${b.remaining != null ? line('Credit left', b.remaining) : ''}${b.limit != null ? line('Key limit', b.limit) : ''}</div>`
        : `<div class="bc-wait">${G.cfg?.hasKey ? 'Loading…' : 'No OpenRouter key yet.'}</div>`}
      <button type="button" class="bc-more">Details in ⚙ Settings → API keys</button>
    </div>`;
  // The card opens and closes with 💲 only (no hover), so its buttons stay put while you use them.
  el.classList.toggle('open', !!G.balanceOpen);
  $('.sp-icon', el).onclick = () => { G.balanceOpen = !G.balanceOpen; renderSpend(); if (G.balanceOpen) refreshBalance(); };
  $('.sp-refresh', el).onclick = () => refreshBalance();
  $('.bc-more', el).onclick = () => { G.balanceOpen = false; renderSpend(); openSettings('keys'); };
  const eye = $('.sp-eye', el); if (eye) eye.onclick = () => { G.balanceShown = !G.balanceShown; renderSpend(); };
  if (!G.balanceCloser) {
    G.balanceCloser = true;
    const close = () => { if (G.balanceOpen) { G.balanceOpen = false; renderSpend(); } };
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('#spend')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && G.balanceOpen) { close(); $('#spend .sp-icon')?.focus(); } });
  }
}
// 💲 Costs: totals, then each project with its top chats; more chats load a page at a time, and the
// search looks through every chat. Projects show 10 at a time.
const COSTS = { sort: (() => { try { return localStorage.getItem('oh-cost-sort') || 'recent'; } catch { return 'recent'; } })(), q: '', projectsShown: 10, data: null };
// ---------- ⏰ Schedules: chats QuorX starts on its own (server/schedules.js) ----------
// A schedule starts a normal chat in its project with the saved prompt, model and mode. They run while QuorX runs
// (the desktop app or its tray). The page polls for what they did: new chats, a chat waiting for you, one finished.
const SCHED = { list: [], since: 0, edit: null, timer: 0, now: Date.now() };
const SCHED_STATUS = { starting: ['Starting', 'run'], running: ['Running', 'run'], waiting: ['Waits for you', 'wait'], done: ['Finished', 'ok'], failed: ['Failed', 'bad'], stopped: ['Stopped', 'bad'], skipped: ['Skipped', 'wait'] };
const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const when2 = (t) => { if (!t) return '–'; const d = new Date(t), today = new Date(); const same = d.toDateString() === today.toDateString(); const tmr = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toDateString() === d.toDateString(); return `${same ? 'Today' : tmr ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`; };
async function loadSchedules() {
  const r = await fetch(`/api/schedules?since=${SCHED.since}`).then((x) => x.json()).catch(() => null);
  if (!r || r.error) return null;
  const first = !SCHED.since && !SCHED.seen;
  SCHED.list = r.schedules; SCHED.now = r.now; SCHED.seen = true;
  // Notices from before this page loaded are old news: only later ones notify.
  if (!first) for (const n of r.notices) scheduleNoticed(n);
  SCHED.since = Math.max(SCHED.since, r.noticeSeq || 0);
  return r;
}
function scheduleNoticed(n) {
  if (n.chatId) refreshSidebar();
  if (n.kind !== 'done' && n.kind !== 'error') { const c = G.open.get(n.chatId); if (c && !c.running) reattachRuns(c); }
  // The desktop app shows these itself (the harness sends them), so only a browser notifies here.
  if (window.ohDesktop) return;
  const pref = uiOf(G.settings).notify;
  if (pref === 'off' || (pref === 'needs' && (n.kind === 'done' || n.kind === 'error')) || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = { done: '✓ Scheduled chat finished', error: '✕ Scheduled chat stopped', approval: '⏸ Scheduled chat needs your approval', answer: '❓ Scheduled chat has a question', budget: '💲 Project budget reached' }[n.kind] || 'QuorX';
  try { const x = new Notification(title, { body: `⏰ ${n.name}${n.text ? `\n${n.text}` : ''}`, icon: 'brand/quorx-192.png', tag: `oh-sched-${n.scheduleId}`, silent: n.kind === 'done' }); x.onclick = () => { window.focus(); if (n.chatId) showChat(n.chatId); x.close(); }; } catch { /* needs a service worker in some browsers */ }
}
// Every 30 s while any schedule exists (the list is short and the server answers from one small file).
function pollSchedules() {
  clearTimeout(SCHED.timer);
  SCHED.timer = setTimeout(async () => { await loadSchedules(); if ($('#schedules')?.open) drawSchedules(); pollSchedules(); }, SCHED.list.length ? 30e3 : 120e3);
}
async function openSchedules(editId) {
  const d = $('#schedules');
  $('#schedBody').innerHTML = '<div class="cx-loading">Loading schedules…</div>';
  if (!d.open) d.showModal();
  await loadSchedules();
  SCHED.edit = editId === 'new' ? blankSchedule() : null;
  drawSchedules();
}
function blankSchedule() {
  const c = focused(), pid = c?.projectId && G.projects.some((p) => p.id === c.projectId) ? c.projectId : (G.projects.find((p) => !p.archived && p.id !== 'scratch') || G.projects[0])?.id;
  const at = new Date(Date.now() + 3600e3); at.setSeconds(0, 0);
  return { name: '', projectId: pid, prompt: '', model: c?.agent.setup.model || G.settings.model, approval: 'strict', when: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, onceAt: at.getTime(), everyN: 2, everyUnit: 'hours' };
}
function drawSchedules() {
  const body = $('#schedBody');
  const proj = (id) => G.projects.find((p) => p.id === id)?.name || id;
  const rows = SCHED.list.map((s) => {
    const st = s.lastRun ? SCHED_STATUS[s.lastRun.status] || [s.lastRun.status, ''] : null;
    return `<li class="sc-row ${s.paused ? 'paused' : ''}" data-id="${esc(s.id)}">
      <div class="sc-main"><div class="sc-top"><b class="sc-name">${esc(s.name)}</b><span class="tag sc-proj">📁 ${esc(proj(s.projectId))}</span><span class="tag sc-mode ${s.approval}" title="${s.approval === 'yolo' ? 'YOLO: the deciders answer for you, nothing waits' : 'Strict: approvals and questions wait for you'}">${s.approval === 'yolo' ? '⚡ YOLO' : '🔒 Strict'}</span></div>
        <div class="sc-when">${esc(s.whenText)} · ${recDot(s.model, 'chat')} ${esc(short(s.model))}</div>
        <div class="sc-prompt" title="${esc(s.prompt)}">${esc(clip(s.prompt.replace(/\s+/g, ' '), 140))}</div>
        <div class="sc-runs"><span>Next: <b>${s.paused ? 'paused' : s.nextAt ? esc(when2(s.nextAt)) : 'none'}</b></span>${s.lastRun ? `<span>Last: ${esc(when2(s.lastRun.at))} <span class="sc-st ${st[1]}">${esc(st[0])}</span>${s.lastRun.missed ? '<span class="sc-st missed" title="QuorX was closed or the computer slept at the planned time, so it ran when QuorX was back">missed, ran late</span>' : ''}${s.lastRun.cost ? ` <span class="cost">${money(s.lastRun.cost, 4)}</span>` : ''}${s.lastRun.chatId ? ` <button type="button" class="mp-link sc-open" data-chat="${esc(s.lastRun.chatId)}">Open chat</button>` : ''}${s.lastRun.note ? `<small class="sc-note">${esc(s.lastRun.note)}</small>` : ''}</span>` : '<span class="sc-dim">Not run yet</span>'}</div></div>
      <div class="sc-acts"><button type="button" class="kx-btn sm sc-now" title="Start this chat now (the schedule stays as it is)">▶ Run now</button><button type="button" class="kx-btn sm sc-pause">${s.paused ? 'Resume' : 'Pause'}</button><button type="button" class="kx-btn sm sc-edit">Edit</button><button type="button" class="kx-btn sm sc-del" title="Delete this schedule (its chats stay)">🗑</button></div></li>`;
  }).join('');
  body.innerHTML = `${SCHED.edit ? scheduleForm(SCHED.edit) : `<div class="sc-head"><p class="pj-hint">Schedules start a normal chat on their own, with the saved prompt, model and mode. They run while QuorX is open or in the tray; a run missed while the computer slept runs once when it wakes. Budgets and caps apply as in any chat.</p><button type="button" class="kx-btn primary sc-new">+ New schedule</button></div>`}
    ${SCHED.list.length ? `<ol class="sc-list">${rows}</ol>` : SCHED.edit ? '' : '<div class="cx-empty">No schedules yet. For example: every weekday at 9, “summarise yesterday\'s commits”, or in an hour, “remind me to check the deploy”.</div>'}`;
  $('.sc-new', body)?.addEventListener('click', () => { SCHED.edit = blankSchedule(); drawSchedules(); $('#scName')?.focus(); });
  for (const row of body.querySelectorAll('.sc-row')) {
    const s = SCHED.list.find((x) => x.id === row.dataset.id);
    $('.sc-pause', row).onclick = async () => { const r = await postJ(`/api/schedules/${s.id}`, { paused: !s.paused }, 'PUT'); if (r?.error) return uiAlert(r.error); await loadSchedules(); drawSchedules(); };
    $('.sc-del', row).onclick = async () => { if (!(await uiConfirm(`Delete the schedule “${s.name}”? Chats it already started stay.`))) return; await postJ(`/api/schedules/${s.id}`, null, 'DELETE'); await loadSchedules(); drawSchedules(); };
    $('.sc-edit', row).onclick = () => { const at = s.when.kind === 'once' ? s.when.at : Date.now() + 3600e3; SCHED.edit = { ...s, onceAt: at, everyN: s.when.kind === 'every' ? (s.when.minutes % 60 ? s.when.minutes : s.when.minutes / 60) : 2, everyUnit: s.when.kind === 'every' && s.when.minutes % 60 ? 'minutes' : 'hours' }; drawSchedules(); };
    $('.sc-now', row).onclick = async (e) => { e.target.disabled = true; const r = await postJ(`/api/schedules/${s.id}/run`, {}); if (r?.error) { e.target.disabled = false; return uiAlert(`It did not start: ${r.error}`); } await loadSchedules(); drawSchedules(); refreshSidebar(); };
    const open = $('.sc-open', row); if (open) open.onclick = () => { $('#schedules').close(); showChat(open.dataset.chat); if (isPhone()) setMView('chat'); };
  }
  if (SCHED.edit) wireScheduleForm(body);
  pollSchedules();
}
const localInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function scheduleForm(e) {
  const w = e.when, kind = w.kind, days = kind === 'daily' ? w.days : [1, 2, 3, 4, 5];
  const projects = G.projects.filter((p) => !p.archived || p.id === e.projectId);
  return `<form class="sc-form" id="scForm" autocomplete="off">
    <h3>${e.id ? 'Edit schedule' : 'New schedule'}</h3>
    <label class="sc-f"><span>Name</span><input id="scName" maxlength="80" placeholder="Morning summary" value="${esc(e.name || '')}"></label>
    <label class="sc-f"><span>Project</span><select id="scProject">${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === e.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label class="sc-f sc-wide"><span>Prompt</span><textarea id="scPrompt" rows="4" placeholder="What the chat should do, as you would type it">${esc(e.prompt || '')}</textarea></label>
    <div class="sc-f sc-wide"><span>When</span><div class="sc-when-box">
      <div class="mp-sorts sc-kind" role="radiogroup" aria-label="How often">${[['once', 'Once'], ['daily', 'Daily'], ['every', 'Repeat every']].map(([k, l]) => `<button type="button" class="mp-sort ${kind === k ? 'on' : ''}" data-kind="${k}" role="radio" aria-checked="${kind === k}">${l}</button>`).join('')}</div>
      <div class="sc-kind-body" data-for="once" ${kind === 'once' ? '' : 'hidden'}><input type="datetime-local" id="scAt" value="${localInput(kind === 'once' ? w.at : e.onceAt)}"><button type="button" class="kx-btn sm sc-quick" data-in="60">In 1 hour</button><button type="button" class="kx-btn sm sc-quick" data-in="tomorrow">Tomorrow 9:00</button></div>
      <div class="sc-kind-body" data-for="daily" ${kind === 'daily' ? '' : 'hidden'}><input type="time" id="scTime" value="${esc(kind === 'daily' ? w.time : '09:00')}"><span class="sc-days">${WEEK.map(([d, l]) => `<label class="sq-check"><input type="checkbox" class="sc-day" value="${d}" ${!days.length || days.includes(d) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</span><button type="button" class="kx-btn sm sc-preset" data-days="1,2,3,4,5">Weekdays</button><button type="button" class="kx-btn sm sc-preset" data-days="0,1,2,3,4,5,6">Every day</button></div>
      <div class="sc-kind-body" data-for="every" ${kind === 'every' ? '' : 'hidden'}><input type="number" id="scEvery" min="1" max="10080" value="${esc(String(e.everyN))}"><select id="scUnit"><option value="minutes" ${e.everyUnit === 'minutes' ? 'selected' : ''}>minutes</option><option value="hours" ${e.everyUnit === 'hours' ? 'selected' : ''}>hours</option></select><small class="sc-dim">at least 15 minutes</small></div>
    </div></div>
    <div class="sc-f"><span>Model</span><button type="button" class="st-chip sc-model">${recDot(e.model, 'chat')} ${esc(short(e.model))} <small>${esc(shortPrice(e.model))}</small></button></div>
    <div class="sc-f"><span>Mode</span><div class="mp-sorts sc-mode-pick" role="radiogroup" aria-label="Permission mode">${[['strict', '🔒 Strict'], ['yolo', '⚡ YOLO']].map(([k, l]) => `<button type="button" class="mp-sort ${e.approval === k ? 'on' : ''}" data-mode="${k}" role="radio" aria-checked="${e.approval === k}">${l}</button>`).join('')}</div><small class="sc-dim sc-mode-note">${e.approval === 'yolo' ? 'Nothing waits: the deciders answer the agent\'s questions and approve commands for you.' : 'Approvals and questions wait for you, with a notification.'}</small></div>
    <div class="sc-form-acts"><span class="sc-err" role="alert"></span><button type="button" class="kx-btn sc-cancel">Cancel</button><button type="submit" class="kx-btn primary">${e.id ? 'Save' : 'Create schedule'}</button></div>
  </form>`;
}
function wireScheduleForm(body) {
  const e = SCHED.edit, f = $('#scForm', body);
  const keep = () => { e.name = $('#scName', f).value; e.projectId = $('#scProject', f).value; e.prompt = $('#scPrompt', f).value; };
  for (const b of f.querySelectorAll('.sc-kind button')) b.onclick = () => {
    keep();
    const k = b.dataset.kind;
    e.when = k === 'once' ? { kind: 'once', at: e.onceAt } : k === 'daily' ? { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } : { kind: 'every', minutes: 120 };
    drawSchedules();
  };
  for (const b of f.querySelectorAll('.sc-mode-pick button')) b.onclick = () => { keep(); e.approval = b.dataset.mode; drawSchedules(); };
  for (const b of f.querySelectorAll('.sc-quick')) b.onclick = () => {
    const t = new Date(); if (b.dataset.in === 'tomorrow') { t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0); } else { t.setMinutes(t.getMinutes() + Number(b.dataset.in)); t.setSeconds(0, 0); }
    $('#scAt', f).value = localInput(t.getTime());
  };
  for (const b of f.querySelectorAll('.sc-preset')) b.onclick = () => { const on = b.dataset.days.split(','); for (const c of f.querySelectorAll('.sc-day')) c.checked = on.includes(c.value); };
  $('.sc-model', f).onclick = async () => { keep(); const id = await pickModel('chat', e.model, { context: 'Model for this schedule' }); if (id) { e.model = id; drawSchedules(); } };
  $('.sc-cancel', f).onclick = () => { SCHED.edit = null; drawSchedules(); };
  f.onsubmit = async (ev) => {
    ev.preventDefault(); keep();
    const err = $('.sc-err', f);
    const k = e.when.kind;
    let when;
    if (k === 'once') when = { kind: 'once', at: new Date($('#scAt', f).value).getTime() };
    else if (k === 'daily') when = { kind: 'daily', time: $('#scTime', f).value, days: [...f.querySelectorAll('.sc-day:checked')].map((c) => Number(c.value)) };
    else when = { kind: 'every', minutes: Math.round(Number($('#scEvery', f).value) * ($('#scUnit', f).value === 'hours' ? 60 : 1)) };
    if (k === 'daily' && !when.days.length) { err.textContent = 'Pick at least one day.'; return; }
    // What a new chat in that project would get: your settings now, with this schedule's mode.
    const c = blankChat(e.projectId);
    c.approval = e.approval;
    const payload = { name: e.name, projectId: e.projectId, prompt: e.prompt, model: e.model, reasoning: c.agent.setup.reasoning, approval: e.approval, when, tools: c.tools,
      settings: { ...G.settings, approval: e.approval, tools: chatTools(c), ...qualitySettings(c), chromeAccess: !!c.tools?.chrome } };
    const r = await postJ(e.id ? `/api/schedules/${e.id}` : '/api/schedules', payload, e.id ? 'PUT' : 'POST');
    if (!r || r.error) { err.textContent = r?.error ? `${r.error[0].toUpperCase()}${r.error.slice(1)}.` : 'Not saved.'; return; }
    SCHED.edit = null; await loadSchedules(); drawSchedules();
  };
}
async function openCosts() {
  COSTS.q = ''; COSTS.projectsShown = 10;
  $('#costBody').innerHTML = '<div class="cx-loading">Loading costs…</div>';
  if (!$('#costs').open) $('#costs').showModal();
  await drawCosts();
}
// The models a chat used: one icon; hover it for each model and what it cost.
const cxModels = (models) => {
  const list = Object.entries(models || {}).sort((a, b) => b[1] - a[1]);
  if (!list.length) return '';
  const total = list.reduce((n, [, v]) => n + (v || 0), 0);
  // A card: the models this chat used, most expensive first, each with what it cost, then the total.
  const tip = [`${list.length} model${list.length === 1 ? '' : 's'} used`, ...list.map(([m, v]) => `${short(m)}\t${money(v, 4)}`), ...(list.length > 1 ? [`Total\t${money(total, 4)}`] : [])].join('\n');
  return `<span class="cx-mi" tabindex="0" title="${esc(tip)}" aria-label="${list.length} model${list.length === 1 ? '' : 's'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>${list.length}</span>`;
};
const costRow = (c, withProject, when) => `<tr><td><a href="#" data-open="${esc(c.id)}" title="${esc(c.title)}">${esc(c.title)}</a>${when && c.lastAt ? `<small class="cx-when">${ago(c.lastAt)}</small>` : ''}${withProject ? `<small class="cx-proj">${esc(G.projects.find((p) => p.id === c.projectId)?.name || c.projectId)}</small>` : ''}</td><td>${c.messages}</td><td class="cx-models">${cxModels(c.models)}</td><td class="mono">${money(c.today, 4)}</td><td class="mono cx-total">${money(c.cost, 4)}</td></tr>`;
const costHead = '<thead><tr><th>Chat</th><th>Msgs</th><th>Models</th><th>Today</th><th>Total</th></tr></thead>';
async function drawCosts() {
  const body = $('#costBody');
  const d = COSTS.data = await fetch(`/api/costs?per=5&sort=${COSTS.sort}`).then((r) => r.json()).catch(() => null);
  if (!d) { body.innerHTML = '<div class="cx-empty">Could not load costs. <button type="button" class="mp-link" id="cxRetry">Try again</button></div>'; $('#cxRetry').onclick = drawCosts; return; }
  const max = Math.max(0.000001, ...d.projects.map((p) => p.cost));
  body.innerHTML = `
    <div class="cost-totals cx-line"><div><small>Today</small><b>${money(d.total.today, 3)}</b></div><div><small>7 days</small><b>${money(d.total.week, 3)}</b></div><div><small>All time</small><b>${money(d.total.cost, 3)}</b></div><div><small>Chats</small><b class="cx-count">${d.total.chats}</b></div></div>
    <div class="cx-tools">
      <label class="mp-search cx-search"><span aria-hidden="true">⌕</span><input id="cxSearch" placeholder="Search every chat by title" aria-label="Search chats" value="${esc(COSTS.q)}"></label>
      <div class="mp-sorts" role="group" aria-label="Sort chats">${[['recent', 'Recent'], ['cost', 'Total'], ['today', 'Today'], ['messages', 'Messages'], ['name', 'Name']].map(([k, l]) => `<button type="button" class="mp-sort ${COSTS.sort === k ? 'on' : ''}" data-sort="${k}">${l}</button>`).join('')}</div>
    </div>
    <div id="cxList"></div>`;
  const list = $('#cxList');
  const drawProjects = () => {
    const shown = d.projects.slice(0, COSTS.projectsShown);
    list.innerHTML = (shown.length ? '<div class="cx-cols" aria-hidden="true"><span>Chat</span><span>Msgs</span><span>Models</span><span>Today</span><span>Total</span></div>' : '') + (shown.map((p) => `
      <details class="cost-proj" data-p="${esc(p.id)}" open>
        <summary style="${projStyle(p)}"><b class="cx-pname">${esc(p.name)}</b><small class="cx-n">${p.chatCount} chat${p.chatCount === 1 ? '' : 's'}${p.lastAt ? ` · ${ago(p.lastAt)}` : ''}</small>${(() => {
          // With a budget: what share of it is used (the line fills toward it). Without one: next to the biggest spender.
          const b = G.projects.find((x) => x.id === p.id)?.budget, has = typeof b === 'number' && b > 0;
          const share = has ? Math.min(1, p.cost / b) : p.cost / max, state = !has ? '' : share >= 1 ? 'full' : share >= 0.85 ? 'near' : 'ok';
          return `<span class="cost-bar cx-line ${state}" title="${has ? `${money(p.cost, 3)} of the $${b.toFixed(2)} budget (${Math.round(share * 100)}%)` : `No budget · spent next to the project that spent the most (${money(p.cost, 3)} of ${money(max, 3)})`}"><i style="width:${share * 100}%"></i></span><span class="mono">${money(p.cost, 3)}</span>${has ? `<small class="cx-budget">of $${b.toFixed(b < 10 ? 2 : 0)} · ${state === 'full' ? 'used up' : `${Math.round(share * 100)}%`}</small>` : ''}`;
        })()}</summary>
        <table class="cost-table cx-compact"><tbody>${p.chats.map((c) => costRow(c, false, true)).join('')}</tbody></table>
        ${p.chatCount > p.chats.length ? `<button type="button" class="cx-more" data-more="${esc(p.id)}" data-offset="${p.chats.length}">Show more (${p.chatCount - p.chats.length} more)</button>` : ''}
      </details>`).join('') || '<div class="cx-empty">No spending recorded yet.</div>')
      + (d.projects.length > COSTS.projectsShown ? `<button type="button" class="cx-more cx-more-proj">Show more projects (${d.projects.length - COSTS.projectsShown} more)</button>` : '');
    wire();
    const mp = $('.cx-more-proj', list); if (mp) mp.onclick = () => { COSTS.projectsShown += 10; drawProjects(); };
  };
  // the next page of one project's chats
  const wire = () => {
    for (const b of list.querySelectorAll('[data-more]')) b.onclick = async () => {
      b.disabled = true; b.textContent = 'Loading…';
      const page = await fetch(`/api/costs/chats?project=${encodeURIComponent(b.dataset.more)}&sort=${COSTS.sort}&offset=${b.dataset.offset}&limit=20`).then((r) => r.json()).catch(() => null);
      if (!page) { b.disabled = false; b.textContent = 'Try again'; return; }
      b.closest('.cost-proj').querySelector('tbody').insertAdjacentHTML('beforeend', page.chats.map((c) => costRow(c, false, true)).join(''));
      const next = page.offset + page.chats.length;
      if (next < page.total) { b.dataset.offset = next; b.disabled = false; b.textContent = `Show more (${page.total - next} more)`; } else b.remove();
      wireOpen();
    };
    wireOpen();
  };
  const wireOpen = () => { for (const a of body.querySelectorAll('[data-open]')) a.onclick = (e) => { e.preventDefault(); $('#costs').close(); showChat(a.dataset.open); if (isPhone()) setMView('chat'); }; };
  // search: every chat, paged
  let timer = 0;
  const search = async (offset = 0) => {
    const q = COSTS.q;
    if (!q) return drawProjects();
    const page = await fetch(`/api/costs/chats?q=${encodeURIComponent(q)}&sort=${COSTS.sort}&offset=${offset}&limit=25`).then((r) => r.json()).catch(() => null);
    if (!page || q !== COSTS.q) return;
    const rows = page.chats.map((c) => costRow(c, true)).join('');
    if (!offset) list.innerHTML = page.total ? `<div class="cx-found">${page.total} chat${page.total === 1 ? '' : 's'} match “${esc(q)}”</div><table class="cost-table">${costHead}<tbody>${rows}</tbody></table>` : `<div class="cx-empty">No chat title matches “${esc(q)}”.</div>`;
    else list.querySelector('tbody').insertAdjacentHTML('beforeend', rows);
    list.querySelector('.cx-more-search')?.remove();
    const next = page.offset + page.chats.length;
    if (next < page.total) { list.insertAdjacentHTML('beforeend', `<button type="button" class="cx-more cx-more-search">Show more (${page.total - next} more)</button>`); $('.cx-more-search', list).onclick = () => search(next); }
    wireOpen();
  };
  $('#cxSearch').oninput = (e) => { COSTS.q = e.target.value.trim(); clearTimeout(timer); timer = setTimeout(() => search(0), 200); };
  for (const b of body.querySelectorAll('.cx-tools .mp-sort')) b.onclick = () => { COSTS.sort = b.dataset.sort; try { localStorage.setItem('oh-cost-sort', COSTS.sort); } catch { /* storage off */ } drawCosts(); };
  COSTS.q ? search(0) : drawProjects();
}

// ---------- settings ----------
function catEditor([k, label, note], T = G.settings.tools) {
  const t = T[k];
  const rows = t.models ? [0, 1, 2].map((i) => {
    const id = t.models[i] || '';
    const voice = k === 'speech' ? `<input class="voice" list="dlv-${i}" placeholder="voice" value="${esc(t.voices?.[id] || '')}"><datalist id="dlv-${i}"></datalist>` : '';
    return `<div class="slot"><span class="n">${i + 1}</span><button type="button" class="mbtn m" data-id="${esc(id)}">${id ? esc(id) : `<i>${i ? 'add a model (optional)' : 'choose a model'}</i>`}</button>${voice}${id && i ? '<button type="button" class="ghost x" title="Remove">✕</button>' : ''}<small class="price"></small></div>`;
  }).join('') : '';
  const pick = t.models && k !== 'listen' ? `<label class="row">Model per call <select class="pick"><option value="fixed" ${t.pick !== 'agent' ? 'selected' : ''}>I pick: always model 1</option><option value="agent" ${t.pick === 'agent' ? 'selected' : ''}>Agent picks among these</option></select></label>` : '';
  const extra = k === 'image' ? `<label class="row">Size <select class="res">${['512', '768', '1K', '1.5K', '2K', '4K'].map((r) => `<option ${r === t.resolution ? 'selected' : ''}>${r}</option>`).join('')}</select></label>`
    : k === 'video' ? `<label class="row">Resolution <select class="res">${['480p', '720p', '1080p'].map((r) => `<option ${r === t.resolution ? 'selected' : ''}>${r}</option>`).join('')}</select> Default length <input type="number" class="secs" min="1" max="15" value="${t.seconds || 5}">s</label>` : '';
  return `<div class="cat" data-cat="${k}"><label class="row head"><input type="checkbox" class="on" ${t.on !== false ? 'checked' : ''}> <b>${label}</b> <small>${esc(note)}</small></label>${pick}${rows}${extra}</div>`;
}
function wireCatEditor(el) {
  const k = el.dataset.cat;
  for (const slot of el.querySelectorAll('.slot')) {
    const btn = $('.m', slot), price = $('.price', slot), voice = $('.voice', slot);
    const upd = () => {
      const id = btn.dataset.id;
      price.textContent = id ? priceOf(id, { res: $('.res', el)?.value }) : '';
      if (voice) $('datalist', slot).innerHTML = (G.byId.get(id)?.voices || []).map((v) => `<option value="${esc(v)}">`).join('');
    };
    btn.onclick = async () => { const id = await pickModel(k, btn.dataset.id, { context: `${CATS.find((x) => x[0] === k)?.[1] || k} · slot ${[...el.querySelectorAll('.slot')].indexOf(slot) + 1}` }); if (id) { btn.dataset.id = id; btn.textContent = id; if (voice) voice.value = ''; upd(); } };
    const x = $('.x', slot);
    if (x) x.onclick = () => { btn.dataset.id = ''; btn.innerHTML = '<i>add a model (optional)</i>'; upd(); };
    slot.upd = upd; upd();
  }
  const res = $('.res', el);
  if (res) res.onchange = () => el.querySelectorAll('.slot').forEach((sl) => sl.upd());
}
// ---------- settings page: categories on the left, that category's settings on the right ----------
const UI_DEFAULTS = { density: 'comfortable', fontSize: 14, reduceMotion: 'system', timestamps: 'time', paneMode: 'auto', sidebarStart: 'remember',
  showBalance: false, maskAmounts: true, blurPaths: false, usageBtn: true, notify: 'all' };
const SETTINGS_NAV = [
  ['Harness', [['setup', '🧪', 'Setup check'], ['appearance', '🎨', 'Appearance'], ['layout', '🧱', 'Layout'], ['privacy', '🕶', 'Privacy & display']]],
  ['OpenRouter', [['keys', '🔑', 'API keys'], ['models', '🧠', 'Models & catalogue']]],
  ['Agent', [['newchats', '✨', 'New chats'], ['loop', '🔁', 'Agent loop'], ['deciders', '⚖️', 'Deciders'], ['tools', '🧰', 'Tools & media'], ['budget', '💵', 'Budget & approvals'], ['safety', '🛡', 'Safety & commands'], ['skills', '🧩', 'Skills'], ['memory', '📌', 'Memory']]],
  ['Workspace', [['projects', '📁', 'Projects'], ['code', '💻', 'Code & servers'], ['docs', '📎', 'Documents']]],
  ['Data', [['usage', '📊', 'Usage & costs'], ['data', '🗄', 'Data & storage'], ['shortcuts', '⌨️', 'Shortcuts'], ['about', 'ℹ️', 'About']]],
];
const ST = { cat: 'appearance', draft: null, dirty: false, reveal: new Set(), revealAccount: false };
const uiOf = (S) => ({ ...UI_DEFAULTS, ...(S.ui || {}) });

// small control builders (they write into the draft through data-bind="path")
// The groups YOLO can do by itself (Settings → Budget & approvals); the server's YOLO_GROUPS match them.
const YOLO_ROWS = [
  ['files', 'Change files', 'Write, edit, append and delete files, and copy starter templates (deleted files go to .quorx/trash).'],
  ['commands', 'Run commands', 'Programs in the project folder: installs, builds, tests, scripts.'],
  ['servers', 'Start and stop servers', 'Dev servers and site previews from the launch file.'],
  ['browser', 'Use the browser', 'Open, click, type and look at pages in the agent\'s browser.'],
  ['web', 'Read web pages', 'Fetch the text of a public page for research.'],
  ['media', 'Paid media', 'Pictures, video, music and voice (they cost money; the budget cap still applies).'],
  ['artifacts', 'Write plans', 'Create and edit artifacts (plans, reports).'],
  ['helpers', 'Ask helpers', 'Hand a side task to a cheaper helper model.'],
  ['deciders', 'Ask the deciders', 'Quick yes/no checks by the decider models.'],
  ['skills', 'Save skills', 'Save a playbook into the project for later chats.'],
];
const stRow = (label, help, ctrl, extra = '') => `<div class="st-row" ${extra}><div class="st-row-info"><div class="st-row-label-wrap"><span class="st-row-label">${label}</span></div>${help ? `<div class="st-row-help">${help}</div>` : ''}</div><div class="st-row-ctrl">${ctrl}</div></div>`;
const stCard = (title, sub, body, cls = '') => `<section class="st-card ${cls}"><div class="st-card-head"><div class="st-card-title">${title}</div>${sub ? `<div class="st-card-subtitle">${sub}</div>` : ''}</div>${body}</section>`;
const stSwitch = (bind, on) => `<label class="st-switch"><input type="checkbox" role="switch" data-bind="${bind}" ${on ? 'checked' : ''}><span class="st-switch-track"><span class="st-switch-thumb"></span></span></label>`;
const stSeg = (bind, opts, v) => `<div class="st-segmented" role="radiogroup" data-bind="${bind}">${opts.map(([k, l]) => `<button type="button" class="st-seg-btn ${String(k) === String(v) ? 'active' : ''}" role="radio" aria-checked="${String(k) === String(v)}" data-v="${esc(k)}">${l}</button>`).join('')}</div>`;
const stStep = (bind, v, min, max, step = 1, unit = '') => `<div class="st-stepper" data-min="${min}" data-max="${max}" data-step="${step}"><button type="button" class="st-step-btn" data-d="-1" aria-label="Less">−</button><input class="st-step-val" type="number" data-bind="${bind}" value="${v}" min="${min}" max="${max}" step="${step}">${unit ? `<span class="st-step-unit">${unit}</span>` : ''}<button type="button" class="st-step-btn" data-d="1" aria-label="More">＋</button></div>`;
const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'), last = ks.pop(); const t = ks.reduce((x, k) => (x[k] ??= {}), o); t[last] = v; };

// ---------- Settings → Safety & commands: the simple controls on top, mapped onto the Advanced ticks ----------
// "Extra care" = all six check-first ticks. "When YOLO needs a decision" = the pause-for-you ticks.
const SF_CARE = ['yoloCheckWeb', 'yoloCheckInline', 'yoloCheckBuild', 'yoloCheckInstall', 'yoloCheckUnknown', 'yoloCheckReads'];
const SF_ASK = ['yoloExternal', 'yoloOutside', 'yoloGlobal'];
const sfOf = (S) => ({ ...(G.cfg?.defaults?.safety || {}), ...(S?.safety || {}) });
function sfModes(SF) {
  const care = SF_CARE.every((k) => SF[k]) ? 'on' : SF_CARE.every((k) => !SF[k]) ? 'off' : 'mix';
  // Ask me: the three pause-for-you groups wait for you (yoloOpaque is left as it is). Deciders: all four go to the vote.
  const decide = SF_ASK.every((k) => !SF[k]) ? 'ask' : [...SF_ASK, 'yoloOpaque'].every((k) => SF[k]) ? 'decide' : 'mix';
  return { care, decide };
}
// The three plain-word columns: they follow the current ticks.
function yoloShortHTML(SF) {
  const M = sfModes(SF);
  const tag = (t) => ` <span class="sf-by">· ${t}</span>`;
  const run = [['Builds and tests', ['yoloCheckBuild']], ['Installs in the project', ['yoloCheckInstall']], ['Web reads', ['yoloCheckWeb']], ['Scripts and one-liners', ['yoloCheckBuild', 'yoloCheckInline']], ['Servers and tunnels', ['yoloCheckBuild']], ['Reading files', ['yoloCheckReads']]]
    .map(([l, ks]) => `<li>${l}${M.care === 'mix' && ks.some((k) => SF[k]) ? tag('deciders check first') : ''}</li>`);
  const ask = [['Installs for the whole computer', 'yoloGlobal'], ['Pushes and deploys', 'yoloExternal'], ['Changes outside the project', 'yoloOutside'], ['Commands QuorX can’t read', 'yoloOpaque']]
    .map(([l, k]) => `<li>${l}${M.decide !== 'decide' && SF[k] ? tag('deciders decide') : ''}</li>`);
  ask.push(`<li>Reading your key folders${M.decide === 'decide' ? tag('always asks you') : ''}</li>`);
  const col = (cls, mark, title, items, note) => `<div class="sf-col ${cls}"><div class="sf-col-head"><span class="sf-mark" aria-hidden="true">${mark}</span>${title}</div><ul>${items.join('')}</ul>${note ? `<p class="sf-col-note">${note}</p>` : ''}</div>`;
  return col('ok', '✓', M.care === 'on' ? 'Runs after the deciders’ check' : 'Runs on its own', run,
    [M.care === 'on' ? 'A no from the deciders comes to you.' : '', SF.snapshots ? 'Undo covers what it changes in the project.' : 'Undo for commands is off.'].filter(Boolean).join(' '))
    + col('warn', '?', M.decide === 'decide' ? 'The deciders decide' : 'Asks you', ask, M.decide === 'ask' ? '' : 'A no or a split vote still comes to you.')
    + col('danger', '✕', 'Never', ['<li>System changes: power, services, registry, disks</li>', '<li>Deleting whole folders</li>', '<li>QuorX’s own keys</li>'], 'You run those yourself in a terminal tab.');
}
// Advanced starts closed; this browser remembers it open or closed.
const sfAdvPref = () => { try { return localStorage.getItem('oh-safety-adv') === '1'; } catch { return false; } };
// After any change on the page: the simple controls, the Advanced ticks and the three columns all show the draft.
function sfSync() {
  const panel = document.querySelector('#stMain [data-panel="safety"]'); if (!panel) return;
  const SF = sfOf(ST.draft), M = sfModes(SF);
  for (const b of panel.querySelectorAll('[data-sf="decide"] .st-seg-btn')) { const on = b.dataset.v === M.decide; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); }
  const care = $('[data-sf="care"]', panel); if (care) care.checked = M.care === 'on';
  for (const n of panel.querySelectorAll('[data-sf-note]')) n.hidden = M[n.dataset.sfNote] !== 'mix';
  for (const inp of panel.querySelectorAll('input[type="checkbox"][data-bind^="safety."]')) inp.checked = !!SF[inp.dataset.bind.slice(7)];
  const short = $('#sfShort'); if (short) short.innerHTML = yoloShortHTML(SF);
}
function wireSafetySimple(mark) {
  const panel = document.querySelector('#stMain [data-panel="safety"]'); if (!panel) return;
  const S = ST.draft;
  const set = (keys, v) => {
    S.safety ??= {};
    for (const k of keys) { S.safety[k] = v; $(`input[data-bind="safety.${k}"]`, panel)?.closest('.st-row')?.classList.add('changed'); }
  };
  for (const b of panel.querySelectorAll('[data-sf="decide"] .st-seg-btn')) b.onclick = () => {
    if (b.dataset.v === 'decide') set([...SF_ASK, 'yoloOpaque'], true); else set(SF_ASK, false);
    b.closest('.st-row')?.classList.add('changed'); mark(); sfSync();
  };
  const care = $('[data-sf="care"]', panel);
  if (care) care.onchange = () => { set(SF_CARE, care.checked); care.closest('.st-row')?.classList.add('changed'); mark(); sfSync(); };
  // An Advanced tick (or the Undo box) changed: the generic handler has already written the draft.
  panel.addEventListener('change', (e) => { if (e.target.matches?.('input[data-bind^="safety."]')) sfSync(); });
  const adv = $('#sfAdv');
  if (adv) adv.ontoggle = () => { if ($('#stSearch').value.trim()) return; try { localStorage.setItem('oh-safety-adv', adv.open ? '1' : ''); } catch { /* this session only */ } };
}

function settingsPanels(S) {
  const U = uiOf(S), d = G.cfg.defaults;
  const keysBadge = G.cfg.hasKey ? '' : 'bad-dot';
  return {
    appearance: ['Appearance', 'How the harness looks on this computer.', [
      stCard('Theme', '', `<div class="st-theme-picker" data-bind="theme">${[[null, 'System', 'system'], ['dark', 'Dark', 'dark'], ['light', 'Light', 'light']].map(([v, l, cls]) => `<button type="button" class="st-theme-card ${(S.theme ?? null) === v ? 'active' : ''}" data-v="${v ?? ''}"><span class="st-theme-preview-box ${cls}">${cls === 'system' ? '<span class="thumb-left"></span><span class="thumb-right"></span>' : '<span class="thumb-bar"></span><span class="thumb-sidebar"></span><span class="thumb-dot"></span>'}</span><span class="st-theme-card-foot"><span class="st-theme-card-label">${l}</span><span class="st-theme-card-radio"></span></span></button>`).join('')}</div>`),
      stCard('Text and spacing', '', stRow('Density', 'Compact fits more messages and chats on screen.', stSeg('ui.density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], U.density))
        + stRow('Message text size', 'Replies, your posts and the message box.', stStep('ui.fontSize', U.fontSize, 12, 18, 1, 'px'))
        + stRow('Motion', 'Animations and transitions. “Follow system” uses Windows’ Animation effects setting (or your OS’s reduce-motion setting).', stSeg('ui.reduceMotion', [['system', 'Follow system'], ['full', 'On'], ['reduce', 'Reduced']], motionPref(U)))
        + stRow('Message timestamps', 'Shown on every post.', stSeg('ui.timestamps', [['time', 'Time'], ['relative', 'Relative'], ['off', 'Off']], U.timestamps))),
      stCard('Notifications', '', stRow('Tell me when a reply…', 'Only while QuorX is in the background. Click a notification to open that chat. Your browser asks once, the first time you send a message.', stSeg('ui.notify', [['all', 'Needs me or ends'], ['needs', 'Needs me'], ['off', 'Off']], U.notify))),
    ]],
    layout: ['Layout', 'Where things sit on the page.', [
      stCard('Panels', '', stRow('Sidebar when the harness opens', '“Remember” keeps it as you last left it.', stSeg('ui.sidebarStart', [['remember', 'Remember'], ['expanded', 'Expanded'], ['rail', 'Rail']], U.sidebarStart))
        + stRow('Artifact pane', 'Auto shows it only when the chat has built something. ◧ in a chat\'s header still toggles it.', stSeg('ui.paneMode', [['auto', 'Auto'], ['always', 'Always'], ['never', 'Only when asked']], U.paneMode))
        + stRow('Sidebar project order', 'Drag a project\'s header in the sidebar to move it.', `<button type="button" class="st-btn ghost sm" data-act="resetOrder">Reset order</button>`)),
    ]],
    privacy: ['Privacy & display', 'For streaming and screen sharing.', [
      stCard('Balance', '', stRow('Show the 💲 balance button in the top bar', 'Off by default, so your OpenRouter spend never shows on a stream. ⚙ Settings → API keys always has the numbers.', stSwitch('ui.showBalance', U.showBalance))
        + stRow('Hide amounts until I click 👁', 'All-time spend, key limits and account credits stay masked (•••) until you reveal them.', stSwitch('ui.maskAmounts', U.maskAmounts))),
      stCard('Paths', '', stRow('Blur folder paths', 'Project folders in the explorer and settings are blurred until you hover them.', stSwitch('ui.blurPaths', U.blurPaths))),
      stCard('Browser', '', stRow('Search with', 'Words typed in the Browser tab’s address bar (not an address) are searched here. Start with ? to always search.', stSeg('ui.searchEngine', [...Object.entries(SEARCH_ENGINES).map(([k, [l]]) => [k, l]), ['custom', 'Custom']], U.searchEngine || 'google'))
        + stRow('Custom search address', 'Used when Custom is picked: the address of a search with %s where the words go.', `<input type="text" class="st-input" data-bind="ui.searchCustom" value="${esc(U.searchCustom || '')}" placeholder="https://example.com/search?q=%s" spellcheck="false">`)),
    ]],
    keys: ['API keys', 'The harness uses one active OpenRouter key for every call. Add as many as you like and switch between them.', [`<div id="stKeys"><div class="st-row-help">Loading keys…</div></div>`]],
    models: ['Models & catalogue', 'Model lists and prices come from OpenRouter.', [
      stCard('Catalogue', '', stRow('Model lists and prices', `<span id="stCatInfo">${G.models ? `${G.models.length} models loaded` : 'Loading…'}</span>`, `<button type="button" class="st-btn secondary sm" data-act="refreshModels">↻ Refresh now</button>`)),
      stCard('New chats use', '', stRow('Default chat model', 'Each chat can still pick any model from its message box.', `<button type="button" class="st-chip" data-act="pickDefModel" id="defModel" data-id="${esc(S.model)}">${recDot(S.model, 'chat')} ${esc(short(S.model))} <small>${esc(shortPrice(S.model))}</small></button>`)
        + stRow('Default reasoning', '', stSeg('reasoning', [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], S.reasoning || 'off'))),
      stCard('Routing', 'How OpenRouter picks the provider behind each model, for every chat’s agent calls. The provider that answered shows on each step in “Steps”.',
        stRow('Provider order', 'Auto favours providers with reliable tool calling (OpenRouter’s Exacto). Cheapest and Fastest sort by price or speed instead.', stSeg('providerSort', [['auto', 'Auto'], ['price', 'Cheapest'], ['throughput', 'Fastest']], S.providerSort || 'auto'))
        + stRow('Only providers that support every feature', 'Skips providers that would silently drop tools, reasoning or other settings. If none qualifies, that reply uses the default routing.', stSwitch('requireParams', S.requireParams !== false))
        + stRow('Zero data retention only', 'Only providers that keep no copy of your prompts. Fewer models qualify.', stSwitch('zdrOnly', !!S.zdrOnly))
        + stRow('Fallback model', 'OpenRouter switches to it when a chat’s model fails or is down, billed at its own price. The trace marks steps it answered.', `<div class="st-fb"><button type="button" class="st-chip" data-act="pickFallback" id="fbModel">${S.fallbackModel ? `${esc(short(S.fallbackModel))} <small>${esc(shortPrice(S.fallbackModel))}</small>` : 'None'}</button>${S.fallbackModel ? '<button type="button" class="st-btn secondary sm" data-act="clearFallback" title="No fallback model">✕</button>' : ''}</div>`)),
    ]],
    newchats: ['New chats', 'What a fresh chat starts with. Each chat can change these in its message box.', [
      stCard('Permissions', '', stRow('Default permission mode', '🔒 Strict asks you before paid media (pictures, video, music, speech, with the price), and the agent\'s questions come to you. ⚡ YOLO never asks: the deciders answer the agent\'s questions for you (the budget cap still applies).', stSeg('approval', [['strict', '🔒 Strict'], ['yolo', '⚡ YOLO']], S.approval))
        + stRow('In 🔒 Strict, ask before', 'Paid media: only pictures, video, music and speech. Every tool: also file edits, commands, reads, the browser and helpers, as before.', stSeg('strictAsk', [['paid', 'Paid media'], ['every', 'Every tool']], S.strictAsk || 'paid'))
        + stRow('Also ask before helpers', 'Helpers hand read-only jobs to a cheaper model. Only with “Paid media”.', stSwitch('strictAskHelpers', S.strictAskHelpers === true))
        + stRow('Also ask before decider checks', 'decide and look ask the deciders; each costs well under $0.001. Only with “Paid media”.', stSwitch('strictAskDeciders', S.strictAskDeciders === true))),
      stCard('Tools on by default', 'For new chats; each chat can change them in its 🧰 Tools menu. Pages, code & servers and the browser are always on.',
        QUALITY_TOOLS.map((k) => stRow(`${QUALITY_INFO[k].icon} ${QUALITY_INFO[k].name}`, `${QUALITY_INFO[k].note} ${QUALITY_INFO[k].perBuild()}.`, stSwitch(`newChatTools.${k}`, S.newChatTools?.[k] !== false))).join('')
        + CHAT_TOOLS.map((k) => stRow(CATS.find((x) => x[0] === k)[1], 'Paid per use.', stSwitch(`newChatTools.${k}`, !!S.newChatTools?.[k]))).join('')),
    ]],
    loop: ['Agent loop', 'How long one reply may work, and how long chats stay cheap.', [
      stCard('Steps', '', stRow('Max model calls per reply', 'A page takes 6–15; a multi-file app with a server can take 40 or more. At 80% the agent is told to wrap up.', stStep('maxSteps', S.maxSteps, 2, 120))
        + stRow('Plan first', 'Off: the agent plans and builds in one go. Big tasks: for a new app, site, game or a change across several files, it shows its plan and waits for Go ahead, Stop here, or your changes. Always: before any file change or command. File changes and commands are refused until you say Go ahead. Waits for you in 🔒 Strict and ⚡ YOLO alike.', stSeg('planFirst', [['off', 'Off'], ['big', 'Big tasks'], ['always', 'Always']], S.planFirst || 'off'))
        + stRow('Steps when the reply has a plan', 'A planned build gets this many instead (checks, previews and review take steps). 0 = the same as above.', stStep('planSteps', S.planSteps ?? 0, 0, 200))
        + stRow('Keep going while the plan is open', 'When the steps run out and the plan still has open items, the reply gets this many extra rounds of half the steps (budget caps still apply). 0 = stop at the limit.', stStep('continueRounds', S.continueRounds ?? 2, 0, 5))
        + stRow('Output per model call', 'Tokens one call may write (thinking included), never more than the model allows. Too little and a model can think through a whole file, then run out before writing it.', stStep('maxOutput', S.maxOutput ?? 64000, 4000, 128000, 4000, 'tokens'))
        + stRow('Thinking share', 'How much of that output reasoning may use, so the answer and tool calls always have room.', stStep('thinkShare', S.thinkShare ?? 25, 5, 60, 5, '%'))
        + stRow('Thinking for builds', 'When the gap check sees that a message asks for a build and the chat\'s thinking is off, the model thinks this much for that reply. Deciders find problems; thinking is what fixes them.', stSeg('buildThinking', [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], S.buildThinking || 'low'))
        + stRow('Retries on model errors', 'Rate limits, network drops and provider errors are retried with growing waits before the reply gives up.', stStep('retries', S.retries ?? 3, 0, 6))
        + stRow('Run look-ups together', 'Several reads, searches and fetches in one step run at the same time.', stSwitch('parallel', S.parallel !== false))),
      stCard('Checks before the final reply', '', stRow('Check the work', 'Re-checks every changed file (Node, Python, JSON, CSS, HTML) and opens what was built in the browser. Problems go back to the agent to fix.', stSwitch('verify', S.verify !== false))
        + stRow('Design lint', 'After each HTML or CSS write, points out patterns that make a page look machine-made: default indigo, purple-blue hero gradients, emoji icons, invented numbers, filler text, missing alt text or focus styles. Advice only: it never sends a build back. Free, no model call.', stSwitch('designLint', S.designLint !== false))
        + stRow('Rounds to fix problems', 'How many times the agent is sent back. After that the reply ends and shows what is left.', stStep('verifyRounds', S.verifyRounds ?? 2, 0, 5))
        + stRow('Steps to fix', 'When the checks or the reviewer send a build back near the step limit, the reply gets this many steps to fix it, instead of ending with a to-do list.', stStep('fixSteps', S.fixSteps ?? 12, 4, 40))),
      stCard('Reviewer', 'A separate model with a fresh context tests what was built before the final reply, scores it, and sends it back with specific bugs if it falls short.',
        stRow('When to review', 'Builds: when the agent made a plan for the reply. Always: whenever it built or changed something that can be opened.', stSeg('review', [['off', 'Off'], ['builds', 'Builds'], ['always', 'Always']], S.review || 'builds'))
        + stRow('Reviewer strength', 'Cheap: gpt-6-luna, about $0.003 a review, but it fails good builds often (it agreed with the benchmark judge 43% of the time). Strong: Claude Sonnet 5.5, about $0.02 a build, agreed 100% and caused no needless rounds of fixing (gpt-6.1-sol when Sonnet is the builder). A model picked below overrides this.', stSeg('reviewTier', [['cheap', 'Cheap'], ['strong', 'Strong']], S.reviewTier || 'cheap'))
        + stRow('Review code changes', 'After a reply that changed code, the reviewer reads the diff and posts the bugs it finds as a card you can send back to fix (about $0.001–0.01 a review). Off: only when you type /review.', stSeg('codeReview', [['off', 'Off'], ['auto', 'After replies']], S.codeReview || 'off'))
        + stRow('Send a build back for', 'Every bug the reviewer reports says how bad it is. Minor bugs never send a build back; they go to the builder as notes.', stSeg('reviewSendBack', [['annoying', 'Breaks or annoying'], ['breaks', 'Only breaks']], S.reviewSendBack || 'annoying'))
        + stRow('Reviewer model', 'Default: gpt-6-luna, which is cheap, sees screenshots, and comes from a different family than most builders (qwen3.7-flash if your chat already uses gpt-6-luna). Pick one that can use tools and see images.', `<div class="st-fb"><button type="button" class="st-chip" data-act="pickReviewer" id="rvModel">${S.reviewModel ? `${recDot(S.reviewModel, 'chat')} ${esc(short(S.reviewModel))} <small>${esc(shortPrice(S.reviewModel))}</small>` : 'Default'}</button>${S.reviewModel ? '<button type="button" class="st-btn secondary sm" data-act="clearReviewer" title="Use the default reviewer">✕</button>' : ''}</div>`)
        + stRow('Rounds to fix', 'How many times the builder is sent back with the reviewer’s bugs. After that, what is still open shows in the reply.', stStep('reviewRounds', S.reviewRounds ?? 1, 0, 3))
        + stRow('Pass bar', 'Every score (function, craft, design, originality, accessibility, and brand fit when the project has a DESIGN.md) must reach this, out of 5.', stStep('reviewBar', S.reviewBar ?? 3, 1, 5))),
      stCard('Helpers', 'For exploring big projects: the agent hands read-only jobs (find, read, summarise) to a cheaper model with its own clean context. Only the helper’s short report comes back, so the agent’s context stays small. Several run at once.',
        stRow('Let the agent use helpers', 'Offered only in chats with a project folder.', stSwitch('helpers', S.helpers !== false))
        + stRow('Only in projects with at least', 'Small builds never used them, and offering them costs prompt space on every step. 0 = every project.', stStep('helperMinFiles', S.helperMinFiles ?? 40, 0, 400, 10, ' files'))
        + stRow('Helper model', 'Default: qwen3.7-flash, which is very cheap, uses tools, and has a 1M-token window. Pick one that can use tools.', `<div class="st-fb"><button type="button" class="st-chip" data-act="pickHelper" id="hpModel">${S.helperModel ? `${recDot(S.helperModel, 'chat')} ${esc(short(S.helperModel))} <small>${esc(shortPrice(S.helperModel))}</small>` : 'Default'}</button>${S.helperModel ? '<button type="button" class="st-btn secondary sm" data-act="clearHelper" title="Use the default helper">✕</button>' : ''}</div>`)
        + stRow('Steps per helper', 'Model calls one helper may make before it must report.', stStep('helperSteps', S.helperSteps ?? 12, 2, 30))),
      stCard('Questions', '', stRow('Questions per reply', 'How often the agent may stop to ask you a question with options (ask_user). 0 = never.', stStep('askLimit', S.askLimit ?? 4, 0, 10))),
      stCard('Long replies', '', stRow('Trim after', 'Characters of conversation inside one reply before old file contents are dropped from it (they stay on disk).', stStep('trimAt', S.trimAt || 120000, 30000, 400000, 10000))),
      stCard('Long chats', '', stRow('Summarise older turns', 'Keeps the context small: older turns become a short summary (shown in the trace as 🗜).', stSwitch('compact', S.compact !== false))
        + stRow('Summarise after', 'Characters of history before the older part is summarised.', stStep('compactAt', S.compactAt || 24000, 8000, 120000, 4000))),
    ]],
    deciders: ['Deciders', 'The fast judges the agent asks when it is unsure. It writes its own questions and guesses first.', [
      stCard('Decider models', 'Up to 5. More deciders agree more reliably but cost more.', '<div id="voterInputs"></div>'),
      stCard('Confidence', '', stRow('Settled at', 'Answers at least this confident count as settled.', stStep('gate.act', S.gate.act, 0.5, 1, 0.05)) + stRow('Lean at', 'Below this the deciders are unsure.', stStep('gate.confirm', S.gate.confirm, 0.3, 0.95, 0.05))),
      stCard('Look and harness checks', 'Screenshot checks and the gap check ask one decider that reads pictures well, not the whole panel. The others are asked only when it is unsure.',
        '<div id="lookInputs"></div>'
        + stRow('Ask the other deciders when it is unsure', 'Only the unsure answers go to the rest of the panel above.', stSwitch('lookEscalate', S.lookEscalate !== false))),
      stCard('Harness checks', 'Fixed questions QuorX asks the deciders at fixed moments, written here instead of by the model. Every answer is logged with its screenshot, so <code>node scripts/checks.mjs</code> can score each question and try new wording on past screenshots.',
        stRow('Gap check before a build', 'Is the message a build, and does it say what a person does in it, what must be in it, how it should look, and the real content? What it leaves out goes to the agent to ask about.', stSwitch('checks.gap', S.checks?.gap !== false))
        + stRow('Screenshot checks', 'After a preview and before the final reply: blank page, unreadable text, broken images, content spilling off the page. Problems go back to the agent.', stSwitch('checks.shots', S.checks?.shots !== false))
        + stRow('Click and key check', 'Clicks the page\'s main button (Start, Add, Play…; never print, download, share or one already selected) and asks whether anything changed. A page with no button, like a keyboard game, gets Enter, Space and the arrows instead.', stSwitch('checks.click', S.checks?.click !== false))
        + stRow('A gap counts below', 'Chance that the message says it.', stStep('checks.gapBelow', S.checks?.gapBelow ?? 0.4, 0.1, 0.9, 0.05))
        + stRow('A check fails below', 'Chance that the screenshot is fine.', stStep('checks.shotBelow', S.checks?.shotBelow ?? 0.3, 0.05, 0.9, 0.05))
        + '<div id="checkList"></div>'),
    ]],
    tools: ['Tools & media', 'Up to 3 models per tool, and who picks the model for each call. Each chat turns tools on in its 🧰 menu.', ['<div id="catEditors"></div>']],
    budget: ['Budget & approvals', 'Limits on paid calls.', [
      stCard('Caps on every model', 'They count everything a reply calls: the agent, the deciders, helpers, screenshot checks and paid media.',
        stRow('Cap per reply', 'At 85% the agent is told to wrap up. At the cap, 🔒 Strict asks you to raise it or wrap up; ⚡ YOLO stops. 0 = no cap.', stStep('replyBudget', S.replyBudget ?? d.replyBudget ?? 1, 0, 100, 0.25, '$'))
        + stRow('Cap per day', 'Today’s spending across all projects. A reply that reaches it stops (Strict asks first). 0 = off. A separate OpenRouter key with its own daily limit is a good second fence for ⚡ YOLO.', stStep('dailyBudget', S.dailyBudget ?? d.dailyBudget ?? 0, 0, 1000, 1, '$'))),
      stCard('Paid calls', '', stRow('Paid media per reply', 'A paid call that would go over this is stopped, in Strict and in YOLO.', stStep('budget', S.budget, 0, 20, 0.05, '$'))
        + stRow('Deciders check paid calls in ⚡ YOLO', 'Before each paid call: is it needed, is the price fair?', stSwitch('yoloCheck', S.yoloCheck !== false))
        + stRow('⚡ YOLO waits for you', 'When the agent asks a question, or the deciders can\'t settle an approval, the card waits this long so you can steer. Then the deciders answer (a question of taste goes back to the agent), or the approval carries on: a command runs only if the deciders saw little risk. "Wait for me" on the card, or typing in it, stops the clock. 0 = no wait.', stStep('yoloWaitSecs', S.yoloWaitSecs ?? 15, 0, 120, 5, 's'))),
      stCard('What ⚡ YOLO does by itself', 'Ticked: YOLO goes ahead without asking. Unticked: it asks you first, as Strict does (Always allow stops the asking for that chat). Reading files, listing and searching never ask.',
        YOLO_ROWS.map(([k, label, help]) => stRow(label, help, stSwitch(`yoloAuto.${k}`, S.yoloAuto?.[k] !== false))).join('')),
      stCard('Project budgets', 'Set a project\'s budget with the $ next to it in the sidebar.', stRow('Allowance to finish a reply', 'A new reply can\'t start once the project budget is used up. A reply already working may go this far past it to finish, then it is stopped. 0% stops it right at the budget.', stStep('budgetGrace', S.budgetGrace ?? 10, 0, 100, 5, '%'))),
    ]],
    safety: (() => {
      const SF = { ...(d.safety || {}), ...(S.safety || {}) };
      const M = sfModes(SF);
      return ['Safety & commands', 'What ⚡ YOLO runs on its own, what it asks you, and what never runs. Advanced has every detail: the shell, each YOLO tick, the deciders’ vote and your command rules.', [
        stCard('⚡ YOLO in short', '', `<div id="sfShort" class="sf-short">${yoloShortHTML(SF)}</div>`),
        stCard('Your choices', '',
          stRow('When YOLO needs a decision', 'Ask me: pushes, deploys, installs for the whole computer and changes outside the project wait for you. The deciders: they vote instead, and a no or a split vote still comes to you.',
            `<div class="sf-ctrl">${stSeg('', [['ask', 'Ask me'], ['decide', 'Let the deciders decide']], M.decide).replace('data-bind=""', 'data-sf="decide" aria-label="When YOLO needs a decision"')}<span class="sf-custom" data-sf-note="decide" ${M.decide === 'mix' ? '' : 'hidden'}>Custom (see Advanced)</span></div>`)
          + stRow('Extra care', 'The deciders check every command before it runs. Slower, and stricter.',
            `<div class="sf-ctrl"><span class="sf-custom" data-sf-note="care" ${M.care === 'mix' ? '' : 'hidden'}>Custom (see Advanced)</span>${stSwitch('', M.care === 'on').replace('data-bind=""', 'data-sf="care" aria-label="Extra care"')}</div>`)
          + stRow('Undo for commands', 'QuorX snapshots the project before a command that can change files, so ↶ Undo and Review changes cover it. Not covered: files outside the project, ignored folders (node_modules, target…), pushes, installs and databases.', stSwitch('safety.snapshots', SF.snapshots))),
        `<details class="sf-adv" id="sfAdv" ${sfAdvPref() ? 'open' : ''}><summary><span class="sf-adv-title">Advanced</span><span class="sf-adv-sub">Shell, undo size, tripwire, each YOLO tick, debugger, the deciders’ vote, audit log, command rules</span></summary><div class="sf-adv-body">` + [
        stCard('Shell', '', stRow('The agent’s shell', G.cfg?.platform && G.cfg.platform !== 'win32'
          ? 'Both are checked with the same rules: each command is split into its parts first, and anything that runs text as a command (eval, $(…), zsh’s glob qualifiers) asks you.'
          : 'Windows PowerShell 5.1 is read by PowerShell’s own parser, so its commands can be checked exactly. cmd and Git Bash are checked with simpler rules, and Git Bash’s path translation caused the worst delete incidents in other agents.',
        stSeg('safety.shell', G.cfg?.platform && G.cfg.platform !== 'win32' ? [['bash', 'bash'], ['zsh', 'zsh']] : [['powershell', 'PowerShell 5.1'], ['pwsh', 'PowerShell 7'], ['cmd', 'cmd'], ['bash', 'Git Bash']], SF.shell))
          + stRow('Wait for a command', 'How long the agent waits for a command before it moves to the background. It keeps running there while the agent carries on; you see it, and can stop it, in the pane’s Running tab.', stStep('safety.timeout', SF.timeout, 5, 900, 5, 's'))
          + stRow('Memory cap per command', `For the command and everything it starts, so a runaway build can’t starve your PC. 0 = no cap.${G.cfg?.platform && G.cfg.platform !== 'win32' ? ' Windows only for now.' : ''}`, stStep('safety.memoryMB', SF.memoryMB, 0, 65536, 256, 'MB'))
          + stRow('Stop', 'How Stop ends a command.', '<span id="stStopMode" class="st-chip">checking…</span>')),
        stCard('Undo size limit', 'Undo for commands is turned on or off above. Each snapshot reads only the files that changed.',
          stRow('Pause snapshots past', 'A project bigger than this (not counting ignored folders) runs commands without a snapshot, and each command row says so.', stStep('safety.snapshotMaxMB', SF.snapshotMaxMB, 50, 100000, 50, 'MB'))),
        stCard('Tripwire', 'While a command runs, QuorX watches your profile and the folders around the project. If many files vanish there, it stops the command and shows what it saw. It is a last line of defence, not a guarantee.',
          stRow('Watch for mass deletes', '', stSwitch('safety.tripwire', SF.tripwire))
          + stRow('Stop after', 'Files removed outside the project…', stStep('safety.tripwireFiles', SF.tripwireFiles, 2, 10000, 1, 'files'))
          + stRow('Within', '…in this many seconds.', stStep('safety.tripwireSeconds', SF.tripwireSeconds, 1, 120, 1, 's'))),
        stCard('⚡ YOLO: what runs on its own', 'Unticked, it just runs; a snapshot first makes it undoable. Ticked, the deciders vote first, and a no comes to you.',
          stRow('Web reads', 'curl or Invoke-WebRequest GET, wrangler whoami, gh pr view, cloud CLI list and describe. Sending data, signing in or deploying always pauses (below).', stSwitch('safety.yoloCheckWeb', SF.yoloCheckWeb))
          + stRow('One-liners', 'node -e, python -c whose code QuorX can read. One that starts programs or deletes files counts as code QuorX can’t read.', stSwitch('safety.yoloCheckInline', SF.yoloCheckInline))
          + stRow('Builds, tests and project scripts', 'cargo build, npm test, node app.js, servers and tunnels…', stSwitch('safety.yoloCheckBuild', SF.yoloCheckBuild))
          + stRow('Package installs in the project', 'npm i, pip install, cargo add… A made-up package is still blocked, and a brand-new one still asks you.', stSwitch('safety.yoloCheckInstall', SF.yoloCheckInstall))
          + stRow('Commands QuorX doesn’t know', 'Programs with no rule yet. A PowerShell command that can change things (Stop-, Set-, Disable-…) or docker always goes to the deciders.', stSwitch('safety.yoloCheckUnknown', SF.yoloCheckUnknown))
          + stRow('Reading files outside the project', 'Never your key folders or QuorX’s own data.', stSwitch('safety.yoloCheckReads', SF.yoloCheckReads))),
        stCard('⚡ YOLO: what pauses for you', 'These show you an amber card even in YOLO. Ticked, the deciders may approve them instead.',
          stRow('Pushes, publishes and deploys', 'Anything that sends data out or changes a remote: git push, npm publish, wrangler deploy, a POST…', stSwitch('safety.yoloExternal', SF.yoloExternal))
          + stRow('Writes and deletes outside the project', 'Never the blocked places: drive roots, your profile, system folders, folders above the project.', stSwitch('safety.yoloOutside', SF.yoloOutside))
          + stRow('Installs for the whole computer', 'npm i -g, winget, cargo install, pipx…', stSwitch('safety.yoloGlobal', SF.yoloGlobal))
          + stRow('Commands QuorX can’t read', 'cmd /c, iex, one-liners that start programs, scripts built from text. Ticked by default.', stSwitch('safety.yoloOpaque', SF.yoloOpaque))
          + stRow('Always asks you', 'Reading your key folders (a red card; hooks never run it), ending other programs, and throwing away uncommitted work.', '')
          + stRow('Never runs', 'System changes (power, services, registry, disks, admin rights), deleting whole folders (the agent uses the trash instead), blocked places and QuorX’s own keys. Run those yourself in a terminal tab.', '')),
        stCard('Debugger and devices', '',
          stRow('Debugger for Node and Python', 'Research found a debugger helps strong models most after plain debugging fails, and can make weaker ones worse from the start. “After failed tries”: it opens once the agent has hit errors or had a build sent back.', stSeg('debugger', [['earned', 'After failed tries'], ['always', 'Always'], ['off', 'Off']], S.debugger || 'earned'))
          + stRow('Let the android tool use a physical phone', 'Unticked, it uses emulators only: a phone holds your real accounts and data.', stSwitch('safety.androidPhones', SF.androidPhones))),
        stCard('How the deciders vote on an action', 'They see your own messages and the facts QuorX worked out (the command, its parts, the real paths, the price), never the agent’s reasons or tool output. A decider can’t be the chat’s own model. A failed or split vote waits for you. Every vote is logged in logs/approvals.jsonl.',
          stRow('Valid votes needed', 'Fewer than this and it asks you.', stStep('safety.quorum', SF.quorum, 1, 5))
          + stRow('“The user asked for it” at least', 'Chance the deciders give that your messages ask for it.', stStep('safety.neededMin', SF.neededMin, 0.5, 1, 0.05))
          + stRow('“It could do harm” at most', 'Damage outside the project, leaked data or keys, or cost.', stStep('safety.harmMax', SF.harmMax, 0, 0.5, 0.05))
          + stRow('Pause after blocks in a row', 'Then commands that need a vote ask you for the rest of the reply.', stStep('safety.escalateRow', SF.escalateRow, 1, 20))
          + stRow('…or blocks in one reply', '', stStep('safety.escalateTotal', SF.escalateTotal, 1, 200))),
        stCard('Audit log', 'Every command the agent ran or was stopped from running, and who let it: a rule, you, the deciders, or the built-in classes. Votes are in logs/approvals.jsonl; this log is logs/audit.jsonl.', '<div id="stAudit"><div class="st-row-help">Loading…</div></div>'),
        stCard('Command rules', 'Your rules, checked before the built-in classes: deny beats ask beats allow. A rule can always make a command stricter. Rules made with the “Always allow…” button never relax pushes, uncheckable commands or deletes outside the project; rules you type here can. Changes here save at once.', '<div id="stPerms"><div class="st-row-help">Loading rules…</div></div>'),
        ].join('') + '</div></details>',
      ]];
    })(),
    skills: ['Skills', 'Playbooks the agent loads when a task fits. Agents can also save their own into a project.', ['<div id="skillList" class="st-skill-list"></div>']],
    memory: ['Memory', 'A few facts and preferences about you that every chat gets, in every project.', ['<div id="memPanel"></div>']],
    projects: ['Projects', 'A project is a folder that many chats share. Changes here apply at once.', [`<div id="stProjects"></div>`]],
    docs: ['Documents', 'Files you attach with 📎. They are kept in the project folder\'s .quorx/uploads, which git ignores.', [
      stCard('Reading', 'Text is read out of PDFs, Word, PowerPoint, Excel, OpenDocument, EPUB, HTML, code and plain text. Other files are saved and the agent decides whether it can read them.',
        stRow('Send whole up to', 'Smaller documents go into your message as they are; bigger ones are made searchable.', stStep('inlineDocTokens', S.inlineDocTokens ?? 15000, 1000, 200000, 1000, 'tokens'))
        + stRow('Upload limit', 'Per file.', stStep('maxUploadMB', S.maxUploadMB ?? 100, 1, 2000, 10, 'MB'))
        + stRow('Send PDFs as files', 'To models that read files themselves: they also see layout and pictures, but it costs more, because the PDF goes along with every step of the reply.', stSwitch('pdfNative', !!S.pdfNative))),
      stCard('Search', 'Big documents are split into passages and embedded once with an OpenRouter embedding model; the agent searches them with search_docs and reads exact lines with read_doc. A 300-page book is about 150k tokens.',
        stRow('Embedding model', 'Price per million tokens. Changing it re-indexes a document the next time it is attached.', '<div id="stEmbedPick" class="st-embed-pick">Loading models…</div>')
        + stRow('Ask before indexing over', 'Above this cost the attachment waits for your OK.', stStep('docIndexBudget', S.docIndexBudget ?? 0.5, 0, 50, 0.1, '$'))),
      stCard('PDFs', 'PDFs are read for free on this computer with pdftotext when it is installed (Git for Windows includes it); otherwise through OpenRouter\'s free parser. A scan with no text asks before OCR (mistral-ocr, about $2 per 1,000 pages).', ''),
    ]],
    code: ['Code & servers', 'What the agent may run on this computer.', [
      stCard('Commands', 'The agent runs command lines in its shell. Each one is checked first: read-only commands run, others ask you (or the deciders in ⚡ YOLO), and system commands or deletes outside the project are blocked.', stRow('Rules, shell, Stop and Undo for commands', '', '<button type="button" class="st-btn secondary sm" data-act="openSafety">🛡 Safety & commands</button>')),
      stCard('Agent folder', 'The agent keeps research scripts, downloads, undo history and deleted files in .quorx/ inside each project folder. Git ignores it, so it never ends up in your repo.', stRow('Ask me when it grows past', 'The chat shows a notice with what to clear, and the agent asks before adding more.', stStep('agentSpaceMB', S.agentSpaceMB ?? 500, 50, 50000, 50, 'MB'))
        + stRow('Undo for the newest', 'Replies per project that keep ↶ Undo. Older undo copies are removed when a new reply starts.', stStep('undoKeep', S.undoKeep ?? 10, 1, 100, 1, 'replies'))
        + stRow('Undo kept for at most', 'Even among the newest replies, Undo goes after this long. For history that lasts, use git.', stStep('undoDays', S.undoDays ?? 7, 1, 90, 1, 'days'))),
      stCard('Servers and browser', 'Servers are saved in .quorx/launch.json per project; run and stop them from 🖥 in the chat header, and watch them in the terminal.', stRow('Dev server ports', 'Each server gets a free port here unless it has a fixed one.', '<code>5300–5999</code>')
        + stRow('Headless browser', 'Used by the agent to check its own pages.', `<code class="blurable">${esc(G.cfg.browser || 'not found')}</code>`)
        + stRow('Secrets', 'Agent processes run without your API keys, tokens or passwords in their environment, and the file tools cannot read .env or data/keys.json.', '<span class="st-key-source-badge">protected</span>')),
      stCard('Chrome extension', 'Give a tab of your everyday Chrome to a chat, so the agent can work in it with your own sign-ins (Gmail, GitHub…). It touches only tabs you give; sending, deleting, buying and account changes ask you first.', '<div id="stExt"></div>'),
    ]],
    usage: ['Usage & costs', 'What chats and projects cost.', [
      stCard('In chats', '', stRow('Show the cost badge in chat headers', 'The amber cost next to the model; click it for the per-chat usage breakdown (also /usage).', stSwitch('ui.usageBtn', U.usageBtn))),
      stCard('Everything', '', stRow('Costs per project and chat', '', '<button type="button" class="st-btn secondary sm" data-act="openCosts">💲 Open costs</button>')),
    ]],
    data: ['Data & storage', 'Where things are kept.', [
      stCard('Chats', 'Saved on this computer in data/chats; deleted chats move to data/trash.', stRow('Export all chats', 'One JSON file with every chat.', '<button type="button" class="st-btn secondary sm" data-act="exportChats">⬇ Export</button>')),
      backupCard(),
      stCard('Danger zone', '', stRow('Clear this browser\'s preferences', 'Settings, layout and theme go back to defaults. Chats, projects and keys are not touched.', '<button type="button" class="st-btn danger sm" data-act="clearPrefs">Clear</button>'), 'danger'),
    ]],
    setup: ['Setup check', 'What this computer has for QuorX, and what each thing is for. Amber rows are optional.', ['<div id="stSetup"><div class="st-row-help">Checking this computer…</div></div>']],
    shortcuts: ['Shortcuts', '', [stCard('Keyboard', '', `<table class="st-shortcuts-table"><tbody>${[['Ctrl + K', 'Search chats, commands, settings and files'], ['Enter', 'Send'], ['Shift + Enter', 'New line'], ['@', 'Add files, chats or projects as context'], ['/', 'Commands (/usage, /model, /strict, …)'], ['↑ ↓ then Enter or Tab', 'Pick a suggestion'], ['Esc', 'Close a dialog or suggestions']].map(([k, v]) => `<tr><td>${k.split(' ').map((x) => (/^[+]$|^then$|^or$/.test(x) ? x : `<kbd>${esc(x)}</kbd>`)).join(' ')}</td><td>${v}</td></tr>`).join('')}</tbody></table>`)]],
    about: ['About', '', [...(DESK ? ['<div id="stDesktop"></div>'] : []), stCard('QuorX', '', stRow('Version', DESK ? 'The desktop app and the harness it is attached to.' : '', `<code id="stVersion">v${esc(G.cfg?.version || '?')}</code>`) + stRow('Address', '', `<code>${esc(location.origin)}</code>`) + stRow('OpenRouter key', '', G.cfg.hasKey ? '<span class="st-key-active-badge">active</span>' : '<span class="st-nav-badge bad-dot"></span> none yet') + stRow('Your data', 'Chats, projects, keys and logs stay in this folder.', '<code>data/</code>') + stRow('Tour', 'Five short steps over the page: projects, Strict and YOLO, the deciders and reviewer, costs, the terminal.', '<button type="button" class="st-btn secondary sm" data-act="tour">Show the tour</button>'))]],
    _badges: { keys: keysBadge },
  };
}

function openSettings(cat) {
  ST.draft = structuredClone(G.settings);
  ST.draft.theme = G.theme ?? null; ST.themeAtOpen = G.theme ?? null;
  ST.draft.newChatTools ??= { ...DEFAULT_CHAT_TOOLS };
  ST.dirty = false; ST.reveal = new Set(); ST.revealAccount = false;
  if (cat) ST.cat = cat;
  $('#stSearch').value = '';
  drawSettings();
  if (!$('#settings').open) $('#settings').showModal();
}
function drawSettings() {
  const S = ST.draft, P = settingsPanels(S);
  $('#stNav').innerHTML = SETTINGS_NAV.map(([group, items]) => `<div class="st-nav-group"><div class="st-nav-group-label">${group}</div>${items.map(([id, ico, label]) => `<button type="button" class="st-nav-item ${ST.cat === id ? 'active' : ''}" data-cat="${id}" ${ST.cat === id ? 'aria-current="page"' : ''}><span class="st-nav-item-left"><span class="st-nav-icon">${ico}</span><span class="st-nav-label">${label}</span></span>${P._badges[id] ? `<span class="st-nav-badge ${P._badges[id]}"></span>` : id === 'skills' && G.skillCount ? `<span class="st-nav-badge count">${G.skillCount}</span>` : ''}</button>`).join('')}</div>`).join('');
  for (const b of document.querySelectorAll('#stNav .st-nav-item')) b.onclick = () => { ST.cat = b.dataset.cat; $('#stSearch').value = ''; drawSettings(); };
  // Every panel is in the page (search looks through all of them); only the chosen one shows.
  $('#stMain').innerHTML = SETTINGS_NAV.flatMap(([, items]) => items).map(([id]) => {
    const [title, desc, cards] = P[id];
    return `<section class="st-panel ${ST.cat === id ? 'active' : ''}" data-panel="${id}"><div class="st-panel-head"><div class="st-panel-title-wrap"><h3 class="st-panel-title">${title}</h3>${desc ? `<p class="st-panel-desc">${desc}</p>` : ''}</div></div>${cards.join('')}</section>`;
  }).join('');
  wireSettings();
  updateDirty();
}
function wireSettings() {
  const S = ST.draft, main = $('#stMain');
  const mark = () => { ST.dirty = true; updateDirty(); };
  for (const inp of main.querySelectorAll('input[data-bind]')) inp.onchange = () => {
    const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'text' ? inp.value.trim() : Number(inp.value);
    setPath(S, inp.dataset.bind, v); inp.closest('.st-row')?.classList.add('changed'); mark();
  };
  for (const seg of main.querySelectorAll('.st-segmented[data-bind]')) for (const b of seg.querySelectorAll('.st-seg-btn')) b.onclick = () => {
    for (const x of seg.querySelectorAll('.st-seg-btn')) { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); }
    setPath(S, seg.dataset.bind, b.dataset.v); seg.closest('.st-row')?.classList.add('changed'); mark();
  };
  for (const st of main.querySelectorAll('.st-stepper')) {
    const inp = $('input', st), step = Number(st.dataset.step), min = Number(st.dataset.min), max = Number(st.dataset.max);
    for (const b of st.querySelectorAll('.st-step-btn')) b.onclick = () => { inp.value = +Math.max(min, Math.min(max, Number(inp.value) + step * Number(b.dataset.d))).toFixed(2); inp.onchange(); };
  }
  for (const b of main.querySelectorAll('.st-theme-card')) b.onclick = () => {
    for (const x of main.querySelectorAll('.st-theme-card')) x.classList.toggle('active', x === b);
    S.theme = b.dataset.v || null; mark();
    G.theme = S.theme; applyTheme(); // preview right away; Cancel puts it back
  };
  main.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'pickDefModel') { const id = await pickModel('chat', S.model, { context: 'Default for new chats' }); if (id) { S.model = id; const b = $('#defModel'); b.dataset.id = id; b.innerHTML = `${esc(short(id))} <small>${esc(shortPrice(id))}</small>`; mark(); } }
    if (act === 'pickFallback') { const id = await pickModel('chat', S.fallbackModel || '', { context: 'Fallback when a chat’s model fails' }); if (id) { S.fallbackModel = id; mark(); drawSettings(); } }
    if (act === 'clearFallback') { S.fallbackModel = ''; mark(); drawSettings(); }
    if (act === 'openSafety') { ST.cat = 'safety'; drawSettings(); }
    if (act === 'pickReviewer') { const id = await pickModel('chat', S.reviewModel || '', { context: 'Reviewer: tests what was built' }); if (id) { S.reviewModel = id; mark(); drawSettings(); } }
    if (act === 'clearReviewer') { S.reviewModel = ''; mark(); drawSettings(); }
    if (act === 'pickHelper') { const id = await pickModel('chat', S.helperModel || '', { context: 'Helper: read-only jobs' }); if (id) { S.helperModel = id; mark(); drawSettings(); } }
    if (act === 'clearHelper') { S.helperModel = ''; mark(); drawSettings(); }
    if (act === 'refreshModels') { $('#stCatInfo').textContent = 'Refreshing…'; await loadModels(true); $('#stCatInfo').textContent = `${G.models?.length || 0} models loaded · refreshed ${new Date().toLocaleTimeString()}`; }
    if (act === 'resetOrder') { G.projectOrder = []; savePrefs(); renderSidebar(); e.target.textContent = 'Done'; }
    if (act === 'openCosts') openCosts();
    if (act === 'tour') { $('#settings').close(); startTour({ fill: fillStart }); }
    if (act === 'exportChats') exportChats(e.target);
    if (act === 'clearPrefs' && await uiConfirm('Clear this browser\'s preferences? Chats, projects and keys stay.')) { try { localStorage.removeItem(STORE); localStorage.removeItem('agent001-v1'); } catch { /* ignore */ } location.reload(); }
  };
  wireSafetySimple(mark);
  // the richer editors
  $('#voterInputs').innerHTML = [0, 1, 2, 3, 4].map((i) => `<div class="slot"><span class="n">${i + 1}</span><button type="button" class="mbtn m" data-id="${esc(S.voters[i] || '')}">${S.voters[i] ? `${recDot(S.voters[i], 'decision')} ${esc(S.voters[i])}` : `<i>${i < 3 ? 'choose a decider' : 'add a decider (optional)'}</i>`}</button>${S.voters[i] && i ? '<button type="button" class="ghost x" title="Remove">✕</button>' : ''}<small class="price">${esc(priceOf(S.voters[i]))}</small></div>`).join('');
  for (const slot of document.querySelectorAll('#voterInputs .slot')) {
    const btn = $('.m', slot);
    btn.onclick = async () => { const id = await pickModel('decision', btn.dataset.id, { context: `Decider ${[...document.querySelectorAll('#voterInputs .slot')].indexOf(slot) + 1}` }); if (id) { btn.dataset.id = id; btn.textContent = id; $('.price', slot).textContent = priceOf(id); mark(); } };
    const x = $('.x', slot); if (x) x.onclick = () => { btn.dataset.id = ''; btn.innerHTML = '<i>add a decider (optional)</i>'; $('.price', slot).textContent = ''; mark(); };
  }
  const lookIds = Array.isArray(S.lookVoters) && S.lookVoters.length ? S.lookVoters : G.cfg.defaults.lookVoters || ['openai/gpt-6-luna-decisions'];
  $('#lookInputs').innerHTML = `<div class="slot"><span class="n">👁</span><button type="button" class="mbtn m" data-id="${esc(lookIds[0])}">${recDot(lookIds[0], 'decision')} ${esc(lookIds[0])}</button><small class="price">${esc(priceOf(lookIds[0]))}</small></div>`;
  for (const slot of document.querySelectorAll('#lookInputs .slot')) {
    const btn = $('.m', slot);
    btn.onclick = async () => { const id = await pickModel('decision', btn.dataset.id, { context: 'Decider for look and the harness checks (it must read images)' }); if (id) { btn.dataset.id = id; btn.textContent = id; $('.price', slot).textContent = priceOf(id); mark(); } };
  }
  drawCheckList(S, mark);
  $('#catEditors').innerHTML = CATS.map((cat) => catEditor(cat, S.tools)).join('');
  for (const el of document.querySelectorAll('#catEditors .cat')) { wireCatEditor(el); el.addEventListener('change', mark); el.addEventListener('click', (ev) => { if (ev.target.closest('button')) mark(); }); }
  const off = new Set(S.skillsOff || []);
  fetch(`/api/skills?project=${focused()?.projectId || 'scratch'}`).then((r) => r.json()).then((list) => {
    G.skillCount = list.length;
    $('#skillList').innerHTML = list.length ? list.map((k) => `<div class="st-skill-item"><div class="st-skill-info"><div class="st-skill-top"><span class="st-skill-name">${esc(k.name)}</span><span class="st-source-badge ${k.source === 'built-in' ? 'builtin' : k.source === 'project' ? 'project' : 'saved'}">${esc(k.source)}</span></div><div class="st-skill-desc">${esc(k.description)}</div></div>${stSwitch('', !off.has(k.name)).replace('data-bind=""', `data-skill="${esc(k.name)}"`)}</div>`).join('') : '<p class="st-row-help">No skills yet.</p>';
    for (const inp of document.querySelectorAll('#skillList input[data-skill]')) inp.onchange = mark;
  }).catch(() => {});
  drawProjectsPanel();
  drawPermsPanel();
  drawKeysPanel();
  drawMemoryPanel();
  drawSetupPanel();
  drawExtPanel();
  drawEmbedPick();
  drawDesktopSettings();
  drawBackup({ postJ, esc, uiConfirm, store: STORE });
  showVersion();
}
// Search looks through every category; matching rows show, everything else hides.
function searchSettings(q) {
  q = q.trim().toLowerCase();
  $('#stMain').classList.toggle('searching', !!q);
  for (const panel of document.querySelectorAll('#stMain .st-panel')) {
    let any = false;
    for (const card of panel.querySelectorAll('.st-card, .st-key-card, .st-account-card, .st-hero-onboard')) {
      let hit = false;
      const rows = card.querySelectorAll('.st-row, .st-skill-item, .st-proj-row, .cat');
      for (const r of rows) { const m = !q || r.textContent.toLowerCase().includes(q); r.hidden = !m; hit ||= m; }
      if (!rows.length || card.querySelector('.st-card-title')?.textContent.toLowerCase().includes(q)) { hit = !q || card.textContent.toLowerCase().includes(q); for (const r of rows) if (hit) r.hidden = false; }
      card.hidden = !hit; any ||= hit;
    }
    panel.classList.toggle('active', q ? any || panel.querySelector('.st-panel-title').textContent.toLowerCase().includes(q) : panel.dataset.panel === ST.cat);
  }
  // Safety's Advanced: a search that hits inside opens it; clearing the search puts it back as you left it.
  const adv = $('#sfAdv');
  if (adv) {
    const hit = [...adv.querySelectorAll('.st-card')].some((c) => !c.hidden);
    adv.hidden = !!q && !hit;
    adv.open = q ? hit : sfAdvPref();
  }
}
// Reset category: that category's settings go back to the defaults (still unsaved until Save).
function resetCategory() {
  const S = ST.draft, d = G.cfg.defaults, U = (S.ui ??= {});
  const uiKeys = { appearance: ['density', 'fontSize', 'reduceMotion', 'timestamps', 'notify'], layout: ['sidebarStart', 'paneMode'], privacy: ['showBalance', 'maskAmounts', 'blurPaths'], usage: ['usageBtn'] }[ST.cat];
  if (uiKeys) for (const k of uiKeys) U[k] = UI_DEFAULTS[k];
  if (ST.cat === 'appearance') { S.theme = null; G.theme = null; applyTheme(); }
  if (ST.cat === 'models') { S.model = d.chatModel || d.setups.C.model; S.reasoning = 'off'; Object.assign(S, { providerSort: 'auto', requireParams: true, zdrOnly: false, fallbackModel: '' }); }
  if (ST.cat === 'newchats') { S.approval = d.approval; S.strictAsk = d.strictAsk; S.strictAskHelpers = d.strictAskHelpers; S.strictAskDeciders = d.strictAskDeciders; S.newChatTools = { ...DEFAULT_CHAT_TOOLS }; }
  if (ST.cat === 'loop') { S.maxSteps = d.maxSteps; S.compact = true; S.compactAt = 24000; Object.assign(S, { planFirst: d.planFirst, planSteps: d.planSteps, continueRounds: d.continueRounds, maxOutput: d.maxOutput, thinkShare: d.thinkShare, review: d.review, reviewModel: '', reviewTier: d.reviewTier, reviewSendBack: d.reviewSendBack, codeReview: d.codeReview, reviewRounds: d.reviewRounds, reviewBar: d.reviewBar, helpers: d.helpers, helperModel: '', helperSteps: d.helperSteps, helperMinFiles: d.helperMinFiles, retries: d.retries, parallel: d.parallel, verify: d.verify, verifyRounds: d.verifyRounds, askLimit: d.askLimit, trimAt: d.trimAt, buildThinking: d.buildThinking }); }
  if (ST.cat === 'deciders') { S.voters = [...d.voters]; S.gate = { ...d.gate }; S.lookVoters = [...d.lookVoters]; S.lookEscalate = d.lookEscalate; S.checks = structuredClone(d.checks); }
  if (ST.cat === 'tools') S.tools = structuredClone(d.tools);
  if (ST.cat === 'budget') { S.budget = d.budget; S.yoloCheck = true; S.budgetGrace = d.budgetGrace; S.yoloAuto = {}; }
  if (ST.cat === 'skills') S.skillsOff = [];
  if (ST.cat === 'safety') { S.safety = { ...(d.safety || {}) }; S.debugger = 'earned'; }
  ST.dirty = true; drawSettings();
}
function updateDirty() {
  $('#stDirty').textContent = ST.dirty ? 'Unsaved changes' : 'No changes';
  $('.st-foot').classList.toggle('dirty', ST.dirty);
}
// The harness's questions, each with its own wording (blank = the built-in one) and a switch; plus your own.
function drawCheckList(S, mark) {
  const box = $('#checkList'); if (!box) return;
  const L = G.cfg.checks || {}, C = (S.checks ??= {}), E = (C.edits ??= {});
  const kinds = [['gap', 'Gap check · the request says…'], ['shot', 'Screenshot · yes means fine'], ['click', 'Click · {control} is the button clicked'], ['keys', 'Keys · for pages with no button, {keys} is what was pressed']];
  const row = (kind, q, custom) => {
    const key = `${kind}:${q.id}`, e = E[key] || {};
    return `<div class="st-check"><input type="checkbox" title="Use this check" data-bind="checks.edits.${esc(key)}.on" ${e.on === false || e.off ? '' : 'checked'}>
      <div class="st-check-body"><input type="text" class="st-input st-check-ask" aria-label="Wording of ${esc(q.id)}" data-bind="checks.edits.${esc(key)}.ask" value="${esc(e.ask || q.ask)}" placeholder="${esc(q.ask)}">
      <small><code>${esc(kind)}:${esc(q.id)}</code> · v${esc(q.v || 1)}${custom ? ' · yours <button type="button" class="st-btn secondary sm st-check-x" data-i="' + custom.i + '">Remove</button>' : ''}</small></div></div>`;
  };
  const custom = (C.custom || []).map((x, i) => ({ ...x, i }));
  box.innerHTML = kinds.map(([kind, title]) => `<div class="st-check-group"><div class="st-check-title">${esc(title)}</div>${(L[kind] || []).filter((q) => !q.gate).map((q) => row(kind, q)).join('')}${custom.filter((x) => x.kind === kind).map((x) => row(kind, x, x)).join('')}</div>`).join('')
    + `<div class="st-check-add"><input type="text" class="st-input" id="newCheck" placeholder="Add your own screenshot check, as a yes = fine statement (e.g. The logo is in the top left corner.)"><button type="button" class="st-btn secondary sm" id="addCheck">Add</button></div>`;
  for (const inp of box.querySelectorAll('input[data-bind]')) inp.onchange = () => { setPath(S, inp.dataset.bind, inp.type === 'checkbox' ? inp.checked : inp.value.trim()); mark(); };
  for (const b of box.querySelectorAll('.st-check-x')) b.onclick = () => { C.custom.splice(Number(b.dataset.i), 1); drawCheckList(S, mark); mark(); };
  $('#addCheck').onclick = () => { const ask = $('#newCheck').value.trim(); if (!ask) return; (C.custom ??= []).push({ kind: 'shot', id: `mine${Date.now().toString(36)}`, ask, label: `not true: ${ask}` }); drawCheckList(S, mark); mark(); };
}
function saveSettings() {
  const S = ST.draft;
  const look = $('#lookInputs .m')?.dataset.id;
  if (look) S.lookVoters = [look];
  const voters = [...document.querySelectorAll('#voterInputs .m')].map((b) => b.dataset.id).filter(Boolean);
  if (voters.length) S.voters = voters;
  S.maxSteps = Math.max(2, Math.min(120, Number(S.maxSteps) || 60));
  S.budget = Math.max(0, Number(S.budget) || 0);
  S.skillsOff = [...document.querySelectorAll('#skillList input[data-skill]')].filter((x) => !x.checked).map((x) => x.dataset.skill);
  for (const el of document.querySelectorAll('#catEditors .cat')) {
    const k = el.dataset.cat, t = S.tools[k];
    t.on = $('.on', el).checked;
    if (t.models) {
      const slots = [...el.querySelectorAll('.slot')];
      const models = slots.map((sl) => $('.m', sl).dataset.id || '');
      if (models.some(Boolean)) t.models = models.filter(Boolean);
      if (k === 'speech') t.voices = Object.fromEntries(slots.map((sl, i) => [models[i], $('.voice', sl).value.trim()]).filter(([m, v]) => m && v));
    }
    if ($('.pick', el)) t.pick = $('.pick', el).value;
    if ($('.res', el)) t.resolution = $('.res', el).value;
    if ($('.secs', el)) t.seconds = Math.max(1, Math.min(15, Number($('.secs', el).value) || 5));
  }
  G.theme = S.theme ?? null; delete S.theme;
  G.settings = S;
  savePrefs(); applyTheme(); applyUi();
  renderToolbars(); renderPanes(); renderSpend();
  $('#settings').close();
}
// Cancel (or Esc) drops the draft and undoes the theme preview.
function cancelSettings() { G.theme = ST.themeAtOpen; applyTheme(); if ($('#settings').open) $('#settings').close(); }

// Projects panel: acts at once (like the sidebar's ⚙ and 🗑).
// Settings → Projects: one compact row per project (colour, spend vs budget, folder) with icon actions.
// ⚙ Settings → Code & servers → Chrome extension: set up in your default browser (Brave, Chrome, Edge…), connect with
// one click (Allow here), and whether it is connected. The key is a fallback, under "Use a key instead".
async function drawExtPanel() {
  const box = $('#stExt'); if (!box) return;
  const r = await getJ('/api/ext/status');
  if (!box.isConnected || !r || r.error) return;
  const b = r.browser || { name: 'Chrome', page: 'chrome://extensions' }, page = b.page || 'chrome://extensions';
  let shown = false;
  const paint = () => {
    box.innerHTML = `<div class="st-ext">
      <div class="st-ext-state ${r.connected ? (r.outdated ? 'warn' : 'on') : ''}"><i></i>${r.connected ? (r.outdated ? `Connected, but the extension is an older version: reload it once in ${esc(page)} (↻ on the QuorX card)` : `Connected to your ${esc(b.name)}`) : 'Not connected'}${r.lent?.length ? ` · ${r.lent.length} tab${r.lent.length > 1 ? 's' : ''} given to chats` : ''}</div>
      ${r.pairing ? `<div class="st-ext-pair"><b>🧩 ${esc(r.pairing.browser)} wants to connect to QuorX.</b> Allow it only if you just pressed Connect in the extension.<span class="st-ext-acts"><button type="button" class="st-btn sm primary" data-x="allow">Allow</button><button type="button" class="st-btn sm" data-x="deny">Deny</button></span></div>` : ''}
      ${b.page === null ? `<p class="st-ext-warn">Your default browser is ${esc(b.name)}, which can't run this extension. Use Chrome, Brave or Edge for it.</p>` : ''}
      <ol class="st-ext-steps">
        <li>Open <code>${esc(page)}</code> in ${esc(b.name)} <span class="st-ext-acts"><button type="button" class="st-btn sm" data-x="chrome" title="Opens the extensions page in ${esc(b.name)}">Open in ${esc(b.name)}</button><button type="button" class="st-btn sm" data-x="copyurl">Copy</button></span> and turn on <b>Developer mode</b>.</li>
        <li><b>Load unpacked</b> and pick the folder <code class="blurable">${esc(r.folder || 'extension')}</code> <span class="st-ext-acts"><button type="button" class="st-btn sm" data-x="copyfolder">Copy path</button><button type="button" class="st-btn sm" data-x="folder">Show folder</button></span></li>
        <li>Click the QuorX icon in the toolbar and press <b>Connect</b>, then <b>Allow</b> here.</li>
        <li>In a chat, tick <b>🧩 Chrome</b> (next to Follow), or give a tab from the QuorX icon.</li>
      </ol>
      <details class="st-ext-keybox"><summary>Use a key instead</summary><div class="st-ext-key"><code class="${shown ? '' : 'masked'}">${shown ? esc(r.key) : '•'.repeat(24)}</code><button type="button" class="kx-icon" data-x="show" title="${shown ? 'Hide the key' : 'Show the key'}">${shown ? '🙈' : '👁'}</button><button type="button" class="st-btn sm" data-x="copy">Copy key</button><button type="button" class="st-btn sm danger" data-x="new" title="Make a new key: the extension disconnects until it connects again">New key</button></div></details>
    </div>`;
    const copy = async (btn, text) => { try { await navigator.clipboard.writeText(text); flashTip(btn, 'Copied'); } catch { uiPrompt('Copy this', text, { ok: 'Done', cancel: 'Close' }); } };
    $('[data-x="show"]', box).onclick = () => { shown = !shown; paint(); $('.st-ext-keybox', box).open = true; };
    $('[data-x="copy"]', box).onclick = (e) => copy(e.currentTarget, r.key);
    $('[data-x="copyurl"]', box).onclick = (e) => copy(e.currentTarget, page);
    $('[data-x="copyfolder"]', box).onclick = (e) => copy(e.currentTarget, r.folder || '');
    $('[data-x="chrome"]', box).onclick = async (e) => { const btn = e.currentTarget, x = await postJ('/api/ext/open-chrome', {}); flashTip(btn, x.error ? `${x.error}: copy the address instead` : `Opened in ${x.browser || b.name}`); };
    $('[data-x="folder"]', box).onclick = async (e) => { const btn = e.currentTarget, x = await postJ('/api/ext/show-folder', {}); if (x.error) flashTip(btn, x.error); };
    $('[data-x="new"]', box).onclick = async () => { if (!(await uiConfirm('Make a new key?\nThe extension disconnects until it connects again (Connect in the extension, then Allow here).', { ok: 'New key', danger: true }))) return; const n = await postJ('/api/ext/key', {}); if (n.key) { r.key = n.key; r.connected = false; shown = true; paint(); } };
    for (const [x, allow] of [['allow', true], ['deny', false]]) { const btn = $(`[data-x="${x}"]`, box); if (btn) btn.onclick = async () => { await postJ('/api/ext/pair', { allow }); setTimeout(drawExtPanel, 700); }; }
  };
  paint();
}
// An extension asking to connect: a notice anywhere in QuorX with Allow / Deny (it waits up to 2 minutes).
function extPairNotice() {
  let n = $('#extPairNotice');
  const p = G.ext?.pairing;
  if (!p) { n?.remove(); return; }
  if (n && n.dataset.at === String(p.at)) return;
  n?.remove();
  n = document.createElement('div'); n.id = 'extPairNotice'; n.className = 'ext-pair-notice'; n.dataset.at = String(p.at); n.setAttribute('role', 'alertdialog');
  n.innerHTML = `<b>🧩 ${esc(p.browser)} wants to connect to QuorX</b><p>Allow it only if you just pressed Connect in the QuorX extension.</p><div class="acts"><button type="button" class="st-btn sm" data-a="0">Deny</button><button type="button" class="st-btn sm primary" data-a="1">Allow</button></div>`;
  document.body.append(n);
  for (const btn of n.querySelectorAll('[data-a]')) btn.onclick = async () => { n.remove(); await postJ('/api/ext/pair', { allow: btn.dataset.a === '1' }); drawExtPanel(); };
}
async function drawProjectsPanel() {
  const box = $('#stProjects'); if (!box) return;
  const projects = await fetch('/api/projects').then((r) => r.json()).catch(() => G.projects);
  const counts = {}; for (const c of G.chats) if (c.messages > 0) counts[c.projectId || 'scratch'] = (counts[c.projectId || 'scratch'] || 0) + 1;
  const short = (d) => { const parts = String(d).split(/[\\/]/).filter(Boolean); return parts.length > 3 ? `…\\${parts.slice(-3).join('\\')}` : d; };
  box.innerHTML = `<section class="pp">
    <header class="pp-head"><div><b>Your projects</b><small>${projects.length} · removing one moves its chats to the trash; the folder and files stay.</small></div><button type="button" class="pp-new" data-proj-new>＋ New project</button></header>
    <div class="pp-list">${projects.map((pr) => {
      const n = counts[pr.id] || 0, spent = pr.spent || 0, share = pr.budget ? Math.min(1, spent / pr.budget) : 0, state = share >= 1 ? 'full' : share >= 0.8 ? 'near' : 'ok';
      return `<div class="pp-row" style="${projStyle(pr)}">
        <span class="pp-ico">📁</span>
        <div class="pp-main">
          <div class="pp-top"><b class="pp-name">${esc(pr.name)}</b><span class="pp-meta">${n} chat${n === 1 ? '' : 's'} · <em>$${spent.toFixed(3)}</em>${pr.budget != null ? ` of $${pr.budget.toFixed(2)}` : ' · no limit'}</span></div>
          ${pr.budget != null ? `<span class="pp-bar ${state}"><i style="width:${(share * 100).toFixed(1)}%"></i></span>` : ''}
          <code class="pp-path blurable" title="${esc(pr.dir)}">${esc(short(pr.dir))}</code>
        </div>
        <div class="pp-acts">
          <button type="button" class="pp-btn open" data-proj-open="${esc(pr.id)}" title="Open the folder in File Explorer" aria-label="Open folder"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>
          <button type="button" class="pp-btn set" data-proj-set="${esc(pr.id)}" title="Project settings: name, folder, budget, costs" aria-label="Project settings">${ICO.gear}</button>
          ${pr.id !== 'scratch' ? `<button type="button" class="pp-btn del" data-proj-del="${esc(pr.id)}" title="Remove the project (its chats move to the trash)" aria-label="Remove project">${ICO.trash}</button>` : '<span class="pp-btn ghost" aria-hidden="true"></span>'}
        </div>
      </div>`;
    }).join('')}</div>
  </section>`;
  const find = (id) => projects.find((x) => x.id === id);
  for (const b of box.querySelectorAll('[data-proj-open]')) b.onclick = () => openFolder(b.dataset.projOpen);
  for (const b of box.querySelectorAll('[data-proj-set]')) b.onclick = () => openProjectSettings(find(b.dataset.projSet));
  for (const b of box.querySelectorAll('[data-proj-del]')) b.onclick = async () => { await deleteProject(find(b.dataset.projDel)); drawProjectsPanel(); };
  const nb = $('[data-proj-new]', box); if (nb) nb.onclick = async () => { await editProject(null); drawProjectsPanel(); };
  // When the project settings window closes, show its changes here.
  const pd = $('#projDlg'); if (pd && !pd.dataset.refreshesPanel) { pd.dataset.refreshesPanel = '1'; pd.addEventListener('close', () => { if ($('#settings').open) drawProjectsPanel(); }); }
}

// ---------- Settings → Safety & commands: the command rules (server/cmdpolicy.js), saved at once ----------
const PERMS = { project: null, testShell: null };
const RULE_EFFECT = { allow: 'Allow', ask: 'Ask me', deny: 'Deny' };
async function drawPermsPanel() {
  const box = $('#stPerms'); if (!box) return;
  const projects = G.projects || [];
  PERMS.project ??= G.chats?.find((c) => c.id === G.panes?.[0])?.projectId || projects[0]?.id || null;
  const r = await fetch(`/api/permissions${PERMS.project ? `?project=${encodeURIComponent(PERMS.project)}` : ''}`).then((x) => x.json()).catch((e) => ({ error: e.message }));
  const sm = $('#stStopMode');
  if (sm && r.stop) { sm.textContent = r.stop.mode === 'jobs' ? '✓ Job Objects: every process, confirmed' : r.stop.mode === 'groups' ? '✓ Process groups: every process, confirmed' : '⚠ Basic: process tree only'; sm.title = r.stop.error || ''; }
  if (r.error) { box.innerHTML = `<div class="st-row-help">Couldn't load the rules: ${esc(r.error)}</div>`; return; }
  const list = (scope, rules) => rules.length ? rules.map((x, i) => `<div class="pr-rule" data-scope="${scope}" data-i="${i}">
      <span class="pr-eff" data-eff="${esc(x.effect)}">${RULE_EFFECT[x.effect] || esc(x.effect)}</span><code>${esc(x.match)}</code>
      <span class="pr-by">${x.by === 'button' ? 'from a card' : 'typed by you'}</span>
      <button type="button" class="pp-btn del" data-pr-del title="Remove this rule" aria-label="Remove rule">${ICO.trash}</button></div>`).join('')
    : '<div class="st-row-help">No rules yet.</div>';
  box.innerHTML = `<div class="pr">
    <div class="pr-head"><label>Project <select data-pr-project>${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === PERMS.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label></div>
    <h5>This project</h5><div class="pr-list">${list('project', r.project)}</div>
    <h5>Everywhere</h5><div class="pr-list">${list('everywhere', r.everywhere)}</div>
    ${r.suggested?.length ? `<h5>Suggested for this project <small>from the files it has</small></h5><div class="pr-list">${r.suggested.map((s) => `<div class="pr-rule sug"><span class="pr-eff" data-eff="allow">Allow</span><code>${esc(s.match)}</code><span class="pr-by">${esc(s.why)}</span><button type="button" class="st-btn secondary sm" data-pr-sug="${esc(s.match)}">＋ Add</button></div>`).join('')}</div>` : ''}
    <h5>Add a rule</h5>
    <div class="pr-add">
      <div class="seg" data-pr-eff>${Object.entries(RULE_EFFECT).map(([k, l], i) => `<button type="button" data-v="${k}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}</div>
      <input type="text" data-pr-match placeholder="cargo build*  ·  * matches anything">
      <div class="seg" data-pr-scope><button type="button" data-v="project" class="on">This project</button><button type="button" data-v="everywhere">Everywhere</button></div>
      <button type="button" class="st-btn primary sm" data-pr-add>Add</button>
    </div>
    <h5>Test a command <small>what would happen, and why · nothing runs</small></h5>
    <div class="pr-test"><input type="text" data-pr-line placeholder="Remove-Item dist -Recurse"><div class="seg" data-pr-mode><button type="button" data-v="strict" class="on">🔒 Strict</button><button type="button" data-v="yolo">⚡ YOLO</button></div><button type="button" class="st-btn secondary sm" data-pr-test>Test</button></div>
    <div class="pr-result" aria-live="polite"></div>
  </div>`;
  drawAuditPanel();
  const rules = { project: r.project, everywhere: r.everywhere };
  const save = async (scope, next) => {
    const res = await fetch('/api/permissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, projectId: PERMS.project, rules: next }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (res.error) $('.pr-result', box).textContent = `The rule wasn't saved: ${res.error}`; else drawPermsPanel();
  };
  const segVal = (sel) => $(`${sel} button.on`, box)?.dataset.v;
  for (const g of box.querySelectorAll('.pr-add .seg, .pr-test .seg')) for (const b of g.children) b.onclick = () => { for (const x of g.children) x.classList.toggle('on', x === b); };
  $('[data-pr-project]', box).onchange = (e) => { PERMS.project = e.target.value; drawPermsPanel(); };
  for (const b of box.querySelectorAll('[data-pr-del]')) b.onclick = () => { const row = b.closest('.pr-rule'); const scope = row.dataset.scope; save(scope, rules[scope].filter((_, i) => i !== Number(row.dataset.i))); };
  for (const b of box.querySelectorAll('[data-pr-sug]')) b.onclick = () => save('project', [...rules.project, { effect: 'allow', match: b.dataset.prSug, by: 'user' }]);
  $('[data-pr-add]', box).onclick = () => {
    const match = $('[data-pr-match]', box).value.trim();
    if (!match) return $('[data-pr-match]', box).focus();
    const scope = segVal('[data-pr-scope]');
    save(scope, [...rules[scope], { effect: segVal('[data-pr-eff]'), match, by: 'user' }]);
  };
  $('[data-pr-test]', box).onclick = async () => {
    const line = $('[data-pr-line]', box).value.trim(); if (!line) return;
    const out = $('.pr-result', box);
    out.textContent = 'Checking…';
    const t = await fetch('/api/permissions/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: PERMS.project, line, mode: segVal('[data-pr-mode]'), safety: ST.draft?.safety || G.settings.safety }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (t.error) { out.textContent = t.error; return; }
    const head = t.verdict === 'allow' ? '✓ Runs without asking' : t.verdict === 'deny' ? '⛔ Blocked' : t.who === 'deciders' ? '⚖ The deciders vote' : '✋ Asks you';
    out.innerHTML = `<div class="pr-verdict" data-v="${esc(t.verdict)}"><b>${head}</b>${t.why ? ` · ${esc(t.why)}` : ''}${t.hint ? `<div class="st-row-help">${esc(t.hint)}</div>` : ''}</div>`
      + t.segments.map((s) => `<div class="sc-seg"><code>${esc(s.text)}</code><span class="sc-cls" data-cls="${esc(s.cls)}">${esc(CMD_CLASS[s.cls] || s.cls)}</span><span class="pr-by">${esc(s.verdict)}${s.who ? ` · ${esc(s.who)}` : ''} · ${esc(s.decidedBy || '')}</span>${(s.paths || []).map((p) => `<span class="sc-path" data-zone="${esc(p.zone)}">${esc(CMD_ZONE[p.zone] || p.zone)} · ${esc(clip(p.path, 90))}${p.why ? ` (${esc(p.why)})` : ''}</span>`).join('')}</div>`).join('');
  };
}

// The audit log for the project picked in the rules card: newest first.
const AUDIT_KIND = { ran: ['ran', 'ok'], background: ['background', 'ok'], approved: ['allowed', 'ok'], declined: ['declined', 'warn'], blocked: ['blocked', 'bad'], rule: ['rule saved', 'ok'], tripwire: ['tripwire', 'bad'] };
async function drawAuditPanel() {
  const box = $('#stAudit'); if (!box) return;
  const rows = await fetch(`/api/audit?limit=150${PERMS.project ? `&project=${encodeURIComponent(PERMS.project)}` : ''}`).then((x) => x.json()).catch(() => []);
  if (!rows.length) { box.innerHTML = '<div class="st-row-help">Nothing yet for this project.</div>'; return; }
  const by = (b) => (!b ? '' : b === 'you' || b === 'user' ? 'you' : b === 'deciders' ? 'the deciders' : b.startsWith('rule:') ? `your rule (${b.slice(5)})` : b.startsWith('class:') ? `built-in: ${b.slice(6)}` : b);
  box.innerHTML = `<div class="au">${rows.map((r) => {
    const [label, tone] = AUDIT_KIND[r.kind] || [r.kind, ''];
    const when = new Date(r.ts);
    const detail = r.kind === 'ran' ? `exit ${r.code ?? '–'}${r.changed ? ` · ${r.changed} file${r.changed > 1 ? 's' : ''} changed` : ''}${r.stopped != null ? ` · stopped, ${r.stopped} left` : ''}${r.timedOut ? ' · hit the time limit' : ''}`
      : r.kind === 'rule' ? `allow ${esc(r.rule)} · ${esc(r.scope)}` : r.kind === 'tripwire' ? `${r.count} files vanished` : esc(r.why || r.reason || '');
    return `<div class="au-row"><time title="${esc(when.toLocaleString())}">${esc(when.toLocaleDateString())} ${esc(when.toLocaleTimeString())}</time><span class="au-kind" data-tone="${tone}">${label}</span><code title="${esc(r.command || r.rule || '')}">${esc(clip(r.command || r.rule || '', 140))}</code><span class="au-by">${esc(by(r.by))}${r.mode ? ` · ${r.mode === 'yolo' ? '⚡' : '🔒'}` : ''}</span><span class="au-detail">${detail}</span></div>`;
  }).join('')}</div>`;
}

// ---------- setup check panel (server/setup-check.js) ----------
// One row per thing: a status pill, what it's for, what was found, and at most one Fix.
const SETUP_PILL = { ok: ['ok', 'Ready'], warn: ['warn', 'Optional'], missing: ['bad', 'Missing'] };
async function drawSetupPanel(again) {
  const box = $('#stSetup'); if (!box) return;
  if (again) box.classList.add('sc-busy');
  const r = await fetch('/api/setup-check').then((x) => x.json()).catch((e) => ({ error: e.message }));
  box.classList.remove('sc-busy');
  if (r.error || !r.items) { box.innerHTML = `<div class="st-row-help">⚠ Could not run the check: ${esc(r.error || 'no answer')}</div>`; return; }
  const n = (s) => r.items.filter((i) => i.status === s).length;
  box.innerHTML = `<div class="sc-head">
      <span class="sc-sum"><b>${n('ok')}</b> ready${n('warn') ? ` · <b class="warn">${n('warn')}</b> optional` : ''}${n('missing') ? ` · <b class="bad">${n('missing')}</b> missing` : ''}</span>
      <span class="sc-when">checked ${new Date(r.checked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <button type="button" class="st-btn secondary sm" data-sc-again>Check again</button>
    </div>
    <div class="sc-list">${r.items.map((i) => {
      const [cls, word] = SETUP_PILL[i.status] || SETUP_PILL.warn;
      return `<div class="sc-row" data-id="${esc(i.id)}">
        <span class="sc-pill ${cls}"><i aria-hidden="true"></i>${word}</span>
        <div class="sc-main"><b>${esc(i.label)}</b><small>${esc(i.need)}</small><span class="sc-detail">${esc(i.detail || '')}</span>
          ${i.fix?.cmd ? `<code class="sc-cmd">${esc(i.fix.cmd)}</code>` : ''}<span class="sc-msg" role="status"></span></div>
        ${i.fix ? `<button type="button" class="st-btn ${i.status === 'missing' ? 'primary' : 'secondary'} sm" data-sc-fix="${esc(i.id)}">${esc(i.fix.label)}</button>` : '<span></span>'}
      </div>`;
    }).join('')}</div>`;
  $('[data-sc-again]', box).onclick = () => drawSetupPanel(true);
  for (const b of box.querySelectorAll('[data-sc-fix]')) b.onclick = async () => {
    const it = r.items.find((x) => x.id === b.dataset.scFix), msg = $('.sc-msg', b.closest('.sc-row'));
    if (it.fix.kind === 'settings') { ST.cat = it.fix.cat; return drawSettings(); }
    if (it.fix.kind === 'link') return window.open(it.fix.url, '_blank', 'noopener');
    b.disabled = true;
    const x = await postJ('/api/setup-check/fix', { id: it.fix.id }).catch((e) => ({ error: e.message }));
    b.disabled = false;
    msg.textContent = x.error ? `⚠ ${x.error}` : 'winget opened in its own window. Answer its questions there, then press Check again.';
    msg.classList.toggle('bad', !!x.error);
  };
}

// Once per browser, after the key is in: if something this computer needs is missing, show the setup check.
async function firstSetupCheck() {
  const KEY = 'oh-setup-seen';
  try { if (localStorage.getItem(KEY)) return; localStorage.setItem(KEY, String(Date.now())); } catch { return; }
  const r = await fetch('/api/setup-check').then((x) => x.json()).catch(() => null);
  if (r?.items?.some((i) => i.status === 'missing') && !$('#settings').open) openSettings('setup');
}

// ---------- API keys panel ----------
const masked = (show, v) => (show ? v : '•••••');

// Sign in with OpenRouter (server/oauth.js). The server holds the PKCE secret; this page opens OpenRouter's page and
// asks every 1.5 s how it went. The panel can redraw meanwhile, so every step looks its elements up again.
let SIGNIN = null; // { id, url, mode, timer }
function signInUi(state, text, bad) {
  const el = $('#stKeys .kx-signin'); if (!el) return;
  const waiting = state === 'waiting';
  $('[data-signin]', el).hidden = waiting;
  $('.kx-signin-wait', el).hidden = !waiting;
  $('.kx-code', el).hidden = !(waiting && SIGNIN?.mode === 'code');
  const msg = $('.kx-signin-msg', el);
  if (text) msg.textContent = text;
  msg.classList.toggle('bad', !!bad);
}
function stopSignIn() { clearInterval(SIGNIN?.timer); SIGNIN = null; }
async function pollSignIn() {
  if (!SIGNIN) return;
  const s = await fetch(`/api/keys/signin/${SIGNIN.id}`).then((x) => x.json()).catch(() => null);
  if (!s || s.status === 'waiting' || s.status === 'working') return;
  stopSignIn();
  if (s.status === 'done') { await keysChanged(); return drawKeysPanel(); }
  signInUi('idle', `⚠ ${s.error || 'Sign-in did not finish.'}`, true);
}
function wireSignIn() {
  const el = $('#stKeys .kx-signin'); if (!el) return;
  if (SIGNIN) signInUi('waiting', SIGNIN.mode === 'code' ? 'Approve on openrouter.ai, then paste the code it shows here.' : 'Approve on openrouter.ai in the tab that opened. This page carries on by itself.');
  $('[data-signin]', el).onclick = async () => {
    const r = await fetch('/api/keys/signin', { method: 'POST' }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) return signInUi('idle', `⚠ ${r.error}`, true);
    stopSignIn();
    SIGNIN = { ...r, timer: setInterval(pollSignIn, 1500) };
    window.open(r.url, '_blank', 'noopener');
    wireSignIn();
  };
  $('[data-signin-reopen]', el).onclick = () => { if (SIGNIN) window.open(SIGNIN.url, '_blank', 'noopener'); };
  $('[data-signin-cancel]', el).onclick = () => {
    if (SIGNIN) fetch(`/api/keys/signin/${SIGNIN.id}`, { method: 'DELETE' }).catch(() => {});
    stopSignIn();
    signInUi('idle', 'Sign-in cancelled. Press the button to try again.');
  };
  $('[data-signin-code]', el).onclick = async () => {
    if (!SIGNIN) return;
    const r = await fetch(`/api/keys/signin/${SIGNIN.id}/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('#stSignCode').value }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) return signInUi('waiting', `⚠ ${r.error}`, true);
    pollSignIn();
  };
}
// ⚙ Memory: a few facts and preferences about you that every chat gets. Saved at once (it lives on the server, so
// scheduled chats and other devices get it too); the server checks the size and refuses anything like a secret.
async function drawMemoryPanel(msg = '') {
  const el = $('#memPanel');
  if (!el) return;
  const m = await fetch('/api/memory').then((r) => r.json()).catch(() => null);
  if (!m || m.error) { el.innerHTML = `<p class="st-row-help">Could not load memory${m?.error ? `: ${esc(m.error)}` : ''}.</p>`; return; }
  const pct = Math.min(100, Math.round((m.tokens / m.limit) * 100));
  el.innerHTML = stCard('Memory', '', stRow('Use memory in every chat', `Every chat, in every project, gets the items below. They stay under ${m.limit} tokens, so even small models have room. When on, the agent may also propose an item; it is saved only if you say yes (in ⚡ YOLO too). Off: chats get nothing.`,
    `<label class="st-switch"><input type="checkbox" role="switch" id="memOn" ${m.on ? 'checked' : ''} aria-label="Use memory in every chat"><span class="st-switch-track"><span class="st-switch-thumb"></span></span></label>`)
    + `<div class="mem-body ${m.on ? '' : 'off'}">
      <div class="mem-meter" title="About 4 characters a token"><span class="mem-bar"><i style="width:${pct}%"></i></span><span class="mem-count ${pct >= 90 ? 'full' : ''}">${m.tokens} / ${m.limit} tokens</span></div>
      ${m.items.length ? `<ul class="mem-list">${m.items.map((x) => `<li class="mem-item" data-id="${esc(x.id)}"><input class="mem-text" value="${esc(x.text)}" maxlength="200" aria-label="Memory item" spellcheck="true"><span class="tag mem-by" title="${x.by === 'agent' ? 'Proposed by the agent, approved by you' : 'Added by you'}">${x.by === 'agent' ? 'agent · approved' : 'you'}</span><button type="button" class="kx-btn sm mem-save" hidden>Save</button><button type="button" class="mem-del" title="Forget this" aria-label="Forget this">✕</button></li>`).join('')}</ul>` : '<p class="st-row-help mem-empty">Nothing yet. For example: “I use pnpm, not npm”, “Prefer dark themes”, “Write commit messages in English”.</p>'}
      <div class="mem-add"><input id="memNew" maxlength="200" placeholder="Add a fact or preference (one short sentence)" aria-label="New memory item"><button type="button" class="kx-btn sm primary" id="memAddBtn">Add</button></div>
      <p class="mem-msg ${msg.startsWith('✓') ? 'ok' : msg ? 'bad' : ''}" role="status">${esc(msg)}</p>
      <p class="st-row-help">Never keys, tokens or passwords: anything that looks like one is refused.</p></div>`);
  const save = async (body, ok) => {
    const r = await postJ('/api/memory', body, 'PUT');
    drawMemoryPanel(r?.error ? `Not saved: ${r.error}.` : ok);
  };
  $('#memOn').onchange = (e) => save({ on: e.target.checked }, e.target.checked ? '✓ Memory is on' : '✓ Memory is off: chats get nothing');
  const add = () => { const t = $('#memNew').value.trim(); if (t) save({ items: [...m.items, { text: t }] }, '✓ Added'); };
  $('#memAddBtn').onclick = add;
  $('#memNew').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  for (const li of el.querySelectorAll('.mem-item')) {
    const id = li.dataset.id, inp = $('.mem-text', li), btn = $('.mem-save', li), orig = m.items.find((x) => x.id === id).text;
    inp.oninput = () => { btn.hidden = inp.value.trim() === orig; };
    const commit = () => { if (inp.value.trim() !== orig) save({ items: m.items.map((x) => (x.id === id ? { ...x, text: inp.value } : x)) }, '✓ Saved'); };
    btn.onclick = commit;
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
    $('.mem-del', li).onclick = () => save({ items: m.items.filter((x) => x.id !== id) }, '✓ Forgotten');
  }
}
// The 👁 / 🙈 button that shows or masks amounts, switched in place.
function revealButton(b, shown) { if (!b) return; b.title = shown ? 'Hide amounts' : 'Show amounts'; b.textContent = shown ? '🙈' : '👁'; }
async function drawKeysPanel() {
  const box = $('#stKeys'); if (!box) return;
  const keys = await fetch('/api/keys').then((r) => r.json()).catch(() => []);
  const U = uiOf(ST.draft);
  const addForm = (hero) => `<div class="kx-add ${hero ? 'hero' : ''}" ${hero ? '' : 'hidden'}>
      ${hero ? '<div class="kx-hero"><div class="kx-hero-ico">🔑</div><div><h4>Connect OpenRouter to start</h4><p>Models, prices, deciders and media all run through OpenRouter.</p></div></div>' : ''}
      <div class="kx-signin">
        <button type="button" class="kx-btn primary kx-signin-btn" data-signin>Sign in with OpenRouter</button>
        <div class="kx-signin-wait" hidden>
          <span class="kx-spin" aria-hidden="true"></span><span class="kx-signin-state">Waiting for you to approve on openrouter.ai…</span>
          <span class="kx-spacer"></span>
          <button type="button" class="kx-btn sm" data-signin-reopen>Open the page again</button>
          <button type="button" class="kx-btn sm" data-signin-cancel>Cancel</button>
        </div>
        <div class="kx-code" hidden>
          <input id="stSignCode" autocomplete="off" spellcheck="false" placeholder="Paste the code OpenRouter shows" aria-label="Code from OpenRouter">
          <button type="button" class="kx-btn primary sm" data-signin-code>Finish</button>
        </div>
        <p class="kx-note kx-signin-msg">You approve on openrouter.ai and can set a spending limit for this key there. QuorX never sees your password, and the key stays on this computer.</p>
      </div>
      <div class="kx-sep"><span>or paste a key from <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a></span></div>
      <div class="kx-form">
        <div class="kx-input"><input id="stKeyInput" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-v1-…" aria-label="OpenRouter API key"><button type="button" id="stKeyEye" aria-label="Show or hide the key" title="Show or hide">👁</button></div>
        <input class="kx-label" id="stKeyLabel" placeholder="Name it, e.g. Personal, Work, Stream" aria-label="Key name" maxlength="60" title="A name so you can tell your keys apart. Left empty, it takes the name the key has on OpenRouter.">
        <button type="button" class="kx-btn primary" id="stKeyAdd">Add &amp; verify</button>
      </div>
      <p class="kx-note" id="stKeyMsg">🔒 Kept only on this computer (data/keys.json). The page never sees it again, and agent processes don't get it.</p>
    </div>`;
  box.innerHTML = (keys.length ? '' : addForm(true))
    + keys.map((k) => `<section class="kx-card ${k.active ? 'active' : ''}" data-key="${esc(k.id)}">
        <header class="kx-head">
          <span class="kx-dot" aria-hidden="true"></span>
          <input class="kx-name" value="${esc(k.label)}" maxlength="60" aria-label="Key name" title="Click to rename this key" data-old="${esc(k.label)}">
          ${k.active ? '<span class="kx-badge on">Active</span>' : ''}
          <span class="kx-badge">${k.source === 'env' ? 'from .env' : 'added here'}</span>
          <code class="kx-masked">${esc(k.masked)}</code>
        </header>
        <div class="kx-body" data-usage><div class="kx-wait">Loading usage…</div></div>
        <footer class="kx-actions">
          ${k.active ? '<span class="kx-in-use">✓ Used for every call</span>' : '<button type="button" class="kx-btn primary sm" data-k="activate">Make active</button>'}
          <span class="kx-spacer"></span>
          <button type="button" class="kx-icon" data-k="reveal" title="${ST.reveal.has(k.id) || !U.maskAmounts ? 'Hide amounts' : 'Show amounts'}">${ST.reveal.has(k.id) || !U.maskAmounts ? '🙈' : '👁'}</button>
          <button type="button" class="kx-icon" data-k="refresh" title="Refresh">↻</button>
          <button type="button" class="kx-icon" data-k="rename" title="Rename">✎</button>${k.source === 'env' ? '' : '<button type="button" class="kx-icon danger" data-k="remove" title="Remove this key">🗑</button>'}
        </footer>
      </section>`).join('')
    + (keys.length ? `<section class="kx-account"><header class="kx-acc-head"><div><b>Account credits</b><small>All keys on your OpenRouter account</small></div><span class="kx-spacer"></span><button type="button" class="kx-icon" data-acc="reveal" title="${ST.revealAccount || !U.maskAmounts ? 'Hide amounts' : 'Show amounts'}">${ST.revealAccount || !U.maskAmounts ? '🙈' : '👁'}</button><button type="button" class="kx-icon" data-acc="refresh" title="Refresh">↻</button></header><div class="kx-acc-grid" id="stAccount"><div class="kx-wait">Loading…</div></div></section>`
      + `<button type="button" class="kx-add-toggle" id="stKeyToggle">＋ Add another key</button>` + addForm(false) : '');
  wireSignIn();
  // add a key
  const tg = $('#stKeyToggle'); if (tg) tg.onclick = () => { const f = $('.kx-add', box); f.hidden = !f.hidden; tg.hidden = !f.hidden; if (!f.hidden) $('#stKeyInput').focus(); };
  $('#stKeyEye').onclick = () => { const i2 = $('#stKeyInput'); i2.type = i2.type === 'password' ? 'text' : 'password'; };
  $('#stKeyAdd').onclick = async () => {
    const msg = $('#stKeyMsg'), btn = $('#stKeyAdd');
    btn.disabled = true; btn.textContent = 'Checking…'; msg.classList.remove('bad'); msg.textContent = 'Checking the key with OpenRouter…';
    const r = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: $('#stKeyInput').value, label: $('#stKeyLabel').value }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    btn.disabled = false; btn.textContent = 'Add & verify';
    if (r.error) { msg.textContent = `⚠ ${r.error}`; msg.classList.add('bad'); return; }
    $('#stKeyInput').value = '';
    await keysChanged();
    drawKeysPanel();
  };
  // per key
  for (const card of box.querySelectorAll('.kx-card')) {
    const id = card.dataset.key, k = keys.find((x) => x.id === id), show = () => ST.reveal.has(id) || !U.maskAmounts;
    // Fetched once; 👁 paints the same numbers again, shown or masked, without reloading or redrawing the panel.
    let last = null;
    const load = async () => {
      last = await fetch(`/api/keys/${id}/usage`).then((x) => x.json()).catch((e) => ({ error: e.message }));
      paint();
    };
    const paint = () => {
      const el = $('[data-usage]', card), u = last;
      if (!u) return;
      if (u.error) { el.innerHTML = `<div class="kx-wait bad">⚠ ${esc(u.error)}</div>`; return; }
      const w = u.windows || {}, partial = Object.values(w).find((x) => x?.partial);
      const val = (x) => (x == null ? '—' : money(x.value ?? x, 2));
      const tile = (label, v, hide) => `<div class="kx-tile ${hide ? 'masked' : ''}"><span>${label}</span><b>${hide ? '•••••' : v}</b></div>`;
      const used = u.limit != null && u.remaining != null ? u.limit - u.remaining : u.usage;
      const pct = u.limit ? Math.min(100, ((used || 0) / u.limit) * 100) : 0;
      el.innerHTML = `
        <div class="kx-label-row">Spend <small>${partial ? `rolling windows measured since ${new Date(partial.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (the harness checks every 10 minutes while it runs)` : 'rolling windows'}</small></div>
        <div class="kx-tiles">${tile('1 h', val(w.h1))}${tile('3 h', val(w.h3))}${tile('24 h', val(w.d1))}${tile('3 days', val(w.d3))}${tile('7 days', val(w.d7))}${tile('All time', money(u.usage ?? 0, 2), !show())}</div>
        <div class="kx-or">OpenRouter: <span>today <b>${money(u.today ?? 0, 2)}</b></span><span>this week <b>${money(u.week ?? 0, 2)}</b></span><span>this month <b>${money(u.month ?? 0, 2)}</b></span></div>
        ${u.limit != null ? `<div class="kx-limit"><div class="kx-limit-row"><span>Key limit <b>${show() ? money(u.limit, 2) : '•••••'}</b></span><span>used <b>${show() ? money(used ?? 0, 2) : '•••••'}</b></span><span class="kx-left">${show() ? money(u.remaining ?? 0, 2) : '•••••'} left</span></div><div class="kx-bar"><i style="width:${show() ? pct : 0}%" class="${pct > 85 ? 'hot' : ''}"></i></div></div>` : '<div class="kx-limit none">This key has no spending limit.</div>'}`;
    };
    load();
    // The name is edited in place: Enter or leaving the field saves it, Esc puts it back.
    const nameIn = $('.kx-name', card);
    nameIn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nameIn.blur(); } if (e.key === 'Escape') { nameIn.value = nameIn.dataset.old; nameIn.blur(); } };
    nameIn.onblur = async () => {
      const v = nameIn.value.trim();
      if (!v || v === nameIn.dataset.old) { nameIn.value = nameIn.dataset.old; return; }
      const r = await fetch(`/api/keys/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: v }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
      if (r.error) { uiAlert(r.error); nameIn.value = nameIn.dataset.old; return; }
      nameIn.dataset.old = v; k.label = v; refreshBalance();
    };
    card.onclick = async (e) => {
      const act = e.target.closest('[data-k]')?.dataset.k; if (!act) return;
      if (act === 'reveal') { ST.reveal.has(id) ? ST.reveal.delete(id) : ST.reveal.add(id); revealButton($('[data-k="reveal"]', card), show()); return paint(); }
      if (act === 'refresh') return load();
      if (act === 'activate') { await fetch(`/api/keys/${id}/activate`, { method: 'POST' }); await keysChanged(); return drawKeysPanel(); }
      if (act === 'rename') { const n = $('.kx-name', card); n.focus(); n.select(); return; }
      if (act === 'remove' && await uiConfirm(`Remove the key "${k.label}" from this computer?`)) { await fetch(`/api/keys/${id}`, { method: 'DELETE' }); await keysChanged(); drawKeysPanel(); }
    };
  }
  // account
  const acc = $('#stAccount');
  if (acc) {
    const showAcc = () => ST.revealAccount || !U.maskAmounts;
    let lastAcc = null;
    const loadAcc = async () => { lastAcc = await fetch('/api/credits').then((x) => x.json()).catch((e) => ({ error: e.message })); paintAcc(); };
    const paintAcc = () => {
      const a = lastAcc; if (!a) return;
      const m = (v) => (showAcc() ? money(v ?? 0, 2) : '•••••');
      acc.innerHTML = a.error ? `<div class="kx-wait">Account credits aren't available for this key (${esc(a.error)}).</div>`
        : `<div class="kx-metric"><span>Total credits</span><b>${m(a.total)}</b></div><div class="kx-metric"><span>Total used</span><b>${m(a.used)}</b></div><div class="kx-metric left"><span>Left</span><b>${m((a.total ?? 0) - (a.used ?? 0))}</b></div><div class="kx-checked">Checked ${new Date(a.checked).toLocaleTimeString()}</div>`;
    };
    loadAcc();
    box.querySelector('[data-acc="reveal"]').onclick = (e) => { ST.revealAccount = !ST.revealAccount; revealButton(e.currentTarget, showAcc()); paintAcc(); };
    box.querySelector('[data-acc="refresh"]').onclick = loadAcc;
  }
}
// After a key is added, switched or removed: the page wakes up (or locks) and fresh data loads.
async function keysChanged() {
  G.cfg = await fetch('/api/config').then((r) => r.json());
  applyKeyLock();
  await loadModels(true);
  refreshBalance();
  const nav = $('#stNav .st-nav-item[data-cat="keys"] .st-nav-badge'); if (nav && G.cfg.hasKey) nav.remove();
}
// Without a key nothing can run: the message boxes lock and point to ⚙ Settings → API keys.
function applyKeyLock() {
  document.body.classList.toggle('no-key', !G.cfg.hasKey);
  for (const c of G.open.values()) {
    if (!c.el) continue;
    const ta = $('.input', c.el.root), send = $('.sendBtn', c.el.root);
    ta.disabled = send.disabled = !G.cfg.hasKey;
    ta.placeholder = G.cfg.hasKey ? 'Ask, or ask for something to be built…  @ to add files or chats · / for commands' : 'Add an OpenRouter key in ⚙ Settings → API keys to start.';
  }
}
async function exportChats(btn) {
  btn.disabled = true; btn.textContent = 'Exporting…';
  const list = await fetch('/api/chats').then((r) => r.json()).catch(() => []);
  const all = [];
  for (const c of list) { const d = await fetch(`/api/chats/${c.id}`).then((r) => r.json()).catch(() => null); if (d && !d.error) all.push(d); }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ exported: new Date().toISOString(), projects: G.projects, chats: all }, null, 2)], { type: 'application/json' }));
  a.download = `quorx-chats-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  btn.disabled = false; btn.textContent = `⬇ Exported ${all.length}`;
}
// Motion: 'system' follows the OS (Windows → Accessibility → Animation effects), 'full' or 'reduce' override it.
// Older settings saved a true/false switch: true meant reduce, false was the untouched default.
const motionPref = (U) => (U.reduceMotion === true ? 'reduce' : ['full', 'reduce'].includes(U.reduceMotion) ? U.reduceMotion : 'system');
const OS_REDUCE = matchMedia('(prefers-reduced-motion: reduce)');
const motionReduced = () => { const p = motionPref(uiOf(G.settings)); return p === 'reduce' || (p === 'system' && OS_REDUCE.matches); };
OS_REDUCE.addEventListener?.('change', () => { if (G.settings) applyUi(); });
// Appearance and display preferences, applied to the whole page.
function applyUi() {
  const U = uiOf(G.settings), root = document.documentElement;
  root.dataset.density = U.density;
  root.style.setProperty('--msg-size', `${U.fontSize}px`);
  root.classList.toggle('reduce-motion', motionReduced());
  root.classList.toggle('blur-paths', !!U.blurPaths);
  root.classList.toggle('no-usage-btn', !U.usageBtn);
  $('#spend').hidden = !U.showBalance;
}

// ---------- mic: record, convert to 16 kHz WAV, transcribe into that chat's message box ----------
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const w = (o, str) => [...str].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
const asDataURL = (blob) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
async function toggleMic(c) {
  const btn = $('.micBtn', c.el.root);
  if (G.rec) { G.rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream), chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      G.rec = null; btn.classList.remove('rec'); btn.innerHTML = CMP_ICO.wait; btn.title = 'Transcribing…'; btn.disabled = true;
      try {
        const decoded = await new AudioContext().decodeAudioData(await new Blob(chunks).arrayBuffer());
        const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
        const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
        const audio = (await asDataURL(encodeWav((await off.startRendering()).getChannelData(0), 16000))).split(',')[1];
        const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio, model: G.settings.tools.listen.models[0] }) }).then((x) => x.json());
        if (r.error) throw new Error(r.error);
        const ta = $('.input', c.el.root);
        ta.value = [ta.value.trim(), r.text].filter(Boolean).join(' ');
        ta.focus();
        G.sessionCost += r.cost || 0; renderSpend();
        if (r.cost) { c.agent.extraUsage.push({ kind: 'listen', model: r.model, cost: r.cost, at: Date.now() }); saveChat(c); renderChatHead(c); }
      } catch (e) { uiAlert(`Transcription failed: ${e.message}`); }
      btn.innerHTML = CMP_ICO.mic; btn.title = 'Speak your message (transcribed into the box)'; btn.disabled = false;
    };
    rec.start(); G.rec = rec; btn.classList.add('rec'); btn.innerHTML = CMP_ICO.rec; btn.title = 'Stop recording';
  } catch (e) { uiAlert(`Microphone unavailable: ${e.message}`); }
}

// ---------- layout: resizing, theme, sidebar ----------
function applySizes() {
  const r = document.documentElement.style;
  if (G.sizes?.side) r.setProperty('--side-w', `${G.sizes.side}px`); else r.removeProperty('--side-w');
  if (G.sizes?.pane) r.setProperty('--pane-w', `${G.sizes.pane}px`); else r.removeProperty('--pane-w');
}
function makeResizer(el, key, { min, max, fromRight }) {
  const clamp = (v) => Math.max(min, Math.min(max(), v));
  el.onpointerdown = (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag'); document.body.classList.add('resizing');
    const target = key === 'side' ? $('#sidebar') : $('#pane');
    const startX = e.clientX, startW = target.getBoundingClientRect().width;
    el.onpointermove = (ev) => { G.sizes = { ...G.sizes, [key]: Math.round(clamp(startW + (fromRight ? startX - ev.clientX : ev.clientX - startX))) }; applySizes(); };
    el.onpointerup = () => { el.onpointermove = null; el.classList.remove('drag'); document.body.classList.remove('resizing'); savePrefs(); };
  };
  el.ondblclick = () => { G.sizes = { ...G.sizes, [key]: undefined }; applySizes(); savePrefs(); };
  el.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const cur = (key === 'side' ? $('#sidebar') : $('#pane')).getBoundingClientRect().width;
    const d = (e.key === 'ArrowRight' ? 1 : -1) * (fromRight ? -1 : 1) * (e.shiftKey ? 60 : 20);
    G.sizes = { ...G.sizes, [key]: Math.round(clamp(cur + d)) }; applySizes(); savePrefs();
  };
}
// Theme icons: a screen (follows your system), a moon (dark), a sun (light).
const THEME_ICONS = { system: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>', dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>', light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' };
const THEMES = [[null, THEME_ICONS.system, 'Theme: follows your system (click for dark)'], ['dark', THEME_ICONS.dark, 'Theme: dark (click for light)'], ['light', THEME_ICONS.light, 'Theme: light (click to follow your system)']];
function applyTheme() {
  const [mode, icon, title] = THEMES.find((t) => t[0] === (G.theme || null)) || THEMES[0];
  if (mode) document.documentElement.setAttribute('data-theme', mode); else document.documentElement.removeAttribute('data-theme');
  for (const b of [$('#themeBtn'), $('#railTheme')].filter(Boolean)) { b.innerHTML = icon; b.setAttribute('aria-label', title); }
  $('#themeBtn').title = title; if ($('#railTheme')) $('#railTheme').dataset.tip = title.replace(/ \(.*\)$/, '');
}
const isNarrow = () => matchMedia('(max-width: 900px)').matches;
// Phones get their own layout: one full-screen view at a time (chat list, chat, preview), chosen in the bottom bar.
const isPhone = () => matchMedia('(max-width: 900px)').matches;
function setMView(v) {
  G.mview = v;
  document.body.dataset.mview = v;
  for (const b of document.querySelectorAll('#mnav [data-mview]')) { const on = b.dataset.mview === v; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); }
  if (v === 'preview') { $('#mnav .mn-dot').hidden = true; renderPane(); }
  if (v === 'chats') renderSidebar();
}
// On a phone, a user action that shows something in the pane switches to the Preview view.
const toPreview = () => { if (isPhone()) setMView('preview'); else if (G.paneHidden) setPaneHidden(false); };
// Phones: the sidebar is a drawer over the chat; picking a chat closes it.
function closeDrawer() { if ($('#sidebar').classList.contains('mobile-open')) { $('#sidebar').classList.remove('mobile-open'); syncLayout(); } }
function syncLayout() {
  const show = paneVisible();
  $('.layout').classList.toggle('nopane', !show);
  for (const p of document.querySelectorAll('.chatpane')) {
    const mine = p.classList.contains('focus');
    $('.ch-pane', p)?.classList.toggle('active', mine && show);
  }
  $('#sidebar').classList.toggle('collapsed', !!G.sideHidden && !isNarrow());

}

// ---------- start-up ----------
async function boot() {
  G.cfg = await fetch('/api/config').then((r) => r.json());
  // Opened without the app link, every other /api call answers 401 and the wall above says what to do: stop here.
  if ((await fetch('/api/chats')).status === 401) return;
  loadScores(); loadCards();
  const d = G.cfg.defaults;
  const saved = load();
  G.settings = { voters: d.voters, gate: d.gate, maxSteps: d.maxSteps, approval: d.approval, budget: d.budget, model: d.chatModel || d.setups.C.model, reasoning: 'off', ...(saved?.settings || {}) };
  G.settings.tools = Object.fromEntries(Object.entries(d.tools).map(([k, v]) => [k, { ...structuredClone(v), ...(saved?.settings?.tools?.[k] || {}) }]));
  delete G.settings.media; delete G.settings.mediaEnabled;
  if ((G.settings.modelDefaultV || 0) < 2) { G.settings.model = d.chatModel || G.settings.model; G.settings.modelDefaultV = 2; }
  if ((G.settings.maxSteps || 0) < d.maxSteps) G.settings.maxSteps = d.maxSteps; // building and checking needs room
  G.settings.maxSteps = Math.min(120, G.settings.maxSteps);
  G.sideHidden = !!saved?.sideHidden; G.projectOrder = saved?.projectOrder || []; G.foldedProjects = saved?.foldedProjects || []; G.favModels = saved?.favModels || {}; G.spaceSeen = saved?.spaceSeen || {}; G.followAgent = saved?.followAgent !== false; G.budgetSeen = saved?.budgetSeen || {}; G.recentModels = saved?.recentModels || {}; G.pickerSort = saved?.pickerSort || {}; G.sizes = saved?.sizes || {}; G.theme = saved?.theme || null;
  G.sessionCost = saved?.sessionCost || 0; G.templates = saved?.templates || [];
  applySizes(); applyTheme();
  const start = G.settings.ui?.sidebarStart || 'remember';
  if (start !== 'remember') G.sideHidden = start === 'rail';
  applyUi();
  // Starter templates for the start screen's "Start from a template" cards (templates/ on the server).
  fetch('/api/starters').then((r) => r.json()).then((list) => { G.starters = Array.isArray(list) ? list : []; if (!G.panes.length && G.starters.length) renderPanes(); }).catch(() => {});

  $('#settingsBtn').onclick = () => openSettings();
  $('#paletteBtn').onclick = () => openPalette();
  $('#saveSettings').onclick = saveSettings;
  $('#stCancel').onclick = cancelSettings;
  $('#stClose').onclick = cancelSettings;
  $('#settings').addEventListener('cancel', (e) => { e.preventDefault(); cancelSettings(); });
  $('#stResetCat').onclick = () => resetCategory();
  $('#stSearch').oninput = () => searchSettings($('#stSearch').value);
  $('#newBtn').onclick = () => newChat();
  $('#costsBtn').onclick = openCosts;
  $('#schedBtn').onclick = () => openSchedules();
  $('#schedClose').onclick = () => $('#schedules').close();
  loadSchedules().then(pollSchedules);
  $('#costClose').onclick = () => $('#costs').close();
  $('#themeBtn').onclick = () => { const i = THEMES.findIndex((t) => t[0] === (G.theme || null)); G.theme = THEMES[(i + 1) % THEMES.length][0]; applyTheme(); savePrefs(); };
  wirePicker();
  $('.brand')?.addEventListener('click', () => showLanding());
  // Clicking outside a dialog (on its backdrop) closes it; Settings asks first if there are unsaved changes.
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('mousedown', (e) => { d._downOnBackdrop = e.target === d; });
    d.addEventListener('click', async (e) => {
      if (e.target !== d || !d._downOnBackdrop) return; // a drag that started inside doesn't count
      const r = d.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && d.id !== 'picker' && d.id !== 'settings') return;
      if (d.id === 'picker') return PK.done?.(null);
      if (d.id === 'settings') { if (ST.dirty && !await uiConfirm('Discard your unsaved settings changes?')) return; return cancelSettings(); }
      d.dispatchEvent(new Event('cancel')); d.close();
    });
  }
  makeResizer($('#sideResizer'), 'side', { min: 200, max: () => Math.min(520, window.innerWidth * 0.4) });
  makeResizer($('#paneResizer'), 'pane', { min: 260, max: () => Math.max(300, $('.layout').getBoundingClientRect().width - 360), fromRight: true });

  $('#artSelect').onchange = (e) => {
    const v = e.target.value;
    G.view = { id: v, src: false, files: false, trace: null };
    renderPane(); refreshTraceButtons();
  };
  wirePaneChrome();
  $('#reloadBtn').onclick = () => { if (G.view.browser && G.dsk?.ph.isConnected) return window.ohDesktop.nav(G.dsk.sid, 'reload'); if (G.view.browser && $('#paneBody .ubview')) return ubCall('reload'); if (!$('#paneBody iframe')) return renderPane(); reloadPreview(); };
  $('#homeBtn').onclick = goHome; $('#railHome').onclick = goHome;
  placeChrome(); matchMedia('(max-width: 900px)').addEventListener('change', placeChrome);
  for (const [rail, real] of [['#railRestart', '#restartBtn'], ['#railTheme', '#themeBtn'], ['#railSettings', '#settingsBtn']]) { const b = $(rail); if (b) b.onclick = () => $(real)?.click(); }
  // The GitHub mark by the name is a control, not content: a plain click opens QuorX's code in the Browser tab.
  const bg = $('#brandGit'); if (bg) bg.onclick = (e) => { e.preventDefault(); openLink(bg.getAttribute('href'), bg); };
  $('#brandHome').onclick = goHome; $('#brandHome').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } };
  $('#sbCollapseBtn').onclick = () => { if (isNarrow()) return closeDrawer(); G.sideHidden = true; savePrefs(); syncLayout(); };
  $('#newBtn').addEventListener('click', closeDrawer);
  $('#newBtn').addEventListener('click', () => { if (isPhone()) setMView('chat'); });
  for (const b of document.querySelectorAll('#mnav [data-mview]')) b.onclick = () => setMView(b.dataset.mview);
  $('#mnav [data-act="settings"]').onclick = () => openSettings();
  setMView('chat');
  $('#sbExpandBtn').onclick = () => { G.sideHidden = false; savePrefs(); syncLayout(); };
  $('#sideBackdrop').onclick = closeDrawer;
  $('#railCosts').onclick = () => openCosts();
  $('#railNew').onclick = () => $('#newBtn').click();
  $('#railProject').onclick = () => $('#newProjectBtn').click();
  // 🔍 on the rail opens the sidebar with the cursor in the search box.
  $('#railSearch').onclick = () => { G.sideHidden = false; savePrefs(); syncLayout(); setTimeout(() => $('#chatSearch')?.focus(), 60); };
  matchMedia('(max-width: 900px)').addEventListener('change', () => { $('#sidebar').classList.remove('mobile-open'); syncLayout(); });
  $('#chatSearch').oninput = renderSidebar;
  $('#newProjectBtn').onclick = () => editProject(null);
  $('#popBtn').onclick = () => {
    if (G.paneUrl && !G.paneUrl.startsWith('data:')) return DESK ? window.ohDesktop.openExternal(G.paneUrl) : window.open(G.paneUrl, '_blank', 'noopener');
    const f = $('#paneBody iframe'), img = $('#paneBody img'), au = $('#paneBody audio'), vid = $('#paneBody video');
    const url = f ? (f.srcdoc ? URL.createObjectURL(new Blob([f.srcdoc], { type: 'text/html' })) : f.src) : img?.src || au?.src || vid?.src;
    if (url) window.open(url, '_blank');
  };
  // No warning on close: running replies keep going on the server and this page reattaches on reload.

  await refreshSidebar();
  // Reopen the chats that were on screen (?chat=<id> opens a specific one).
  const linked = new URLSearchParams(location.search).get('chat');
  // The app opens on the landing screen; a ?chat= link opens that chat instead.
  const ids = linked && G.chats.some((c) => c.id === linked) ? [linked] : [];
  for (const id of ids) await getChat(id);
  G.panes = ids.filter((id) => G.open.has(id));
  G.focus = 0;
  renderPanes();
  renderSidebar(); renderSpend(); refreshBalance();
  // Chats with a reply still running on the server (started before a reload) reattach too.
  fetch('/api/runs').then((r) => r.json()).then(async (list) => { for (const r of list) if (r.chatId && !G.open.has(r.chatId)) { await getChat(r.chatId); renderSidebar(); } }).catch(() => {});
  loadModels();
  if (!G.cfg.hasKey) openSettings('keys');
  else firstSetupCheck();
  maybeStartTour({ fill: fillStart });
}
// The tour's first build: into the start box on Home, or the open chat's message box (not sent).
function fillStart(text) {
  const ta = $('#ldStartText') || $('.chatpane.focus .input');
  if (!ta) return;
  ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
}

boot();

// ---------- project folders: any folder on this PC, and a notice when one has gone missing ----------
const postJ = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json()).catch((e) => ({ error: e.message }));
const getJ = (url) => fetch(url).then((r) => r.json()).catch((e) => ({ error: e.message }));
const baseName = (d) => String(d || '').split(/[\\/]/).filter(Boolean).pop() || String(d || '');
const mbText = (b) => `${((b || 0) / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;

// New project, or change/reselect a project's folder: a name, any folder (typed or picked with the
// computer's own folder dialog), or empty for a folder inside this app's workspaces folder.
// A project is a folder that already exists on this PC, picked with the PC's own folder dialog. Its name is the
// folder's name: it can't be edited, and it changes only when you pick a different folder.
// (Typing a path is only offered when the dialog can't open, e.g. when the page is used from another computer.)
function editProject(p, opts = {}) {
  return new Promise((resolve) => {
    const isNew = !p;
    const dlg = document.createElement('dialog');
    dlg.className = 'pf-dialog';
    dlg.innerHTML = `<form class="pf">
      <h3>${isNew ? 'New project' : p.missing ? 'Reselect the project folder' : p.needsFolder ? 'Pick a folder for this project' : 'Change the project folder'}</h3>
      ${p?.needsFolder && !p.missing ? `<p class="pf-warn">📁 “${esc(p.name)}” keeps its files inside QuorX itself (<code class="blurable">${esc(p.dir)}</code>). Pick a folder of your own outside the app: its files are copied there (nothing is overwritten), and chats, costs and budget stay with the project.</p>` : ''}
      ${p?.missing ? `<p class="pf-warn">⚠ The folder <code class="blurable">${esc(p.dir)}</code> is missing. It may have been moved, renamed or deleted. Pick where it is now, or choose another folder. Chats and costs stay with the project.</p>` : ''}
      <div class="pf-field"><span>Folder</span>
        <span class="pf-row"><input class="pf-dir" value="${esc(p?.path || '')}" placeholder="Pick a folder on this PC" spellcheck="false" readonly aria-readonly="true"><button type="button" class="pf-browse">📂 Browse…</button></span></div>
      <div class="pf-named"><span>Project name</span><b class="pf-name-preview">${esc(p?.name || '—')}</b><small>always the folder's name</small></div>
      <p class="pf-hint">Every chat in this project reads, writes and runs programs in this folder. The agent keeps its own working files (research scripts, undo history) in <code>.quorx/</code> there; git ignores that folder, so it never ends up in your repo.</p>
      <p class="pf-err" role="alert" hidden></p>
      <div class="pf-acts"><button type="button" class="pf-cancel">Cancel</button><button type="submit" class="pf-save" ${isNew || p?.missing || p?.needsFolder ? 'disabled' : ''}>${isNew ? 'Create project' : 'Use this folder'}</button></div>
    </form>`;
    document.body.appendChild(dlg);
    const dirIn = $('.pf-dir', dlg), err = $('.pf-err', dlg), browse = $('.pf-browse', dlg), save = $('.pf-save', dlg), preview = $('.pf-name-preview', dlg);
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const done = (r) => { dlg.close(); dlg.remove(); resolve(r); };
    const sync = () => { const d = dirIn.value.trim(); preview.textContent = d ? baseName(d) : (p?.name || '—'); save.disabled = !d || (!isNew && !p.missing && !p.needsFolder && d === (p.path || '')); };
    dirIn.oninput = sync;
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    $('.pf-cancel', dlg).onclick = () => done(null);
    browse.onclick = async () => {
      browse.disabled = true; browse.textContent = 'Pick it in the window on your PC…'; err.hidden = true;
      const r = await postJ('/api/pick-folder', { start: dirIn.value.trim() || p?.dir || '' });
      browse.disabled = false; browse.textContent = '📂 Browse…';
      if (r.error) {
        // No dialog here (another computer, or an old server): let the path be typed instead.
        if (/type the path|^not found$/i.test(r.error)) { dirIn.readOnly = false; dirIn.removeAttribute('aria-readonly'); dirIn.placeholder = 'Type the full path of an existing folder, e.g. D:\Coding\my-app'; dirIn.focus(); return fail('The folder dialog can\'t open from here: type the folder\'s full path instead.'); }
        return fail(r.error);
      }
      if (r.path) { dirIn.value = r.path; sync(); save.focus(); }
    };
    $('.pf', dlg).onsubmit = async (e) => {
      e.preventDefault();
      const dir = dirIn.value.trim();
      if (!dir) return fail('Pick a folder first.');
      const r = await postJ('/api/projects', { id: p?.id || `p${Date.now().toString(36)}`, name: baseName(dir), path: dir });
      if (r.error) return fail(r.error);
      done(r);
      await refreshSidebar();
      for (const c of G.open.values()) if (c.projectId === r.id) renderChatHead(c);
      renderPane();
      if (isNew) await newChat(r.id);
    };
    dlg.showModal();
    browse.focus();
    if (isNew || opts.reselect || p?.missing || p?.needsFolder) browse.click();
  });
}
const projectOf = (c) => G.projects.find((x) => x.id === c?.projectId);
// Before sending: a project whose folder is gone, or that still lives inside QuorX, can't be worked in
// until it has a folder of its own.
function folderMissing(c) {
  const p = projectOf(c);
  if (!p?.missing && !p?.needsFolder) return false;
  editProject(p, { reselect: true });
  return true;
}
// A notice at the top of each open chat whose project folder is missing (it stays until it's fixed).
function folderNotices() {
  for (const c of G.open.values()) {
    if (!c.el) continue;
    const p = projectOf(c), old = $('.folder-notice', c.el.root);
    $('.ch-proj-tag', c.el.root)?.classList.toggle('missing', !!(p?.missing || p?.needsFolder));
    if (!p?.missing && !p?.needsFolder) { old?.remove(); continue; }
    if (old) continue;
    $('.chat-head', c.el.root).insertAdjacentHTML('afterend', p.missing ? `<div class="budget-notice full folder-notice" role="alert">
      <span class="bn-ico">📁</span>
      <div class="bn-text"><b>The folder of “${esc(p.name)}” is missing.</b><small><code class="blurable">${esc(p.dir)}</code> was moved, renamed or deleted outside QuorX. Reselect it to keep working; nothing is created there until you do.</small></div>
      <button type="button" class="bn-raise">Reselect folder…</button></div>` : `<div class="budget-notice near folder-notice" role="alert">
      <span class="bn-ico">📁</span>
      <div class="bn-text"><b>“${esc(p.name)}” needs a folder of its own.</b><small>Its files sit inside QuorX itself (<code class="blurable">${esc(p.dir)}</code>). Pick a folder outside the app: the files are copied there and this chat can carry on.</small></div>
      <button type="button" class="bn-raise">Pick a folder…</button></div>`);
    $('.folder-notice .bn-raise', c.el.root).onclick = () => editProject(p, { reselect: true });
  }
}
// Folders can disappear while the app is in the background: look again when the window comes back.
window.addEventListener('focus', () => { if (Date.now() - (G.focusCheck || 0) > 4000) { G.focusCheck = Date.now(); refreshSidebar(); } });

// ---------- the agent's own folder (.quorx): ask before it takes too much room ----------
async function checkSpace(c, force) {
  if (!c?.el || projectOf(c)?.missing || projectOf(c)?.needsFolder) return;
  const at = (G.spaceAt ||= {});
  if (!force && Date.now() - (at[c.projectId] || 0) < 30e3) return;
  at[c.projectId] = Date.now();
  const r = await getJ(`/api/agent-space?project=${encodeURIComponent(c.projectId)}`);
  if (!r || r.error || !c.el) return;
  const limit = (Number(G.settings.agentSpaceMB) || 500) * 1e6;
  const seen = (G.spaceSeen || {})[c.projectId] || 0;
  const old = $('.space-notice', c.el.root);
  if (r.total <= limit || r.total <= seen * 1.2) { old?.remove(); return; }
  const p = projectOf(c);
  const part = (n) => r.parts.find((x) => x.name === n) || { bytes: 0, files: 0 };
  const LABEL = { scratch: 'research & scratch', checkpoints: 'undo history', trash: 'deleted files', other: 'notes & other' };
  const html = `<div class="budget-notice space-notice" role="status">
    <span class="bn-ico">🧹</span>
    <div class="bn-text"><b>The agent's folder in “${esc(p?.name || c.projectId)}” uses ${mbText(r.total)}</b> (your limit: ${mbText(limit)})
      <small>${r.parts.filter((x) => x.bytes).map((x) => `${LABEL[x.name]} ${mbText(x.bytes)}`).join(' · ')} · in <code>.quorx/</code>, never committed</small></div>
    <span class="sn-acts">
      ${part('scratch').bytes ? `<button type="button" data-clear="scratch" title="Delete the agent's research scripts, downloads and test files (${part('scratch').files} files)">Clear scratch</button>` : ''}
      ${part('trash').bytes ? '<button type="button" data-clear="trash" title="Files the agent deleted are kept here; empty it">Empty agent trash</button>' : ''}
      ${part('checkpoints').bytes ? '<button type="button" data-clear="checkpoints" title="Keeps Undo for the ${Number(G.settings?.undoKeep) || 10} newest replies; older replies can no longer be undone">Trim undo history</button>' : ''}
    </span>
    <button type="button" class="bn-x" title="Keep it: don't ask again until it grows" aria-label="Keep">✕</button></div>`;
  if (old) old.outerHTML = html; else $('.chat-head', c.el.root).insertAdjacentHTML('afterend', html);
  const el = $('.space-notice', c.el.root);
  for (const b of el.querySelectorAll('[data-clear]')) b.onclick = async () => {
    const what = b.dataset.clear, x = part(what);
    const msg = { scratch: `Delete the agent's scratch files in this project (${x.files} files, ${mbText(x.bytes)})?`, trash: `Permanently delete the files the agent moved to its trash (${mbText(x.bytes)})?`, checkpoints: `Remove undo history older than the ${Number(G.settings?.undoKeep) || 10} newest replies? Those replies can no longer be undone.` }[what];
    if (!await uiConfirm(`${msg}\nThis can't be undone.`)) return;
    const res = await postJ('/api/agent-space/clear', { projectId: c.projectId, what, keep: Number(G.settings?.undoKeep) || 10 });
    if (res.error) return uiAlert(res.error);
    checkSpace(c, true);
  };
  $('.bn-x', el).onclick = () => { (G.spaceSeen ??= {})[c.projectId] = r.total; savePrefs(); el.remove(); };
}

// ---------- 🖥 servers: the project's launch configs, with run / stop / restart / open ----------
const SVG_SERVER = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>';
const SVG_TERM = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3M12 15h6"/></svg>';
const srvState = (s) => (s.status === 'running' ? ['ok', 'running']
  : s.status === 'starting' ? ['busy', 'starting…']
  : s.status === 'not listening' ? ['warn', 'not listening on its port']
  : s.code != null && s.code !== 0 && s.started ? ['bad', `exited (code ${s.code})`]
  : ['off', 'stopped']);

function toggleServers(c) {
  const pop = $('#paneSrvPop'), btn = $('#paneSrvBtn');
  const wasOpen = !pop.hidden;
  closeServers(c); // also drops a menu left over from before the chat was re-drawn
  if (wasOpen) return;
  pop.hidden = false; btn.classList.add('active'); btn.setAttribute('aria-expanded', 'true');
  const outside = (e) => {
    if (c.srvPop?.outside !== outside) return document.removeEventListener('pointerdown', outside, true);
    if (!pop.isConnected || (!pop.contains(e.target) && !btn.contains(e.target))) closeServers(c);
  };
  document.addEventListener('pointerdown', outside, true);
  c.srvPop = { el: pop, outside, timer: setInterval(() => renderServers(c), 2000), editing: null };
  pop.innerHTML = '<div class="srv-empty">Loading…</div>';
  renderServers(c);
}
function closeServers(c) {
  const s = c.srvPop; if (!s) return;
  clearInterval(s.timer); document.removeEventListener('pointerdown', s.outside, true); c.srvPop = null;
  if (!c.el || s.inline) return;
  $('#paneSrvPop').hidden = true;
  const btn = $('#paneSrvBtn'); btn.classList.remove('active'); btn.setAttribute('aria-expanded', 'false');
}
// The 🖥 servers list: square icon buttons (colour only where it means something: stop red, run green).
const SRV_ICO = {
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/></svg>',
  run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg>',
  logs: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};
async function renderServers(c) {
  const pop = c.srvPop?.el;
  if (!pop || !pop.isConnected) { if (c.srvPop?.inline) closeServers(c); return; }
  if (c.srvPop.editing || c.srvPop.busy) return;
  const r = await getJ(`/api/servers/overview?project=${encodeURIComponent(c.projectId)}`);
  if (!c.srvPop || c.srvPop.editing || c.srvPop.busy) return;
  devBadges(c.projectId, r);
  const p = projectOf(c);
  const head = `<div class="srv-head"><span class="srv-h-ico">${SVG_SERVER}</span><b>Servers</b><span class="srv-sub">${esc(p?.name || c.projectId)}</span><span class="srv-spacer"></span>
    <button type="button" class="srv-btn srv-add" title="Add a server command to this project">＋ Add</button><button type="button" class="srv-btn srv-term" title="Watch every command and server in this project">${SVG_TERM} Terminal</button></div>`;
  if (r.code === 'FOLDER_MISSING' || r.error) {
    pop.innerHTML = `${head}<div class="srv-empty">⚠ ${esc(r.error)}${r.code === 'FOLDER_MISSING' ? '<br><button type="button" class="srv-btn start srv-reselect">Reselect folder…</button>' : ''}</div>`;
    const rs = $('.srv-reselect', pop); if (rs) rs.onclick = () => { closeServers(c); editProject(p, { reselect: true }); };
    $('.srv-add', pop).onclick = () => {}; $('.srv-term', pop).onclick = () => { closeServers(c); openTerminal(c); };
    return;
  }
  const rows = r.servers || [], jobs = (r.jobs || []);
  pop.innerHTML = `${head}
    <div class="srv-list">${rows.map((s, i) => {
      const [cls, label] = srvState(s), live = s.status === 'running' || s.status === 'starting' || s.status === 'not listening';
      const host = s.url ? s.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
      return `<div class="srv-row" data-i="${i}">
        <div class="srv-top">
          <span class="srv-dot ${cls}" title="${esc(label)}"></span><b class="srv-nm" title="${esc(s.name)}">${esc(s.name)}</b><span class="srv-state ${cls}">${esc(label)}</span>
          ${s.from === '.claude/launch.json' ? '<span class="srv-from" title="Saved in .claude/launch.json">.claude</span>' : !s.from ? '<span class="srv-from unsaved" title="Running, but not in the launch file">not saved</span>' : ''}
          <span class="srv-acts">
            ${live ? `<button type="button" class="srv-ib stop" data-act="stop" title="Stop it" aria-label="Stop">${SRV_ICO.stop}</button><button type="button" class="srv-ib" data-act="restart" title="Restart it" aria-label="Restart">${SRV_ICO.restart}</button>${s.url ? `<button type="button" class="srv-ib" data-act="open" title="Open it in the Browser tab" aria-label="Open in the Browser tab">${SRV_ICO.open}</button>` : ''}`
              : `<button type="button" class="srv-ib run" data-act="start" title="Run it and open it in the Browser tab" aria-label="Run">${SRV_ICO.run}</button>`}
            <button type="button" class="srv-ib" data-act="logs" title="Its output in the terminal" aria-label="Logs">${SRV_ICO.logs}</button>
            <button type="button" class="srv-ib" data-act="edit" title="Edit its command, folder or port" aria-label="Edit">${SRV_ICO.edit}</button>
            ${s.from === '.quorx/launch.json' && !live ? `<button type="button" class="srv-ib danger" data-act="remove" title="Remove it from the launch file" aria-label="Remove">${SRV_ICO.trash}</button>` : ''}
          </span>
        </div>
        <div class="srv-meta">
          <code class="srv-cmd" title="${esc([s.command, ...(s.args || [])].join(' '))}&#10;Runs in the project folder">${esc([s.command, ...(s.args || [])].join(' '))}</code>
          ${s.url && live ? `<button type="button" class="srv-link" data-act="open" title="Open ${esc(s.url)} in the Browser tab">${esc(host)}</button>` : s.port ? `<span class="srv-port">port ${s.port}</span>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="srv-empty">No servers yet. Each server the agent starts is saved here, so you can run and stop it later; or add one yourself.</div>'}</div>
    ${jobs.length ? `<div class="srv-sec">Running now</div><div class="srv-list">${jobs.map((j) => `<div class="srv-row job"><span class="srv-dot busy"></span><div class="srv-main"><div class="srv-name"><b>${j.source === 'agent' ? '🤖 agent' : '👤 you'}</b><span class="srv-state busy">${esc(ago(j.at).replace('just now', 'started just now'))}</span></div><code class="srv-cmd">${esc(j.label)}</code></div><div class="srv-acts"><button type="button" class="srv-btn stop" data-job="${esc(j.job)}">■ Stop</button></div></div>`).join('')}</div>` : ''}
    <div class="srv-foot" title="Each server gets a free port as PORT / {PORT} unless it has a fixed one${rows.some((x) => x.from === '.claude/launch.json') ? '. .claude/launch.json is read too' : ''}.">Saved in <code>.quorx/launch.json</code> · free port as <code>{PORT}</code></div>`;
  $('.srv-add', pop).onclick = () => editServer(c, {});
  $('.srv-term', pop).onclick = () => { closeServers(c); openTerminal(c); };
  for (const b of pop.querySelectorAll('[data-job]')) b.onclick = async () => { b.disabled = true; await postJ('/api/term/stop', { job: b.dataset.job }); renderServers(c); };
  for (const row of pop.querySelectorAll('.srv-row[data-i]')) {
    const s = rows[Number(row.dataset.i)];
    for (const b of row.querySelectorAll('[data-act]')) b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'edit') return editServer(c, s);
      if (act === 'logs') { closeServers(c); return openTerminal(c, s.name); }
      if (act === 'open') { closeServers(c); return showServerInPane(c, s); }
      if (act === 'remove') { if (!await uiConfirm(`Remove "${s.name}" from the launch file?`)) return; await postJ(`/api/launch?project=${encodeURIComponent(c.projectId)}&name=${encodeURIComponent(s.name)}`, null, 'DELETE'); return renderServers(c); }
      c.srvPop.busy = true; b.disabled = true; b.classList.add('busy'); b.title = act === 'stop' ? 'Stopping…' : 'Starting…';
      const res = act === 'stop' ? await postJ('/api/servers/stop', { key: s.key })
        : act === 'restart' ? await postJ('/api/servers/restart', { key: s.key })
        : await postJ('/api/servers/start', s.from ? { projectId: c.projectId, name: s.name } : { projectId: c.projectId, name: s.name, cmd: s.command, args: s.args, port: s.port });
      if (c.srvPop) c.srvPop.busy = false;
      if (res.error) uiAlert(`${s.name}: ${res.error}`);
      else if (act === 'start' && res.url) showServerInPane(c, { ...s, url: res.url, key: res.key, status: res.status });
      renderServers(c); pollDev();
    };
  }
}
// Add or edit a launch config, right in the menu.
function editServer(c, s) {
  const pop = c.srvPop.el;
  c.srvPop.editing = s;
  const allowed = G.cfg.allowed || [];
  pop.innerHTML = `<form class="srv-form">
    <div class="srv-head"><span class="srv-h-ico">${SVG_SERVER}</span><b>${s.name ? `Edit “${esc(s.name)}”` : 'New server'}</b></div>
    <label><span>Name</span><input name="name" value="${esc(s.name || '')}" placeholder="web" required></label>
    <label><span>Program</span><select name="command">${allowed.map((x) => `<option ${x === String(s.command || 'node').toLowerCase().replace(/\.(exe|cmd|bat)$/, '') ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
    <label><span>Arguments</span><input name="args" value="${esc((s.args || []).join(' '))}" placeholder="server.js   ·   -m http.server {PORT}   ·   run dev" spellcheck="false"></label>
    <label><span>Fixed port</span><input name="port" type="number" min="1" max="65535" value="${s.port || ''}" placeholder="none: a free port is given as PORT"></label>
    <p class="srv-hint">One program with plain arguments, run in the project folder. <code>{PORT}</code> in the arguments becomes the port.${s.from === '.claude/launch.json' ? ' Saving copies it into <code>.quorx/launch.json</code>.' : ''}</p>
    <p class="srv-err" role="alert" hidden></p>
    <div class="srv-form-acts"><button type="button" class="srv-btn srv-cancel">Cancel</button><button type="submit" class="srv-btn">Save</button><button type="button" class="srv-btn start srv-saverun">Save & run</button></div>
  </form>`;
  const f = $('.srv-form', pop), err = $('.srv-err', pop);
  const save = async (run) => {
    const cfg = { projectId: c.projectId, oldName: s.name, name: f.name.value.trim(), command: f.command.value, args: f.args.value.trim().split(/\s+/).filter(Boolean), port: Number(f.port.value) || null };
    if (!cfg.name) { err.textContent = 'Give it a name.'; err.hidden = false; return; }
    const r = await postJ('/api/launch', cfg);
    if (r.error) { err.textContent = r.error; err.hidden = false; return; }
    c.srvPop.editing = null;
    if (run) { pop.innerHTML = '<div class="srv-empty">Starting…</div>'; const res = await postJ('/api/servers/start', { projectId: c.projectId, name: cfg.name }); if (res.error) uiAlert(res.error); else if (res.url) showServerInPane(c, { ...cfg, url: res.url, key: res.key, status: res.status }); }
    renderServers(c); pollDev();
  };
  f.onsubmit = (e) => { e.preventDefault(); save(false); };
  $('.srv-saverun', pop).onclick = () => save(true);
  $('.srv-cancel', pop).onclick = () => { c.srvPop.editing = null; renderServers(c); };
  f.name.focus();
}
// A running server as a live app in this chat's pane (the same artifact the agent makes with start_server).
// A server from the list opens in the Browser tab (one tab per address).
function showServerInPane(c, s) { openInBrowser(c, s.url); toPreview(); }

// Badges on the header buttons: how many servers run, and whether a command is running right now.
function devBadges(projectId, r) {
  if (!r || r.error) return;
  const running = (r.servers || []).filter((s) => s.status === 'running').length;
  const busy = (r.jobs || []).length + (r.servers || []).filter((s) => s.status === 'starting').length;
  // The pane's 🖥 and Terminal tab show the project of the chat the pane is showing.
  if (focused()?.projectId !== projectId) return;
  const sb = $('#paneSrvBtn'), tb = $('#paneTabs [data-tab="term"]');
  if (sb) { const n = $('.hdr-count', sb); n.textContent = running || ''; n.hidden = !running; sb.classList.toggle('has-live', !!running); sb.title = `Servers: ${running ? `${running} running` : 'none running'} · run, stop and edit this project's dev servers`; }
  if (tb) { tb.classList.toggle('busy', !!busy); tb.title = busy ? `Terminal: ${busy} command${busy > 1 ? 's' : ''} running now` : 'Terminal: every command and server in this project, live, and what is running in the background'; }
}
function devAfter(projectId, r) {
  if (!r || r.error) return;
  const running = (r.servers || []).filter((s) => s.status === 'running').length, busy = (r.jobs || []).length;
  (G.devCount ||= {})[projectId] = { running, busy };
  const fc = focused();
  if (fc?.projectId === projectId) { renderPaneTabs(fc); if (G.view.term) drawRunning(fc, r); }
}
async function pollDev() {
  if (document.hidden) return;
  getJ('/api/ext/state').then((r) => { const k = (x) => `${!!x?.connected}${!!x?.outdated}`, was = k(G.ext); G.ext = r && !r.error ? r : null; if (was !== k(G.ext)) for (const ch of G.open.values()) renderComposerBar(ch); extPairNotice(); }).catch(() => {});
  const ids = new Set(G.panes.map((id) => G.open.get(id)?.projectId).filter(Boolean));
  for (const pid of ids) {
    if (G.projects.find((p) => p.id === pid)?.missing) continue;
    const r = await getJ(`/api/servers/overview?project=${encodeURIComponent(pid)}`); devBadges(pid, r); devAfter(pid, r);
    const run = await getJ(`/api/running?project=${encodeURIComponent(pid)}`);
    if (run && !run.error) {
      (G.runCount ||= {})[pid] = { n: run.items.filter((x) => x.kind !== 'your-term').length };
      const fc = focused();
      if (fc?.projectId === pid) { renderPaneTabs(fc); if (G.view.term && G.term?.sec === 'run') drawRunningPane(fc, run); syncLent(fc); }
    }
  }
}
setInterval(pollDev, 3000);

// ---------- ⌨ terminal: live output of every command and server in the project ----------
// One Terminal tab with three sections: your terminals (panes stacked top to bottom, each with its own tabs, added
// above or below and resized by dragging the bar between them), what is Running (each with a Stop), and the Servers.
function openTerminal(c, filter, sec = 'term') {
  const t = termState(c.projectId);
  if (filter) t.filter = t.terms.some((u) => u.id === filter) || filter === 'all' || filter === 'agent' ? filter : `srv:${filter}`;
  t.sec = sec; termSave(t);
  G.view = { id: G.view.id, src: false, files: false, term: true };
  c.paneHidden = false;
  syncLayout(); renderPane(); toPreview();
}
const termLayoutKey = (projectId) => `oh-term-layout:${projectId}`;
function termState(projectId) {
  if (G.term?.projectId !== projectId) {
    closeTermStream();
    let saved = null; try { saved = JSON.parse(localStorage.getItem(termLayoutKey(projectId)) || 'null'); } catch { /* storage off */ }
    const panes = (Array.isArray(saved?.panes) && saved.panes.length ? saved.panes : [{ filter: 'u1', grow: 1 }]).slice(0, 6)
      .map((p, i) => ({ id: `p${i + 1}`, filter: String(p.filter || 'u1'), grow: Math.max(0.1, Number(p.grow) || 1) }));
    // Your terminals that the saved panes show come back (their shells start again when shown).
    const ids = [...new Set(['u1', ...panes.map((p) => p.filter).filter((f) => /^u\d+$/.test(f))])];
    G.term = { projectId, jobs: new Map(), order: [], seq: 0, cleared: 0, terms: ids.map((id) => ({ id, name: `Terminal ${id.slice(1)}`, cwd: '', hist: [], hi: 0 })),
      nextTerm: Math.max(...ids.map((x) => Number(x.slice(1)))) + 1, panes, act: panes[0].id, nextPane: panes.length + 1, sec: ['term', 'run', 'srv'].includes(saved?.sec) ? saved.sec : 'term' };
    // The active pane's tab, as the rest of the page knows it (Follow, Clear, a server's Logs).
    Object.defineProperty(G.term, 'filter', { get() { return termPane(this).filter; }, set(v) { termPane(this).filter = v; }, enumerable: true });
  }
  return G.term;
}
const termPane = (t) => t.panes.find((p) => p.id === t.act) || t.panes[0];
const tpaneEl = (p) => $(`#paneBody .tpane[data-pane="${p.id}"]`);
function termSave(t) {
  try { localStorage.setItem(termLayoutKey(t.projectId), JSON.stringify({ panes: t.panes.map((p) => ({ filter: p.filter, grow: Math.round(p.grow * 1000) / 1000 })), sec: t.sec })); } catch { /* storage off */ }
}
function closeTermStream() { if (G.term?.es) { G.term.es.close(); G.term.es = null; } }
function termOpenStream(t) {
  if (t.es) return;
  t.es = new EventSource(`/api/term/stream?project=${encodeURIComponent(t.projectId)}&from=${t.seq}`);
  t.es.onmessage = (m) => { const e = JSON.parse(m.data); if (e.seq <= t.seq) return; t.seq = e.seq; termApply(t, e); };
}
function termApply(t, e) {
  let j = t.jobs.get(e.job);
  if (!j) {
    j = { id: e.job, label: e.label || '(earlier output)', source: e.source, server: e.server, chatId: e.chatId, tab: e.tab, at: e.at, lines: [], status: 'running', port: e.port, rev: 0, cut: 0 };
    t.jobs.set(e.job, j); t.order.push(e.job);
    if (t.order.length > 300) t.jobs.delete(t.order.shift());
  }
  if (e.kind === 'start') Object.assign(j, { label: e.label, source: e.source, server: e.server, chatId: e.chatId, tab: e.tab, at: e.at, port: e.port, status: 'running' });
  else if (e.kind === 'out') { j.lines.push({ text: e.text, stream: e.stream }); if (j.lines.length > 3000) { j.lines.splice(0, j.lines.length - 3000); j.cut++; } }
  else if (e.kind === 'end') {
    Object.assign(j, { status: 'done', code: e.code, ms: e.ms, error: e.error });
    const u = e.cwd && e.tab && t.terms?.find((x) => x.id === e.tab);
    if (u) { u.dir = e.cwd; renderTermInput(t); }
  }
  j.rev++;
  // A short timer, not requestAnimationFrame: frames are paused in background tabs and some embedded views.
  if (!t.raf) t.raf = setTimeout(() => { t.raf = null; termDraw(t); }, 40);
}
// Which output a terminal tab shows: Activity = everything, Agent = its commands, a server's own tab,
// or one of your terminals (only what was run from it).
const termShows = (t, j, f = t.filter) => (f === 'all' ? true : f === 'agent' ? j.source === 'agent' && !j.server : f.startsWith('srv:') ? j.server === f.slice(4) : j.tab === f)
  && (j.status === 'running' || j.at >= (t.clearedBy?.[f] || 0));
// ---------- ↪ terminal output into the chat ----------
// A command and its output (or what your own terminal shows) goes with your next message, as a chip like a file.
function termJobText(j) {
  const st = j.status === 'running' ? 'still running' : j.error ? `failed: ${j.error}` : j.code === 0 || (j.server && j.code == null) ? 'finished' : `exit code ${j.code ?? '?'}`;
  const lines = j.lines.map((l) => l.text), cut = lines.length > 300;
  return { title: `$ ${clip(j.label, 48)}`, text: `$ ${j.label}\n(${j.source === 'agent' ? 'run by the agent' : j.server ? `server ${j.server}` : 'run by the user'}, ${st})\n${(cut ? ['… (earlier lines cut)', ...lines.slice(-300)] : lines).join('\n')}` };
}
// Your own terminal: the selected text, or the last lines of its screen.
function termScreenText(t, f) {
  const x = G.xt?.get(`${t.projectId}:${f}`), u = t.terms.find((y) => y.id === f);
  if (x) {
    const sel = x.term.getSelection().trim();
    if (sel) return { title: `⌨ ${u?.name || 'Terminal'} (selection)`, text: sel };
    const b = x.term.buffer.active, rows = [];
    for (let i = 0; i < b.length; i++) rows.push(b.getLine(i)?.translateToString(true) ?? '');
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    return { title: `⌨ ${u?.name || 'Terminal'} (last ${Math.min(rows.length, 200)} lines)`, text: rows.slice(-200).join('\n') };
  }
  // A terminal tab without a full screen, or one of the output tabs: the commands it shows.
  const jobs = t.order.map((id) => t.jobs.get(id)).filter((j) => j && termShows(t, j, f)).slice(-5);
  if (!jobs.length) return null;
  return { title: `⌨ ${f === 'all' ? 'Activity' : f === 'agent' ? 'Agent' : f.startsWith('srv:') ? f.slice(4) : u?.name || 'Terminal'} (last ${jobs.length} command${jobs.length > 1 ? 's' : ''})`, text: jobs.map((j) => termJobText(j).text).join('\n\n') };
}
function termToChat(item, from) {
  const c = focused();
  if (!c?.el) return uiAlert('Open a chat first: the output goes with your next message there.');
  if (!item?.text?.trim()) return flashTip(from || document.body, 'Nothing to send yet');
  c.ctx.push({ type: 'term', id: `term-${Date.now().toString(36)}`, title: item.title, text: item.text.slice(-20000) });
  renderAttachments(c);
  flashTip(from || document.body, 'Added to your next message');
}
function termHead(t, j) {
  const chat = j.chatId && G.chats.find((x) => x.id === j.chatId);
  const who = j.server ? `<span class="tj-srv">🖥 ${esc(j.server)}</span>` : '';
  const src = j.source === 'agent' ? `<span class="tj-src agent" title="${esc(chat ? `From the chat “${chat.title}”` : 'Run by the agent')}">🤖 agent${chat ? ` · ${esc(clip(chat.title, 24))}` : ''}</span>` : j.source === 'you' ? '<span class="tj-src you">👤 you</span>' : '';
  const st = j.status === 'running' ? `<span class="tj-st busy">● ${j.server ? 'running' : 'running…'}</span>`
    : j.error ? `<span class="tj-st bad">✗ ${esc(j.error)}</span>`
    : j.code === 0 || (j.server && j.code == null) ? `<span class="tj-st ok">✓ ${j.server ? 'stopped' : `done${j.ms != null ? ` in ${secs(j.ms)}` : ''}`}</span>`
    : `<span class="tj-st bad">✗ exit ${j.code ?? '?'}${j.ms != null ? ` · ${secs(j.ms)}` : ''}</span>`;
  return `${src}${who}<code class="tj-cmd"><span class="tj-ps">$</span> ${esc(j.label)}</code><span class="tj-time">${esc(new Date(j.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>${st}<button type="button" class="tj-share" title="Send this command and its output to the chat, with your next message">↪ Chat</button>${j.status === 'running' ? '<button type="button" class="tj-stop" title="Stop it">■ Stop</button>' : ''}`;
}
// full: true redraws the active pane from scratch, 'all' every pane; otherwise only what changed is added.
function termDraw(t, full) {
  if (G.term !== t) return;
  for (const p of t.panes) termDrawPane(t, p, full === 'all' || (!!full && p.id === t.act));
  termFilters(t);
}
function termDrawPane(t, p, full) {
  const root = tpaneEl(p), out = root && $('.term-out', root);
  if (!out) return;
  const f = p.filter;
  const stick = full || out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  if (full) { out.innerHTML = ''; for (const j of t.jobs.values()) if (j.v) delete j.v[p.id]; }
  for (const id of t.order) {
    const j = t.jobs.get(id); if (!j) continue;
    const v = (j.v ||= {})[p.id];
    if (!termShows(t, j, f)) { if (v) { v.el.remove(); delete j.v[p.id]; } continue; }
    if (v && v.rev === j.rev) continue;
    const w = v || (j.v[p.id] = { el: document.createElement('div'), drawn: 0, cut: j.cut, rev: -1 });
    if (!v) { w.el.className = 'tj'; w.el.innerHTML = '<div class="tj-head"></div><pre class="tj-out"></pre>'; out.appendChild(w.el); }
    w.el.classList.toggle('running', j.status === 'running');
    $('.tj-head', w.el).innerHTML = termHead(t, j);
    $('.tj-share', w.el).onclick = (e) => termToChat(termJobText(j), e.currentTarget);
    w.el.oncontextmenu = (e) => { if (window.getSelection()?.toString().trim()) return; popMenu(e, [['↪ Send this command and its output to the chat', () => termToChat(termJobText(j), w.el)]]); };
    const stop = $('.tj-stop', w.el);
    if (stop) stop.onclick = () => { stop.disabled = true; if (j.server) postJ('/api/servers/stop', { key: j.id.slice(4, j.id.lastIndexOf(':')) }); else postJ('/api/term/stop', { job: j.id }); };
    const pre = $('.tj-out', w.el);
    if (w.cut !== j.cut) { pre.textContent = ''; w.drawn = 0; w.cut = j.cut; }
    const frag = document.createDocumentFragment();
    for (const l of j.lines.slice(w.drawn)) { const s = document.createElement('span'); s.className = `tl ${l.stream || 'out'}`; s.textContent = `${l.text}\n`; frag.appendChild(s); }
    w.drawn = j.lines.length; pre.appendChild(frag);
    while (pre.childElementCount > 1500) pre.firstChild.remove();
    pre.hidden = !j.lines.length;
    w.rev = j.rev;
  }
  if (!out.querySelector('.tj')) out.innerHTML = `<div class="term-empty">${f === 'all' ? 'Nothing has run in this project yet. Commands and servers started by the agent or by you show here live.' : t.terms.some((u) => u.id === f) ? 'A fresh terminal in the project folder. Type a command below (help for what works).' : 'Nothing here yet.'}</div>`;
  else $('.term-empty', out)?.remove();
  if (stick) out.scrollTop = out.scrollHeight;
}
const TP_ICO = {
  above: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 5.5v4M10 7.5h4"/></svg>',
  below: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 13h16"/><path d="M12 14.5v4M10 16.5h4"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/></svg>',
};
function termFilters(t) {
  const servers = [...new Set([...t.jobs.values()].filter((j) => j.server).map((j) => j.server))];
  const agentRan = [...t.jobs.values()].some((j) => j.source === 'agent' && !j.server);
  const busy = (f) => [...t.jobs.values()].some((j) => j.status === 'running' && termShows({ ...t, clearedBy: {} }, j, f));
  const many = t.panes.length > 1;
  for (const p of t.panes) {
    const root = tpaneEl(p), box = root && $('.ttabs', root); if (!box) continue;
    const tabs = [['all', '≡ Activity'], ...(agentRan ? [['agent', '🤖 Agent']] : []), ...servers.map((x) => [`srv:${x}`, `🖥 ${x}`]), ...t.terms.map((u) => [u.id, `⌨ ${u.name}`, true])];
    if (!tabs.some(([k]) => k === p.filter)) p.filter = t.terms.find((u) => !t.panes.some((q) => q.filter === u.id))?.id || 'all';
    const html = tabs.map(([k, l, mine]) => `<span class="ttab ${p.filter === k ? 'on' : ''}" data-f="${esc(k)}" role="tab">${busy(k) ? '<i class="tr-dot busy"></i>' : ''}<span>${esc(l)}</span>${mine ? `<button type="button" class="bt-x" data-close="${esc(k)}" title="Close this terminal" aria-label="Close terminal">×</button>` : ''}</span>`).join('')
      + '<button type="button" class="btab-new ttab-new" title="New terminal in this pane">＋</button>'
      + `<span class="tp-acts"><button type="button" class="tp-btn" data-tp="above" title="Add a terminal pane above this one" aria-label="Add a pane above"${t.panes.length >= 6 ? ' disabled' : ''}>${TP_ICO.above}</button><button type="button" class="tp-btn" data-tp="below" title="Add a terminal pane below this one" aria-label="Add a pane below"${t.panes.length >= 6 ? ' disabled' : ''}>${TP_ICO.below}</button>${many ? `<button type="button" class="tp-btn danger" data-tp="close" title="Close this pane (its terminals stay in the tabs)" aria-label="Close this pane">${TP_ICO.close}</button>` : ''}</span>`;
    if (box.dataset.html === html) continue;
    box.dataset.html = html; box.innerHTML = html;
    for (const el of box.querySelectorAll('.ttab')) { el.onclick = (e) => { if (!e.target.closest('.bt-x')) termPick(t, p, el.dataset.f); }; el.draggable = true; el.ondragstart = (e) => { e.dataTransfer.setData('application/x-quorx-term', el.dataset.f); e.dataTransfer.effectAllowed = 'copy'; }; el.oncontextmenu = (e) => popMenu(e, [['↪ Send what this tab shows to the chat', () => termToChat(termScreenText(t, el.dataset.f), el)]]); }
    for (const b of box.querySelectorAll('.bt-x')) b.onclick = () => {
      const id = b.dataset.close;
      postJ('/api/term/close', { projectId: t.projectId, tab: id }).catch(() => {}); dropXterm(t.projectId, id, true);
      t.terms = t.terms.filter((u) => u.id !== id);
      for (const q of t.panes) if (q.filter === id) q.filter = t.terms.find((u) => !t.panes.some((r) => r.filter === u.id))?.id || 'all';
      termSave(t); renderTermInput(t); termDraw(t, 'all');
    };
    $('.ttab-new', box).onclick = () => { const id = termNew(t); termPick(t, p, id); $('.term-in input', root)?.focus(); };
    for (const b of box.querySelectorAll('[data-tp]')) b.onclick = () => (b.dataset.tp === 'close' ? termClosePane(t, p) : termSplit(t, p, b.dataset.tp));
  }
}
function termNew(t) { const id = `u${t.nextTerm}`; t.terms.push({ id, name: `Terminal ${t.nextTerm++}`, cwd: '', hist: [], hi: 0 }); return id; }
// Your own terminal shows in one pane at a time: picking it where another pane shows it swaps the two.
function termPick(t, p, f) {
  const other = /^u\d+$/.test(f) && t.panes.find((q) => q !== p && q.filter === f);
  if (other) other.filter = p.filter;
  p.filter = f; termActivate(t, p); termSave(t);
  renderTermInput(t); termDraw(t, other ? 'all' : true);
}
function termActivate(t, p) {
  t.act = p.id;
  for (const el of document.querySelectorAll('#paneBody .tpane')) el.classList.toggle('on', el.dataset.pane === p.id);
  for (const q of t.panes) { const h = tpaneEl(q) && $('.term-hint', tpaneEl(q)); if (h && !$('.term-in', tpaneEl(q)).hidden) h.hidden = q !== p; }
}
// A new pane above or below, with a fresh terminal in it; the two share the space this one had.
function termSplit(t, p, where) {
  if (t.panes.length >= 6) return;
  const q = { id: `p${t.nextPane++}`, filter: termNew(t), grow: p.grow / 2 };
  p.grow /= 2;
  t.panes.splice(t.panes.indexOf(p) + (where === 'below' ? 1 : 0), 0, q);
  t.act = q.id; termSave(t); renderPane();
}
function termClosePane(t, p) {
  if (t.panes.length < 2) return;
  const i = t.panes.indexOf(p), n = t.panes[i ? i - 1 : 1];
  n.grow += p.grow; t.panes.splice(i, 1);
  t.act = n.id; termSave(t); renderPane();
}
// The input row belongs to your own terminals; the other tabs only show output. The hint shows in the active pane.
function renderTermInput(t) { for (const p of t.panes) termPaneInput(t, p); }
function termPaneInput(t, p) {
  const root = tpaneEl(p); if (!root) return;
  const u = t.terms.find((x) => x.id === p.filter), form = $('.term-in', root), hint = $('.term-hint', root);
  const full = !!u && G.cfg.pty && !u.plain;
  form.hidden = !u || full; hint.hidden = !u || full || p.id !== t.act;
  $('.term-note', root).hidden = !!u;
  const xbox = $('.term-x', root), outBox = $('.term-out', root);
  xbox.hidden = !full; outBox.hidden = full;
  if (full) { mountXterm(t, u, xbox, p.id === t.act); return; }
  if (!u) return;
  const pr = G.projects.find((x) => x.id === t.projectId);
  const dir = u.dir || pr?.dir || '';
  $('.term-ps', form).textContent = `${baseName(dir) || t.projectId} ›`;
  $('.term-ps', form).title = dir;
  const running = [...t.jobs.values()].some((j) => j.tab === u.id && j.status === 'running');
  $('input', form).placeholder = running ? 'Type input for the running command (Enter sends it), or ■ to stop it' : `${G.cfg.shell || 'Shell'}: git status   ·   npm run dev   ·   ${G.cfg.shell?.includes('PowerShell') ? 'dir' : 'ls'}`;
}
// ---------- the full terminal: xterm.js on the page, a pseudo-terminal on the server ----------
// Each of your terminal tabs keeps one xterm (it survives switching tabs and re-drawing the pane) and one stream of
// output. Keys go to the server in small batches, in order; the screen size follows the pane.
let xtermLoad = null;
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  return (xtermLoad ||= new Promise((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/xterm.css'; document.head.appendChild(css);
    const add = (src) => new Promise((ok, bad) => { const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = () => bad(new Error(`could not load ${src}`)); document.head.appendChild(sc); });
    add('/vendor/xterm.js').then(() => add('/vendor/addon-fit.js')).then(resolve, (e) => { xtermLoad = null; reject(e); });
  }));
}
function xtermTheme() {
  const v = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
  return { background: v('--surface-inset', '#05080a') || '#05080a', foreground: v('--text', '#d7e0dc'), cursor: v('--accent', '#1fc8db'), cursorAccent: '#000000', selectionBackground: 'rgba(31, 200, 219, 0.35)' };
}
async function mountXterm(t, u, box, focus = true) {
  const k = `${t.projectId}:${u.id}`;
  G.xt ||= new Map();
  let x = G.xt.get(k);
  if (x) { if (x.el.parentElement !== box) box.replaceChildren(x.el); requestAnimationFrame(() => { try { x.fit.fit(); } catch { /* hidden */ } if (focus) x.term.focus(); }); return; }
  // The pane can redraw while this one is still being set up: only one terminal per tab.
  if ((G.xtBusy ||= new Set()).has(k)) return;
  G.xtBusy.add(k);
  box.innerHTML = '<div class="fx-empty">Starting the terminal…</div>';
  try { await loadXterm(); } catch (e) { G.xtBusy.delete(k); u.plain = true; box.hidden = true; renderTermInput(t); return; }
  const el = document.createElement('div'); el.className = 'xt-host';
  const term = new window.Terminal({ cursorBlink: true, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'Consolas, monospace', fontSize: (() => { try { return Number(localStorage.getItem('oh-term-font')) || 13; } catch { return 13; } })(), lineHeight: 1.15, scrollback: 5000, allowProposedApi: false, theme: xtermTheme(), convertEol: false, linkHandler: termLink });
  termLinks(term);
  const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit);
  x = { term, fit, el, es: null, q: '', chain: Promise.resolve(), exited: false, projectId: t.projectId, tab: u.id };
  G.xt.set(k, x); G.xtBusy.delete(k);
  box.replaceChildren(el); term.open(el);
  // Measure once the pane has laid out, so the shell starts at the size it will be shown at.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try { fit.fit(); } catch { /* not laid out yet */ }
  // Copy with Ctrl+C when text is selected (otherwise Ctrl+C interrupts, as in any terminal); Ctrl+V pastes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c' && term.hasSelection()) { navigator.clipboard?.writeText(term.getSelection()).catch(() => {}); term.clearSelection(); return false; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') return false; // the browser's paste reaches the terminal
    return true;
  });
  const send = (data) => {
    if (x.exited) { if (data === '\r' || data === '\n') { term.write('\r\n'); startXterm(x); } return; }
    x.q += data;
    if (x.flush) return;
    x.flush = setTimeout(() => {
      const chunk = x.q; x.q = ''; x.flush = null;
      x.chain = x.chain.then(() => postJ('/api/pty/input', { projectId: x.projectId, tab: x.tab, data: chunk })).catch(() => {});
    }, 4);
  };
  term.onData(send);
  term.onResize(({ cols, rows }) => { clearTimeout(x.rt); x.rt = setTimeout(() => postJ('/api/pty/resize', { projectId: x.projectId, tab: x.tab, cols, rows }).catch(() => {}), 60); });
  new ResizeObserver(() => { if (el.offsetParent) { try { fit.fit(); } catch { /* hidden */ } } }).observe(el);
  await startXterm(x);
  if (focus) term.focus();
  // Once it runs, fit again: the shell redraws its screen for the final size (a first prompt can be drawn too early).
  setTimeout(() => { try { fit.fit(); } catch { /* hidden */ } }, 300);
}
// Open (or reopen) the tab's terminal on the server and follow its output.
async function startXterm(x) {
  const r = await postJ('/api/pty/open', { projectId: x.projectId, tab: x.tab, cols: x.term.cols, rows: x.term.rows }).catch((e) => ({ error: e.message }));
  if (r?.error) {
    x.term.write(`\r\n\x1b[31m${r.error}\x1b[0m\r\n`);
    if (r.fallback) { const t = G.term; const u = t?.terms.find((y) => y.id === x.tab); if (u) { u.plain = true; dropXterm(x.projectId, x.tab, false); renderTermInput(t); } }
    return;
  }
  x.exited = false;
  // Windows PowerShell takes a few seconds to start: say so (its first screen clears this line).
  if (!x.started) { x.started = true; x.term.write(`\x1b[90mStarting ${r.shell || 'the shell'}…\x1b[0m`); }
  x.es?.close();
  x.es = new EventSource(`/api/pty/stream?project=${encodeURIComponent(x.projectId)}&tab=${encodeURIComponent(x.tab)}`);
  x.es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.d) x.term.write(e.d);
    if (e.exit != null && !e.closed) { x.exited = true; x.es.close(); x.term.write(`\r\n\x1b[90m[the shell ended${e.exit ? ` with code ${e.exit}` : ''} · press Enter for a new one]\x1b[0m\r\n`); }
  };
}
function dropXterm(projectId, tab, close) {
  const k = `${projectId}:${tab}`, x = G.xt?.get(k);
  if (close) postJ('/api/pty/close', { projectId, tab }).catch(() => {});
  if (!x) return;
  x.es?.close(); try { x.term.dispose(); } catch { /* gone */ } x.el.remove(); G.xt.delete(k);
}
// Built-ins handled here: clear, pwd, help. cd and ls go to the server (they stay inside the project).
function termLocal(t, u, label, lines) {
  const job = `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  termApply(t, { kind: 'start', job, source: 'you', tab: u.id, label, at: Date.now() });
  for (const text of lines) termApply(t, { kind: 'out', job, text, stream: 'note', at: Date.now() });
  termApply(t, { kind: 'end', job, code: 0, at: Date.now() });
}
const SVG_RUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>';
function renderTerm(c) {
  const body = $('#paneBody'), bar = $('#appBar');
  const p = projectOf(c), t = termState(c.projectId);
  if (c.srvPop?.inline) closeServers(c);
  bar.hidden = false;
  const sec = (k, ico, label, tip) => `<button type="button" class="tsec ${t.sec === k ? 'on' : ''}" data-sec="${k}" role="tab" aria-selected="${t.sec === k}" title="${tip}">${ico}<span class="tsec-l">${label}</span><span class="tsec-n" hidden></span></button>`;
  bar.innerHTML = `<span class="term-title">${SVG_TERM}<b>Terminal</b></span><span class="dim">${esc(p?.name || c.projectId)}</span>
    <span class="tsecs" role="tablist" aria-label="Terminal sections">${sec('term', SVG_TERM, 'Terminals', 'Your terminals and the live output of every command and server, in panes you can stack')}${sec('run', SVG_RUN, 'Running', 'Everything running in this project (background jobs, commands, servers, terminals), each with a Stop')}${sec('srv', SVG_SERVER, 'Servers', 'This project’s saved servers: run, stop, edit, open')}</span><span class="spacer"></span>
    ${t.sec === 'term' ? '<button type="button" class="term-share" title="Send what the active pane shows to the chat, with your next message: the text you selected, or the last lines (you can also drag a terminal tab onto the chat)">↪ Send to chat</button><button type="button" class="term-clear" title="Clear the active pane’s finished output (running ones stay)">⌫ Clear output</button>' : t.sec === 'run' ? '<button type="button" class="run-stopall danger" title="Stop every command, background job, server and agent terminal in this project (your terminal tabs stay open)" disabled>■ Stop all</button>' : ''}<button type="button" class="back" title="Close the terminal">✕ Close</button>`;
  for (const b of bar.querySelectorAll('.tsec')) b.onclick = () => { if (t.sec === b.dataset.sec) return; t.sec = b.dataset.sec; termSave(t); renderTerm(c); };
  $('.back', bar).onclick = () => { G.view.term = false; closeTermStream(); if (c.srvPop?.inline) closeServers(c); syncLayout(); renderPane(); };
  termSecCounts(c);
  termOpenStream(t);
  if (t.sec === 'run') {
    $('.run-stopall', bar).onclick = async (e) => {
      const n = G.runCount?.[c.projectId]?.n || 0;
      if (!n || !(await uiConfirm(`Stop everything running in this project?\n${n} thing${n > 1 ? 's' : ''}: commands, background jobs, servers and the agent’s terminals, with all they started. Your terminal tabs stay open. A reply that is working is told, and carries on without them.`, { ok: 'Stop all', danger: true }))) return;
      e.target.disabled = true;
      await postJ('/api/running/stop-all', { projectId: c.projectId });
      refreshRunning(c);
    };
    body.innerHTML = '<div class="run" id="runPane"><div class="run-empty dim">Checking…</div></div>';
    return refreshRunning(c);
  }
  if (t.sec === 'srv') {
    body.innerHTML = '<div class="srv-pop srv-inline" id="termSrv"><div class="srv-empty">Loading…</div></div>';
    c.srvPop = { el: $('#termSrv', body), inline: true, editing: null, timer: setInterval(() => renderServers(c), 2000) };
    return renderServers(c);
  }
  $('.term-share', bar).onclick = (e) => termToChat(termScreenText(t, t.filter), e.currentTarget);
  $('.term-clear', bar).onclick = () => {
    const root = tpaneEl(termPane(t)), x = G.xt?.get(`${t.projectId}:${t.filter}`);
    if (x && root && !$('.term-x', root).hidden) { x.term.clear(); x.term.focus(); return; }
    (t.clearedBy ||= {})[t.filter] = Date.now(); termDraw(t, true);
  };
  const hintHTML = `<b>${esc(G.cfg.shell || 'Shell')}</b>, starting in the project folder · pipes, scripts, git and dev servers work · <code>clear</code> empties the tab · ■ stops a command (the shell restarts in the same folder) · ↑ ↓ earlier commands · full-screen programs (vim, htop) need a terminal app`;
  body.innerHTML = `<div class="term">
    <div class="term-running" id="termRunning"><span class="tr-label">Running</span><span class="dim">checking…</span></div>
    <div class="tpanes">${t.panes.map((q, i) => `${i ? `<div class="tsplit" data-i="${i}" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal panes" title="Drag to resize · double-click to share the space evenly"></div>` : ''}<section class="tpane ${q.id === t.act ? 'on' : ''}" data-pane="${q.id}" style="flex-grow:${q.grow}">
      <div class="ttabs" role="tablist" aria-label="Terminals"></div>
      <div class="term-out" tabindex="0" aria-live="polite"></div>
      <div class="term-x" hidden></div>
      <div class="term-note dim" hidden>This tab only shows output. Pick one of your terminals (⌨, or ＋) to run commands.</div>
      <form class="term-in"><span class="term-ps"></span><input aria-label="Command" placeholder="git status   ·   npm run dev   ·   dir" autocomplete="off" spellcheck="false"><button type="submit">Run</button></form>
      <div class="term-hint">${hintHTML}</div>
    </section>`).join('')}</div>
  </div>`;
  for (const q of t.panes) {
    const root = tpaneEl(q), form = $('.term-in', root), inp = $('input', form), hint = $('.term-hint', root);
    const say = (msg, bad) => { hint.classList.toggle('bad', !!bad); hint.innerHTML = msg; };
    root.addEventListener('pointerdown', () => { if (t.act !== q.id) termActivate(t, q); }, true);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const u = t.terms.find((x) => x.id === q.filter); if (!u) return;
      const line = inp.value.trim(); if (!line) return;
      if (folderMissing(c)) return;
      u.hist.push(line); u.hi = u.hist.length; inp.value = '';
      const [cmd] = line.split(/\s+/);
      if (cmd === 'clear' || cmd === 'cls') { (t.clearedBy ||= {})[u.id] = Date.now(); termDraw(t, 'all'); return; }
      // Your terminals are a real shell; the line goes to it as typed.
      const rs = await postJ('/api/term/run', { projectId: c.projectId, line, tab: u.id });
      if (rs.error) { say(`⚠ ${esc(rs.error)}`, true); termLocal(t, u, line, [`⚠ ${rs.error}`]); return; }
      say(hintHTML); termPaneInput(t, q);
    };
    inp.onkeydown = (e) => {
      const u = t.terms.find((x) => x.id === q.filter); if (!u) return;
      if (e.key === 'ArrowUp' && u.hi > 0) { u.hi--; inp.value = u.hist[u.hi]; e.preventDefault(); }
      if (e.key === 'ArrowDown') { u.hi = Math.min(u.hist.length, u.hi + 1); inp.value = u.hist[u.hi] || ''; e.preventDefault(); }
    };
  }
  // The bar between two panes moves the space between them; the sizes are remembered for the project.
  for (const s of body.querySelectorAll('.tsplit')) {
    const a = t.panes[Number(s.dataset.i) - 1], b = t.panes[Number(s.dataset.i)];
    s.onpointerdown = (e) => {
      e.preventDefault(); s.setPointerCapture(e.pointerId); s.classList.add('drag');
      const ea = tpaneEl(a), eb = tpaneEl(b), ha = ea.getBoundingClientRect().height, hb = eb.getBoundingClientRect().height, g = a.grow + b.grow, y0 = e.clientY;
      s.onpointermove = (ev) => {
        const na = Math.max(70, Math.min(ha + hb - 70, ha + ev.clientY - y0));
        a.grow = (g * na) / (ha + hb); b.grow = g - a.grow;
        ea.style.flexGrow = a.grow; eb.style.flexGrow = b.grow;
      };
      s.onpointerup = () => { s.onpointermove = null; s.classList.remove('drag'); termSave(t); };
    };
    s.ondblclick = () => { for (const q of t.panes) { q.grow = 1; tpaneEl(q).style.flexGrow = 1; } termSave(t); };
  }
  termFilters(t); renderTermInput(t);
  termDraw(t, 'all');
  getJ(`/api/servers/overview?project=${encodeURIComponent(c.projectId)}`).then((r) => drawRunning(c, r));
}
// The section buttons count what runs and how many servers are up.
function termSecCounts(c) {
  const bar = $('#appBar'); if (!bar || !G.view.term) return;
  const put = (k, n, tip) => { const el = $(`.tsec[data-sec="${k}"] .tsec-n`, bar); if (el) { el.textContent = n || ''; el.hidden = !n; el.title = tip; } };
  const rn = G.runCount?.[c.projectId]?.n || 0, sn = G.devCount?.[c.projectId]?.running || 0;
  put('run', rn, `${rn} running`); put('srv', sn, `${sn} server${sn === 1 ? '' : 's'} up`);
}

// ---------- 📎 attached files of any kind: uploaded to the project, read and (when big) indexed ----------
const DOC_ICON = { pdf: '📕', docx: '📘', odt: '📘', pptx: '📙', odp: '📙', xlsx: '📗', ods: '📗', epub: '📚', text: '📄', image: '🖼', binary: '📦' };
const docSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1e3))} KB`);
const docSettings = () => { const S = G.settings || {}; return { embedModel: S.embedModel, inlineDocTokens: S.inlineDocTokens, docIndexBudget: S.docIndexBudget, readerModel: S.readerModel }; };
async function addFiles(c, files) {
  const list = [...files];
  const pics = list.filter((f) => f.type.startsWith('image/') && c.images.length < 4);
  if (pics.length) await addImages(c, pics);
  for (const f of list.filter((x) => !pics.includes(x))) uploadDoc(c, f);
}
async function uploadDoc(c, f) {
  const max = Number(G.settings?.maxUploadMB) || 100;
  const d = { key: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: f.name, size: f.size, kind: '', busy: 'uploading' };
  (c.docs ||= []).push(d); renderAttachments(c);
  const done = (patch) => { Object.assign(d, patch); renderAttachments(c); };
  if (f.size > max * 1e6) return done({ busy: null, status: 'error', note: `Over the ${max} MB limit (⚙ Settings → Documents).` });
  const up = await fetch(`/api/docs/upload?project=${encodeURIComponent(c.projectId)}&name=${encodeURIComponent(f.name)}&max=${max}`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (up.error) return done({ busy: null, status: 'error', note: up.error });
  done({ ...up, busy: 'reading' });
  processDocChip(c, d, {});
}
async function processDocChip(c, d, extra) {
  Object.assign(d, { busy: extra.ocr ? 'running OCR' : extra.confirm ? 'indexing' : 'reading' }); renderAttachments(c);
  const r = await postJ('/api/docs/process', { projectId: c.projectId, id: d.id, chatId: c.id, settings: docSettings(), ...extra });
  Object.assign(d, r.error ? { status: 'error', note: r.error } : r, { busy: null });
  renderAttachments(c);
}
const DOC_STATE = {
  text: ['ok', '✓ included'], indexed: ['ok', '🔎 searchable'], image: ['ok', '✓ picture'], stored: ['warn', 'saved · agent decides'],
  'needs-ok': ['ask', 'big'], 'needs-ocr': ['ask', 'scanned'], error: ['bad', '✗ failed'],
};
function docChip(d, i) {
  const [cls, label] = d.busy ? ['busy', `${d.busy}…`] : DOC_STATE[d.status] || ['warn', d.status || ''];
  const act = !d.busy && d.status === 'needs-ok' ? `<button type="button" class="doc-act" data-doc-ok="${i}" title="${esc(d.note || '')}">Make searchable · ~$${Number(d.estimate || 0).toFixed(3)}</button>`
    : !d.busy && d.status === 'needs-ocr' ? `<button type="button" class="doc-act" data-doc-ocr="${i}" title="${esc(d.note || '')}">Read with OCR · ~$${Number(d.ocrEstimate || 0).toFixed(3)}</button>` : '';
  const tip = [d.name, docSize(d.size), d.pages ? `${d.pages} pages` : '', d.tokens ? `~${d.tokens.toLocaleString()} tokens` : '', d.method || '', d.note || '', d.cost ? `cost $${Number(d.cost).toFixed(4)}` : ''].filter(Boolean).join('\n');
  return `<span class="doc-chip cmp-att-item ${cls}" title="${esc(tip)}"><span class="doc-ico">${DOC_ICON[d.kind] || '📄'}</span><span class="doc-name">${esc(d.name)}</span><span class="doc-size">${docSize(d.size)}</span><span class="doc-state ${cls}">${esc(label)}</span>${d.cost ? `<span class="doc-cost">$${Number(d.cost).toFixed(4)}</span>` : ''}${act}<button type="button" data-doc-x="${i}" aria-label="Remove ${esc(d.name)}">✕</button></span>`;
}
function wireDocChips(c, box) {
  for (const b of box.querySelectorAll('[data-doc-x]')) b.onclick = () => {
    const [d] = c.docs.splice(Number(b.dataset.docX), 1);
    // Not sent yet, so the upload goes too.
    if (d?.id) fetch(`/api/docs?project=${encodeURIComponent(c.projectId)}&id=${encodeURIComponent(d.id)}`, { method: 'DELETE' }).catch(() => {});
    renderAttachments(c);
  };
  for (const b of box.querySelectorAll('[data-doc-ok]')) b.onclick = () => processDocChip(c, c.docs[Number(b.dataset.docOk)], { confirm: true });
  for (const b of box.querySelectorAll('[data-doc-ocr]')) b.onclick = async () => { const d = c.docs[Number(b.dataset.docOcr)]; if (await uiConfirm(`Read "${d.name}" with OCR (mistral-ocr through OpenRouter, about $${Number(d.ocrEstimate || 0).toFixed(3)})?`)) processDocChip(c, d, { ocr: true, confirm: true }); };
}

// ⚙ Settings → Documents: the embedding model, with prices, cheapest first.
async function drawEmbedPick() {
  const box = $('#stEmbedPick'); if (!box) return;
  const r = await getJ('/api/docs/models');
  if (!box.isConnected) return;
  const cur = ST.draft.embedModel || r.defaults?.embedModel;
  const models = (r.models || []).sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  if (!models.length) { box.textContent = r.error ? `Could not load the models (${r.error}).` : 'No embedding models found.'; return; }
  box.innerHTML = `<select class="st-select" aria-label="Embedding model">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.id)} · ${m.price ? `$${m.price < 0.01 ? m.price.toFixed(3) : m.price.toFixed(2)}/M` : 'free'} · ${m.ctx >= 1000 ? `${Math.round(m.ctx / 1000)}k` : m.ctx} ctx${m.id === r.defaults?.embedModel ? ' · default' : ''}</option>`).join('')}</select>`;
  $('select', box).onchange = (e) => { ST.draft.embedModel = e.target.value; box.closest('.st-row')?.classList.add('changed'); ST.dirty = true; updateDirty(); };
}

// ---------- the pane as a small browser: tabs, an address bar, and the agent's own browser ----------
const paneTab = () => (G.view.term ? 'term' : G.view.files ? 'files' : G.view.trace ? 'trace' : G.view.browser ? 'browser' : 'art');
const absUrl = (u) => (!u || u.startsWith('data:') ? '' : u.startsWith('/') ? location.origin + u : u);
function artifactUrl(c, a) {
  if (a.kind === 'html' || a.kind === 'md') return `/art/${encodeURIComponent(c.id)}/${encodeURIComponent(a.id)}`;
  return a.url || '';
}
function setPaneTab(tab) {
  const c = focused(); if (!c) return;
  if (tab === 'run') return openTerminal(c, null, 'run');
  const lastRun = [...c.agent.messages].reverse().find((m) => m.role === 'assistant' && m.runId);
  if (tab === 'trace') G.traceRun = G.traceRun && c.agent.messages.some((m) => m.runId === G.traceRun) ? G.traceRun : lastRun?.runId || null;
  if (tab === 'browser') refreshAgentTab(c).then((ch) => { if (ch && G.view.browser) renderPane(); });
  G.view = { id: G.view.id, src: false, files: tab === 'files', term: tab === 'term', run: tab === 'run', browser: tab === 'browser', trace: tab === 'trace' ? (G.traceRun || '(none)') : null };
  c.paneHidden = false;
  syncLayout(); renderPane(); refreshTraceButtons(); toPreview();
}
function renderPaneTabs(c) {
  const box = $('#paneTabs'); if (!box) return;
  const t = paneTab();
  for (const b of box.querySelectorAll('[data-tab]')) { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
  const n = planArts(c).length;
  $('[data-tab="art"] .pt-n', box).textContent = n || '';
  // The Terminal tab counts what runs (its Running section lists them) and turns amber while a command runs.
  const dev = c && G.devCount?.[c.projectId], rn = c && G.runCount?.[c.projectId];
  const tb = $('[data-tab="term"]', box), tn = $('[data-tab="term"] .pt-n', box);
  tn.textContent = rn?.n || ''; tn.classList.toggle('busy', !!rn?.n); tb.classList.toggle('busy', !!dev?.busy);
  if (c && G.view.term) termSecCounts(c);
  const ag = c && G.agentTab?.[c.id];
  const dot = $('[data-tab="browser"] .pt-dot', box); dot.className = `pt-dot ${ag?.locked ? 'live' : ag || G.btabs?.length ? 'has' : ''}`;
  const fa = $('#followAgent'); if (fa) fa.checked = G.followAgent !== false;
}
// The address bar: the served address of what is open, editable to look at any address yourself.
function setUrlBar(url, { art = false } = {}) {
  const tab = paneTab(), wrap = $('#paneUrlWrap'), f = $('#paneUrl');
  wrap.hidden = tab === 'term' || tab === 'files' || tab === 'trace' || tab === 'run';
  $('#artSelect').hidden = !art;
  wrap.classList.toggle('art-mode', !!art);
  const full = absUrl(url);
  f.value = full;
  f.placeholder = url && url.startsWith('data:') ? 'Embedded in the chat (no address)' : 'Type an address or words to search, and press Enter';
  f.title = full || f.placeholder;
  $('#copyUrlBtn').disabled = !full; $('#popBtn').disabled = !full && !(url || '').startsWith('data:');
  G.paneUrl = full;
}
function wirePaneChrome() {
  $('#paneSrvBtn').innerHTML = `${SVG_SERVER}<span class="hdr-count" hidden></span>`;
  $('#paneSrvBtn').onclick = () => { const c = focused(); if (c?.el) toggleServers(c); };
  // ⤢ the pane takes the whole window (chat hidden); ⤡ puts the chat back. Remembered.
  const setMax = (on) => { G.paneMax = on; $('.layout').classList.toggle('pane-max', on); const b = $('#paneMaxBtn'); b.textContent = on ? '⤡' : '⤢'; b.title = on ? 'Show the chat again' : 'Make the pane full width (the chat hides until you press this again)'; b.setAttribute('aria-pressed', String(on)); try { localStorage.setItem('oh-pane-max', on ? '1' : ''); } catch { /* storage off */ } };
  $('#paneMaxBtn').onclick = () => { if (G.paneHidden) setPaneHidden(false); setMax(!G.paneMax); };
  let wasHidden = false; try { wasHidden = localStorage.getItem('oh-pane-hidden') === '1'; } catch { /* storage off */ }
  setPaneHidden(wasHidden, true);
  let wasMax = false; try { wasMax = localStorage.getItem('oh-pane-max') === '1'; } catch { /* storage off */ }
  setMax(wasMax);
  for (const b of document.querySelectorAll('#paneTabs [data-tab]')) b.onclick = () => (paneTab() === b.dataset.tab && b.dataset.tab !== 'art' ? setPaneTab('art') : setPaneTab(b.dataset.tab));
  const fa = $('#followAgent'); if (fa) fa.onchange = () => { G.followAgent = fa.checked; savePrefs(); };
  $('#copyUrlBtn').onclick = async () => {
    if (!G.paneUrl) return;
    const b = $('#copyUrlBtn');
    try { await navigator.clipboard.writeText(G.paneUrl); flashTip(b, 'Copied'); } catch { uiPrompt('Copy the address', G.paneUrl, { ok: 'Done', cancel: 'Close' }); }
  };
  $('#paneUrl').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim(); if (!v) return;
    browserGo(typedToUrl(v));
  };
}

// Every page the agent's browser showed in a reply: browser steps and look's vision checks.
const isShot = (e) => !!e && !!e.image && (e.t === 'screenshot' || (e.t === 'decide_start' && e.look));
function onAgentBrowse(c, m) {
  if (focused() !== c) return;
  renderPaneTabs(c);
  // The agent's page appears as a browser tab; with "Follow the agent" the pane switches to it.
  refreshAgentTab(c).then(() => {
    if (G.followAgent !== false && !(G.view.browser && G.bActive === `agent-${c.id}`)) { G.view = { id: G.view.id, src: false, files: false, browser: true }; G.bActive = `agent-${c.id}`; c.paneHidden = false; syncLayout(); renderPane(); }
    else if (G.view.browser) renderPane();
  });
}
// With "Follow the agent", a command the agent runs brings up the Terminal tab on its output (the 🤖 Agent view, or
// ≡ Activity before the agent's first command has shown up there), unless you are typing in the pane.
function onAgentCommand(c) {
  if (focused() !== c || G.followAgent === false || (G.view.term && ['agent', 'all'].includes(G.term?.filter))) return;
  if ($('#pane')?.contains(document.activeElement) && document.activeElement.matches('input, textarea, .xterm-helper-textarea, [contenteditable]')) return;
  const t = termState(c.projectId);
  openTerminal(c, [...t.jobs.values()].some((j) => j.source === 'agent' && !j.server) ? 'agent' : 'all');
}
// The Browser tab is a small browser of its own: the agent's page for this chat (live, and watch-only
// while its reply works), and your own tabs. Pages run in the harness's headless browser and show as a
// live picture you can click, scroll and type into; your own served pages can show in a frame instead.
function browserTabs(c) {
  const agentSid = `agent-${c.id}`;
  G.btabs ||= [];
  const list = [];
  // The agent's tab is its stored record itself, not a copy: a step's answer (its picture) and its state stay on it.
  if (G.agentTab?.[c.id]) list.push(Object.assign(G.agentTab[c.id], { sid: agentSid, agent: true }));
  return list.concat(G.btabs);
}
function activeBTab(c) {
  const list = browserTabs(c);
  return list.find((t) => t.sid === G.bActive) || list[0] || null;
}
function newBTab(url) {
  const t = { sid: `ub${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, url: url || '', title: url ? '' : 'New tab' };
  (G.btabs ||= []).push(t); G.bActive = t.sid;
  return t;
}
function renderBrowser(c) {
  const body = $('#paneBody'), bar = $('#appBar');
  const list = browserTabs(c), t = activeBTab(c);
  if (t) G.bActive = t.sid;
  setUrlBar(t?.url || '');
  bar.hidden = false;
  const live = t?.agent && t.locked;
  const REAL = DESK && !!t && (!t.agent || t.desktop);
  bar.innerHTML = !t ? ''
    : `${t.agent ? `<span class="bv-who agent" title="${live ? "The agent's page: it is using it now, so you can only watch" : "The agent's page: it is done with it, so it is yours to use"}">🤖</span>${live ? '<span class="bv-lock" title="The agent is using this page: watch only">watching</span>' : ''}` : '<span class="bv-who you" title="Your tab">👤</span>'}
       ${!live && t.mode !== 'frame' && t.url ? `<button type="button" class="bv-nav" data-op="back" title="Back" aria-label="Back"${REAL && t.canBack === false ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button><button type="button" class="bv-nav" data-op="forward" title="Forward" aria-label="Forward"${REAL && t.canForward === false ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>` : ''}
       ${REAL && t.url ? `<span class="bv-real ${t.loading ? 'loading' : ''}" title="A real Chromium tab in the desktop app">● real tab${t.loading ? ' · loading…' : ''}</span>` : ''}
       <span class="spacer"></span>${!t.agent && t.url ? (() => { const to = lentChatOf(t.sid), ch = to && (G.open.get(to) || G.chats.find((x) => x.id === to)); return to ? `<span class="bv-lent" title="The agent can work in this tab in that chat">🤖 Lent to ${to === c.id ? 'this chat' : `“${esc(clip(ch?.title || 'another chat', 24))}”`}</span><button type="button" class="bv-takeback" title="Take this tab back: the agent can no longer use it">Take back</button>` : `<button type="button" class="bv-give" title="Let the agent in this chat work in this tab (signed in as you). Sending, deleting, buying and account changes always ask you first. You can also drag the tab onto a chat.">🤖 Give to agent</button>`; })() : ''}${t.url ? `<button type="button" class="bv-cmt ${t.commenting ? 'on' : ''}" aria-pressed="${!!t.commenting}" title="Comment on part of this page: click an element, say what to change, and it goes with your next message">💬 ${t.commenting ? 'Done commenting' : 'Comment'}</button><button type="button" class="bv-exp" aria-haspopup="menu" title="Export this page as a PDF or one long picture, or the project's files as a ZIP">⤓ Export</button>` : ''}${REAL && t.url && !live ? '<button type="button" class="bv-dev" title="Open DevTools for this tab" aria-label="DevTools"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg></button>' : ''}${!DESK && !t.agent && t.url ? `<button type="button" class="bv-mode ${t.mode === 'frame' ? 'on' : ''}" title="${t.mode === 'frame' ? 'Shown in a frame. Click to open it in the harness browser instead (for sites that refuse frames)' : 'Shown in the harness browser. Click to show it in a frame (works for your own served pages)'}" aria-label="Frame or harness browser"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg></button>` : ''}${downloadsHTML()}`;
  for (const b of bar.querySelectorAll('.bv-nav')) b.onclick = () => (REAL ? window.ohDesktop.nav(t.sid, b.dataset.op) : ubCall(b.dataset.op));
  const dv = $('.bv-dev', bar); if (dv) dv.onclick = () => window.ohDesktop.nav(t.sid, 'devtools');
  const cmb = $('.bv-cmt', bar); if (cmb) cmb.onclick = () => { t.commenting = !t.commenting; renderPane(); };
  const exb = $('.bv-exp', bar); if (exb) exb.onclick = () => exportMenu(exb, c, t);
  const gv = $('.bv-give', bar); if (gv) gv.onclick = () => lendTab(c, t.sid);
  const tb = $('.bv-takeback', bar); if (tb) tb.onclick = () => takeBackTab(lentChatOf(t.sid));
  const ex = $('.bv-ext', bar); if (ex) ex.onclick = () => window.ohDesktop.openExternal(t.url);
  wireDownloads(bar);
  const mb = $('.bv-mode', bar); if (mb) mb.onclick = () => { t.mode = t.mode === 'frame' ? 'remote' : 'frame'; t.opened = null; renderPane(); };
  body.innerHTML = `<div class="bwin"><div class="btabs" role="tablist" aria-label="Browser tabs">${list.map((x) => `<span class="btab ${x.sid === t?.sid ? 'on' : ''} ${x.agent ? 'agent' : ''} ${!x.agent && lentChatOf(x.sid) ? 'lent' : ''}" data-sid="${esc(x.sid)}" role="tab" ${x.agent ? '' : 'draggable="true" '}title="${esc(x.url || 'New tab')}">${x.agent ? `<i class="bt-dot ${x.locked ? 'live' : ''}"></i>🤖` : '🌐'}<span class="bt-title">${esc(x.agent ? (x.title || 'Agent') : (x.title || (x.url ? x.url.replace(/^https?:\/\//, '').slice(0, 24) : 'New tab')))}</span><button type="button" class="bt-x" data-close="${esc(x.sid)}" title="Close this tab" aria-label="Close tab">×</button></span>`).join('')}<button type="button" class="btab-new" title="New tab">＋</button></div><div class="bstage"></div></div>`;
  for (const el of body.querySelectorAll('.btab')) el.onclick = (e) => { if (e.target.closest('.bt-x')) return; G.bActive = el.dataset.sid; renderPane(); };
  for (const el of body.querySelectorAll('.btab[draggable="true"]')) el.ondragstart = (e) => { e.dataTransfer.setData('application/x-quorx-tab', el.dataset.sid); e.dataTransfer.effectAllowed = 'link'; };
  // Right-click one of your tabs: give it to this chat's agent (or take it back), or close it.
  for (const el of body.querySelectorAll('.btab[draggable="true"]')) el.oncontextmenu = (e) => {
    const sid = el.dataset.sid, to = lentChatOf(sid);
    popMenu(e, [to ? ['↩ Take back from the agent', () => takeBackTab(to)] : ['🤖 Give to agent in this chat', () => lendTab(c, sid)], ['✕ Close tab', () => closeBTab(c, sid)]]);
  };
  for (const b of body.querySelectorAll('.bt-x')) b.onclick = () => closeBTab(c, b.dataset.close);
  $('.btab-new', body).onclick = () => { newBTab(''); renderPane(); $('#paneUrl').focus(); };
  const stage = $('.bstage', body);
  if (!t || !t.url) return newTabPage(c, stage);
  if (t.commenting) return commentStage(c, t, stage);
  if (DESK && t.agent && t.desktop) { t.opened = t.url; return deskStage(t, stage); } // the agent's real tab: shown as it is, never reloaded
  if (DESK && !t.agent) return deskStage(t, stage);
  if (!t.agent && (t.mode || (t.mode = sameSite(t.url) ? 'frame' : 'remote')) === 'frame') {
    const f = document.createElement('iframe'); f.title = t.url; f.src = t.url; stage.appendChild(f);
    return;
  }
  stage.innerHTML = `<div class="ubview ${live ? 'locked' : ''}" tabindex="0"><img class="ub-shot" alt="The page"><textarea class="ub-keys" aria-label="Type into the page" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>${live ? '<div class="ub-lock">🤖 The agent is using this page. You can watch; it is yours when the reply ends.</div>' : ''}<div class="ub-status">${t.shot ? '' : 'Opening…'}</div></div>`;
  const img = $('.ub-shot', stage); if (t.shot) img.src = t.shot;
  wireUbView(t);
  if (!t.agent && t.opened !== t.url) { t.opened = t.url; ubCall('open', { url: t.url }); } else ubCall('look');
}
// A new tab: quick links to what this chat built and the project's running servers.
async function newTabPage(c, stage) {
  const arts = Object.values(c.agent.artifacts).filter((a) => ['html', 'md', 'site', 'app'].includes(a.kind));
  const srv = await getJ(`/api/servers?project=${encodeURIComponent(c.projectId)}`);
  const links = [...arts.map((a) => ({ label: `${ICON[a.kind] || '📄'} ${a.title}`, url: absUrl(artifactUrl(c, a)) })),
    ...(Array.isArray(srv) ? srv.filter((x) => x.status === 'running' && !arts.some((a) => a.url === x.url)).map((x) => ({ label: `🖥 ${x.name}`, url: x.url })) : [])].filter((x) => x.url);
  if (!stage.isConnected) return;
  stage.innerHTML = `<div class="bnew"><p class="dim">Type an address or words to search in the bar above, and press Enter${links.length ? ', or open something from this chat:' : '.'}</p>${links.length ? `<div class="bnew-links">${links.map((l, i) => `<button type="button" class="bnew-link" data-i="${i}"><b>${esc(l.label)}</b><code>${esc(l.url)}</code></button>`).join('')}</div>` : ''}</div>`;
  for (const b of stage.querySelectorAll('.bnew-link')) b.onclick = () => browserGo(links[Number(b.dataset.i)].url);
}
// The address bar: an address opens; anything else (how to make cake) is searched with the engine you picked in
// ⚙ Settings → Privacy & display. Starting with ? always searches.
const SEARCH_ENGINES = { google: ['Google', 'https://www.google.com/search?q=%s'], duckduckgo: ['DuckDuckGo', 'https://duckduckgo.com/?q=%s'], bing: ['Bing', 'https://www.bing.com/search?q=%s'], brave: ['Brave', 'https://search.brave.com/search?q=%s'], startpage: ['Startpage', 'https://www.startpage.com/do/search?query=%s'] };
function searchUrl(q) {
  const ui = G.settings.ui || {}, custom = String(ui.searchCustom || '').trim();
  const tpl = ui.searchEngine === 'custom' && /^https?:\/\/\S*%s/i.test(custom) ? custom : (SEARCH_ENGINES[ui.searchEngine] || SEARCH_ENGINES.google)[1];
  return tpl.replace('%s', encodeURIComponent(q));
}
// What was typed as an address (example.com, localhost:3000, 192.168.1.5/x, https://…), or null for words to search.
function addressOf(v) {
  if (/^https?:\/\//i.test(v)) return v;
  if (/\s/.test(v)) return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(v) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(v)) return `http://${v}`;
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(v)) return `https://${v}`;
  return null;
}
function typedToUrl(v) {
  if (v.startsWith('?')) return searchUrl(v.slice(1).trim());
  if (v.startsWith('/')) return location.origin + v;
  return addressOf(v) || searchUrl(v);
}
function browserGo(url) {
  const c = focused(); if (!c) return;
  let t = activeBTab(c);
  if (!t || t.agent) t = newBTab(url);
  Object.assign(t, { url, title: '', mode: null, opened: null, shot: null });
  G.bActive = t.sid;
  G.view = { id: G.view.id, src: false, files: false, browser: true };
  c.paneHidden = false; syncLayout(); renderPane();
}
// ---------- links in content: Ctrl+click (Cmd+click on a Mac) opens them in the Browser tab ----------
// Chat messages, Steps, News, documents in the pane, artifact pages and the terminal. A plain click does nothing (text
// selection works as usual). Only web addresses open, in a new tab of the pane's Browser, never in the system browser
// or a new window. QuorX's own pages never open inside its Browser tab, as the agent's browser can't open them either.
function quorxPage(u) {
  let x; try { x = new URL(String(u || '')); } catch { return false; }
  const port = (p, proto) => Number(p || (proto === 'https:' ? 443 : 80));
  if (!/^https?:$/.test(x.protocol) || port(x.port, x.protocol) !== port(location.port, location.protocol)) return false;
  const host = (h) => h.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const h = host(x.hostname);
  const self = h === host(location.hostname) || h === 'localhost' || h.endsWith('.localhost') || /^(127\.|0\.0\.0\.0$)/.test(h) || h === '::1' || h === '::' || /^::ffff:(127\.|7f)/.test(h);
  return self && !/^\/(ws|art|preview|blob)\//.test(x.pathname); // its own work served by QuorX is fine
}
async function openLink(url, from) {
  let u; try { u = new URL(String(url || ''), location.href); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  const say = (text) => { if (from?.isConnected && from.getClientRects().length) flashTip(from, text, 2400); };
  if (quorxPage(u.href)) return say("QuorX's own pages don't open in its Browser tab");
  // The Browser tab is in a chat's side pane: News closes, and with no chat open the latest one opens.
  if (NEWS.open) closeNews();
  let c = focused();
  if (!c) { const last = [...G.chats].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0]; if (last) { await showChat(last.id); c = focused(); } }
  if (!c) return say('Open a chat first: links open in its Browser tab');
  // A new tab, or the empty tab you're on.
  const cur = G.view.browser ? activeBTab(c) : null;
  const t = cur && !cur.agent && !cur.url ? cur : newBTab(u.href);
  Object.assign(t, { url: u.href, title: '', mode: null, opened: null, shot: null });
  G.bActive = t.sid;
  G.view = { id: G.view.id, src: false, files: false, browser: true };
  c.paneHidden = false; syncLayout(); renderPane(); toPreview();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-cl]');
  if (!a) return;
  e.preventDefault();
  if ((e.ctrlKey || e.metaKey) && e.button === 0) openLink(a.getAttribute('href'), a);
}, true);
// A middle click would open a new window: nothing, like a plain click.
document.addEventListener('auxclick', (e) => { if (e.target.closest?.('a[data-cl]')) e.preventDefault(); }, true);
// The hand shows on a link only while Ctrl (Cmd) is held, since only then a click opens it.
const linkModKey = (e) => document.body.classList.toggle('link-mod', !!(e.ctrlKey || e.metaKey));
document.addEventListener('keydown', linkModKey, true);
document.addEventListener('keyup', linkModKey, true);
window.addEventListener('blur', () => document.body.classList.remove('link-mod'));
// Artifact pages (in frames) send their Ctrl+clicked links here (see server/artifacts.js); only from a frame of this page.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.quorx !== 'open-link' || typeof d.url !== 'string') return;
  const f = [...document.querySelectorAll('iframe')].find((x) => x.contentWindow === e.source);
  if (f) openLink(d.url, f);
});
// The terminal: web addresses in its output (and OSC 8 links) open the same way, with the same tip at the pointer.
function termTip(ev, text) {
  let a = $('.xt-tip-at');
  if (!text) { if (TIP.target === a) hideTip(); a?.remove(); return; }
  if (!a) { a = document.createElement('span'); a.className = 'xt-tip-at'; document.body.appendChild(a); }
  a.style.left = `${ev.clientX}px`; a.style.top = `${ev.clientY}px`;
  clearTimeout(TIP.timer);
  TIP.target = a;
  TIP.timer = setTimeout(() => TIP.target === a && showTip(a, text), 450);
}
const termLink = {
  activate: (ev, url) => { if (ev.ctrlKey || ev.metaKey) openLink(url); },
  hover: (ev, url) => termTip(ev, `${LINK_TIP}\n${url}`),
  leave: () => termTip(null),
  allowNonHttpProtocols: false,
};
function termLinks(term) {
  const RX = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1);
      const text = line ? line.translateToString(true) : '';
      const links = [...text.matchAll(RX)].map((m) => ({ text: m[0], range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } }, decorations: { pointerCursor: false, underline: true }, ...termLink }));
      cb(links.length ? links : undefined);
    },
  });
}
// ---------- 🤖 Give to agent: lend one of your Browser tabs to a chat ----------
// Drag a tab onto a chat, or press 🤖 Give to agent in the tab's bar. The agent can then work in that one tab (with
// your sign-in on that site) in that chat; it is covered while the agent uses it, and Take back ends it at once.
const lentChatOf = (sid) => Object.keys(G.lent ||= {}).find((id) => G.lent[id]?.sid === sid);
async function lendTab(c, sid) {
  const t = (G.btabs || []).find((x) => x.sid === sid);
  if (!t) return;
  if (!t.url) return uiAlert('Open a page in this tab first, then give it to the agent.');
  // A page shown in a frame has no browser tab of its own behind it: it moves to "your view" first.
  if (!DESK && t.mode === 'frame') { t.mode = 'remote'; t.opened = null; if (G.view.browser) renderPane(); await postJ('/api/ubrowser', { sid: t.sid, op: 'open', url: t.url }).catch(() => {}); }
  const r = await postJ('/api/given-tab', { chatId: c.id, sid, url: t.url, title: t.title || '', desktop: DESK });
  if (r.error) return uiAlert(`Could not give the tab: ${r.error}`);
  G.lent ||= {};
  for (const id of Object.keys(G.lent)) if (G.lent[id]?.sid === sid) { delete G.lent[id]; const o = G.open.get(id); if (o) renderAttachments(o); }
  G.lent[c.id] = { sid, url: t.url, title: t.title || '' };
  renderAttachments(c);
  if (G.view.browser) renderPane();
}
async function takeBackTab(chatId) {
  await fetch(`/api/given-tab?chat=${encodeURIComponent(chatId)}`, { method: 'DELETE' }).catch(() => {});
  delete (G.lent ||= {})[chatId];
  const c = G.open.get(chatId); if (c) renderAttachments(c);
  if (G.view.browser) renderPane();
}
// The harness forgets lent tabs when it restarts: the chip goes when the harness no longer has it.
async function syncLent(c) {
  if (!c?.el) return;
  const r = await getJ(`/api/given-tab?chat=${encodeURIComponent(c.id)}`);
  if (!r || r.error) return;
  const had = (G.lent ||= {})[c.id];
  if (!r.given && had) { delete G.lent[c.id]; renderAttachments(c); }
  // A tab given from Chrome (the QuorX extension) appears here on its own.
  else if (r.given && had?.sid !== r.given.sid) { G.lent[c.id] = { sid: r.given.sid, url: r.given.url, title: r.given.title, chrome: r.given.ext != null }; renderAttachments(c); }
}
// Closing a tab that shows one of your running servers asks first: keep the server running (reopen the address any
// time) or stop it too.
async function closeBTab(c, sid) {
  const url = sid.startsWith('agent-') ? G.agentTab?.[c.id]?.url : (G.btabs || []).find((x) => x.sid === sid)?.url;
  let u = null; try { u = url && new URL(url); } catch { /* not an address */ }
  if (u && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
    const all = await getJ('/api/servers');
    const sv = (Array.isArray(all) ? all : []).find((x) => x.status !== 'stopped' && x.url && (() => { try { return new URL(x.url).port === u.port; } catch { return false; } })());
    if (sv) {
      const where = `${u.hostname}:${u.port}`;
      const ans = await uiConfirm(`Close ${where}?\n“${sv.name}” is still running. You can keep it running and reopen this tab any time by entering ${where} in the address bar.`, { ok: 'Keep running', alt: 'Stop server', altDanger: true, danger: false });
      if (!ans) return;
      if (ans === 'alt') { await postJ('/api/servers/stop', { key: sv.key }); pollDev(); }
    }
  }
  const lentTo = lentChatOf(sid); if (lentTo) takeBackTab(lentTo);
  if (sid.startsWith('agent-')) { delete G.agentTab[c.id]; } else { G.btabs = (G.btabs || []).filter((x) => x.sid !== sid); if (DESK) window.ohDesktop.close(sid); }
  postJ('/api/ubrowser', { sid, op: 'close' }).catch(() => {});
  if (G.bActive === sid) G.bActive = null;
  renderPane();
}
// Is there an agent page for this chat, and is the agent still on it? (Checked while the Browser tab shows.)
async function refreshAgentTab(c) {
  const r = await postJ('/api/ubrowser', { sid: `agent-${c.id}`, op: 'peek' });
  G.agentTab ||= {};
  const had = G.agentTab[c.id], was = had && { locked: had.locked, desktop: had.desktop };
  if (r.none || r.error) { if (had) { delete G.agentTab[c.id]; return true; } return false; }
  G.agentTab[c.id] = Object.assign(had || {}, { url: r.url, title: r.title, locked: r.locked, w: r.w, h: r.h, desktop: r.desktop });
  return !had || was.locked !== r.locked || was.desktop !== r.desktop;
}

// Terminal tab: everything running in the background, in this project and elsewhere, with ■ Stop.
async function drawRunning(c, r) {
  const box = $('#termRunning'); if (!box || !r || r.error) return;
  const all = await getJ('/api/servers');
  if (!box.isConnected) return;
  const here = (r.servers || []).filter((s) => s.status !== 'stopped'), jobs = r.jobs || [];
  const elsewhere = (Array.isArray(all) ? all : []).filter((s) => s.projectId !== c.projectId && s.status !== 'stopped');
  const pname = (id) => G.projects.find((p) => p.id === id)?.name || id;
  const chips = [
    ...here.map((s) => `<span class="tr-chip srv" data-filter="${esc(s.name)}" title="${esc([s.command, ...(s.args || [])].join(' '))}"><i class="tr-dot ${s.status === 'running' ? 'ok' : 'busy'}"></i>🖥 ${esc(s.name)}${s.url ? ` <code>:${esc(String(s.url).match(/:(\d+)/)?.[1] || '')}</code>` : ''}<button type="button" data-stop-key="${esc(s.key)}" title="Stop ${esc(s.name)}">■</button></span>`),
    ...jobs.map((j) => `<span class="tr-chip job" title="${esc(j.label)}"><i class="tr-dot busy"></i>${j.source === 'agent' ? '🤖' : '👤'} ${esc(clip(j.label, 34))}<button type="button" data-stop-job="${esc(j.job)}" title="Stop it">■</button></span>`),
  ];
  box.innerHTML = `<span class="tr-label">Running</span>${chips.join('') || '<span class="dim">nothing in the background</span>'}${elsewhere.length ? `<span class="tr-else" title="${esc(elsewhere.map((s) => `${pname(s.projectId)} › ${s.name} ${s.url || ''}`).join('\n'))}">+ ${elsewhere.length} in other project${elsewhere.length > 1 ? 's' : ''}: ${elsewhere.map((s) => `${esc(pname(s.projectId))} › ${esc(s.name)}<button type="button" data-stop-key="${esc(s.key)}" title="Stop it">■</button>`).join(' · ')}</span>` : ''}`;
  for (const b of box.querySelectorAll('[data-stop-key]')) b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; await postJ('/api/servers/stop', { key: b.dataset.stopKey }); pollDev(); };
  for (const b of box.querySelectorAll('[data-stop-job]')) b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; await postJ('/api/term/stop', { job: b.dataset.stopJob }); pollDev(); };
  for (const ch of box.querySelectorAll('[data-filter]')) ch.onclick = () => { const t = G.term; if (!t) return; t.filter = `srv:${ch.dataset.filter}`; renderTermInput(t); termDraw(t, true); };
}

// ---------- the Running tab: everything running in the project, each with a Stop ----------
// The agent keeps going while its long commands, servers and terminals run; this is where you see them all and end
// what you don't want. It refreshes with the pane's 3-second poll. Stopping something the agent started while its
// reply still works tells the agent before its next step.
const RUN_GROUPS = [
  ['background', 'In the background', 'Commands that went on running after the agent moved on'],
  ['command', 'Running now', 'Commands the agent or you are waiting on'],
  ['agent-term', 'The agent’s terminals', 'Programs the agent drives with keys (prompts, menus, REPLs)'],
  ['server', 'Servers', 'Dev servers and apps on a port'],
  ['your-term', 'Your terminal tabs', 'Open shells in the Terminal tab'],
];
const RUN_KIND = { background: 'Background', command: 'Command', 'agent-term': 'Agent terminal', server: 'Server', 'your-term': 'Your terminal' };
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
async function refreshRunning(c) {
  const r = await getJ(`/api/running?project=${encodeURIComponent(c.projectId)}`);
  if (r && !r.error) (G.runCount ||= {})[c.projectId] = { n: r.items.filter((x) => x.kind !== 'your-term').length };
  renderPaneTabs(c);
  drawRunningPane(c, r);
}
function runRowHTML(c, x) {
  const chat = x.chatId && G.chats.find((h) => h.id === x.chatId);
  const who = x.source === 'agent' ? `<span class="run-who agent">🤖 agent</span>` : x.source === 'you' ? '<span class="run-who you">👤 you</span>' : '';
  const from = chat ? `<button type="button" class="run-chat linkish" data-chat="${esc(chat.id)}" title="Open the chat that started it">${esc(clip(chat.title || 'a chat', 34))}</button>` : '';
  const port = x.url ? `<a class="run-url" href="${esc(x.url)}" target="_blank" rel="noopener" title="Open ${esc(x.url)}">:${esc(String(x.url).match(/:(\d+)/)?.[1] || '')}</a>` : '';
  const tag = `<span class="run-kind" data-kind="${esc(x.kind)}">${esc(RUN_KIND[x.kind] || x.kind)}${x.bg ? ` · ${esc(x.bg)}` : ''}</span>`;
  const label = x.kind === 'your-term' ? (G.term?.terms?.find((u) => u.id === x.tab)?.name || `Terminal ${String(x.tab || '').replace(/^u/, '')}`) + ` · ${x.label}` : x.label;
  const acts = [
    x.kind === 'server' && x.url ? `<button type="button" class="run-open" title="Open it in the pane's browser">Open</button>` : '',
    x.kind !== 'agent-term' ? `<button type="button" class="run-out" title="Show its output in the Terminal tab">Output</button>` : '',
    `<button type="button" class="run-stop danger" title="${x.kind === 'your-term' ? 'Close this terminal tab' : 'Stop it, and everything it started'}">${x.kind === 'your-term' ? '✕ Close' : '■ Stop'}</button>`,
  ].join('');
  return `<div class="run-row" data-id="${esc(x.id)}" data-kind="${esc(x.kind)}">
    <div class="run-top"><i class="tr-dot ${x.status === 'starting' ? 'busy' : 'ok'}"></i>${tag}<code class="run-cmd" title="${esc(x.detail || x.label)}">${esc(label)}</code></div>
    <div class="run-meta">${[who, from, x.started ? `<span class="run-time" title="Started ${esc(new Date(x.started).toLocaleString())}">${x.kind === 'your-term' ? 'open' : 'running'} ${dur(Date.now() - x.started)}</span>` : '', port].filter(Boolean).join('<span class="run-sep">·</span>')}</div>
    ${x.tail?.length ? `<pre class="run-tail">${esc(x.tail.join('\n'))}</pre>` : ''}
    <div class="run-acts">${acts}</div>
  </div>`;
}
function drawRunningPane(c, r) {
  const box = $('#runPane'); if (!box || !r) return;
  if (r.error) { box.innerHTML = `<div class="run-empty bad">Could not list what runs: ${esc(r.error)}</div>`; return; }
  const items = r.items || [];
  const sa = $('#appBar .run-stopall'); if (sa) sa.disabled = !items.some((x) => x.kind !== 'your-term');
  const groups = RUN_GROUPS.map(([k, title, hint]) => { const rows = items.filter((x) => x.kind === k); return rows.length ? `<section class="run-group" data-kind="${k}"><h4>${esc(title)} <span class="run-n">${rows.length}</span><small>${esc(hint)}</small></h4>${rows.map((x) => runRowHTML(c, x)).join('')}</section>` : ''; }).join('');
  const pname = (id) => G.projects.find((p) => p.id === id)?.name || id;
  const elsewhere = (r.elsewhere || []).length ? `<div class="run-else">Also running in other projects: ${r.elsewhere.map((e) => `<b>${esc(pname(e.projectId))}</b> (${e.count})`).join(', ')}</div>` : '';
  const html = (groups || `<div class="run-empty"><b>Nothing is running in this project.</b><br>Long commands the agent starts keep running here in the background while it carries on; servers, the agent’s terminals and your terminal tabs show here too, each with a Stop.</div>`) + elsewhere;
  // Rows are rebuilt only when what runs changes. Output and times update in place, so a Stop click never lands on a
  // button that a redraw has just replaced (output changes every second or two).
  const sig = JSON.stringify(items.map((x) => [x.id, x.status, x.chatId, !!x.tail?.length])) + elsewhere;
  if (box.dataset.sig === sig) {
    for (const x of items) {
      const row = box.querySelector(`.run-row[data-id="${CSS.escape(x.id)}"]`); if (!row) continue;
      const t = $('.run-time', row); if (t && x.started) t.textContent = `${x.kind === 'your-term' ? 'open' : 'running'} ${dur(Date.now() - x.started)}`;
      const pre = $('.run-tail', row), text = (x.tail || []).join('\n'); if (pre && pre.textContent !== text) pre.textContent = text;
    }
    return;
  }
  box.dataset.sig = sig;
  box.innerHTML = html;
  for (const row of box.querySelectorAll('.run-row')) {
    const x = items.find((i) => i.id === row.dataset.id); if (!x) continue;
    const stopBtn = $('.run-stop', row);
    if ((G.runStopping ||= new Set()).has(x.id)) { stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'; }
    stopBtn.onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Stopping…';
      G.runStopping.add(x.id);
      const res = await postJ('/api/running/stop', { projectId: c.projectId, id: x.id }).finally(() => G.runStopping.delete(x.id));
      if (res.error) uiAlert(res.error);
      else if (res.left) uiAlert(`${res.left} process${res.left > 1 ? 'es' : ''} did not stop: ${(res.names || []).join(', ')}`);
      if (x.kind === 'your-term' && G.term?.projectId === c.projectId) { dropXterm?.(c.projectId, x.tab, true); G.term.terms = G.term.terms.filter((u) => u.id !== x.tab); }
      refreshRunning(c); pollDev();
    };
    const out = $('.run-out', row);
    if (out) out.onclick = () => openTerminal(c, x.kind === 'server' ? x.label : x.tab || (x.source === 'agent' ? 'agent' : 'all'));
    const op = $('.run-open', row); if (op) op.onclick = () => showServerInPane(c, { url: x.url });
    const ch = $('.run-chat', row); if (ch) ch.onclick = () => showChat(ch.dataset.chat);
  }
}

// ---------- ↩ rewind to one of your messages, ⑂ remix a reply into a new chat ----------
// Rewind removes your message and everything after it from the chat and puts the message back in the
// box. You choose: keep the files as they are (only the conversation goes back), or also undo the file
// changes of those replies, newest first (with the usual warning when a file changed again since).
async function rewindTo(c, m) {
  if (c.running) return uiAlert('This chat is still working. Stop it first.');
  const msgs = c.agent.messages, i = msgs.indexOf(m);
  if (i < 0) return;
  const later = msgs.slice(i);
  const changed = later.filter((x) => x.role === 'assistant' && x.stats?.changed?.length && !x.undone);
  await refreshUndoable(c.projectId);
  const gone = changed.filter((x) => undoGone(c, x)), undoable = changed.filter((x) => !undoGone(c, x));
  const files = [...new Set(undoable.flatMap((x) => x.stats.changed))];
  const choice = await rewindDialog(later.length, files, gone);
  if (!choice) return;
  const problems = [];
  if (choice === 'files') {
    for (const x of [...undoable].reverse()) {
      const runId = x.stats.undoId || x.runId;
      let r = await postJ('/api/checkpoints/restore', { projectId: c.projectId, runId });
      if (r.conflicts?.length && !r.restored) {
        const mode = await undoChoice(x.stats.changed, r.conflicts);
        if (!mode) { problems.push(`stopped before undoing the reply at ${stamp(x.doneAt || x.at)}; nothing after that was rewound`); return finish(true); }
        r = await postJ('/api/checkpoints/restore', { projectId: c.projectId, runId, mode });
      }
      if (r.error) problems.push(`${stamp(x.doneAt || x.at)}: ${r.error}`); else x.undone = true;
    }
    // Pages and documents that only those replies made go too (edited older ones stay as they are now).
    const kept = new Set(msgs.slice(0, i).flatMap((x) => (x.arts || []).map((a) => a.id)));
    for (const x of later) for (const a of x.arts || []) if (!kept.has(a.id)) delete c.agent.artifacts[a.id];
  }
  return finish(false);
  async function finish(stopped) {
    if (stopped) { uiAlert(`Rewind stopped: ${problems.join('; ')}.`); refreshUndoable(c.projectId); return; }
    c.agent.messages = msgs.slice(0, i);
    if (c.agent.summaryAt && c.agent.summaryAt >= (m.at || 0)) { c.agent.summary = ''; c.agent.summaryAt = 0; }
    // An emptied chat is still saved, so a reload doesn't bring the old conversation back.
    if (c.agent.messages.length) await saveChat(c, true);
    else await fetch(`/api/chats/${c.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chatDoc(c)) }).catch(() => {});
    G.view = { id: null, src: false, files: false }; G.traceRun = null;
    renderPanes(); refreshSidebar(); refreshUndoable(c.projectId);
    // Your message goes back in the box, with its attached files, to edit and send again.
    const ta = c.el && $('.input', c.el.root);
    if (ta) { ta.value = m.content || ''; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    if (m.docs?.length) { c.docs = m.docs.map((d) => ({ ...d, busy: null })); renderAttachments(c); }
    if (problems.length) uiAlert(`Rewound, but some file changes could not be undone:\n${problems.join('\n')}`);
  }
}
function rewindDialog(count, files, gone) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'pf-dialog';
    dlg.innerHTML = `<form class="pf" method="dialog">
      <h3>Rewind to this message?</h3>
      <p class="pf-hint">This message and the ${count - 1} after it leave the chat, and your message goes back in the box so you can change it and send it again.</p>
      ${files.length ? `<p class="pf-hint">The replies after it changed ${files.length} file${files.length > 1 ? 's' : ''}:</p><ul class="undo-list">${files.slice(0, 30).map((f) => `<li><code>${esc(f)}</code></li>`).join('')}${files.length > 30 ? `<li>… and ${files.length - 30} more</li>` : ''}</ul>` : '<p class="pf-hint">Those replies changed no files.</p>'}
      ${gone.length ? `<p class="pf-warn">⚠ ${gone.length} of those replies can no longer be undone (their undo history was cleared), so their file changes stay either way.</p>` : ''}
      <div class="pf-acts undo-acts">
        <button type="button" data-v="">Cancel</button>
        <button type="button" data-v="context" class="${files.length ? '' : 'pf-save'}" title="Only the conversation goes back; the files stay as they are now">${files.length ? 'Rewind, keep the files' : 'Rewind'}</button>
        ${files.length ? '<button type="button" data-v="files" class="danger" title="Also put back every file those replies changed (files they created go to the agent\'s trash)">Rewind and undo the file changes</button>' : ''}
      </div></form>`;
    document.body.appendChild(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v || null); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    for (const b of dlg.querySelectorAll('[data-v]')) b.onclick = () => done(b.dataset.v);
    dlg.showModal();
  });
}
// Remix: a new chat in the same project that starts with this conversation up to (and with) this reply.
// Files are not touched, and the copied replies have no Undo, so the new chat can't change the old work by accident.
function remixFrom(c, m) {
  const i = c.agent.messages.indexOf(m);
  if (i < 0) return;
  const copy = JSON.parse(JSON.stringify(c.agent.messages.slice(0, i + 1).filter((x) => x.role === 'user' || x.role === 'assistant'), (k, v) => (k === 'el' || (typeof Node !== 'undefined' && v instanceof Node) ? undefined : v)));
  for (const x of copy) { if (x.stats) delete x.stats.changed; x.live = false; x.runActive = false; x.resumable = false; }
  const n = blankChat(c.projectId);
  n.title = `Remix: ${c.title}`.slice(0, 60);
  n.approval = c.approval;
  n.tools = JSON.parse(JSON.stringify(c.tools || {}));
  n.agent.setup = JSON.parse(JSON.stringify(c.agent.setup));
  n.agent.messages = copy;
  n.agent.artifacts = JSON.parse(JSON.stringify(c.agent.artifacts || {}));
  if (c.agent.summary && (!c.agent.summaryAt || c.agent.summaryAt <= (m.doneAt || m.at || Date.now()))) { n.agent.summary = c.agent.summary; n.agent.summaryAt = c.agent.summaryAt; }
  n.remixOf = { chatId: c.id, title: c.title, at: m.doneAt || m.at };
  G.open.set(n.id, n); G.panes = [n.id]; G.focus = 0;
  G.view = { id: null, src: false, files: false }; G.traceRun = null;
  renderPanes(); saveChat(n, true); savePrefs(); renderSidebar();
  $('.input', n.el.root)?.focus();
}

// ---------- pages in the harness's browser (see server/userbrowser.js) ----------
const sameSite = (u) => { try { const x = new URL(u); return x.origin === location.origin || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname); } catch { return false; } };
// 💬 Comment mode: a live picture of the page (the tab's own one, or a copy of its page for frames and real tabs).
// A click shows what is under it; a note turns it into a chip for the next message.
async function commentStage(c, t, stage) {
  const sid = t.agent || (!DESK && t.mode !== 'frame') ? t.sid : `cmt-${t.sid}`.slice(0, 60);
  stage.innerHTML = `<div class="cmtview" tabindex="0"><img class="ub-shot" alt="The page to comment on"><div class="cmt-hl" hidden></div><div class="cmt-tip">💬 Click the part you want changed. Scroll to move around the page.</div><div class="cmt-pop" hidden></div></div>`;
  const v = $('.cmtview', stage), img = $('.ub-shot', v), hl = $('.cmt-hl', v), pop = $('.cmt-pop', v);
  const size = () => { const r = stage.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  let view = { w: 1280, h: 800 };
  const show = (res) => { if (res?.shot) { img.src = res.shot; view = { w: res.w || view.w, h: res.h || view.h }; } };
  const first = await postJ('/api/ubrowser', { sid, op: sid === t.sid ? 'look' : 'open', url: t.url, ...size() });
  if (first.error) { $('.cmt-tip', v).textContent = `⚠ ${first.error}`; return; }
  show(first);
  let dy = 0, dyT = null;
  v.addEventListener('wheel', (e) => { e.preventDefault(); dy += e.deltaY; clearTimeout(dyT); dyT = setTimeout(async () => { const d = dy; dy = 0; hl.hidden = true; pop.hidden = true; await postJ('/api/ubrowser', { sid, op: 'scroll', dy: Math.round(d), ...size() }).catch(() => {}); show(await postJ('/api/ubrowser', { sid, op: 'look', ...size() })); }, 160); }, { passive: false });
  img.onclick = async (e) => {
    const sx = img.clientWidth / view.w, sy = img.clientHeight / view.h;
    const res = await postJ('/api/ubrowser', { sid, op: 'inspect', x: e.offsetX / sx, y: e.offsetY / sy, ...size() });
    if (res.error || !res.hit) { $('.cmt-tip', v).textContent = res.error ? `⚠ ${res.error}` : 'Nothing there to comment on. Try another spot.'; return; }
    const h = res.hit, box = { left: h.rect.x * sx, top: h.rect.y * sy, width: h.rect.w * sx, height: h.rect.h * sy };
    Object.assign(hl.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }); hl.hidden = false;
    pop.innerHTML = `<div class="cp-what">${res.crop ? `<img src="${res.crop}" alt="">` : ''}<div><b>${esc(h.tag)}</b> ${esc(clip(h.text || '(no text)', 60))}<div class="cp-sel" title="How the agent will find it">${esc(clip(h.selector, 70))}</div></div></div>
      <textarea class="cp-note" rows="3" placeholder="What should change here? (optional)" aria-label="What should change here"></textarea>
      <div class="cp-acts"><button type="button" class="kx-btn primary sm cp-add">Add to message</button><button type="button" class="kx-btn sm cp-cancel">Cancel</button></div>`;
    pop.hidden = false;
    const below = box.top + box.height + 8, room = v.clientHeight - below;
    Object.assign(pop.style, { left: `${Math.max(8, Math.min(box.left, v.clientWidth - 300))}px`, top: `${room > 180 ? below : Math.max(8, box.top - 190)}px` });
    const note = $('.cp-note', pop); note.focus();
    const add = () => {
      (c.comments ||= []).push({ ...h, note: note.value.trim(), crop: res.crop });
      renderAttachments(c);
      pop.hidden = true; hl.hidden = true;
      $('.cmt-tip', v).textContent = `💬 ${c.comments.length} comment${c.comments.length > 1 ? 's' : ''} in your message box. Add more, or write your message and send it.`;
    };
    $('.cp-add', pop).onclick = add;
    note.onkeydown = (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); add(); } if (ev.key === 'Escape') { pop.hidden = true; hl.hidden = true; } };
    $('.cp-cancel', pop).onclick = () => { pop.hidden = true; hl.hidden = true; };
  };
}
// ⤓ Export: the page as a PDF or one long PNG, or the project's files as a ZIP (without .quorx, node_modules or .git).
function exportMenu(btn, c, t) {
  document.querySelector('.exp-menu')?.remove();
  const p = G.projects.find((x) => x.id === c.projectId);
  const m = document.createElement('div'); m.className = 'exp-menu'; m.setAttribute('role', 'menu');
  m.innerHTML = `<button type="button" role="menuitem" data-f="pdf">📄 PDF of this page</button><button type="button" role="menuitem" data-f="png">🖼 PNG of the whole page</button>${p && !p.missing && !p.needsFolder ? `<button type="button" role="menuitem" data-f="zip">🗜 ZIP of ${esc(p.name)}'s files</button>` : ''}<div class="exp-status" hidden></div>`;
  document.body.appendChild(m);
  { const r = btn.getBoundingClientRect(); m.style.top = `${r.bottom + 6}px`; m.style.left = `${Math.max(8, Math.min(r.right - 240, innerWidth - 248))}px`; }
  const close = (e) => { if (!m.contains(e.target) && e.target !== btn) { m.remove(); document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true));
  for (const b of m.querySelectorAll('[data-f]')) b.onclick = async () => {
    const st = $('.exp-status', m); st.hidden = false; st.textContent = 'Making it…';
    m.querySelectorAll('button').forEach((x) => (x.disabled = true));
    try {
      const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: b.dataset.f, url: t.url, projectId: c.projectId, width: t.w || 1280 }) });
      if ((r.headers.get('content-type') || '').includes('json')) throw new Error((await r.json()).error || 'export failed');
      const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `export.${b.dataset.f}`;
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60e3);
      st.textContent = `Saved ${name}${r.headers.get('x-skipped') ? ` (${r.headers.get('x-skipped')} big files left out)` : ''}`;
      setTimeout(() => m.remove(), 2500);
    } catch (e) { st.textContent = `⚠ ${e.message}`; m.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
  };
}
function ubStatus(t) { const el = $('#paneBody .ub-status'); if (el) { el.textContent = t; el.hidden = !t; } }
async function ubCall(op, a = {}) {
  const c = focused(), t = c && activeBTab(c);
  if (!t || !$('#paneBody .ubview')) return;
  const r = $('#paneBody .bstage').getBoundingClientRect(); // the page is sized to the pane
  t.busy = (t.busy || 0) + 1;
  if (op !== 'look') ubStatus(op === 'open' ? 'Opening…' : '…');
  const res = await postJ('/api/ubrowser', { sid: t.sid, op, w: Math.round(r.width), h: Math.round(r.height), ...a });
  t.busy--;
  if (activeBTab(c) !== t || !$('#paneBody .ubview')) return;
  if (res.none) { if (t.agent) { delete G.agentTab[c.id]; renderPane(); } return; }
  if (res.error) return ubStatus(/^(not found|HTTP 404)/i.test(res.error) ? '⚠ The harness is running an older version: restart it to use the browser.' : `⚠ ${res.error}`);
  const lockChanged = t.agent && !!t.locked !== !!res.locked;
  // An answer without a picture keeps the last one on screen.
  Object.assign(t, { url: res.url, title: res.title, shot: res.shot || t.shot, w: res.w, h: res.h, locked: res.locked });
  if (lockChanged) return renderPane();
  if (res.shot) $('#paneBody .ub-shot').src = res.shot;
  const tt = $(`#paneBody .btab[data-sid="${CSS.escape(t.sid)}"] .bt-title`); if (tt && !t.agent) tt.textContent = res.title || res.url.replace(/^https?:\/\//, '').slice(0, 24);
  setUrlBar(res.url); ubStatus('');
}
function wireUbView(t) {
  const v = $('#paneBody .ubview'), img = $('.ub-shot', v), keys = $('.ub-keys', v);
  let buf = '', bufT = null, dy = 0, dyT = null;
  const flush = async () => { clearTimeout(bufT); if (!buf) return; const x = buf; buf = ''; await ubCall('type', { text: x }); };
  // Typing goes into a hidden box, so keyboards, paste and input methods all reach the page the same way.
  const grab = () => keys.focus({ preventScroll: true });
  img.onclick = (e) => { if (t.agent && t.locked) return; grab(); if (!t.w) return; ubCall('click', { x: (e.offsetX / img.clientWidth) * t.w, y: (e.offsetY / img.clientHeight) * t.h }); };
  v.onclick = (e) => { if (e.target !== img && !(t.agent && t.locked)) grab(); };
  v.addEventListener('wheel', (e) => { if (t.agent && t.locked) return; e.preventDefault(); dy += e.deltaY; clearTimeout(dyT); dyT = setTimeout(() => { const d = dy; dy = 0; ubCall('scroll', { dy: Math.round(d) }); }, 180); }, { passive: false });
  keys.oninput = () => { if (!keys.value) return; buf += keys.value; keys.value = ''; clearTimeout(bufT); bufT = setTimeout(flush, 300); };
  keys.onkeydown = async (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'Backspace' && buf) { buf = buf.slice(0, -1); return; }
      await flush(); ubCall('key', { key: e.key });
    }
  };
}
// While it is on screen, the picture refreshes every 2 s (pages change by themselves too).
let ubTick = 0;
setInterval(async () => {
  const c = focused();
  if (!G.view?.browser || !c || document.hidden) return;
  ubTick++;
  // Every 2 s: is the agent on its page? (a new tab appears, or the lock lifts when its reply ends)
  if (ubTick % 2 === 0 && await refreshAgentTab(c) && G.view.browser && focused() === c) return renderPane();
  const t = activeBTab(c);
  // The open page's picture: every second while the agent works on it, every 2 s otherwise.
  if (t && !t.busy && $('#paneBody .ubview') && (t.agent && t.locked ? true : ubTick % 2 === 0)) ubCall('look');
}, 1000);

// ---------- small icons under messages (copy, remix, rewind), like the row under a chat reply ----------
function msgIcon(n) {
  const d = { copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>', rewind: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>', check: '<path d="m5 12 5 5 9-10"/>' }[n];
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
}
function wireIconCopy(btn, text) {
  if (!btn) return;
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(text() || ''); btn.innerHTML = msgIcon('check'); btn.classList.add('done'); } catch { btn.title = 'Could not copy'; }
    setTimeout(() => { btn.innerHTML = msgIcon('copy'); btn.classList.remove('done'); }, 1400);
  };
}

// ---------- "restart the harness" notice: its server code changed after it started ----------
async function checkStale() {
  const r = await getJ('/api/stale');
  const el = $('#staleNote'); if (!el) return;
  // An older harness has no /api/stale at all: that is stale too (it predates this check).
  const old = r && r.error && /not found|404/i.test(r.error);
  const stale = old || r?.stale;
  el.hidden = !stale;
  for (const b of ['#restartBtn', '#railRestart'].map((q) => $(q)).filter(Boolean)) { b.classList.toggle('stale', !!stale); if (stale) b.title = 'Restart needed: the harness has newer server code than it is running. Click to restart.'; }
  if (stale) el.title = old ? 'The harness was started before its latest server changes. Restart it (stop it, then run npm start) to load them; pages already load fresh.' : `${r.stale.file} changed after the harness started. Restart it (stop it, then run npm start) to load the latest server code; pages already load fresh.`;
}
setInterval(checkStale, 30000);
setTimeout(checkStale, 1500);

// ---------- the desktop app: real Chromium tabs in the Browser tab (desktop/main.js, desktop/preload.js) ----------
// The page keeps the tab strip and address bar; the desktop app places a real browser view exactly over
// the page area. A loop keeps it there, and hides it whenever it would cover something: another pane
// tab, a dialog (a snapshot stands in), the hidden pane or a phone-sized window.
const DESK = !!window.ohDesktop?.available;
// The desktop app run from your QuorX folder (npm run desktop) looks different from the installed one: an amber DEV
// badge by the name, a thin amber line along the top, and DEV in the window title, so the two are never mixed up.
// Only when the desktop app says so itself (its DEV value: not packaged and a git checkout).
if (DESK) window.ohDesktop.info().then((i) => { if (i?.dev === true) markDevBuild(); }).catch(() => {});
function markDevBuild() {
  document.body.classList.add('dev-build');
  document.title = 'QuorX · DEV';
  const b = $('#brandHome');
  if (b && !$('.dev-badge')) b.insertAdjacentHTML('afterend', '<span class="dev-badge" title="Running from your QuorX folder (npm run desktop), not the installed app">DEV</span>');
}
function deskStage(t, stage) {
  if (!t.agent && t.opened !== t.url) { t.opened = t.url; t.error = null; window.ohDesktop.open(t.sid, t.url).catch((e) => { t.error = e.message; deskPlace(true); }); }
  // The pane redraws often while the agent works: the same tab keeps its box, so the real view isn't hidden,
  // shown and re-placed each time (that was the flicker). A different tab gets a fresh box.
  if (G.dsk && G.dsk.sid === t.sid && G.dsk.ph) { stage.replaceChildren(G.dsk.ph); deskPlace(false); return; }
  stage.innerHTML = `<div class="dview" data-sid="${esc(t.sid)}"><img class="dsnap" alt="" hidden><div class="derr" hidden></div></div>`;
  const ph = $('.dview', stage);
  G.dsk = { sid: t.sid, ph, rect: '', shown: false, snap: false };
  deskPlace(true);
}
async function deskPlace(force) {
  const d = G.dsk;
  if (!DESK || !d) return;
  const c0 = focused(), t = c0 ? browserTabs(c0).find((x) => x.sid === d.sid) : null;
  const visible = d.ph.isConnected && G.view.browser && t && paneVisible() && d.ph.getClientRects().length && document.visibilityState === 'visible';
  if (!visible) { if (d.shown || force) { window.ohDesktop.hideAll(); d.shown = false; } if (!d.ph.isConnected) G.dsk = null; return; }
  const err = $('.derr', d.ph);
  if (t.error) { err.hidden = false; err.innerHTML = `⚠ ${esc(t.error)}<br><button type="button" class="derr-retry">Try again</button>`; $('.derr-retry', err).onclick = () => { t.error = null; t.opened = null; renderPane(); }; if (d.shown) { window.ohDesktop.hideAll(); d.shown = false; } return; }
  err.hidden = true;
  // Something over the page (a dialog, the model picker, settings): show a snapshot and step aside.
  // The real tab is drawn above the page, so anything opened over it (a dialog, the 🖥 servers list) needs it to step aside.
  const covered = !!document.querySelector('dialog[open], #paneSrvPop:not([hidden]), .oh-tip.on.covers, #replyInfoPop.covers:not([hidden])');
  const snap = $('.dsnap', d.ph);
  if (covered) {
    if (d.shown) { const url = await window.ohDesktop.snapshot(d.sid).catch(() => null); if (url) { snap.src = url; snap.hidden = false; } }
    // Hidden every time, not only when we think it's showing: a tab the app re-made under the same name may be
    // showing without us knowing, and would sit on top of the servers list or a dialog.
    window.ohDesktop.hideAll();
    d.shown = false;
    return;
  }
  snap.hidden = true;
  const r = d.ph.getBoundingClientRect(), key = `${r.x},${r.y},${r.width},${r.height}`;
  if (force || key !== d.rect) { d.rect = key; await window.ohDesktop.bounds(d.sid, { x: r.x, y: r.y, width: r.width, height: r.height }); }
  if (force || !d.shown) { await window.ohDesktop.show(d.sid); d.shown = true; }
}
if (DESK) {
  setInterval(() => deskPlace(false), 150);
  window.addEventListener('resize', () => deskPlace(true));
  document.addEventListener('visibilitychange', () => deskPlace(true));
  window.ohDesktop.on((ev) => {
    const c = focused();
    if (ev.type === 'open-link') { openLink(ev.url); return; }
    if (ev.type === 'popup') { newBTab(ev.url); if (c) { G.view = { id: G.view.id, src: false, files: false, browser: true }; syncLayout(); renderPane(); } return; }
    if (ev.type === 'download') { deskDownload(ev); return; }
    if (String(ev.sid || '').startsWith('agent-')) return deskAgentEvent(ev);
    const t = (G.btabs || []).find((x) => x.sid === ev.sid); if (!t) return;
    if (ev.type === 'state') {
      const urlChanged = ev.url && ev.url !== t.url;
      Object.assign(t, { url: ev.url || t.url, opened: ev.url || t.opened, title: ev.title || t.title, loading: ev.loading, canBack: ev.canBack, canForward: ev.canForward });
      const active = G.view.browser && G.dsk?.sid === t.sid;
      const tt = $(`#paneBody .btab[data-sid="${CSS.escape(t.sid)}"] .bt-title`); if (tt) tt.textContent = t.title || t.url.replace(/^https?:\/\//, '').slice(0, 24);
      if (active) {
        if (urlChanged || document.activeElement !== $('#paneUrl')) setUrlBar(t.url);
        const real = $('#appBar .bv-real'); if (real) { real.textContent = `● real tab${t.loading ? ' · loading…' : ''}`; real.classList.toggle('loading', !!t.loading); }
        const [b, f] = document.querySelectorAll('#appBar .bv-nav'); if (b) b.disabled = !t.canBack; if (f) f.disabled = !t.canForward;
      }
    }
    if (ev.type === 'error') { t.error = `${ev.message} (${ev.url})`; deskPlace(true); }
  });
}
// Downloads from real tabs: a small row in the bar, with "show in folder" when done.
function deskDownload(ev) {
  const list = (G.downloads ||= []);
  let d = list.find((x) => x.name === ev.name && x.state !== 'completed' && x.state !== 'cancelled' && x.state !== 'interrupted');
  if (!d) { d = { name: ev.name }; list.unshift(d); if (list.length > 4) list.pop(); }
  Object.assign(d, ev);
  const box = $('#appBar .bdl');
  if (box) { box.outerHTML = downloadsHTML(); wireDownloads($('#appBar')); }
}
function downloadsHTML() {
  const list = (G.downloads || []).slice(0, 3);
  if (!list.length) return '';
  return `<span class="bdl">${list.map((d, i) => `<button type="button" class="bdl-item ${d.state}" data-i="${i}" title="${esc(d.file || d.name)}">${d.state === 'completed' ? '✓' : d.state === 'progress' || d.state === 'started' ? '⬇' : '⚠'} ${esc(clip(d.name, 22))}${d.state === 'progress' && d.total ? ` ${Math.round((d.received / d.total) * 100)}%` : ''}</button>`).join('')}</span>`;
}
function wireDownloads(bar) {
  for (const b of bar.querySelectorAll('.bdl-item')) b.onclick = () => { const d = G.downloads[Number(b.dataset.i)]; if (d?.file && d.state === 'completed') window.ohDesktop.showFile(d.file); };
}

// The agent's real tab in the desktop app: its address and title as it browses, and the lock lifting.
function deskAgentEvent(ev) {
  const chatId = ev.sid.slice(6), c = focused();
  const a = (G.agentTab ||= {})[chatId];
  if (ev.type === 'agent-tab' || ev.type === 'agent-lock') {
    // A new agent tab (a new reply makes one under the same name) hasn't been placed or shown yet: forget the old one's place.
    if (ev.type === 'agent-tab' && G.dsk?.sid === ev.sid) { G.dsk.rect = ''; G.dsk.shown = false; deskPlace(true); }
    if (a && ev.type === 'agent-lock') a.locked = ev.locked;
    if (c?.id === chatId) refreshAgentTab(c).then(() => { if (G.view.browser) renderPane(); });
    return;
  }
  if (!a || ev.type !== 'state') return;
  Object.assign(a, { url: ev.url || a.url, title: ev.title || a.title, loading: ev.loading, canBack: ev.canBack, canForward: ev.canForward });
  if (c?.id === chatId && G.view.browser && G.dsk?.sid === ev.sid) {
    setUrlBar(a.url);
    const tt = $(`#paneBody .btab[data-sid="${CSS.escape(ev.sid)}"] .bt-title`); if (tt) tt.textContent = a.title || 'Agent';
    const real = $('#appBar .bv-real'); if (real) { real.textContent = `● real tab${a.loading ? ' · loading…' : ''}`; real.classList.toggle('loading', !!a.loading); }
  }
}

// ⚙ Settings → About, in the desktop app only: start at login (applied right away) and the data folder.
async function drawDesktopSettings() {
  const box = $('#stDesktop'); if (!box || !DESK) return;
  const [info, login, onClose] = await Promise.all([window.ohDesktop.info().catch(() => ({})), window.ohDesktop.loginItem().catch(() => false), window.ohDesktop.closeAction?.().catch(() => 'ask')]);
  if (!box.isConnected) return;
  const canQuit = typeof window.ohDesktop.quit === 'function';
  const closeSeg = `<div class="st-segmented" role="radiogroup" id="stDeskClose">${[['ask', 'Ask'], ['tray', 'Keep running in the tray'], ['quit', 'Quit QuorX']].map(([k, l]) => `<button type="button" class="st-seg-btn ${k === (onClose || 'ask') ? 'active' : ''}" role="radio" aria-checked="${k === (onClose || 'ask')}" data-v="${k}">${l}</button>`).join('')}</div>`;
  box.innerHTML = stCard('Desktop app', `Version ${esc(info.version || '?')}${info.packaged ? '' : ' (running from the repo)'}. ${info.ownsServer ? 'It runs the harness itself, so scheduled tasks keep running while the window is closed.' : 'It is attached to a harness that was already running; closing the window leaves that one running.'}`,
    (canQuit ? stRow('Closing the window (✕)', 'Ask: a short notice the first time. Keep running: QuorX stays in the tray, where right-click → Quit QuorX stops it. Quit: ✕ stops QuorX and the harness.', closeSeg)
      + stRow('Quit QuorX', info.ownsServer ? 'Stops QuorX and the harness now. Scheduled tasks wait until you open QuorX again.' : 'Closes this window. The harness it is attached to keeps running.', '<button type="button" class="st-btn danger sm" id="stDeskQuit">Quit QuorX</button>') : '')
    // The Microsoft Store copy can't start at login this way, and the Store brings its updates.
    + (info.store ? '' : stRow('Start at login', 'Opens QuorX in the tray when you sign in to Windows, so scheduled tasks run. Applies right away.', '<label class="sq-check"><input type="checkbox" id="stDeskLogin"' + (login ? ' checked' : '') + '><span>On</span></label>'))
    + stRow('Updates', '', `<span id="stDeskUpd" class="st-upd">…</span> <button type="button" class="st-btn ghost sm" id="stDeskCheck">${info.store ? 'Open in the Store ↗' : 'Check now'}</button>`)
    + (info.store ? '' : stRow('Update feed', 'Where new versions are published (latest.yml and the installer), e.g. https://github.com/you/repo/releases/latest/download. Empty: no updates.', '<input type="url" class="st-input" id="stDeskFeed" placeholder="https://…" spellcheck="false" style="min-width:260px">'))
    + stRow('Data folder', 'Chats, projects, keys and logs.', `<code class="blurable" title="${esc(info.home || '')}">${esc(info.home || '')}</code> <button type="button" class="st-btn ghost sm" id="stDeskHome">📂 Open</button>`));
  if ($('#stDeskLogin')) $('#stDeskLogin').onchange = async (e) => { e.target.checked = await window.ohDesktop.loginItem(e.target.checked).catch(() => !e.target.checked); };
  $('#stDeskHome').onclick = () => window.ohDesktop.openHome();
  for (const b of box.querySelectorAll('#stDeskClose .st-seg-btn')) b.onclick = async () => {
    const v = await window.ohDesktop.closeAction(b.dataset.v).catch(() => null);
    if (v) for (const x of box.querySelectorAll('#stDeskClose .st-seg-btn')) { x.classList.toggle('active', x.dataset.v === v); x.setAttribute('aria-checked', String(x.dataset.v === v)); }
  };
  const quit = $('#stDeskQuit');
  if (quit) quit.onclick = async () => { if (await uiConfirm(info.ownsServer ? 'Quit QuorX? The harness stops too, and scheduled tasks wait until you open QuorX again.' : 'Close QuorX? The harness it is attached to keeps running.')) window.ohDesktop.quit(); };
  const st = await window.ohDesktop.update('state').catch(() => ({}));
  const feed = $('#stDeskFeed');
  if (feed) feed.value = st.url || '';
  if (feed) feed.onchange = async (e) => { try { await window.ohDesktop.update('setUrl', e.target.value); } catch (er) { uiAlert(er.message); } };
  $('#stDeskCheck').onclick = () => window.ohDesktop.update(info.store ? 'store' : 'check');
  drawUpdate(st);
}
// ---------- updates (desktop app): "⬆ Update" in the top bar, progress, "Restart to update" ----------
function updateText(u) {
  const v = u.version ? `v${u.version}` : 'a new version';
  return { available: `⬆ Update to ${v}`, downloading: `⬇ Downloading ${v}… ${u.percent ?? 0}%`, ready: `↻ Restart to update to ${v}`, error: '⚠ Update failed' }[u.state] || '';
}
const UPD_ICO = {
  available: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6"/></svg>',
  downloading: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v13M6 12l6 6 6-6"/></svg>',
  ready: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>',
};
// Both versions when they fit (old → new), else just the new one: a half-cut old version reads as noise.
function fitUpdStrip(b) {
  const v = $('.un-vers', b); if (!v) return;
  b.classList.remove('un-tight');
  if (v.scrollWidth > v.clientWidth + 1) b.classList.add('un-tight');
}
function drawUpdate(u) {
  const b = $('#updNote');
  if (b) {
    const t = updateText(u);
    // Short on the button (it shares the sidebar's footer with three icons); the whole sentence is in its tip.
    // While downloading, the button fills up like a progress bar.
    const short = { available: 'Update', downloading: `${u.percent ?? 0}%`, ready: 'Restart', error: 'Retry' }[u.state] || '';
    b.hidden = !t; b.dataset.state = u.state || '';
    // In the sidebar's footer it takes over the version's place (and ⟳'s): the versions it goes between, an action
    // on the right, and while downloading the whole strip fills up. Elsewhere (the phone's top bar) it stays short.
    const from = u.current || G.cfg?.version || '', to = u.version || '';
    const vers = u.state === 'error' ? '<span class="un-vers">Update failed</span>'
      : u.state === 'ready' ? `<span class="un-vers"><b>v${esc(to)}</b><em>ready</em></span>`
      : `<span class="un-vers">${from ? `<s>v${esc(from)}</s><i aria-hidden="true">→</i>` : ''}<b>${to ? `v${esc(to)}` : 'new version'}</b></span>`;
    // the action on the right: ⬆ (out), the % (downloading), ↻ Restart (ready), Retry (failed); only a failure leads with an icon
    const act = u.state === 'available' ? UPD_ICO.available : u.state === 'ready' ? `${UPD_ICO.ready}<span>Restart</span>` : esc(short);
    b.innerHTML = t ? `<span class="un-fill" aria-hidden="true"></span>${u.state === 'error' ? `<span class="un-ico">${UPD_ICO.error}</span>` : ''}${vers}<span class="un-txt">${act}</span>` : '';
    const foot = $('#sbFoot'); if (foot) { if (t) foot.dataset.upd = u.state; else delete foot.dataset.upd; }
    fitUpdStrip(b);
    if (!b.dataset.fitWired && window.ResizeObserver) { b.dataset.fitWired = '1'; new ResizeObserver(() => fitUpdStrip(b)).observe(b); }
    b.setAttribute('aria-label', t.replace(/^\S+\s/, ''));
    b.style.setProperty('--p', `${Math.max(0, Math.min(100, u.percent ?? 0))}%`);
    b.disabled = u.state === 'downloading';
    b.title = u.state === 'error' ? `${u.error || ''}\nClick to try again.` : u.state === 'available' ? `Version ${u.version} is out (you have ${u.current || 'an older one'}). Click to download it${u.size ? ` (${Math.round(u.size / 1e6)} MB)` : ''}.${u.notes ? `\n\n${u.notes.replace(/<[^>]+>/g, '')}` : ''}` : u.state === 'ready' ? 'Restarts QuorX and installs the update. Your chats and projects stay as they are.' : '';
    if (u.state === 'downloading') b.title = t;
  }
  // The folded sidebar shows it as an icon, coloured like the button: ⬆ out, ⬇ downloading (with its %), ↻ ready, ⚠ failed.
  const r = $('#railUpd');
  if (r) {
    const t = updateText(u);
    r.hidden = !t; r.dataset.state = u.state || ''; r.disabled = u.state === 'downloading';
    r.dataset.tip = t.replace(/^\S+\s/, ''); r.setAttribute('aria-label', r.dataset.tip);
    r.innerHTML = u.state === 'downloading' ? `<span class="ru-pct">${u.percent ?? 0}</span>` : UPD_ICO[u.state] || '';
  }
  // ⚙ Settings' header: the same check one click away, without opening About. It says where the update stands and
  // its click does the next step: check, Update, Restart, or open the Store page.
  const h = $('#stHeadUpd');
  if (h && (DESK || u.demo)) {
    const v = u.version ? ` to v${u.version}` : '';
    h.hidden = false; h.dataset.state = u.state || '';
    h.textContent = { checking: 'Checking…', current: '✓ Up to date', available: `⬆ Update${v}`, downloading: `⬇ ${u.percent ?? 0}%`, ready: `↻ Restart to update${v}`, error: '⚠ Check again', store: 'Microsoft Store ↗', dev: 'Updates from git', 'no-feed': 'No update feed' }[u.state] || '⟳ Check for updates';
    h.title = { current: `QuorX v${u.current || '?'} is the newest version. Click to check again.`, store: 'This copy is updated by the Microsoft Store. Opens QuorX in the Store, where a new version shows as Update.', dev: 'Running from the repo: pull with git to update.', 'no-feed': 'Set the update feed in Settings → About.', error: u.error || '' }[u.state] || '';
    h.classList.toggle('accent', ['available', 'ready'].includes(u.state));
    h.classList.toggle('secondary', !['available', 'ready'].includes(u.state));
    h.disabled = ['checking', 'downloading', 'dev', 'no-feed'].includes(u.state);
  }
  const s = $('#stDeskUpd');
  if (s) s.textContent = { dev: 'Running from the repo: updates come from git.', store: 'Updates come from the Microsoft Store.', 'no-feed': 'No update feed set.', checking: 'Checking…', current: `Up to date (v${u.current || '?'}).`, available: `v${u.version} is available.`, downloading: `Downloading… ${u.percent ?? 0}%`, ready: `v${u.version} is downloaded: restart to install.`, error: `Couldn't check: ${u.error || 'unknown error'}` }[u.state] || `v${u.current || '?'}`;
}
// Preview of the update strip in a browser on this computer: ?demo-update=available | downloading:42 | ready | error
{
  const demo = new URLSearchParams(location.search).get('demo-update');
  if (demo && !DESK && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    const [state, pct] = demo.split(':');
    setTimeout(() => drawUpdate({ demo: true, state, percent: Number(pct) || 0, version: '0.2.5', current: G.cfg?.version || '0.2.4', error: 'The download stopped (demo).' }), 1600);
  }
}
if (DESK) {
  window.ohDesktop.on((ev) => { if (ev.type === 'update') drawUpdate(ev); });
  // A clicked notification opens its chat.
  window.ohDesktop.on((ev) => { if (ev.type === 'notify-click' && ev.chatId && !G.panes.includes(ev.chatId)) showChat(ev.chatId); });
  setTimeout(() => window.ohDesktop.update('state').then(drawUpdate).catch(() => {}), 1500);
  const ub = $('#updNote');
  const rb = $('#railUpd'); if (rb) rb.onclick = () => ub?.click();
  const hb = $('#stHeadUpd');
  if (hb) hb.onclick = () => {
    const st = hb.dataset.state;
    if (['available', 'ready', 'error'].includes(st) && ub) ub.click();
    else window.ohDesktop.update(st === 'store' ? 'store' : 'check');
  };
  if (ub) ub.onclick = async () => {
    const st = ub.dataset.state;
    if (st === 'available') drawUpdate(await window.ohDesktop.update('download'));
    else if (st === 'ready') { if (await uiConfirm('Restart QuorX now to install the update?\n\nRunning replies are stopped and can be resumed after the restart.')) window.ohDesktop.update('install'); }
    else if (st === 'error') window.ohDesktop.update('check');
  };
}

// ---------- the version: bottom left of the sidebar, and in Settings → About ----------
async function showVersion() {
  const v = G.cfg?.version || (await getJ('/api/config'))?.version;
  // An older harness doesn't report its version: then only the desktop app's (or nothing) is shown.
  let text = v ? `QuorX v${v}` : '', title = v ? `Harness v${v}` : '';
  if (DESK) {
    const info = await window.ohDesktop.info().catch(() => null);
    if (info?.version) {
      text = !v || info.version === v ? `QuorX v${info.version}` : `QuorX v${info.version} · harness v${v}`;
      title = `Desktop app v${info.version}${info.packaged ? '' : ' (from the repo)'}${v ? ` · harness v${v}` : ''}`;
    }
  }
  const el = $('#appVersion'); if (el) { el.textContent = text; el.title = title; }
  const st = $('#stVersion'); if (st) st.textContent = text.replace(/^QuorX /, '') || 'unknown (restart the harness)';
}
setTimeout(showVersion, 1200);

// ---------- ⟳ restart the harness (top bar, and the amber notice) ----------
async function restartHarness() {
  const runs = await getJ('/api/runs');
  const n = Array.isArray(runs) ? runs.length : 0;
  if (!await uiConfirm(`Restart the harness?\n\nIt loads the latest server code. Dev servers it started stop and can be run again from 🖥.${n ? `\n\n${n} repl${n > 1 ? 'ies are' : 'y is'} running: ${n > 1 ? 'they pause' : 'it pauses'} and can be resumed afterwards.` : ''}`)) return;
  const btn = $('#restartBtn'), note = $('#staleNote');
  const before = (await getJ('/api/config'))?.started;
  btn.disabled = true; btn.classList.add('spinning'); btn.title = 'Restarting…';
  if (note) { note.hidden = false; note.textContent = '⟳ Restarting the harness…'; }
  // An older desktop window (opened before this feature) has no restart of its own: the harness restarts itself.
  const r = DESK && typeof window.ohDesktop.restartHarness === 'function' ? await window.ohDesktop.restartHarness() : await postJ('/api/harness/restart');
  if (r && r.ok === false) { uiAlert(`Restart failed: ${r.error}`); btn.disabled = false; btn.classList.remove('spinning'); return; }
  // Wait for the fresh copy (it reports a new start time), then reload the page against it.
  for (let i = 0; i < 80; i++) {
    await new Promise((res) => setTimeout(res, 500));
    const c = await getJ('/api/config').catch(() => null);
    if (c && c.started && c.started !== before) return location.reload();
  }
  uiAlert('The harness did not come back within 40 seconds. Check logs/harness.log, or start it again with npm start.');
  btn.disabled = false; btn.classList.remove('spinning');
}
$('#restartBtn')?.addEventListener('click', restartHarness);
$('#staleNote')?.addEventListener('click', () => { if (!$('#restartBtn').disabled) restartHarness(); });

// =====================================================================================================================
// ---------- News (docs/news-format.md): What's new, Reports, Articles, and the article pages ----------
// Everything News adds to the page lives in this section. news-md.js renders Markdown and draws each block at rest;
// this part fetches /api/news*, shows the view in place of the chats, and adds the motion: count-ups, bars that grow,
// Play on a flow, the compare switch, the matrix filter, clickable lanes and the terminal replay. Routes:
// #news, #news/reports, #news/articles, #news/articles/<slug> (drafts, whose folder starts with _, open only this way).
// =====================================================================================================================
import { renderMarkdown as newsMarkdown, blockHtml, blockError, chartSvg, lanesSvg, laneCard, flowSvg, flowCap, compareBody, termLines, localHtml, fmt as newsFmt, withUnit } from './news-md.js';

const NEWS = { data: null, tab: 'updates', tags: {}, seen: undefined, open: false, item: null, io: null, ro: null, gen: 0 };
const NEWS_KIND = { new: 'New', improved: 'Improved', fixed: 'Fixed', safety: 'Safety' };
const NEWS_DRAWN = ['chart', 'lanes', 'flow', 'local'];
const newsCalm = () => motionReduced() || matchMedia('(prefers-reduced-motion: reduce)').matches;
function newsVer(a, b) {
  const p = (v) => String(v || '').split('.').map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}
const newsDate = (d) => { const t = Date.parse(`${d}T12:00:00`); return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }) : esc(d); };
const newsTop = () => NEWS.data?.updates?.versions?.[0]?.version || null;
const newsUnread = () => { const top = newsTop(); return !!top && (!NEWS.data.lastRead || newsVer(top, NEWS.data.lastRead) > 0); };

async function newsLoad() {
  const d = await getJ('/api/news');
  if (d && !d.error) { NEWS.data = d; newsDot(); }
  return NEWS.data;
}
function newsDot() {
  const on = newsUnread();
  for (const el of document.querySelectorAll('#newsDot, #railNews .nw-dot')) el.hidden = !on;
  $('#newsBtn')?.setAttribute('aria-label', on ? 'News, with new updates' : 'News');
  $('#railNews')?.setAttribute('data-tip', on ? 'News · new updates' : 'News');
}
function newsEl() {
  let v = $('#newsView');
  if (!v) {
    v = document.createElement('div');
    v.id = 'newsView'; v.className = 'news-view'; v.hidden = true;
    v.setAttribute('role', 'region'); v.setAttribute('aria-label', 'News');
    $('.work').append(v);
    v.addEventListener('click', newsClick);
  }
  return v;
}
function newsRoute(route) { try { history.replaceState(null, '', `${location.pathname}${location.search}#news${route ? `/${route}` : ''}`); } catch { /* file: or sandboxed */ } }

/** Opens News at a route: 'updates', 'reports', 'articles', or 'articles/<slug>'. */
async function openNews(route = 'updates') {
  closeDrawer(); if (isPhone()) setMView('chat');
  const v = newsEl(), gen = ++NEWS.gen;
  if (!NEWS.open) { NEWS.open = true; NEWS.seen = undefined; }
  $('.work').classList.add('news-on'); $('.layout').classList.add('news-on'); v.hidden = false;
  for (const b of document.querySelectorAll('#newsBtn, #railNews')) { b.classList.add('active'); b.setAttribute('aria-current', 'page'); }
  for (const b of document.querySelectorAll('#homeBtn, #railHome')) { b.classList.remove('active'); b.setAttribute('aria-current', 'false'); }
  newsStop();
  if (!NEWS.data) { v.innerHTML = '<div class="nw-wrap"><p class="nw-sub">Loading News…</p></div>'; await newsLoad(); if (gen !== NEWS.gen) return; }
  if (!NEWS.data) { v.innerHTML = `<div class="nw-wrap">${newsHead('News')}<div class="nw-empty"><b>News didn't load.</b><span>The QuorX server didn't answer. <button type="button" class="nw-go" data-go="updates">Try again</button></span></div></div>`; return; }
  // "New" marks compare against what you had read before this visit, so they stay while you look.
  if (NEWS.seen === undefined) NEWS.seen = NEWS.data.lastRead || null;
  const [kind, slug] = String(route || 'updates').split('/');
  if ((kind === 'articles' || kind === 'reports') && slug) return newsArticle(kind, slug, gen);
  NEWS.tab = ['articles', 'reports'].includes(kind) ? kind : 'updates';
  newsRoute(NEWS.tab === 'updates' ? '' : NEWS.tab);
  newsList();
}
function closeNews() {
  if (!NEWS.open) return;
  NEWS.open = false; NEWS.gen++; newsStop();
  const v = $('#newsView'); if (v) { v.hidden = true; v.innerHTML = ''; }
  $('.work').classList.remove('news-on'); $('.layout').classList.remove('news-on');
  for (const b of document.querySelectorAll('#newsBtn, #railNews')) { b.classList.remove('active'); b.setAttribute('aria-current', 'false'); }
  if (/^#news\b/.test(location.hash)) { try { history.replaceState(null, '', `${location.pathname}${location.search}`); } catch { /* ignore */ } }
  syncHome(); syncLayout();
}
// Stops what the open page was animating (flows, terminals) and its observers.
function newsStop() {
  for (const el of document.querySelectorAll('#newsView .nb')) { newsFlowStop(el); if (el._term) el._term.stop = true; }
  NEWS.io?.disconnect(); NEWS.io = null; NEWS.ro?.disconnect(); NEWS.ro = null;
}

// A colour for each kind of tag, so rows and chips read at a glance.
const NEWS_TONES = { research: 'research', models: 'models', deciders: 'models', cost: 'cost', safety: 'safety', security: 'safety', tests: 'tests', bugs: 'safety', platforms: 'platforms', toolchains: 'platforms', desktop: 'platforms', workflow: 'workflow', release: 'workflow' };
const newsTone = (tag) => NEWS_TONES[String(tag || '').toLowerCase()] || 'other';
const newsHead = (title, sub = '', left = '') => `<header class="nw-head"><div class="nw-head-left">${left}<h1>${title}</h1>${sub ? `<span class="nw-sub">${sub}</span>` : ''}</div><div class="nw-head-right"><button type="button" class="nw-icon-btn nw-close" title="Close News and go back" aria-label="Close News">✕</button></div></header>`;
function newsTabs() {
  const d = NEWS.data, n = (k) => d[k]?.length || 0;
  const b = (k, label, count) => `<button type="button" data-tab="${k}" aria-pressed="${NEWS.tab === k}">${label}${count != null ? ` <span class="nw-count">${count}</span>` : ''}</button>`;
  return `<div class="nw-seg" role="group" aria-label="News sections">${b('updates', 'What\'s new')}${b('reports', 'Reports', n('reports'))}${b('articles', 'Articles', n('articles'))}</div>`;
}
function newsList() {
  const v = newsEl(), d = NEWS.data, t = NEWS.tab;
  let body = '';
  if (t === 'updates') {
    const vs = d.updates?.versions || [];
    const title = (link) => { const [k, s] = String(link).split('/'); return (d[k] || []).find((x) => x.slug === s)?.title; };
    body = vs.length ? `<div class="nw-versions">${vs.map((ver) => {
      const unread = !NEWS.seen || newsVer(ver.version, NEWS.seen) > 0, mine = ver.version === d.version;
      const items = (ver.items || []).map((it) => {
        const meta = [it.pr ? `<span class="nw-pr" title="Pull request ${esc(it.pr)} on GitHub">PR ${esc(it.pr)}</span>` : '', it.link ? `<button type="button" class="nw-go" data-go="${esc(it.link)}">${esc(title(it.link) ? `Read: ${title(it.link)}` : it.link.startsWith('reports/') ? 'Open the report' : 'Read the article')} →</button>` : ''].filter(Boolean).join('');
        return `<li class="nw-item"><span class="nw-tag" data-k="${esc(it.kind)}">${esc(NEWS_KIND[it.kind] || it.kind)}</span><div class="nw-item-text">${esc(it.text)}${meta ? `<div class="nw-item-meta">${meta}</div>` : ''}</div></li>`;
      }).join('');
      return `<section class="nw-version${unread ? ' unread' : ''}" data-version="${esc(ver.version)}"><div class="nw-vhead"><span class="nw-vnum">v${esc(ver.version)}</span>${ver.title ? `<h2>${esc(ver.title)}</h2>` : ''}<span class="nw-vdate">${newsDate(ver.date)}${mine ? ' · the version you run' : ''}</span>${unread ? '<span class="nw-new" title="New since you last opened What\'s new">new</span>' : ''}</div><ul class="nw-items">${items}</ul></section>`;
    }).join('')}</div>` : '<div class="nw-empty"><b>Nothing here yet.</b><span>What\'s new in each version of QuorX shows here.</span></div>';
    // Opening What's new reads it: the dot goes, the marks stay until you leave News.
    const top = newsTop();
    if (top && newsUnread()) postJ('/api/news/read', { version: top }).then((r) => { if (r?.lastRead) { NEWS.data.lastRead = r.lastRead; newsDot(); } });
  } else {
    const list = d[t] || [], tags = [...new Set(list.flatMap((x) => x.tags || []))].sort(), cur = tags.includes(NEWS.tags[t]) ? NEWS.tags[t] : null;
    const shown = cur ? list.filter((x) => (x.tags || []).includes(cur)) : list;
    const filter = tags.length > 1 ? `<div class="nw-filter"><span class="nw-filter-label">Tag</span><div class="nw-seg" role="group" aria-label="Show by tag"><button type="button" data-tag="" aria-pressed="${!cur}">All</button>${tags.map((x) => `<button type="button" data-tag="${esc(x)}" aria-pressed="${cur === x}">${esc(x)}</button>`).join('')}</div></div>` : '';
    const what = t === 'reports' ? 'reports' : 'articles';
    // One row per article or report: a colour bar for its most specific tag (not "research", which nearly all have), the title and summary, then its date, version
    // and every tag as a coloured chip.
    body = list.length ? `${filter}<div class="nw-rows">${shown.map((x) => `<button type="button" class="nw-row" data-tone="${esc(newsTone((x.tags || []).find((g) => g !== 'research') || (x.tags || [])[0]))}" data-go="${t}/${esc(x.slug)}"><div class="nw-row-main"><h3>${esc(x.title)}</h3><p>${esc(x.summary)}</p></div><div class="nw-row-side"><span class="nw-row-date">${newsDate(x.date)}${x.version ? ` · v${esc(x.version)}` : ''}</span>${(x.tags || []).length ? `<span class="nw-tags">${x.tags.map((g) => `<span class="nw-tag" data-tone="${esc(newsTone(g))}">${esc(g)}</span>`).join('')}</span>` : ''}</div></button>`).join('')}</div>`
      : `<div class="nw-empty"><b>No ${what} yet.</b><span>${t === 'reports' ? 'Reports on models, tests and platforms' : 'Research articles'} arrive with QuorX updates and show here.</span></div>`;
  }
  const sub = t === 'updates' ? 'What changed in each version of QuorX' : t === 'reports' ? 'Models, tests and platforms, measured' : 'Research and how QuorX works';
  v.innerHTML = `<div class="nw-wrap">${newsHead('News', sub)}${newsTabs()}${body}</div>`;
  v.scrollTop = 0;
}

async function newsArticle(kind, slug, gen) {
  const v = newsEl();
  v.innerHTML = '<div class="nw-wrap"><p class="nw-sub">Loading…</p></div>';
  const it = await getJ(`/api/news/item?kind=${encodeURIComponent(kind)}&slug=${encodeURIComponent(slug)}`);
  if (gen !== NEWS.gen) return;
  const back = `<button type="button" class="nw-back" data-go="${kind}">← ${kind === 'reports' ? 'Reports' : 'Articles'}</button>`;
  newsRoute(`${kind}/${slug}`);
  if (!it || it.error) { v.innerHTML = `<div class="nw-wrap">${newsHead('Not found', '', back)}<div class="nw-empty"><b>This page isn't in News.</b><span>It may have been renamed or removed in an update.</span></div></div>`; return; }
  const f = it.front || {}, blocks = [];
  const html = newsMarkdown(it.body, { kind, slug, block: (name, json, n) => { blocks[n] = { name, json }; return `<div class="nb-slot" data-n="${n}"></div>`; } });
  const tags = String(f.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
  NEWS.item = { kind, slug, blocks };
  v.innerHTML = `<div class="nw-wrap"><header class="nw-head"><div class="nw-head-left">${back}</div><div class="nw-head-right"><button type="button" class="nw-icon-btn nw-close" title="Close News and go back" aria-label="Close News">✕</button></div></header>
    <article class="nw-article"><header><h1>${esc(f.title || slug)}</h1>${f.summary ? `<p class="nw-lede">${esc(f.summary)}</p>` : ''}<div class="nw-meta">${f.date ? `<span>${newsDate(f.date)}</span>` : ''}${f.version ? `<span>QuorX v${esc(f.version)}</span>` : ''}${tags.length ? `<span class="nw-tags">${tags.map((g) => `<span class="nw-tag">${esc(g)}</span>`).join('')}</span>` : ''}${slug.startsWith('_') ? '<span class="nw-draft">Draft: not listed in News</span>' : ''}</div></header>
    <div class="nw-body">${html}</div></article></div>`;
  v.scrollTop = 0;
  await newsBlocks(v, kind, slug, blocks, gen);
}

// A block's data: its inline JSON, with a src file from the same folder merged in first (inline keys win).
async function newsBlockData(json, kind, slug) {
  const inline = JSON.parse(json);
  if (!inline || typeof inline !== 'object' || !inline.src) return inline;
  const r = await fetch(`/api/news/file?kind=${encodeURIComponent(kind)}&slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(inline.src)}`);
  if (!r.ok) throw new Error(`its data file ${inline.src} isn't there`);
  let file = await r.json();
  if (inline.path) file = String(inline.path).split('.').reduce((o, k) => o?.[k], file);
  if (!file || typeof file !== 'object') throw new Error(`${inline.src} has nothing at ${inline.path}`);
  const { src: _s, path: _p, ...rest } = inline;
  return { ...file, ...rest };
}
const newsWidth = (slot) => Math.max(280, (slot.clientWidth || 720) - 34);
async function newsBlocks(v, kind, slug, blocks, gen) {
  const slots = [...v.querySelectorAll('.nb-slot')];
  await Promise.all(slots.map(async (slot) => {
    const b = blocks[Number(slot.dataset.n)];
    if (!b) return;
    let data;
    try { data = await newsBlockData(b.json, kind, slug); } catch (e) { slot.outerHTML = blockError(b.name, e instanceof SyntaxError ? `its JSON doesn't parse: ${e.message}` : e.message); return; }
    if (gen !== NEWS.gen) return;
    let html;
    try { html = blockHtml(b.name, data, newsWidth(slot)); } catch (e) { html = blockError(b.name, e.message); }
    const box = document.createElement('div'); box.innerHTML = html;
    const el = box.firstElementChild;
    if (!el) return;
    el._nb = { name: b.name, data, w: newsWidth(slot) };
    slot.replaceWith(el);
    if (!el.classList.contains('nb-error')) newsWire(el);
  }));
  if (gen !== NEWS.gen) return;
  // Motion replays each block the first time it comes into view.
  if (!newsCalm() && 'IntersectionObserver' in window) {
    NEWS.io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { NEWS.io?.unobserve(e.target); newsEnter(e.target); } }, { root: v, threshold: 0.2 });
    for (const el of v.querySelectorAll('.nb')) NEWS.io.observe(el);
  }
  // Drawn blocks fit their width: redrawn when the view is resized.
  if ('ResizeObserver' in window) {
    let t = null;
    NEWS.ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => newsRedraw(v), 140); });
    NEWS.ro.observe($('.nw-body', v));
  }
}
function newsRedraw(v) {
  for (const el of v.querySelectorAll('.nb')) {
    const nb = el._nb;
    if (!nb || !NEWS_DRAWN.includes(nb.name) || el.classList.contains('nb-error')) continue;
    const w = Math.max(280, el.clientWidth - (nb.name === 'local' ? 2 : 34));
    if (Math.abs(w - nb.w) < 8) continue;
    nb.w = w;
    if (nb.name === 'chart') { const box = $('.nb-draw-box', el); if (box) box.innerHTML = chartSvg(nb.data, w); }
    if (nb.name === 'lanes') { $('.nb-draw-box', el).innerHTML = lanesSvg(nb.data, w); newsLaneOn(el, el._lane ?? 0); }
    if (nb.name === 'flow') { newsFlowStop(el); el._flow = null; $('.nb-draw-box', el).innerHTML = flowSvg(nb.data, w); $('.nb-play', el).textContent = '▶ Play'; const cap = $('.nb-flow-cap', el); cap.dataset.k = ''; cap.innerHTML = flowCap(nb.data, -1); }
    if (nb.name === 'local' && el._local && nb.data.view === 'costs') el.innerHTML = localHtml('costs', el._local, w);
  }
}
function newsEnter(el) {
  if (newsCalm()) return;
  el.classList.add('in');
  const nb = el._nb;
  if (nb?.name === 'stat') for (const t of el.querySelectorAll('.to[data-count]')) newsCount(t);
  if (nb?.name === 'terminal') newsTermReplay(el);
}
function newsCount(t) {
  const end = Number(t.dataset.count), dec = Number(t.dataset.dec) || 0, unit = t.dataset.unit || '', t0 = performance.now();
  const tick = (now) => { const f = Math.min(1, (now - t0) / 1100); t.textContent = withUnit(newsFmt(end * (1 - (1 - f) ** 3), dec), unit); if (f < 1 && t.isConnected) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

// ---------- wiring for each block ----------
function newsWire(el) {
  const { name, data } = el._nb;
  if (name === 'lanes') {
    newsLaneOn(el, Math.max(0, (data.rows || []).findIndex((r) => r.detail)));
    el.addEventListener('click', (e) => { const g = e.target.closest('.nb-lane'); if (g) newsLaneOn(el, Number(g.dataset.i)); });
    el.addEventListener('keydown', (e) => { const g = e.target.closest('.nb-lane'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); newsLaneOn(el, Number(g.dataset.i)); } });
  }
  if (name === 'flow') $('.nb-play', el).addEventListener('click', () => newsFlowPlay(el));
  if (name === 'compare') {
    for (const b of el.querySelectorAll('.nb-seg button')) b.addEventListener('click', () => {
      const o = Number(b.dataset.o);
      for (const x of el.querySelectorAll('.nb-seg button')) x.setAttribute('aria-pressed', String(x === b));
      el.dataset.o = String(o);
      $('.nb-cmp-body', el).innerHTML = compareBody(data, o);
      if (!newsCalm()) $('.nb-steps', el)?.classList.add('swap');
    });
  }
  if (name === 'matrix') {
    for (const b of el.querySelectorAll('.nb-filter button')) b.addEventListener('click', () => {
      for (const x of el.querySelectorAll('.nb-filter button')) x.setAttribute('aria-pressed', String(x === b));
      let n = 0;
      for (const tr of el.querySelectorAll('tbody tr')) { const hide = b.dataset.f !== 'all' && tr.dataset.l !== b.dataset.f; tr.classList.toggle('hide', hide); if (!hide) n++; }
      $('.nb-matrix-none', el).hidden = n > 0;
    });
  }
  if (name === 'terminal') $('.nb-term-replay', el).addEventListener('click', () => newsTermReplay(el, true));
  if (name === 'local') {
    getJ(`/api/news/local?view=${encodeURIComponent(data.view)}`).then((r) => { if (!el.isConnected) return; el._local = r; el.innerHTML = localHtml(data.view, r, Math.max(280, el.clientWidth - 2)); });
  }
}
function newsLaneOn(el, i) {
  el._lane = i;
  for (const g of el.querySelectorAll('.nb-lane')) g.classList.toggle('on', Number(g.dataset.i) === i);
  $('.nb-lane-card', el).innerHTML = laneCard(el._nb.data, i);
}

// Flow: Play walks a token along the path, lighting each step and showing what it says; Pause, Resume, Replay.
// With reduced motion it steps from node to node without moving anything.
function newsFlowGeom(el) {
  if (el._flow?.geom) return el._flow.geom;
  const svg = $('.nb-flow-svg', el), path = svg?.querySelector('.edge:not(.lit)');
  if (!path) return null;
  const L = path.getTotalLength(), nodes = [...svg.querySelectorAll('.node')];
  const at = nodes.map((g) => {
    const r = g.querySelector('rect'), cx = Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2, cy = Number(r.getAttribute('y')) + Number(r.getAttribute('height')) / 2;
    let best = 0, dmin = Infinity;
    for (let s = 0; s <= 500; s++) { const p = path.getPointAtLength((s / 500) * L), dd = (p.x - cx) ** 2 + (p.y - cy) ** 2; if (dd < dmin) { dmin = dd; best = (s / 500) * L; } }
    return best;
  });
  const geom = { svg, path, L, nodes, at, lit: svg.querySelector('.edge.lit'), tok: svg.querySelector('.tok'), halo: svg.querySelector('.halo') };
  el._flow = { ...(el._flow || {}), geom };
  return geom;
}
function newsFlowShow(el, len, k) {
  const g = newsFlowGeom(el), d = el._nb.data;
  const p = g.path.getPointAtLength(len);
  for (const c of [g.tok, g.halo]) { c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); }
  g.lit.style.strokeDasharray = `${len} ${g.L}`;
  g.nodes.forEach((n, i) => n.classList.toggle('on', i === k));
  const cap = $('.nb-flow-cap', el);
  if (cap.dataset.k !== String(k)) { cap.dataset.k = String(k); cap.innerHTML = flowCap(d, k); }
}
function newsFlowStop(el) { const f = el._flow; if (!f) return; if (f.raf) cancelAnimationFrame(f.raf); if (f.timer) { clearInterval(f.timer); clearTimeout(f.timer); } f.raf = null; f.timer = null; f.playing = false; el.classList.remove('playing'); }
function newsFlowPlay(el) {
  const g = newsFlowGeom(el), btn = $('.nb-play', el), f = el._flow;
  if (!g) return;
  if (f.playing) { newsFlowStop(el); btn.textContent = '▶ Resume'; return; }
  const n = g.nodes.length;
  f.playing = true; el.classList.add('playing'); btn.textContent = '❚❚ Pause';
  const done = () => { newsFlowStop(el); f.t = 0; f.k = 0; btn.textContent = '↻ Replay'; g.tok.setAttribute('opacity', '0'); g.halo.setAttribute('opacity', '0'); };
  if (newsCalm()) {
    let k = f.k && f.k < n ? f.k : 0;
    g.tok.setAttribute('opacity', '0'); g.halo.setAttribute('opacity', '0');
    newsFlowShow(el, g.at[k], k);
    f.timer = setInterval(() => { k++; f.k = k; if (k >= n) { g.lit.style.strokeDasharray = ''; return done(); } newsFlowShow(el, g.at[k], k); }, 2400);
    return;
  }
  g.tok.setAttribute('opacity', '1'); g.halo.setAttribute('opacity', '1');
  const per = 1900, total = per * (n - 1) + 1400, t0 = performance.now() - (f.t || 0);
  // Frames, with a timer behind them: a window the system has put in the background gets no frames, and the walk
  // should still reach the end. The clock is performance.now(), not the frame's time, which can lag while the window
  // isn't painting and kept the walk on its first step.
  const next = () => { f.raf = requestAnimationFrame(step); f.timer = setTimeout(() => { cancelAnimationFrame(f.raf); step(); }, 120); };
  const step = () => {
    clearTimeout(f.timer);
    if (!el.isConnected) return newsFlowStop(el);
    f.t = performance.now() - t0;
    // Glide to the next step, then rest on it so its caption can be read.
    const seg = Math.min(n - 1, Math.floor(f.t / per)), x = Math.min(1, ((f.t % per) / per) / 0.5), e = x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
    const len = seg >= n - 1 ? g.at[n - 1] : g.at[seg] + (g.at[seg + 1] - g.at[seg]) * e;
    let k = 0; g.at.forEach((a, i) => { if (len >= a - 1) k = i; });
    newsFlowShow(el, len, k);
    if (f.t < total) next(); else done();
  };
  step();
}

// Terminal: types the commands and prints the output again; at rest it shows every line.
async function newsTermReplay(el, asked) {
  const pre = $('.nb-term-out', el), lines = el._nb.data.lines || [], all = termLines(lines);
  if (el._term && !el._term.stop) { el._term.stop = true; pre.innerHTML = all; if (!asked) return; }
  if (newsCalm()) { pre.innerHTML = all; return; }
  const run = el._term = { stop: false };
  pre.innerHTML = all; pre.style.minHeight = `${pre.offsetHeight}px`; // keeps its height while it types
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let html = '';
  for (const l of lines) {
    if (run.stop || !el.isConnected) return;
    if (typeof l.cmd === 'string') {
      for (let i = 1; i <= l.cmd.length; i++) { if (run.stop) return; pre.innerHTML = `${html}<span class="ps">&gt;</span> ${esc(l.cmd.slice(0, i))}<span class="cur"></span>`; await wait(l.cmd.length > 60 ? 10 : 22); }
      html += `<span class="ps">&gt;</span> ${esc(l.cmd)}\n`; await wait(260);
    } else { html += `<span class="out">${esc(l.out)}</span>\n`; pre.innerHTML = html; await wait(320); }
  }
  if (!run.stop) { pre.innerHTML = all; run.stop = true; }
}

// Clicks in the view: tabs, the tag filter, cards, links between News pages, and the web.
function newsClick(e) {
  const t = e.target;
  if (t.closest('.nw-close')) return closeNews();
  const tab = t.closest('[data-tab]');
  if (tab) return openNews(tab.dataset.tab);
  const tag = t.closest('[data-tag]');
  if (tag) { NEWS.tags[NEWS.tab] = tag.dataset.tag || null; return newsList(); }
  const go = t.closest('[data-go]');
  if (go) return openNews(go.dataset.go);
  const a = t.closest('a');
  if (!a) return;
  if (a.dataset.news) { e.preventDefault(); return openNews(a.dataset.news); }
  if (a.dataset.anchor) { e.preventDefault(); $(`#nw-${CSS.escape(a.dataset.anchor)}`, $('#newsView'))?.scrollIntoView({ block: 'start' }); return; }
  if (a.dataset.cl) return; // a web link: Ctrl+click opens it in the Browser tab (see openLink)
  if (a.dataset.ext && DESK) { e.preventDefault(); window.ohDesktop.openExternal(a.href); }
}

(function newsInit() {
  $('#newsBtn')?.addEventListener('click', () => openNews('updates'));
  $('#railNews')?.addEventListener('click', () => openNews('updates'));
  // Anything else in the sidebar, the rail or the phone bar (a chat, Home, New chat, a project) leaves News.
  document.addEventListener('click', (e) => {
    if (!NEWS.open) return;
    const hit = e.target.closest('#sidebar button, #sidebar a, #sidebar [role="button"], #sidebar .sb-chat-item, #mnav button, #brandHome');
    if (!hit || hit.closest('#newsBtn, #railNews, #sbCollapseBtn, #sbExpandBtn, #railSearch, #settingsBtn, #railSettings, #themeBtn, #railTheme, #paletteBtn, #restartBtn, #railRestart, .sb-tools')) return;
    closeNews();
  }, true);
  window.addEventListener('hashchange', () => { const m = /^#news(?:\/(.*))?$/.exec(location.hash); if (m) openNews(m[1] || 'updates'); });
  newsLoad().then(() => { const m = /^#news(?:\/(.*))?$/.exec(location.hash); if (m) openNews(m[1] || 'updates'); });
})();
