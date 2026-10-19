// QuorX front end. One agent per chat; up to two chats side by side, each with its own
// run, so chats work in parallel. Every run streams events from /api/run; approvals are answered
// through /api/approve. Chats live on the server; preferences stay in this browser. Plain JS.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c, d = 4) => `$${(Number(c) || 0).toFixed(d)}`;
const secs = (ms) => `${((ms || 0) / 1000).toFixed(1)}s`;
const short = (m) => String(m || '').split('/').pop();
const pct = (p) => `${Math.round((p || 0) * 100)}%`;
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
const TOOL_NAME = { imagine: '🖼 Make a picture', make_video: '🎬 Make a video', compose_music: '🎵 Compose music', speak: '🗣 Speak aloud',
  write_artifact: '📄 Write a page', edit_artifact: '✏️ Edit a page', read_artifact: '👀 Read a page', decide: '⚖️ Ask the deciders',
  list_files: '🗂 List files', read_file: '👀 Read a file', write_file: '📝 Write a file', append_file: '📝 Append to a file', edit_file: '✏️ Edit a file',
  search_docs: '🔎 Search the attached documents', read_doc: '📄 Read an attached document', list_docs: '📎 List attached documents',
  run_command: '⌨️ Run a command', start_server: '🚀 Start a server', stop_server: '■ Stop a server', preview_site: '🌐 Preview a site',
  browser: '🌐 Use the browser', look: '👁 Look at the result', search_files: '🔎 Search files', delete_file: '🗑 Delete a file',
  scaffold: '🧱 Use a template', save_skill: '🧩 Save a skill', use_skill: '🧩 Load a skill', fetch_url: '🌍 Read a web page', delegate: '🤝 Ask a helper', plan: '🗺 Plan' };
const CATS = [
  ['image', '🖼 Pictures', 'paid'], ['video', '🎬 Video', 'paid; the most expensive tool'], ['music', '🎵 Music', 'paid'],
  ['speech', '🗣 Voice', 'paid; reads text aloud'], ['listen', '🎤 Mic', 'turns your speech into text (model 1 is used)'],
];
// What each new chat starts with: every paid media tool off. Artifacts, code & servers and the browser are always on.
const CHAT_TOOLS = ['image', 'video', 'music', 'speech'];
// The quality tools: on by default (the best value in the build benchmark); each chat can switch them off in 🧰.
const QUALITY_TOOLS = ['reviewer', 'freshEyes', 'deciders', 'helpers'];
const DEFAULT_CHAT_TOOLS = { image: false, video: false, music: false, speech: false, reviewer: true, freshEyes: true, deciders: true, helpers: true };
const REVIEW_CHEAP = 'openai/gpt-6-luna', REVIEW_STRONG = 'anthropic/claude-sonnet-5.5', HELPER_DEFAULT = 'qwen/qwen3.7-flash', LOOK_DEFAULT = 'openai/gpt-6-luna-decisions';
const reviewerModel = () => G.settings.reviewModel || (G.settings.reviewTier === 'strong' ? REVIEW_STRONG : REVIEW_CHEAP);
const helperModel = () => G.settings.helperModel || HELPER_DEFAULT;
const lookModel = () => (Array.isArray(G.settings.lookVoters) && G.settings.lookVoters[0]) || LOOK_DEFAULT;
const freshModel = () => G.settings.freshEyesModel || (G.settings.freshEyesTier === 'strong' ? REVIEW_STRONG : helperModel());
const QUALITY_INFO = {
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
const anyRunning = () => [...G.open.values()].some((c) => c.running);

// ---------- preferences (this browser) and chats (the server) ----------
function savePrefs() {
  try { localStorage.setItem(STORE, JSON.stringify({ settings: G.settings, templates: G.templates, sideHidden: G.sideHidden, projectOrder: G.projectOrder, foldedProjects: G.foldedProjects, favModels: G.favModels, recentModels: G.recentModels, budgetSeen: G.budgetSeen, spaceSeen: G.spaceSeen, followAgent: G.followAgent, pickerSort: G.pickerSort, panes: G.panes, sessionCost: G.sessionCost, sizes: G.sizes, theme: G.theme, chatOpts: !!G.chatOpts })); } catch { /* storage unavailable */ }
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
    agent: { setup: { model: from?.agent.setup.model || G.settings.model, reasoning: from?.agent.setup.reasoning || G.settings.reasoning } } });
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
  ['files', 'Browse this project\'s files', () => { G.view.files = true; syncLayout(); renderPane(); }],
  ['notes', 'Open this project\'s AGENT.md notes', (c) => openNotes(c)],
  ['file', 'Attach files of any kind (documents, PDFs, sheets, images…)', (c) => $('.imgInput', c.el.root).click()],
  ['image', 'Attach images', (c) => $('.imgInput', c.el.root).click()],
  ['attach', 'Pick chats to attach as context (a checklist)', (c) => openCtxPicker(c)],
  ['usage', 'This chat\'s cost per model, as a card only you see', (c) => postUsage(c)],
  ['costs', 'What each project and chat has cost', () => openCosts()],
  ['skills', 'List the skills the agent can load', (c) => showSkills(c)],
  ['settings', 'Open settings', () => openSettings()],
  ['help', 'What @ and / can do', () => uiAlert('@  attach a file, another chat, or another project as context for your next message.\n/  run a command: ' + COMMANDS.map(([k]) => '/' + k).join(' '))],
];
// What a command takes next. Tab completes the command and lists these; Tab fills one in, Enter runs it.
// need: the command does nothing without one, so Enter on the bare command lists them instead of running it.
const CMD_ARGS = {
  model: { usage: '[model]', list: (c) => modelArgs(c) },
  fresh: { usage: '[model]', list: (c) => modelArgs(c) },
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
const PAL_GLOBAL = new Set(['new', 'costs', 'settings', 'help']);
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
  G.view.files = true; syncLayout(); await renderFiles(c);
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
  fileCache.set(pid, { at: Date.now(), files: files.filter((f) => !f.path.endsWith('(skipped)')) });
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
  G.view.files = true; syncLayout(); await renderFiles(c);
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
  box.innerHTML = c.ctx.map((x, i) => `<span class="ctx-chip cmp-att-item ${x.type === 'file' ? 'file' : x.type === 'project' ? 'project' : 'chat'}" title="Attached as context for your next message">${x.type === 'file' ? '📄' : x.type === 'project' ? '' : '💬'} ${esc(x.title)}<button type="button" data-ctx="${i}" aria-label="Remove">✕</button></span>`).join('')
    + c.images.map((x, i) => `<span class="img-chip cmp-att-item image"><img src="${x.thumb}" alt="attached image ${i + 1}"><button type="button" data-img="${i}" aria-label="Remove image">✕</button></span>`).join('')
    + (c.docs || []).map((d, i) => docChip(d, i)).join('');
  for (const b of box.querySelectorAll('[data-ctx]')) b.onclick = () => { c.ctx.splice(Number(b.dataset.ctx), 1); renderAttachments(c); };
  for (const b of box.querySelectorAll('[data-img]')) b.onclick = () => { c.images.splice(Number(b.dataset.img), 1); renderAttachments(c); };
  wireDocChips(c, box);
}

// ---------- sidebar: projects and chats ----------
async function refreshSidebar() {
  try { [G.projects, G.chats] = await Promise.all([fetch('/api/projects').then((r) => r.json()), fetch('/api/chats').then((r) => r.json())]); }
  catch { return; }
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
  $('#projectList').innerHTML = [...G.projects].sort((a, b) => rank(a) - rank(b)).map((p) => {
    const chats = all.filter((c) => (c.projectId || 'scratch') === p.id && (c.messages > 0 || G.panes.includes(c.id)));
    const shown = chats.filter((c) => !q || c.title.toLowerCase().includes(q) || String(c.preview || '').toLowerCase().includes(q));
    if (q && !shown.length) return '';
    // The server's total also counts replies that never reached a chat file (stopped, page closed, deleted).
    const cost = p.spent ?? chats.reduce((s, c) => s + (c.cost || 0), 0);
    const share = p.budget ? Math.min(1, cost / p.budget) : 0;
    const folded = (G.foldedProjects || []).includes(p.id) && !q;
    // A project with a chat working glows; with a chat open it's the current one; the rest fade back (see last.css).
    const working = chats.some((c) => G.open.get(c.id)?.running);
    return `<div class="sb-project ${p.id === curProject ? 'current' : ''} ${working ? 'working' : ''} ${folded ? 'folded' : ''}" data-p="${esc(p.id)}" style="${projStyle(p)}">
      <div class="sb-ph" aria-expanded="${!folded}">
        <div class="sb-pname-wrap"><button type="button" class="sb-fold" aria-expanded="${!folded}" title="${folded ? 'Show' : 'Hide'} this project's chats" aria-label="${folded ? 'Show' : 'Hide'} chats of ${esc(p.name)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button><b class="sb-pname" title="${esc(p.name)} · ${esc(p.dir)}">${esc(p.name)}</b>${p.missing ? '<button type="button" class="sb-missing" title="The project folder was moved, renamed or deleted: click to reselect it">⚠ missing</button>' : p.needsFolder ? '<button type="button" class="sb-missing needs" title="Pick a folder for this project: its files sit inside QuorX itself and are copied to the folder you pick" aria-label="Pick a folder for this project">📁</button>' : ''}${working ? '<span class="sb-pworking" title="A chat in this project is working" aria-label="Working"></span>' : ''}<span class="sb-grip" draggable="true" tabindex="0" role="button" title="Drag to move this project (or focus it and press ↑ / ↓)" aria-label="Move ${esc(p.name)}: drag, or press up or down"><svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg></span></div>
        ${budgetLine(p, chats.length, cost, share, `<span class="sb-pacts sb-pactions">
          <button type="button" class="ghost sb-new ico-add" title="New chat in ${esc(p.name)}" aria-label="New chat in ${esc(p.name)}">${ICO.plus}</button>
          <button type="button" class="ghost sb-edit ico-settings" title="Project settings: name, folder, budget and what each chat cost" aria-label="Project settings">${ICO.gear}</button>
          ${p.id !== 'scratch' ? `<button type="button" class="ghost sb-delp ico-delete" title="Delete this project (its chats move to trash; the folder is not touched)" aria-label="Delete project">${ICO.trash}</button>` : ''}
        </span>`)}
      </div>
      ${shown.map((c) => {
        const live = G.open.get(c.id);
        const running = !!live?.running, waiting = running && live.waiting;
        return `<div class="sb-chat sb-chat-item ${G.panes.includes(c.id) ? 'on active' : ''} ${running ? 'running' : ''}" data-c="${esc(c.id)}" title="${esc(c.title)}">
          <div class="sb-chat-content">
            <div class="sb-chat-topline"><span class="sb-chat-title">${esc(c.title)}</span>${running ? '<span class="live-dot" title="Running"></span>' : ''}</div>
            ${waiting ? `<div class="sb-chat-prev"><b class="needs">${waiting === 'answer' ? 'Waiting for your answer' : waiting === 'budget' ? 'Waiting: project budget reached' : 'Waiting for your approval'}</b></div>` : running ? '<div class="sb-chat-prev"><i>Working…</i></div>' : ''}
            <div class="sb-chat-meta" title="Last message ${esc(new Date(c.lastAt || c.updated || Date.now()).toLocaleString())}"><span>${ago(c.lastAt || c.updated || Date.now())}</span>${c.model ? `<span>· ${esc(short(c.model))}</span>` : ''}${c.cost ? `<span class="cost">· $${c.cost.toFixed(3)}</span>` : ''}</div>
          </div>
          <div class="sb-chat-acts"><button type="button" class="sb-ren ico-rename" title="Rename chat" aria-label="Rename chat">${ICO.pencil}</button><button type="button" class="sb-del del ico-delete" title="Delete chat (moves it to data/trash)" aria-label="Delete chat">${ICO.trash}</button></div>
        </div>`;
      }).join('') || '<div class="sb-empty">No chats yet</div>'}
    </div>`;
  }).join('');
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
    $('.sb-new', el).onclick = () => newChat(p.id);
    $('.sb-edit', el).onclick = () => openProjectSettings(p);
    const miss = $('.sb-missing', el); if (miss) miss.onclick = () => editProject(p, { reselect: true });
    const meter = $('.sb-budget', el); if (meter) meter.onclick = () => openProjectSettings(p, 'budget');
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
      <button type="button" class="mp-x pj-close" aria-label="Close">✕</button>
    </header>
    <div class="pj-scroll">
      <section class="pj-sec">
        <h4>Folder</h4>
        <div class="pj-folder-row"><div class="pj-folder ${p.missing ? 'missing' : ''}"><button type="button" class="pj-copy" title="Copy the folder path" aria-label="Copy the folder path">${msgIcon('copy')}</button><code class="blurable" title="${esc(p.dir)}
Every chat in this project reads, writes and runs programs in this folder.">${esc(p.dir)}</code></div>
        ${p.missing ? '' : '<button type="button" class="kx-btn sm pj-open" title="Open in File Explorer">📂 Open</button>'}<button type="button" class="kx-btn sm pj-move">${p.missing ? 'Reselect…' : p.needsFolder ? 'Pick a folder…' : 'Change…'}</button></div>
        ${p.missing ? '<p class="pf-warn">⚠ This folder is missing: it was moved, renamed or deleted outside QuorX. Reselect it to keep working.</p>' : p.needsFolder ? '<p class="pf-warn">📁 This project\'s files sit inside QuorX itself. Pick a folder of your own: its files are copied there, and chats can work in it again.</p>' : ''}
      </section>
      <section class="pj-sec">
        <div class="pj-sec-head"><h4>Name colour <small>where the name shows</small></h4>
          <div class="pj-colors" role="radiogroup" aria-label="Name colour">
            <button type="button" class="pj-sw auto ${p.color ? '' : 'on'}" data-c="" role="radio" aria-checked="${!p.color}" title="Automatic: picked from the name" style="--sw:hsl(${hue(p.name)} 55% 55%)">Auto</button>
            ${PROJ_COLORS.map((col) => `<button type="button" class="pj-sw ${p.color === col ? 'on' : ''}" data-c="${col}" role="radio" aria-checked="${p.color === col}" title="${col}" aria-label="Colour ${col}" style="--sw:${col}"></button>`).join('')}
            <label class="pj-sw custom ${p.color && !PROJ_COLORS.includes(p.color) ? 'on' : ''}" title="Any colour" style="--sw:${p.color && !PROJ_COLORS.includes(p.color) ? p.color : 'transparent'}"><input type="color" value="${esc(p.color || '#2fb36f')}" aria-label="Pick any colour"><span aria-hidden="true">+</span></label>
          </div>
        </div>
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
      ${p.id !== 'scratch' ? `<section class="pj-sec danger"><div class="pj-row"><h4>Danger zone</h4><button type="button" class="kx-btn sm pj-del">🗑 Delete project</button><span class="pj-hint">Its chats move to the trash; the folder and files are not touched.</span></div></section>` : ''}
    </div>`;
  const close = () => dlg.close();
  $('.pj-close', box).onclick = close;
  const pjOpen = $('.pj-open', box); if (pjOpen) pjOpen.onclick = () => openFolder(p.id);
  const pjCopy = $('.pj-copy', box);
  pjCopy.onclick = () => navigator.clipboard?.writeText(p.dir).then(() => flashTip(pjCopy, 'Copied')).catch(() => flashTip(pjCopy, 'Could not copy'));
  // Name colour: saved at once; the sidebar, start screen and chat headers follow.
  const setColor = async (color) => {
    const r = await postJ(`/api/projects/${p.id}/color`, { color: color || null }).catch((e) => ({ error: e.message }));
    if (r?.error) return uiAlert(`Could not change the colour: ${r.error}`);
    p.color = r.color || undefined;
    const gp = G.projects.find((x) => x.id === p.id); if (gp) gp.color = p.color;
    for (const sw of box.querySelectorAll('.pj-sw')) { const on = sw.classList.contains('custom') ? !!p.color && !PROJ_COLORS.includes(p.color) : (sw.dataset.c || '') === (p.color || ''); sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); }
    const cus = $('.pj-sw.custom', box); if (cus) cus.style.setProperty('--sw', p.color && !PROJ_COLORS.includes(p.color) ? p.color : 'transparent');
    const tt = $('.pj-title', box); if (p.color) tt.style.setProperty('--pcx', p.color); else tt.style.removeProperty('--pcx');
    refreshSidebar();
    for (const ch of G.open.values()) if (ch.projectId === p.id) renderChatHead(ch);
    const land = $('.landing'); if (land) renderLanding(land.parentElement);
  };
  for (const sw of box.querySelectorAll('.pj-sw[data-c]')) sw.onclick = () => setColor(sw.dataset.c);
  const picker = $('.pj-sw.custom input', box); picker.onchange = () => setColor(picker.value);
  $('.pj-move', box).onclick = async () => { dlg.close(); await editProject(p, { reselect: p.missing || p.needsFolder }); };
  const del = $('.pj-del', box); if (del) del.onclick = async () => { dlg.close(); await deleteProject(p); };
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
  if (!dlg.open) dlg.showModal();
  if (focusOn === 'budget') $('#pjBudgetSec', box).scrollIntoView({ block: 'start' });
}
// The strip under a project's name: one box with its spend (a meter when it has a budget) and its + ⚙ 🗑 buttons.
function budgetLine(p, n, cost, share, acts = '') {
  const usd = (v) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
  if (p.budget == null) return `<div class="sb-pstrip none"><div class="sb-pmeta"><span class="pm-chats">${n} chat${n === 1 ? '' : 's'}</span><span class="pm-dot">·</span><span class="pm-spent" title="Spent so far by this project's chats">${usd(cost)}</span><span class="pm-nolim">no limit</span></div>${acts}</div>`;
  const pct = Math.round(share * 100), state = share >= 1 ? 'full' : share >= 0.85 ? 'near' : 'ok';
  return `<div class="sb-pstrip ${state}"><button type="button" class="sb-budget sb-pmeter ${state}" title="${n} chat${n === 1 ? '' : 's'} · ${usd(cost)} of the $${p.budget.toFixed(2)} budget · ${state === 'full' ? 'budget reached' : `${pct}% used, $${Math.max(0, p.budget - cost).toFixed(2)} left`} · click for project settings">
      <span class="pmm-top"><span class="pmm-used">${usd(cost)} <small>/ $${p.budget.toFixed(p.budget < 10 ? 2 : 0)}</small></span><span class="pmm-left">${state === 'full' ? 'Full' : `${pct}%`}</span></span>
      <span class="pmm-bar"><i style="width:${Math.min(100, share * 100).toFixed(1)}%"></i></span>
    </button>${acts}</div>`;
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
      if (q) { spent = q.spent || 0; serverBusy = !!q.running; Object.assign(p, { spent, budget: q.budget, running: q.running }); }
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
function rowHTML(m, i) {
  const p = providerOf(m.id), fav = (G.favModels?.[m.kind] || []).includes(m.id);
  const caps = [(m.in || []).includes('image') && m.kind !== 'image' ? ['👁', 'Sees images'] : null, m.tools ? ['🧰', 'Uses tools'] : null, m.reasoning ? ['🧠', 'Reasoning'] : null, (m.in || []).includes('audio') ? ['🎙', 'Hears audio'] : null, m.voices?.length ? ['🗣', `${m.voices.length} voices`] : null].filter(Boolean);
  return `<div class="mp-row ${m.id === PK.current ? 'cur' : ''}" role="option" data-i="${i}" data-id="${esc(m.id)}" aria-selected="false" title="${esc(m.desc || priceText(m))}">
    <span class="mp-ava" style="--h:${hue(p)}" title="${esc(PROVIDER_NAME(p))}">${esc(initials(PROVIDER_NAME(p)))}</span>
    <span class="mp-main"><span class="mp-name">${recDot(m, PK.kind)} ${esc(cleanName(m))}${m.id === PK.current ? ' <span class="mp-tag cur">current</span>' : ''}</span><span class="mp-id">${esc(m.id)}</span></span>
    <span class="mp-caps">${caps.map(([i2, t]) => `<span title="${t}">${i2}</span>`).join('')}</span>
    <span class="mp-meta">${m.ctx ? `<span title="Context window">${ctxText(m.ctx)}</span>` : ''}${m.created ? `<span title="${new Date(m.created * 1000).toLocaleDateString()}">${agoDate(m.created)}</span>` : ''}</span>
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
  const brand = $('#brandHome'), sep = $('.top-sep', top) || null, bits = ['#spend', '#staleNote'].map((q) => $(q)).filter(Boolean);
  const upd = $('#updNote'), btns = ['#restartBtn', '#themeBtn', '#settingsBtn'].map((q) => $(q)).filter(Boolean);
  // The ☰ panel toggle leads the title row on wider screens; phones keep it beside the search.
  const tog = $('#sbCollapseBtn'), tools = $('.sb-tools');
  if (desk) { title.append(brand, ...bits); if (tog) title.prepend(tog); foot.append(...(upd ? [upd] : []), ...btns); return; }
  if (tog && tools) tools.prepend(tog);
  top.prepend(brand);
  if (sep) sep.after(...bits, ...(upd ? [upd] : [])); else top.append(...bits, ...(upd ? [upd] : []));
  top.append(...btns);
}
// 🏠 Home (sidebar, rail, and the app name in the top bar): back to the start screen. Lit while you're on it.
function goHome() { withTransition(showLanding); closeDrawer(); if (isPhone()) setMView('chat'); }
function syncHome() { const on = !G.panes.length; for (const b of document.querySelectorAll('#homeBtn, #railHome')) { b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); } }
function renderLanding(box) {
  const recent = [...G.chats].filter((c) => c.messages > 0).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 6);
  const projName = (id) => G.projects.find((p) => p.id === id)?.name || id;
  // Projects you used most recently first; six show until you ask for the rest.
  const lastUsed = (id) => Math.max(0, ...G.chats.filter((c) => (c.projectId || 'scratch') === id).map((c) => c.lastAt || 0));
  const projects = [...G.projects].sort((a, b) => lastUsed(b.id) - lastUsed(a.id));
  const last = G.landingProject && G.projects.some((p) => p.id === G.landingProject) ? G.landingProject : (recent[0]?.projectId || 'scratch');
  box.innerHTML = `<section class="landing">
    <div class="ld-hero">
      <div class="ld-mark">◆</div>
      <h1>What are we building?</h1>
      <p>Start a chat in a project, or pick up where you left off.</p>
      <div class="ld-start">
        <label class="ld-proj"><span>📁</span><select id="ldProject" aria-label="Project">${G.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === last ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <button type="button" class="ld-new">＋ New chat</button>
        <span class="ld-or">or</span>
        <button type="button" class="ld-folder" title="Pick any folder on this PC: a chat opens in its project (one is made for it if it has none)">📂 Open folder…</button>
      </div>
      <p class="ld-folder-err" role="alert" hidden></p>
    </div>
    ${G.starters?.length ? `<h2 class="ld-h">Start from a template</h2><div class="ld-starters">${G.starters.map((t) => `<button type="button" class="ld-starter" data-starter="${esc(t.name)}" title="${esc(t.description)}"><span class="ld-st-mark" style="--h:${hue(t.name)}">${esc(initials(starterName(t.name)))}</span><span class="ld-st-main"><b>${esc(starterName(t.name))}</b><small>${esc(t.description.split(/[:;(]/)[0].trim())}</small></span></button>`).join('')}</div>` : ''}
    ${recent.length ? `<h2 class="ld-h">Recent chats</h2><div class="ld-recent">${recent.map((c) => `<button type="button" class="ld-chat" data-c="${esc(c.id)}"><span class="sb-chat-avatar" style="--h:${hue(c.title)}">${esc(initials(c.title))}</span><span class="ld-chat-main"><b>${esc(c.title)}</b><small><span class="ld-chat-proj" style="${projStyle(G.projects.find((x) => x.id === c.projectId) || { name: projName(c.projectId) })}">${esc(projName(c.projectId))}</span> · ${ago(c.lastAt || Date.now())}</small></span><span class="ld-cost">$${(c.cost || 0).toFixed(3)}</span></button>`).join('')}</div>` : ''}
    <h2 class="ld-h">Projects</h2>
    <div class="ld-projects">${projects.slice(0, G.landingAllProjects ? projects.length : 6).map((p) => {
      const n = G.chats.filter((c) => (c.projectId || 'scratch') === p.id && c.messages > 0).length, spent = p.spent || 0;
      const share = p.budget ? Math.min(1, spent / p.budget) : 0, state = share >= 1 ? 'full' : share >= 0.8 ? 'near' : 'ok';
      return `<div class="ld-project" style="${projStyle(p)}"><div class="ld-p-top"><b>${esc(p.name)}</b><button type="button" class="ld-p-set" data-set="${esc(p.id)}" title="Project settings">${ICO.gear}</button></div>
        <small>${n} chat${n === 1 ? '' : 's'} · $${spent.toFixed(3)}${p.budget != null ? ` of $${p.budget.toFixed(2)}` : ' · no limit'}</small>
        ${p.budget != null ? `<span class="ld-bar ${state}"><i style="width:${(share * 100).toFixed(1)}%"></i></span>` : ''}
        <button type="button" class="ld-p-new" data-new="${esc(p.id)}">＋ New chat here</button></div>`;
    }).join('')}</div>
    ${projects.length > 6 ? `<button type="button" class="ld-more" aria-expanded="${!!G.landingAllProjects}">${G.landingAllProjects ? 'Show fewer' : `Show all ${projects.length} projects`}</button>` : ''}
    <p class="ld-tips">Tips: type <kbd>@</kbd> to add files or other chats as context, <kbd>/</kbd> for commands, and ⚙ for settings.</p>
  </section>`;
  const more = $('.ld-more', box);
  if (more) more.onclick = () => { const y = $('.landing', box).scrollTop; G.landingAllProjects = !G.landingAllProjects; renderLanding(box); $('.landing', box).scrollTop = y; };
  $('.ld-new', box).onclick = () => { G.landingProject = $('#ldProject', box).value; newChat(G.landingProject); };
  $('.ld-folder', box).onclick = () => openFolderAsProject($('.ld-folder', box), $('.ld-folder-err', box));
  for (const b of box.querySelectorAll('.ld-chat')) b.onclick = () => { showChat(b.dataset.c); if (isPhone()) setMView('chat'); };
  for (const b of box.querySelectorAll('[data-new]')) b.onclick = () => newChat(b.dataset.new);
  for (const b of box.querySelectorAll('[data-set]')) b.onclick = () => openProjectSettings(G.projects.find((p) => p.id === b.dataset.set));
  // A template card starts a NEW project in a folder of its own (never inside the project you used last).
  for (const b of box.querySelectorAll('[data-starter]')) b.onclick = () => startFromTemplate(b.dataset.starter, b);
}
// A template → a new project: pick where it goes, name its folder, and the harness makes <where>/<name>, copies the
// template in and opens a chat there with the message started (you say what to build).
async function startFromTemplate(tpl, btn) {
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
async function openFolderAsProject(btn, errEl) {
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
  if (known) { G.landingProject = known.id; return newChat(known.id); }
  const made = await postJ('/api/projects', { id: `p${Date.now().toString(36)}`, name: baseName(r.path), path: r.path });
  if (made.error) { if (errEl) { errEl.textContent = made.error; errEl.hidden = false; } return; }
  await refreshSidebar();
  G.landingProject = made.id;
  await newChat(made.id);
}
// ---------- the pane's tabs: icons only when their names don't fit (the servers and full-width buttons stay on) ----------
(() => {
  const bar = document.getElementById('paneTabs'); if (!bar || !window.ResizeObserver) return;
  let w = -1;
  const fit = () => {
    if (bar.clientWidth === w) return; w = bar.clientWidth;
    bar.classList.remove('icons-only');
    if (bar.scrollWidth > bar.clientWidth + 1) bar.classList.add('icons-only');
  };
  new ResizeObserver(fit).observe(bar);
  new MutationObserver(() => { w = -1; fit(); }).observe(bar, { subtree: true, childList: true, characterData: true }); // counts and dots change the width
})();
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
function ask(message, { ok, cancel = 'Cancel', danger, input = null, alertOnly = false } = {}) {
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
      <footer>${alertOnly ? '' : `<button type="button" class="ask-cancel">${esc(cancel)}</button>`}<button type="submit" class="ask-ok ${danger ? 'danger' : ''}">${esc(ok)}</button></footer>
    </form>`;
    document.body.appendChild(d);
    const no = input != null ? null : alertOnly;
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; d.close(); d.remove(); resolve(v); };
    $('.ask-cancel', d)?.addEventListener('click', () => done(no));
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
const PROJ_COLORS = ['#2fb36f', '#1fc8db', '#60a5fa', '#a78bfa', '#f472b6', '#f59e0b', '#ef4444', '#e5e7eb'];
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
function tipText(t) { return t.dataset.ohTitle ?? t.getAttribute('data-tip') ?? ''; }
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
      else if (tab > 0) { el.className = 'tip-row'; const a = document.createElement('span'), b = document.createElement('b'); a.textContent = l.slice(0, tab); b.textContent = l.slice(tab + 1); el.append(a, b); }
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
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const t = e.target.closest?.('[data-oh-title], [data-tip], [title]');
  if (t === TIP.target) return;
  hideTip();
  if (!t || t.closest('.oh-tip')) return;
  if (t.hasAttribute('title')) adoptTitle(t);
  if (!tipText(t).trim()) return;
  TIP.target = t;
  TIP.timer = setTimeout(() => TIP.target === t && showTip(t), Date.now() - TIP.hidAt < 400 ? 0 : 450);
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
  msgs.addEventListener('scroll', () => { c.follow = nearEnd(); jump.hidden = c.follow; }, { passive: true });
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
            <span class="dir-a-crumb-sep">/</span>
            <span class="dir-a-msgs-count"></span>
          </div>
          <div class="dir-a-meta-chips">
            <span class="ch-model-badge model-badge-violet" title="This chat's model (change it in the message box)"></span>
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
        <div class="cmp-control-rack"><div class="cbar"></div><div class="toolbar cmp-tools-wrap" aria-label="Tools the agent may use"></div></div>
        <div class="attachments cmp-attachments-tray"></div>
        <div class="suggest cmp-suggest-popup" role="listbox" hidden></div>
        <div class="composer-row cmp-input-row">
          <textarea class="input cmp-textarea" rows="1" placeholder="Ask, or ask for something to be built…  @ to add files or chats · / for commands"></textarea>
          <div class="composer-actions cmp-bottom-bar">
            <div class="cmp-actions-left">
              <button type="button" class="cmp-act-btn imgBtn attachBtn" title="Attach files of any kind: documents, PDFs, spreadsheets, code, images… (or paste / drop them)" aria-label="Attach files">${CMP_ICO.attach}</button>
              <input type="file" class="imgInput" multiple hidden>
              <button type="button" class="cmp-act-btn micBtn" title="Speak your message (transcribed into the box)" aria-label="Speak your message">${CMP_ICO.mic}</button>
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
  $('.ch-delete', root).onclick = () => deleteChat(c.id);
  // On a phone ◧ switches between the chat and what it built; on a desktop the pane is always there.
  $('.ch-pane', root).onclick = () => setMView(G.mview === 'preview' ? 'chat' : 'preview');
  const form = $('.composer', root), ta = $('.input', root);
  form.addEventListener('submit', () => setTimeout(() => fitInput(ta))); // the box shrinks back once it's cleared
  form.onsubmit = (e) => { e.preventDefault(); const t = ta.value; if (/^\/\w+(\s|$)/.test(t.trim()) && runCommand(c, t.trim())) { ta.value = ''; return; } if (c.running?.runId && (t.trim() || c.images.length || c.docs?.length || c.ctx.length)) { ta.value = ''; steer(c, t.trim()); return; } if (t.trim() && !c.running) { if (folderMissing(c)) return; if ((c.docs || []).some((d) => d.busy)) { uiAlert('Some attached files are still being read. Send when their chips say they are ready.'); return; } ta.value = ''; send(c, t); } };
  ta.onkeydown = (e) => { if (suggestKey(c, e)) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } };
  ta.oninput = () => { updateSuggest(c); fitInput(ta); };
  ta.onblur = () => setTimeout(() => hideSuggest(c), 150);
  ta.onpaste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(c, files); } };
  root.ondragover = (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); root.classList.add('drop'); } };
  root.ondragleave = () => root.classList.remove('drop');
  root.ondrop = (e) => { root.classList.remove('drop'); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(c, e.dataTransfer.files); } };
  $('.imgBtn', root).onclick = () => $('.imgInput', root).click();
  $('.imgInput', root).onchange = (e) => { addFiles(c, e.target.files); e.target.value = ''; };
  $('.micBtn', root).onclick = () => toggleMic(c);
  $('.stopBtn', root).onclick = () => c.running?.abort();
}
function chatTotals(c) {
  const done = c.agent.messages.filter((m) => m.role === 'assistant' && m.stats);
  return { cost: done.reduce((s, m) => s + m.stats.cost, 0) + (c.agent.extraUsage || []).reduce((s, x) => s + (x.cost || 0), 0), replies: done.length, msgs: c.agent.messages.filter((m) => m.role === 'user').length };
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
  $('.dir-a-msgs-count', r).textContent = `${t.msgs} msg${t.msgs === 1 ? '' : 's'}`;
  $('.ch-model-badge', r).textContent = short(c.agent.setup.model);
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
  bar.innerHTML = `
    <button type="button" class="mbtn model cmp-model-chip" title="Model for this chat: ${esc(priceOf(s.model))} (click to pick any model)">${recDot(s.model, 'chat')} ${esc(short(s.model))} <small>${esc(shortPrice(s.model))}</small></button>
    ${reasonMenuHTML(s)}
    ${creativityMenuHTML(s)}
    <div class="seg perm cmp-perm-switch" title="How much permission this chat's agent asks for">
      <button type="button" data-approval="strict" class="${c.approval === 'strict' ? 'on' : ''}" title="Asks before every tool it uses">🔒 Strict</button>
      <button type="button" data-approval="yolo" class="${c.approval === 'yolo' ? 'on' : ''}" title="Uses its tools without asking (budget cap still applies)">⚡ YOLO</button>
    </div>
    <label class="sq-check cmp-follow" title="Follow the agent: when it opens or checks a page in its browser, or starts a site or app, the Browser tab switches to it so you can watch. Off: the pane stays where you put it (all chats)."><input type="checkbox" class="follow-agent" ${G.followAgent !== false ? 'checked' : ''}><span>Follow</span></label>
    <span class="mode-note cmp-budget" title="Paid tools stop before going over this per reply (⚙ Settings)">budget $${G.settings.budget}/reply</span>
    <button type="button" class="cmp-more ${G.chatOpts ? 'on' : ''} ${c.approval === 'yolo' ? 'yolo' : ''}" aria-expanded="${!!G.chatOpts}" title="${G.chatOpts ? 'Hide' : 'Show'} this chat's settings: reasoning, creativity, Strict / YOLO (${esc(REASON_INFO[s.reasoning]?.[0] || s.reasoning || 'default')} · ${esc(CREATIVITY_INFO[s.creativity]?.[0] || 'Default')} · ${c.approval === 'yolo' ? 'YOLO' : 'Strict'})" aria-label="This chat's settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></button>`;
  bar.closest('.cmp-control-rack')?.classList.toggle('opts-open', !!G.chatOpts);
  $('.cmp-more', bar).onclick = () => { G.chatOpts = !G.chatOpts; savePrefs(); for (const ch of G.open.values()) renderComposerBar(ch); };
  $('.model', bar).onclick = async () => { const id = await pickModel('chat', s.model, { context: `For “${clip(c.title, 40)}”` }); if (id) { s.model = id; saveChat(c); renderComposerBar(c); renderChatHead(c); } };
  wireReasonMenu(c, bar);
  $('.follow-agent', bar).onchange = (e) => { G.followAgent = e.target.checked; savePrefs(); for (const ch of G.open.values()) if (ch !== c) renderComposerBar(ch); };
  for (const b of bar.querySelectorAll('.perm button')) b.onclick = () => { c.approval = b.dataset.approval; saveChat(c); renderComposerBar(c); if (c.running?.runId) postJ(`/api/runs/${c.running.runId}/mode`, { approval: c.approval }).catch(() => {}); };
  renderAllowed(c);
}
// ---------- usage (per chat): every model this chat paid for, grouped by kind of call ----------
const USAGE_KIND = {
  writer: ['💬', 'Chat model'], strong: ['💬', 'Chat model (strong)'], summary: ['🗜', 'Summaries'], decider: ['⚖️', 'Deciders · checks, look, decide'],
  reviewer: ['🔍', 'Reviewer'], helper: ['🧭', 'Helpers'], freshEyes: ['👀', 'Fresh eyes'],
  image: ['🖼', 'Pictures'], video: ['🎬', 'Video'], music: ['🎵', 'Music'], speech: ['🗣', 'Voice'], listen: ['🎤', 'Mic (speech to text)'], media: ['🎨', 'Media'],
};
function chatUsage(c) {
  const rows = new Map(), add = (kind, model, v) => {
    const k = `${kind}|${model}`, r = rows.get(k) || { kind, model, calls: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
    r.calls += v.calls || 0; r.cost += v.cost || 0; r.tokensIn += v.tokensIn || 0; r.tokensOut += v.tokensOut || 0; rows.set(k, r);
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
        ${rs.map((r) => `<div class="uc-row"><span class="uc-model" title="${esc(r.model)}">${esc(short(r.model))}</span><span class="uc-calls">${r.calls}×${r.tokensIn || r.tokensOut ? ` · ${tok(r.tokensIn)} in / ${tok(r.tokensOut)} out` : ''}</span><span class="uc-cost">${money(r.cost, 5)}</span><span class="uc-bar"><i style="width:${pct(r.cost)}%"></i></span></div>`).join('')}</div>`;
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
// Reasoning effort: a menu in the app's own style (not the system dropdown), aware of what the model supports.
const REASON_INFO = { off: ['Off', 'Answers straight away. Fastest and cheapest.'], low: ['Low', 'A little thinking before answering.'], medium: ['Medium', 'Thinks through multi-step work.'], high: ['High', 'Thinks longest. Slowest and costs the most.'], default: ['Model default', 'Whatever the model does by default.'] };
function reasonMenuHTML(s) {
  const m = G.byId.get(s.model), unsupported = m && m.kind === 'chat' && m.reasoning === false;
  const v = unsupported ? 'off' : s.reasoning || 'off';
  return `<div class="rs-wrap" data-key="reasoning">
    <button type="button" class="rs-btn cmp-reason-group ${unsupported ? 'na' : ''} ${v !== 'off' ? 'thinking' : ''}" aria-haspopup="listbox" aria-expanded="false" title="${unsupported ? 'This model has no reasoning setting' : 'How much the model thinks before answering'}">🧠 <span>${unsupported ? 'No reasoning' : `Reasoning: ${REASON_INFO[v][0].toLowerCase()}`}</span><i aria-hidden="true">▾</i></button>
    <div class="rs-pop" role="listbox" aria-label="Reasoning" hidden>
      <div class="rs-head">Reasoning for this chat${unsupported ? '<small>This model has no reasoning setting; these apply if you switch to one that does.</small>' : ''}</div>
      ${Object.entries(REASON_INFO).map(([k, [name, note]]) => `<button type="button" class="rs-opt ${k === (s.reasoning || 'off') ? 'on' : ''}" role="option" aria-selected="${k === (s.reasoning || 'off')}" data-v="${k}"><span class="rs-name">${name}</span><span class="rs-note">${note}</span><span class="rs-check" aria-hidden="true">✓</span></button>`).join('')}
    </div></div>`;
}
// Creativity (per chat): how varied the answers are. "Default" sends no temperature, so each model uses its own.
const CREATIVITY_INFO = { default: ['Default', "The model's own setting. Right for most work."], focused: ['Focused', 'Steadier, more predictable answers. Good for fixes and data.'], creative: ['Creative', 'More varied ideas. Good for games, designs and writing.'] };
function creativityMenuHTML(s) {
  const v = CREATIVITY_INFO[s.creativity] ? s.creativity : 'default';
  const m = G.byId.get(s.model), claudeThinking = /^anthropic\//.test(s.model) && (s.reasoning || 'off') !== 'off';
  const noTemp = m && m.kind === 'chat' && m.temp === false;
  const why = noTemp ? 'This model has no temperature setting, so this has no effect on it.' : claudeThinking ? 'Claude with reasoning on only takes Creative; Focused is skipped.' : '';
  return `<div class="rs-wrap cr-wrap" data-key="creativity">
    <button type="button" class="rs-btn cmp-creativity ${v !== 'default' ? 'thinking' : ''} ${noTemp ? 'na' : ''}" aria-haspopup="listbox" aria-expanded="false" title="How varied the answers are">🎨 <span>Creativity: ${CREATIVITY_INFO[v][0].toLowerCase()}</span><i aria-hidden="true">▾</i></button>
    <div class="rs-pop" role="listbox" aria-label="Creativity" hidden>
      <div class="rs-head">Creativity for this chat${why ? `<small>${why}</small>` : ''}</div>
      ${Object.entries(CREATIVITY_INFO).map(([k, [name, note]]) => `<button type="button" class="rs-opt ${k === v ? 'on' : ''}" role="option" aria-selected="${k === v}" data-v="${k}"><span class="rs-name">${name}</span><span class="rs-note">${note}</span><span class="rs-check" aria-hidden="true">✓</span></button>`).join('')}
    </div></div>`;
}
// Wires every dropdown in the message box (Reasoning, Creativity); each sets its own key on the chat's setup.
function wireReasonMenu(c, bar) { for (const wrap of bar.querySelectorAll('.rs-wrap')) wireSetupMenu(c, wrap); }
function wireSetupMenu(c, wrap) {
  const btn = $('.rs-btn', wrap), pop = $('.rs-pop', wrap), key = wrap.dataset.key || 'reasoning';
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  btn.onclick = () => { if (!pop.hidden) return close(); pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); document.addEventListener('pointerdown', outside, true); $('.rs-opt.on', pop)?.focus(); };
  pop.onkeydown = (e) => {
    const opts = [...pop.querySelectorAll('.rs-opt')], i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); opts[(i + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length].focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); }
  };
  for (const o of pop.querySelectorAll('.rs-opt')) o.onclick = () => { c.agent.setup[key] = o.dataset.v; saveChat(c); close(); renderComposerBar(c); };
}
// The quality tools for one reply: on/off from this chat's 🧰, models and strength from ⚙ Settings.
function qualitySettings(c) {
  const t = { ...DEFAULT_CHAT_TOOLS, ...c.tools };
  return {
    review: t.reviewer ? (G.settings.review && G.settings.review !== 'off' ? G.settings.review : 'builds') : 'off',
    freshEyes: t.freshEyes !== false,
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
          <span class="cmp-tp-info"><span class="cmp-tp-top"><span class="cmp-tp-name">${q.icon} ${q.name} <span class="q-cost">${esc(q.perBuild())}</span></span><button type="button" class="cmp-tp-model q-pick" data-q="${k}" title="${esc(m)} · ${esc(priceOf(m))} (all chats)">${recDot(m, q.kind)} ${esc(short(m))} <small>${esc(shortPrice(m))}</small> <i>▾</i></button></span>
          <span class="cmp-tp-note">${esc(q.note)}${k === 'reviewer' || k === 'freshEyes' ? ` <span class="q-tier" role="group" aria-label="${q.name} strength">${[['cheap', 'Cheap'], ['strong', 'Strong']].map(([v, l]) => { const tierKey = k === 'reviewer' ? 'reviewTier' : 'freshEyesTier', modelKey = k === 'reviewer' ? 'reviewModel' : 'freshEyesModel'; return `<button type="button" class="q-tier-btn ${!G.settings[modelKey] && (G.settings[tierKey] || 'cheap') === v ? 'on' : ''}" data-q="${k}" data-tier="${v}" title="${v === 'cheap' ? (k === 'reviewer' ? 'gpt-6-luna: about $0.003 a build' : 'the helper model: fast, about $0.001 a look') : 'Claude Sonnet 5.5: stronger, about $0.01–0.02'}">${l}</button>`; }).join('')}</span>` : ''}</span></span></label>`;
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
          <span class="cmp-tp-note">${esc(note.replace(/^paid;?\s*/, '') || 'costs money per use')}</span></span></label>`;
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
  for (const cb of menu.querySelectorAll('input[data-tool]')) cb.onchange = () => { c.tools[cb.dataset.tool] = cb.checked; saveChat(c); const keep = !menu.hidden; renderChatTools(c); if (keep) $('.tools-btn', box).click(); };
  // The quality tools: on/off for this chat; their models and the reviewer's strength apply to all chats.
  const reopen = () => { const keep = !menu.hidden; renderToolbars(); if (keep) $('.tools-btn', $('.toolbar', c.el.root))?.click(); };
  for (const cb of menu.querySelectorAll('input[data-qtool]')) cb.onchange = () => { c.tools[cb.dataset.qtool] = cb.checked; saveChat(c); reopen(); };
  for (const b of menu.querySelectorAll('.q-tier-btn')) b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (b.dataset.q === 'freshEyes') { G.settings.freshEyesTier = b.dataset.tier; G.settings.freshEyesModel = ''; } else { G.settings.reviewTier = b.dataset.tier; G.settings.reviewModel = ''; } savePrefs(); reopen(); };
  for (const b of menu.querySelectorAll('.q-pick')) b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const k = b.dataset.q, q = QUALITY_INFO[k];
    const id = await pickModel(q.kind, q.model(), { context: k === 'freshEyes' ? 'Fresh eyes (all chats): it must use tools' : k === 'reviewer' ? 'Reviewer (all chats): it must use tools and see images' : k === 'deciders' ? 'Decider for screenshot checks (all chats): it must read images' : 'Helper model (all chats): it must use tools' });
    if (id) { if (k === 'reviewer') G.settings.reviewModel = id; else if (k === 'freshEyes') G.settings.freshEyesModel = id; else if (k === 'helpers') G.settings.helperModel = id; else G.settings.lookVoters = [id]; savePrefs(); }
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
    el.innerHTML = `<div class="utext"></div>${m.imgs?.length ? `<div class="u-imgs" data-views="${esc(JSON.stringify(m.imgViews || []))}">${m.imgs.map((u, k) => `<img src="${u}" alt="attached picture" data-k="${k}" title="Click to see it large">`).join('')}</div>` : ''}${m.docs?.length ? `<div class="u-docs">${m.docs.map((d) => `<button type="button" class="u-doc" data-doc="${esc(JSON.stringify(d))}" title="${esc(d.name)} · ${esc(docSize(d.size))} · click to preview">${DOC_ICON[d.kind] || '📄'} ${esc(d.name)}</button>`).join('')}</div>` : ''}${m.ctx?.length ? `<div class="ctx-used">${m.ctx.map((t) => `<span>📎 ${esc(t)}</span>`).join('')}</div>` : ''}${m.at ? timeTag(m.at) : ''}`;
    $('.utext', el).innerHTML = md(m.content);
    enhance($('.utext', el));
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
  el.className = 'msg bot';
  el.innerHTML = `<div class="reply-head"></div><div class="plan-slot"></div><div class="timeline"></div><details class="thinking" hidden><summary></summary><div class="think-body"></div></details><div class="body"></div><div class="approvals"></div><button type="button" class="trace-btn mt-btn" title="Open this reply's steps in the side pane" aria-label="Steps"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg></button><div class="foot"></div>`;
  // Only your own clicks decide whether the thinking stays open; otherwise it opens while thinking and folds after.
  $('.thinking > summary', el).addEventListener('click', () => { m.thinkOpen = !$('.thinking', el).open; });
  updateMsg(c, m);
  return el;
}
function wireCopy(btn, text) {
  btn.onclick = async () => { try { await navigator.clipboard.writeText(text() || ''); btn.textContent = '✓'; btn.classList.add('done'); } catch { btn.textContent = '!'; } setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('done'); }, 1300); };
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
function reviewCardsHTML(m) {
  const tr = m.trace || [];
  const reviews = tr.filter((e) => e.t === 'review');
  const running = m.live && tr.findLast((e) => e.t === 'review_start' || e.t === 'review')?.t === 'review_start' ? tr.findLast((e) => e.t === 'review_start') : null;
  return reviews.map((r, i) => {
    const sentBack = !r.pass && (i < reviews.length - 1 || tr.some((e) => e.t === 'sent_back' && e.by === 'reviewer' && e.at >= r.at));
    const verdict = r.pass ? 'Passed' : sentBack ? 'Sent back to fix' : 'Not passed';
    return `<div class="review-card ${r.pass ? 'pass' : 'fail'}">
      <div class="rv-head"><b>🧪 Reviewer</b><span class="rv-model" title="A separate model with a fresh context tested this">${esc(short(r.model))}</span><span class="rv-round">round ${r.round}</span><span class="rv-verdict">${verdict}</span><span class="rv-cost" title="What this review cost">${money(r.cost, 4)}</span></div>
      <div class="rv-scores">${Object.keys(r.scores).map((k) => `<div class="rv-score ${r.scores[k] < r.bar ? 'low' : ''}"><span>${esc(REVIEW_LABEL[k] || k)}</span><span class="rv-pips" aria-label="${r.scores[k]} of 5">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= r.scores[k] ? 'on' : ''}${n === r.bar ? ' bar' : ''}"></i>`).join('')}</span><b>${r.scores[k]}/5</b></div>`).join('')}</div>
      ${r.bugs.length ? `<ul class="rv-bugs">${r.bugs.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${r.summary ? `<p class="rv-sum">${esc(r.summary)}</p>` : ''}
    </div>`;
  }).join('') + (running ? `<div class="review-card running"><div class="rv-head"><b>🧪 Reviewer</b><span class="rv-model">${esc(short(running.model))}</span><span class="rv-verdict">testing ${esc(running.targets.join(', '))}…</span></div></div>` : '');
}
// ---------- the reply timeline ----------
// One-line descriptions of tool calls, in the user's terms: one call names its target, several are counted.
const TL_ONE = {
  read_file: (a) => `Read ${a.path}`, write_file: (a) => `Wrote ${a.path}`, append_file: (a) => `Added to ${a.path}`, edit_file: (a) => `Edited ${a.path}`,
  delete_file: (a) => `Deleted ${a.path}`, list_files: () => 'Listed the files', search_files: (a) => `Searched for "${clip(a.query || '', 40)}"`,
  run_command: (a) => `Ran ${clip([a.command, ...(a.args || [])].join(' '), 50)}`, start_server: (a) => `Started the "${a.name}" server`, stop_server: (a) => `Stopped the "${a.name}" server`,
  preview_site: () => 'Opened the site preview', browser: (a) => (a.action === 'open' ? `Opened ${a.target}` : `Browser: ${a.action}${a.key ? ` ${a.key}` : ''}`),
  look: () => 'Checked the page with the judges', decide: (a) => `Asked the deciders ${a.questions?.length || ''} question${a.questions?.length === 1 ? '' : 's'}`.replace('  ', ' '),
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
  const tr = m.trace || [], items = [], helpers = new Map();
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
    if (e.t === 'review_start') { rv = null; continue; }
    if (e.t === 'fresh_eyes') { items.push({ kind: 'note', text: `👀 Fresh eyes (${short(e.model)}) ${e.ok ? `on a problem that came back: ${clip((e.report || '').split('\n')[0].replace(/^Cause:\s*/i, ''), 220)}` : 'looked but found nothing'}` }); continue; }
    if (e.t === 'helper_done') { const h = helpers.get(e.id); if (h) { h.label = `Helper ${e.id} ${e.ok ? 'reported back' : 'gave no report'} · ${e.steps} step${e.steps === 1 ? '' : 's'} · ${money(e.cost, 4)}`; h.done = true; } continue; }
    if (e.t === 'approval') {
      // Waiting for you: a card where it happened. Answered (or being checked): a badge on the tool call it was about.
      const a = m.approvals?.[e.id], waiting = a && !a.outcome && a.card.mode === 'strict' && m.live;
      const pool = blk?.calls || [];
      const call = !waiting && a && ([...pool].reverse().find((y) => !y.approval && y.e.name === e.tool) || [...pool].reverse().find((y) => !y.approval));
      if (call) { call.approval = e.id; continue; }
      items.push({ kind: 'card', html: () => (m.approvals?.[e.id] ? approvalHTML(m.approvals[e.id], !!m.live) : '') }); continue;
    }
    if (e.t === 'question') { items.push({ kind: 'card', html: () => (m.questions?.[e.id] ? questionHTML(m.questions[e.id], !!m.live) : '') }); continue; }
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
    if (it.kind === 'card') { other(it.html()); continue; }
    if (it.kind === 'steer') {
      const att = (m.steerAtt || []).find((x) => x.text === it.e.text && !usedAtt.has(x)) || null;
      if (att) usedAtt.add(att);
      other(`<div class="steer-card ${it.read ? 'read' : ''}"><span class="sc-who">You, while it worked</span><p>${esc(it.e.text)}</p>${att?.imgs?.length ? `<div class="u-imgs" data-views="${esc(JSON.stringify(att.imgViews || []))}">${att.imgs.map((u, k) => `<img src="${u}" alt="attached picture" data-k="${k}">`).join('')}</div>` : it.e.images ? `<span class="sc-att">📎 ${it.e.images} picture${it.e.images > 1 ? 's' : ''}</span>` : ''}${att?.docs?.length ? `<div class="u-docs">${att.docs.map((d) => `<button type="button" class="u-doc" data-doc="${esc(JSON.stringify(d))}" title="${esc(d.name)} · ${esc(docSize(d.size))} · click to preview">${DOC_ICON[d.kind] || '📄'} ${esc(d.name)}</button>`).join('')}</div>` : it.e.docs ? `<span class="sc-att">📎 ${it.e.docs} file${it.e.docs > 1 ? 's' : ''}</span>` : ''}<span class="sc-state">${it.read ? '✓ read by the agent' : '… it reads this at its next step'}</span></div>`);
      continue;
    }
    if (it.kind === 'note') other(`<div class="tl-note">${esc(clip(it.text, 220))}</div>`);
  }
  // Four or more lines in a row with nothing said between them fold into one line ("Wrote 7 files, ran 7 commands ·
  // thought 6 times"); open it to see each. While the reply works, its newest line stays outside so you see what it's doing.
  const out = [];
  for (let k = 0; k < pieces.length;) {
    if (!pieces[k].row) { out.push(pieces[k++].html); continue; }
    let e = k; while (e < pieces.length && pieces[e].row) e++;
    let run = pieces.slice(k, e);
    const tail = m.live && e === pieces.length ? run.splice(-1) : [];
    if (run.length >= 4) {
      const calls = run.flatMap((x) => x.calls), thinks = run.reduce((n, x) => n + x.think, 0);
      const errs = calls.filter((x) => x.res != null && /^Error/.test(x.res)).length;
      const label = [calls.length ? callsLabel(calls) : '', thinks ? `${calls.length ? 'thought' : 'Thought'} ${thinks} time${thinks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      out.push(det(`b-${run[0].key}`, 'tl-row tl-bundle', `<span class="tl-ic">🗂</span><span class="tl-label">${esc(label)}</span><small class="tl-words">${run.length} steps</small>${run.some((x) => x.busy) ? '<span class="tl-spin" aria-label="running"></span>' : ''}${errs ? `<span class="tl-err">${errs} error${errs > 1 ? 's' : ''}</span>` : ''}`, `<div class="tl-bundle-body">${run.map((x) => x.html).join('')}</div>`));
    } else out.push(...run.map((x) => x.html));
    out.push(...tail.map((x) => x.html));
    k = e;
  }
  return out.join('');
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
// Notes you sent while the agent worked, and whether it has read them yet.
function steerCardsHTML(m) {
  const tr = m.trace || [];
  const notes = tr.filter((e) => e.t === 'steer');
  if (!notes.length) return '';
  const read = tr.filter((e) => e.t === 'steer_delivered').reduce((n, e) => n + (e.count || 1), 0);
  return notes.map((e, i) => `<div class="steer-card ${i < read ? 'read' : ''}"><span class="sc-who">You, while it worked</span><p>${esc(e.text)}</p><span class="sc-state">${i < read ? '✓ read by the agent' : '… it reads this at its next step'}</span></div>`).join('');
}
function updateMsg(c, m, { bodyOnly = false } = {}) {
  const el = m.el;
  if (!el) return;
  const body = $('.body', el);
  body.innerHTML = m.error ? `${md(m.content)}<p class="err">⚠ ${esc(m.error)}</p>` : md(m.content) || (m.live ? '' : '<p class="err">(no reply)</p>');
  body.classList.toggle('typing', !!m.live);
  enhance(body);
  drawThinking(m);
  // The card's colour says what state the reply is in: working, waiting for you, or failed.
  const waiting = Object.values(m.approvals || {}).some((a) => !a.outcome);
  el.classList.toggle('is-live', !!m.live && !waiting);
  el.classList.toggle('is-waiting', !!m.live && waiting);
  el.classList.toggle('is-error', !!m.error);
  // The badge shows which model wrote this reply.
  const model = (m.trace || []).find((e) => e.t === 'llm_start')?.model || Object.keys(m.stats?.byModel || {}).find((k) => (m.stats.byModel[k].role || 'writer') === 'writer') || c.agent.setup.model;
  el.dataset.who = initials(short(model)).slice(0, 2);
  el.title = '';
  const rh = $('.reply-head', el);
  if (rh) { const h = replyHeadHTML(m, model); if (rh._h !== h) { rh.innerHTML = h; rh._h = h; } }
  if (bodyOnly) return;
  // The plan leads the reply; whatever is asking you (approvals, questions, budget) and the reviews come last,
  // below the thinking and the text, where the newest output is.
  $('.plan-slot', el).innerHTML = planCardHTML(m);
  // Everything the agent did reads in order: its thinking (folded), what it said, one line per step's tool calls
  // (click for each call and its result), and any card that asks you something, right where it happened.
  $('.timeline', el).innerHTML = timelineHTML(m);
  wireTimeline(m, el);
  $('.approvals', el).innerHTML = reviewCardsHTML(m) + outOfStepsHTML(m);
  const oos = $('.oos-card[data-run]', el); if (oos) wireOutOfSteps(oos, c, m);
  for (const card of el.querySelectorAll('.approval[data-id]:not(.question):not(.budget-card)')) wireApproval(card, m);
  for (const card of el.querySelectorAll('.question[data-id]')) wireQuestion(card, m);
  const bcard = $('.budget-card[data-id]', el); if (bcard) wireBudget(bcard, c, m);
  // One chip per artifact this reply made or changed (edits don't add a second chip).
  // Artifacts are reached from the pane's dropdown and the Files view, not as chips under each reply.
  // Steps: a button under the reply; the list of steps opens in the side pane.
  const tb = $('.trace-btn', el);
  // Only when there's something to see: a plain reply's trace is just the model call itself.
  tb.hidden = !(m.trace || []).some((e) => !TRACE_PLAIN.has(e.t));
  const sum = traceSummary(m);
  tb.title = traceTip(m);
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
  $('.foot', el).innerHTML = !s && m.resumable && !m.live ? '<button type="button" class="resume-btn primary" title="Carry on from the last finished step">▶ Resume where it stopped</button>'
    : s ? `<span class="f-cost" title="What the reply cost">${money(s.cost, 5)}</span><span class="f-dur" title="How long the reply took">${secs(s.ms)}</span>${checkTag}${stopTag}${s.changed?.length ? (m.undone ? `<span class="undone undo-undone">↶ ${m.undone === 'partial' ? 'changes undone, except files changed since' : 'changes undone'}</span>` : undoGone(c, m) ? `<span class="undo-gone" title="Undo is kept for the newest ${Number(G.settings?.undoKeep) || 10} replies in a project, for up to ${Number(G.settings?.undoDays) || 7} days (⚙ Settings → Code & servers). Older undo copies are removed.">↶ undo no longer kept</span>` : `<button type="button" class="undo undo-btn" title="Put back the files this reply changed: ${esc(s.changed.filter((f) => !m.undoneFiles?.includes(f)).join(', '))}">↶ Undo changes (${s.changed.length - (m.undoneFiles?.length || 0)})</button>`) : ''}` : '';
  // Right side: ? (the breakdown on hover), 🧭 Steps, then copy and remix.
  const right = document.createElement('span'); right.className = 'f-right';
  if (s) right.insertAdjacentHTML('beforeend', replyInfoHTML(s, when));
  right.append(tb);
  $('.foot', el).append(right);
  if (s && !m.live && !m.runActive) {
    right.insertAdjacentHTML('beforeend', `<span class="msg-tools"><button type="button" class="mt-btn mt-copy" title="Copy this reply (Markdown)" aria-label="Copy reply">${msgIcon('copy')}</button><button type="button" class="mt-btn mt-remix" title="Remix: a new chat in this project with the conversation up to here. Files are not touched." aria-label="Remix in a new chat">${msgIcon('branch')}</button></span>`);
    wireIconCopy($('.foot .mt-copy', el), () => m.content);
    $('.foot .mt-remix', el).onclick = () => remixFrom(c, m);
  }
  const undo = $('.foot .undo', el);
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
  if (!slot) { slot = document.createElement('div'); slot.className = 'review-slot'; $('.foot', el).before(slot); }
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
const TRACE_PLAIN = new Set(['llm_start', 'llm_done', 'done', 'checks', 'mode']);
const kTok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0);
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
function replyInfoHTML(s, when) {
  const k = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0);
  const row = (label, value) => `<span class="fi-row"><span>${label}</span><b>${value}</b></span>`;
  const models = Object.entries(s.byModel || {}).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
  return `<span class="f-info mt-btn" tabindex="0" role="button" aria-label="Reply details"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg><span class="f-pop" role="tooltip">
    ${when ? row('When', esc(new Date(when).toLocaleString())) : ''}
    ${row('Took', secs(s.ms))}${row('Cost', money(s.cost, 5))}
    ${row('Model calls', s.llmCalls || 0)}
    ${s.tokensIn || s.tokensOut ? row('Tokens in', k(s.tokensIn)) + row('Tokens out', k(s.tokensOut)) : ''}
    ${s.decide?.calls ? row('Decider questions', `${s.decide.questions} in ${s.decide.calls} call${s.decide.calls === 1 ? '' : 's'}`) : ''}
    ${s.plan?.of ? row('Plan', `${s.plan.done} of ${s.plan.of} done`) : ''}
    ${s.changed?.length ? row('Files changed', s.changed.length) : ''}
    ${s.mediaSpent ? row('Media', money(s.mediaSpent, 4)) : ''}
    ${models.length ? `<span class="fi-h">By model</span>${models.map(([m, v]) => `<span class="fi-row fi-model"><span>${esc(short(m))}${v.role && v.role !== 'writer' ? ` <i>${esc(v.role)}</i>` : ''}</span><b>${v.calls}× · ${money(v.cost || 0, 4)}</b></span>`).join('')}` : ''}
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
  const f = e.target.closest?.('.f-info'); if (!f) return;
  const src = $('.f-pop', f); if (!src) return;
  const box = replyInfoBox(), r = f.getBoundingClientRect();
  box.innerHTML = src.innerHTML; box.hidden = false;
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  box.style.top = `${r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(innerHeight - h - 8, r.bottom + 8)}px`;
  avoidDesk(box);
}
function hideReplyInfo(e) {
  const f = e.target.closest?.('.f-info'); if (!f || f.contains(e.relatedTarget)) return;
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
async function openFolder(projectId) {
  const r = await fetch('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
  if (r.error) uiAlert(`Could not open the folder: ${r.error}`);
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
  const body = $('#paneBody'), bar = $('#appBar');
  bar.hidden = false;
  bar.innerHTML = `🧭 <b>Steps</b> <span class="dim">${esc(traceSummary(m).replace(/^Steps · /, ''))}</span> <button type="button" class="back" title="Close the trace">✕ Close</button>`;
  $('.back', bar).onclick = closeTrace;
  // Opening a trace starts at its latest step; redrawing the same one keeps your place (and follows new steps while you're at the end).
  const old = $('.trace-pane', body), same = !!old && old.dataset.run === m.runId;
  const top = same ? old.scrollTop : 0, atEnd = !same || old.scrollHeight - old.scrollTop - old.clientHeight < 40;
  const kinds = [...new Set((traceHTML(m).match(/data-k="(\w+)"/g) || []).map((x) => x.slice(8, -1)))];
  // The legend highlights: picked kinds stay bright and everything else dims, so the order and timing stay readable.
  const F = (G.traceFocus ??= new Set());
  for (const k of [...F]) if (!kinds.includes(k)) F.delete(k);
  const legend = TRACE_KINDS.filter(([k]) => kinds.includes(k)).map(([k, label]) => `<button type="button" class="tl-chip k-${k} ${F.has(k) ? 'on' : ''}" data-k="${k}" aria-pressed="${F.has(k)}" title="Highlight these steps (the rest dims)">${label}</button>`).join('')
    + (F.size ? '<button type="button" class="tl-all">Show all</button>' : '');
  body.innerHTML = `<div class="trace trace-pane ${F.size ? 'focusing' : ''} ${[...F].map((k) => `f-${k}`).join(' ')}" data-run="${esc(m.runId)}"><div class="tp-legend">${legend}</div><div class="tp-q">${esc(clip(c.agent.messages[c.agent.messages.indexOf(m) - 1]?.content || '', 220))}</div><div class="steps">${traceHTML(m)}</div></div>`;
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
  now.addEventListener('scroll', () => { T[m.runId] = now.scrollHeight - now.scrollTop - now.clientHeight < 60; jump.hidden = T[m.runId]; }, { passive: true });
  for (const b of now.querySelectorAll('.tl-chip')) b.onclick = () => { F.has(b.dataset.k) ? F.delete(b.dataset.k) : F.add(b.dataset.k); renderTracePane(c, m); };
  const all = $('.tl-all', now); if (all) all.onclick = () => { F.clear(); renderTracePane(c, m); };
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
function traceHTML(m) {
  const out = [], rounds = {};
  let mediaStatus = null;
  // Each step carries its kind, so the trace can colour it and the legend can show or hide it.
  const row = (at, what, kind = 'note') => out.push(`<div class="step k-${kind}" data-k="${kind}"><div class="when">${kind === 'res' ? '' : secs(at)}</div><div class="what">${what}</div></div>`);
  for (const e of m.trace || []) {
    if (e.t === 'llm_start') row(e.at, `🧠 <b>${esc(short(e.model))}</b> thinks<span class="sub" data-llm="${e.step}"></span>${m.thinking?.[e.step]?.trim() ? `<details class="think-trace"><summary>💭 Thinking · ${m.thinking[e.step].split(/\s+/).filter(Boolean).length} words</summary><div class="tt-body">${md(m.thinking[e.step])}</div></details>` : ''}`, 'think');
    else if (e.t === 'llm_done') {
      const i = out.findLastIndex((h) => h.includes(`data-llm="${e.step}"`));
      if (i >= 0) out[i] = out[i].replace(`<span class="sub" data-llm="${e.step}"></span>`, `<div class="sub">${secs(e.ms)} · ${e.tokensOut} tokens out · ${money(e.cost, 5)}${e.provider ? ` · via <span class="tr-prov" title="The provider OpenRouter routed this call to">${esc(e.provider)}</span>` : ''}${e.model && e.model !== m.trace.find((x) => x.t === 'llm_start' && x.step === e.step)?.model ? ` · <b class="tr-fallback" title="The chat's model was unavailable, so OpenRouter used the fallback model">fallback ${esc(short(e.model))}</b>` : ''}${e.toolCalls.length ? ` · then ${e.toolCalls.join(', ')}` : ''}</div>${e.aside ? `<div class="aside">💬 ${esc(e.aside)}</div>` : ''}`);
    } else if (e.t === 'tool' && e.name !== 'decide') row(e.at, `${e.by === 'reviewer' ? '🧪 <span class="tr-rv">reviewer</span> ' : e.by === 'helper' ? `🤝 <span class="tr-hp">helper ${e.helper || ''}</span> ` : ''}${TOOL_NAME[e.name]?.split(' ')[0] || '🔧'} <b>${esc(e.name)}</b><div class="sub">${esc(argSummary(e))}</div>`, e.by === 'reviewer' ? 'browser' : 'tool');
    else if (e.t === 'fresh_eyes_start') row(e.at, `👀 <b>Fresh eyes</b> ${esc(short(e.model))}: a problem came back, so a clean-context model takes a look<div class="sub">${(e.problems || []).map(esc).join('<br>')}</div>`, 'note');
    else if (e.t === 'fresh_eyes') row(e.at, `👀 Fresh eyes ${e.ok ? 'diagnosed it' : 'found nothing'}${e.report ? `<div class="sub" style="white-space:pre-wrap">${esc(e.report)}</div>` : ''}`, e.ok ? 'ok' : 'warn');
    else if (e.t === 'helper_start' && e.fresh) continue;
    else if (e.t === 'helper_start') row(e.at, `🤝 <b>Helper ${e.id}</b> ${esc(short(e.model))} starts, with a clean context<div class="sub">${esc(e.task)}</div>`, 'note');
    else if (e.t === 'helper_done') row(e.at, `🤝 Helper ${e.id} ${e.ok ? 'reported back' : 'gave no report'} · ${e.steps} step${e.steps === 1 ? '' : 's'} · ${secs(e.ms)} · ${money(e.cost, 4)}${e.chars ? ` · ${e.chars} characters returned` : ''}`, e.ok ? 'ok' : 'warn');
    else if (e.t === 'steer') row(e.at, `✉ <b>You</b> while it worked: ${esc(clip(e.text, 200))}`, 'ask');
    else if (e.t === 'steer_delivered') row(e.at, `✓ The agent read your note${e.count > 1 ? 's' : ''} before step ${e.step + 1}`, 'note');
    else if (e.t === 'mode') row(e.at, `${e.approval === 'yolo' ? '⚡ Switched to YOLO: it stops asking (budget caps still apply)' : '🔒 Switched to Strict: it asks before each tool'}`, 'note');
    else if (e.t === 'plan') row(e.at, `🗺 <b>Plan</b> · ${e.items.filter((x) => x.status === 'done').length} of ${e.items.length} done<div class="sub">${esc(e.items.map((x) => `${x.status === 'done' ? '✓' : x.status === 'doing' ? '◐' : '○'} ${x.text}`).join('  '))}</div>`, 'note');
    else if (e.t === 'review_start') row(e.at, `🧪 <b>Reviewer</b> ${esc(short(e.model))} starts testing ${esc(e.targets.join(', '))} <span class="sub">(round ${e.round}, fresh context)</span>`, 'browser');
    else if (e.t === 'review') row(e.at, `🧪 Reviewer: <b>${e.pass ? 'passed' : 'not passed'}</b> · ${Object.entries(e.scores).map(([k, v]) => `${k} ${v}/5`).join(', ')} (bar ${e.bar}) · ${money(e.cost, 4)}${e.bugs.length ? `<div class="sub">${esc(e.bugs.join(' · '))}</div>` : ''}`, e.pass ? 'ok' : 'warn');
    else if (e.t === 'tool_result' && e.name !== 'decide') row(e.at, `<div class="sub">↳ ${esc(e.result.slice(0, 220))}</div>`, /^Error/.test(e.result) ? 'err' : 'res');
    else if (e.t === 'decide_start') { rounds[e.round] = { start: e, votes: [], done: null }; row(e.at, `<span data-round="${e.round}"></span>`, 'decide'); }
    else if (e.t === 'decide_vote') rounds[e.round]?.votes.push(e);
    else if (e.t === 'decide_done') { if (rounds[e.round]) rounds[e.round].done = e; }
    else if (e.t === 'approval') row(e.at, e.free ? `✋ asks to use <b>${esc(e.tool)}</b>` : `💳 <b>${esc(e.tool)}</b> wants approval · ${money(e.est, 3)} (${esc(e.basis || 'estimated')})`, 'ask');
    else if (e.t === 'approval_done') row(e.at, `${e.approve ? '✅ approved' : '⛔ declined'} by ${esc(e.by)}${e.reason ? `<div class="sub">${esc(e.reason)}</div>` : ''}`, e.approve ? 'ok' : 'err');
    else if (e.t === 'media_status') mediaStatus = e;
    else if (e.t === 'screenshot') row(e.at, `📸 browser ${esc(e.action)}${e.target ? ` ${esc(e.target)}` : ''}<div class="sub">${esc(e.url || '')}</div><img class="shot" src="${e.image}" alt="screenshot" loading="lazy">`, 'browser');
    else if (e.t === 'command') row(e.at, `⌨️ <code>${esc(e.command)}</code> → exit ${e.code} · ${secs(e.ms)}${e.out ? `<details class="out"><summary>output</summary><pre>${esc(e.out)}</pre></details>` : ''}`, e.code ? 'err' : 'cmd');
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
    else if (e.t === 'question') row(e.at, `❓ ${e.auto ? 'Asked (⚡ YOLO: the deciders answer for you)' : 'Asked you'}: <b>${esc(e.question)}</b><div class="sub">${e.questions ? e.questions.map((q, i) => `${i + 1}. ${esc(q.question)} (${q.options.map(esc).join(' · ')})`).join('<br>') : e.options.map(esc).join(' · ')}</div>`, 'ask');
    else if (e.t === 'answer') row(e.at, e.by === 'deciders' ? `⚖️ The deciders answered for you: <b>${esc(e.label || e.text || '')}</b>${e.confidence != null ? ` · ${Math.round(e.confidence * 100)}% sure` : ''}` : `💬 You answered: ${esc(e.label || e.text || '')}`, 'ok');
    else if (e.t === 'checks' && e.kind === 'gap') row(e.at, `🧭 <b>Gap check</b> · ${e.build ? 'a build' : 'not a build, so nothing to ask'}${e.build ? `<div class="sub">${e.rows.filter((r) => r.label).map((r) => `<span class="chk ${r.missing ? 'miss' : 'ok'}">${r.missing ? '✗ not said' : '✓'} ${esc(r.label)}</span>`).join(' ')}</div>` : ''}<div class="sub">Fixed harness questions about your message, answered by the deciders${e.ms ? ` in ${secs(e.ms)}` : ''}.</div>`, e.rows.some((r) => r.missing) ? 'warn' : 'ok');
    else if (e.t === 'checks' && e.kind === 'page') { const bad = e.rows.filter((r) => r.fail); row(e.at, `🔎 <b>Harness checks</b> on ${esc(e.target)} (${e.when === 'verify' ? 'before the final reply' : 'after the preview'}) · ${bad.length ? `<span class="warn">${bad.length} problem${bad.length > 1 ? 's' : ''}</span>` : `${e.rows.length} passed`}<div class="sub">${e.rows.map((r) => `<span class="chk ${r.fail ? 'miss' : 'ok'}" title="${r.p == null ? 'no answer' : `${Math.round(r.p * 100)}% fine`}">${r.fail ? '✗' : '✓'} ${esc(r.fail ? r.label : r.id)}</span>`).join(' ')}</div>${e.clicked ? `<div class="sub">clicked “${esc(e.clicked)}” to see whether it responds</div>` : ''}${e.image ? `<img class="shot" src="${e.image}" alt="what the checks saw" loading="lazy">` : ''}${e.after ? `<img class="shot" src="${e.after}" alt="after the click" loading="lazy">` : ''}`, bad.length ? 'warn' : 'ok'); }
    else if (e.t === 'budget_ask') row(e.at, `💵 The project budget is used up (${money(e.spent, 3)} of ${money(e.budget, 2)}); asked you to raise it or wrap up`, 'ask');
    else if (e.t === 'budget_done') row(e.at, e.raised ? `✅ Budget raised to ${e.budget == null ? 'no limit' : money(e.budget, 2)}; carrying on` : '⛔ Wrapped up at the budget', e.raised ? 'ok' : 'warn');
    else if (e.t === 'interrupted') row(e.at || 0, `<span class="warn">⚠ The harness restarted while this reply was running${e.resumable ? '. It can be resumed.' : '.'}</span>`, 'warn');
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
  const who = o ? `${o.approve ? 'Allowed' : 'Declined'} by ${o.by === 'user' ? 'you' : esc(o.by)}${o.always ? ' · always allowed from now on' : ''}${o.approve && o.model && o.model !== c.model ? ` · switched to ${esc(short(o.model))}` : ''}${o.reason ? ` · ${esc(o.reason)}` : ''}`
    : live ? 'The deciders are checking whether this is needed and worth the price…' : 'Not answered: the reply ended';
  const mark = { yes: '✓', no: '⛔', wait: '⚡', none: '·' }[state];
  const price = c.free ? '' : money(c.est, 3);
  return {
    badge: `<span class="tl-ap ${state}" title="${esc(who.replace(/<[^>]+>/g, ''))}">${mark}${price ? ` ${price}` : ''}</span>`,
    detail: `<div class="tl-ap-detail ${state}">${who}${!c.free ? ` · ${esc(short(o?.model || c.model))}${c.detail ? ` · ${esc(c.detail)}` : ''}` : ''}${c.why ? `<div class="dim">Why: ${esc(c.why)}</div>` : ''}</div>`,
  };
}
function approvalHTML(a, live = true) {
  const c = a.card, o = a.outcome;
  const waiting = !o && c.mode === 'strict' && live;
  const opts = c.options || [];
  const finalModel = o?.model || c.model;
  const name = TOOL_NAME[c.tool] || esc(c.tool);
  const head = c.free ? `<h4>${name} <small>(free)</small></h4>` : `<h4>${name} · <span class="cost">${money(c.est, 3)}</span> <small>(${esc(c.basis || 'estimated')})</small></h4>`;
  const model = c.free ? '' : waiting && opts.length > 1
    ? `<label class="what">Model <select class="pickModel">${opts.map((x) => `<option value="${esc(x.model)}" data-est="${x.est}" ${x.model === c.model ? 'selected' : ''}>${esc(short(x.model))} · ${money(x.est, 3)} · ${esc(x.detail)}${x.model === c.model ? (c.pickedBy === 'agent' ? ' (agent’s choice)' : ' (your default)') : ''}</option>`).join('')}</select></label>`
    : `<div class="what">${esc(short(finalModel))} · ${esc(c.detail)}${c.pickedBy === 'agent' && finalModel === c.model ? ' · chosen by the agent' : ''}</div>`;
  // Answered (or no longer waiting): one line, ✓/⛔ + the tool + what it did + the price; click it for the details.
  if (!waiting) {
    const state = o ? (o.approve ? 'yes' : 'no') : live ? 'wait' : 'none';
    const mark = { yes: '✓', no: '⛔', wait: '⚡', none: '·' }[state];
    const who = o ? `${o.approve ? 'Allowed' : 'Declined'} by ${o.by === 'user' ? 'you' : esc(o.by)}${o.always ? ' · always allowed from now on' : ''}${o.approve && o.model && o.model !== c.model ? ` · switched to ${esc(short(o.model))}` : ''}${o.reason ? ` · ${esc(o.reason)}` : ''}`
      : live ? 'Deciders are checking whether this is needed and worth the price…' : 'Not answered: the reply ended';
    return `<details class="approval-line ${state}"><summary title="${esc(who)}"><span class="al-mark">${mark}</span><b>${name}</b><span class="al-what">${esc(c.what)}</span><span class="al-price">${c.free ? 'free' : money(c.est, 3)}</span></summary>
      <div class="al-detail">${c.free ? '' : `<div>${esc(short(finalModel))} · ${esc(c.detail || '')}</div>`}<div>${esc(c.what)}</div>${c.why ? `<div>Why: ${esc(c.why)}</div>` : ''}<div class="al-who ${state}">${who}</div></div></details>`;
  }
  return `<div class="approval ${o ? 'done' : ''} ${c.free ? 'free' : ''}" ${waiting ? `data-id="${esc(c.id)}" data-tool="${esc(c.tool)}"` : ''}>
    ${head}${model}
    <div class="what">${c.free ? esc(c.what) : `“${esc(c.what)}”`}</div>
    ${c.why ? `<div class="what">Why: ${esc(c.why)}</div>` : ''}
    ${waiting ? `<textarea rows="1" placeholder="If you decline, say why (optional). The agent reads this and decides what to do."></textarea>
      <div class="acts"><button type="button" class="primary yes">${c.free ? 'Allow once' : `Approve ${money(c.est, 3)}`}</button><button type="button" class="always" title="Stop asking for this tool in this chat">Always allow</button><button type="button" class="no">Decline</button></div>`
      : o ? `<div class="outcome ${o.approve ? 'yes' : 'no'}">${o.approve ? '✅ Allowed' : '⛔ Declined'} by ${o.by === 'user' ? 'you' : esc(o.by)}${o.always ? ' · always allowed from now on' : ''}${o.approve && o.model && o.model !== c.model ? ` · switched to ${esc(short(o.model))}` : ''}${o.reason ? ` · ${esc(o.reason)}` : ''}</div>`
      : !live ? '<div class="outcome">Not answered: the reply ended</div>' : `<div class="outcome">⚡ Deciders are checking whether this is needed and worth the price…</div>`}
  </div>`;
}
function wireApproval(card, m) {
  const id = card.dataset.id;
  const sel = $('.pickModel', card);
  if (sel) sel.onchange = () => { $('.yes', card).textContent = `Approve ${money(Number(sel.selectedOptions[0].dataset.est), 3)}`; };
  const answer = async (approve, always = false) => {
    card.querySelectorAll('button, select').forEach((b) => (b.disabled = true));
    const reason = $('textarea', card)?.value.trim() || '';
    await fetch('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: m.runId, id, approve, always, reason, model: sel?.value }) }).catch(() => {});
  };
  $('.yes', card).onclick = () => answer(true);
  $('.always', card).onclick = () => answer(true, true);
  $('.no', card).onclick = () => answer(false);
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
  return `<div class="approval budget-card ${open ? '' : 'done'}" ${open ? `data-id="${esc(c.id)}"` : ''}>
    <h4>💵 Project budget reached · <span class="cost">${money(c.spent, 3)} of ${money(c.budget, 2)}</span></h4>
    <div class="what">All chats in this project together have used up its budget. Raise it to let this reply carry on, or wrap up here.</div>
    ${open ? `<div class="acts own-row"><label class="what">Raise to $ <input type="number" class="own raise-to" min="${(Math.ceil(c.spent * 100) / 100).toFixed(2)}" step="0.5" value="${next.toFixed(2)}" aria-label="New budget in dollars"></label></div>
      <div class="acts"><button type="button" class="primary raise">Raise and carry on</button><button type="button" class="stop-here">Wrap up</button></div><div class="what err" hidden></div>`
      : `<div class="outcome ${o?.raised ? 'yes' : 'no'}">${o ? (o.raised ? `✅ Budget raised to ${o.budget == null ? 'no limit' : money(o.budget, 2)}; the reply carried on` : '⛔ Wrapped up at the budget') : 'Not answered: the reply ended'}</div>`}
  </div>`;
}
function wireBudget(card, c, m) {
  const err = $('.err', card), input = $('.raise-to', card);
  $('.raise', card).onclick = async () => {
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
function questionHTML(q, live = true) {
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
  return `<div class="approval question qbox ${a ? 'done' : ''}" ${a ? '' : `data-id="${esc(c.id)}" tabindex="-1"`}>
    <div class="q-head"><span class="q-badge">${c.gate === 'plan' ? 'Plan first' : 'Question'}</span><p class="q-text">${esc(c.question)}</p></div>
    ${a ? `<div class="q-opts answered">${c.options.map((o, i) => `<div class="q-opt ${i === picked ? 'picked' : 'faded'}"><span class="q-key">${i === picked ? '✓' : i + 1}</span><span class="q-label">${esc(o)}</span></div>`).join('')}
        ${picked == null ? `<div class="q-opt ${missed ? 'missed' : 'picked'}"><span class="q-key">${missed ? '–' : '✓'}</span><span class="q-label">${missed ? 'Not answered: the reply ended' : `Your answer: ${esc(a.label || a.text || '')}`}</span></div>` : ''}</div>`
      : `<div class="q-opts" role="group" aria-label="Answers">${c.options.map((o, i) => `<button type="button" class="opt q-opt" data-i="${i}"><span class="q-key">${i + 1}</span><span class="q-label">${esc(o)}</span></button>`).join('')}</div>
      <div class="own-row q-own"><input type="text" class="own" placeholder="${c.gate === 'plan' ? 'Or say what to change in the plan' : 'Or answer in your own words'}" aria-label="${c.gate === 'plan' ? 'What to change in the plan' : 'Your own answer'}"><button type="button" class="send-own">Send</button></div>`}
  </div>`;
}
// Several questions in one card: pick per question (the agent's recommendation is preselected), or type your own words.
function questionsHTML(c, a) {
  const qs = c.questions;
  if (a) {
    const got = a.answers || [];
    return `<div class="approval question qbox qmulti done">
    <div class="q-head"><span class="q-badge">Questions · ${qs.length}</span><p class="q-text">${a.defaults ? 'You took the agent\'s recommendations' : a.answers ? 'Your answers' : 'Not answered: the reply ended'}</p></div>
    ${qs.map((q, i) => { const g = got[i] || {}; const said = g.choice != null ? q.options[g.choice] : g.text ? `Your answer: ${g.text}` : 'No answer: the agent decides'; return `<div class="qm-item"><p class="qm-q"><span class="q-key">${i + 1}</span>${esc(q.question)}</p><div class="q-opt ${g.choice != null || g.text ? 'picked' : 'missed'}"><span class="q-key">${g.choice != null || g.text ? '✓' : '–'}</span><span class="q-label">${esc(said)}</span></div></div>`; }).join('')}
  </div>`;
  }
  return `<div class="approval question qbox qmulti" data-id="${esc(c.id)}" tabindex="-1">
    <div class="q-head"><span class="q-badge">Questions · ${qs.length}</span><p class="q-text">A few things to settle before the agent goes on. Its recommendation is selected; change what you like.</p></div>
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
  const imgs = c.images.splice(0), docs = (c.docs || []).splice(0).filter((d) => d.id && !d.busy), ctxItems = c.ctx.splice(0);
  renderAttachments(c);
  const context = ctxItems.length ? await contextText(ctxItems).catch(() => '') : '';
  const r = await postJ(`/api/runs/${c.running.runId}/steer`, { text, images: imgs.map((x) => x.full), docs: docs.map((d) => d.id), context }).catch((e) => ({ error: e.message }));
  if (!r?.ok) {
    // Nothing is lost: the text and the attachments go back into the box.
    const ta = $('.input', c.el.root); if (ta && !ta.value) ta.value = text;
    c.images.unshift(...imgs); (c.docs ||= []).unshift(...docs); c.ctx.unshift(...ctxItems); renderAttachments(c);
    uiAlert(`The note didn't reach the agent${r?.error ? `: ${r.error}` : ''}. It's back in the box.`);
    return;
  }
  // Keep the pictures with the note so the reply can show them (and they open large when clicked).
  const m = [...c.agent.messages].reverse().find((x) => x.role === 'assistant' && x.runId === c.running?.runId);
  if (m && (imgs.length || docs.length)) { (m.steerAtt ||= []).push({ text, imgs: imgs.map((x) => x.thumb), imgViews: imgs.map((x) => x.view || x.full), docs: docs.map(({ id, name, kind, size, rel }) => ({ id, name, kind, size, rel })) }); saveChat(c); }
}
async function send(c, text) {
  text = text.trim();
  if (!text || c.running) return;
  askNotifyPermission();
  const ctx =c.ctx.length ? { titles: c.ctx.map((x) => x.title), text: await contextText(c.ctx) } : null;
  const imgs = c.images.splice(0);
  const docs = (c.docs || []).splice(0).filter((d) => d.id && !d.busy);
  c.ctx = []; renderAttachments(c);
  if (!c.title || c.title === 'New chat') { c.title = text.replace(/\s+/g, ' ').slice(0, 60); if (c.el) { $('.ch-name', c.el.root).value = c.title; } }
  runChat(c, text, ctx, imgs, { docs });
}
async function runChat(c, text, ctx, imgs, { resumeOf, docs = [], more = 0, model = '' } = {}) {
  const a = c.agent;
  // After a compaction only the turns since the summary are sent, together with the summary.
  const history = a.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error && (!a.summaryAt || (m.at || 0) >= a.summaryAt)).map((m) => ({ role: m.role, at: m.at, content: m.role === 'assistant' ? `${m.content}${m.note || ''}` : `${m.ctx?.length ? `[attached context: ${m.ctx.join(', ')}] ` : ''}${m.docs?.length ? `[attached files: ${m.docs.map((d) => d.name).join(', ')}; read them with read_doc / search_docs] ` : ''}${m.content}` }));
  const m = { role: 'assistant', content: '', at: Date.now(), trace: [], approvals: {}, questions: {}, arts: [], runId: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, live: true, runActive: true };
  const user = resumeOf ? null : { role: 'user', content: text, at: Date.now(), ...(ctx ? { ctx: ctx.titles } : {}), ...(imgs.length ? { imgs: imgs.map((x) => x.thumb), imgViews: imgs.map((x) => x.view || x.full) } : {}), ...(docs.length ? { docs: docs.map(({ id, name, kind, size, status, rel }) => ({ rel, id, name, kind, size, status })) } : {}) };
  a.messages.push(...(user ? [user] : []), m);
  const box = c.el && G.panes.includes(c.id) ? $('.msgs', c.el.root) : null;
  if (box) { if (box.querySelector('.hint')) box.innerHTML = ''; if (user) box.appendChild(renderMsg(c, user)); box.appendChild(renderMsg(c, m)); c.follow = true; c.toEnd?.(); }
  const artifacts = Object.fromEntries(Object.entries(a.artifacts).map(([id, x]) => [id, x.kind === 'html' ? { kind: 'html', title: x.title, html: x.html, v: 1 } : x.kind === 'md' ? { kind: 'md', title: x.title, md: x.md || '', v: 1 } : { kind: x.kind, title: x.title, url: x.url?.startsWith('data:') ? undefined : x.url, v: 1 }]));
  const settings = { ...G.settings, approval: c.approval, tools: chatTools(c), ...qualitySettings(c) };
  const body = resumeOf ? { runId: m.runId, chatId: c.id, resume: resumeOf, settings, allowed: a.allowed, ...(more ? { continue: more, ...(model ? { model } : {}) } : {}) }
    : { runId: m.runId, chatId: c.id, projectId: c.projectId, chatTitle: c.title, setup: a.setup, settings, allowed: a.allowed, history, summary: a.summary || '', text, artifacts, context: ctx?.text || '', images: imgs.map((x) => x.full), docs: docs.map((d) => d.id) };
  // Saved straight away, so a reload finds the running reply and reattaches to it.
  saveChat(c, true);
  return followRun(c, m, (signal) => fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body) }));
}
// After a page reload: replies that were still running pick up again (everything so far is
// replayed), finished ones get their result, and ones a harness restart cut off offer ▶ Resume.
const following = new Set(); // replies this page is following now (never twice)
async function reattachRuns(c) {
  for (const m of c.agent.messages) {
    if (m.role !== 'assistant' || !m.runActive || c.running || following.has(m.runId)) continue;
    following.add(m.runId);
    const st = await fetch(`/api/runs/${m.runId}`).then((r) => r.json()).catch(() => ({ status: 'unknown' }));
    if (st.status === 'unknown') { following.delete(m.runId); m.runActive = false; m.error ||= 'This reply was interrupted.'; saveChat(c); continue; }
    // Interrupted by a restart: offer Resume instead of replaying its whole log (it never ends, so it looped).
    // A reply that is running, or that finished while no one watched, is replayed to its end as before.
    if (st.status === 'interrupted') {
      following.delete(m.runId); m.runActive = false; m.live = false;
      m.error = 'The harness restarted while this reply was running.'; m.resumable = !!st.resumable;
      if (m.el) updateMsg(c, m);
      syncRunState(c); saveChat(c); continue;
    }
    // A replay starts from the first event, so the thinking starts empty too (it used to be appended again).
    Object.assign(m, { content: '', trace: [], approvals: {}, questions: {}, thinking: {}, error: undefined, live: true });
    if (m.el) updateMsg(c, m);
    followRun(c, m, (signal) => fetch(`/api/runs/${m.runId}/events`, { signal }));
  }
}
// ---------- notifications: a reply needs you, or ended, while QuorX is in the background ----------
// ⚙ Appearance → Notifications. One notification per chat at a time (tag), so a busy chat doesn't pile them up.
const NOTIFY_TITLE = { approval: 'Needs your approval', answer: 'Question for you', budget: 'Project budget reached', done: 'Reply finished', error: 'Reply stopped' };
function notifyRun(c, kind, body = '') {
  const pref = uiOf(G.settings).notify;
  if (pref === 'off' || (pref === 'needs' && (kind === 'done' || kind === 'error'))) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    const n = new Notification(`${NOTIFY_TITLE[kind]} · ${c.title || 'Chat'}`, { body: String(body).slice(0, 180), tag: `oh-${c.id}`, silent: kind === 'done' });
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
        if (e.t === 'approval') { m.approvals[e.id] = { card: e }; if (e.mode === 'strict') { c.waiting = true; renderSidebar(); renderChatHead(c); note('approval', e.what || e.tool); } }
        if (e.t === 'approval_done' && m.approvals[e.id]) { m.approvals[e.id].outcome = e; c.waiting = false; renderSidebar(); renderChatHead(c); }
        if (e.t === 'question') { m.questions[e.id] = { card: e }; if (!e.auto) { c.waiting = 'answer'; renderSidebar(); renderChatHead(c); note('answer', e.question); } }
        if (e.t === 'budget_ask') { m.budgetAsk = { card: e }; c.waiting = 'budget'; renderSidebar(); renderChatHead(c); note('budget', 'Raise the budget to carry on, or wrap up.'); }
        if (e.t === 'budget_done' && m.budgetAsk) { m.budgetAsk.outcome = e; c.waiting = false; refreshSidebar(); renderChatHead(c); }
        if (e.t === 'answer' && m.questions[e.id]) { const qc = m.questions[e.id].card; e.label = e.answers ? (e.defaults ? 'the recommended answers' : e.answers.map((x, i) => (x.choice != null ? qc.questions?.[i]?.options[x.choice] : x.text || '–')).join(' · ')) : e.choice != null ? qc.options[e.choice] : e.text; m.questions[e.id].answer = e; c.waiting = false; renderSidebar(); renderChatHead(c); }
        if (e.t === 'done') { m.doneAt = Date.now(); m.content = e.reply; m.note = e.historyNote; m.stats = e.stats; G.sessionCost += e.stats.cost; renderSpend(); }
        if (e.t === 'error') m.error = e.msg;
        if (e.t === 'interrupted') { m.error = 'The harness restarted while this reply was running.'; m.resumable = !!e.resumable; }
        if (e.t === 'compacted') { a.summary = e.summary; a.summaryAt = e.cutoffAt; }
        if (e.t !== 'start') m.trace.push(e);
        if (isShot(e)) onAgentBrowse(c, m);
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
      else note('done', `${took ? `Done in ${secs(took)}` : 'Done'}${cost}. ${String(m.content || '').replace(/[#*_`>]/g, '').slice(0, 120)}`);
    }
    updateMsg(c, m); syncRunState(c); saveChat(c, true); refreshSidebar(); checkSpace(c, true); refreshUndoable(c.projectId); if (G.view.browser && focused() === c) renderPane();
    refreshBalance();
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
function paneVisible() {
  const c = focused();
  if (!c) return false;
  if (!isPhone()) return true; // always there on a desktop: drag the divider to resize, ⤢ to make it full width
  // ◧ always wins: hidden means hidden, even with the explorer or a trace open (they come back with it).
  if (c.paneHidden === true) return false;
  if (G.view.files || G.view.trace || G.view.term || G.view.browser) return true;
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
    const parts = f.path.replace(/\/ \(skipped\)$/, '/').split('/').filter(Boolean);
    let node = tree;
    parts.forEach((part, k) => { if (k === parts.length - 1 && !f.path.endsWith('(skipped)')) (node.__files ||= []).push({ name: part, ...f }); else node = (node[part] ||= {}); });
    if (f.path.endsWith('(skipped)')) node.__skipped = true;
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
    previewFile(view, { name: path, src, size: f?.size, full: p?.dir ? `${p.dir}${p.dir.includes('\\') ? '\\' : '/'}${path.replaceAll('/', p.dir.includes('\\') ? '\\' : '/')}` : path });
  };
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
  return `<span class="cx-mi" tabindex="0" title="${esc(list.map(([m, v]) => `${short(m)}  ${money(v, 4)}`).join('\n'))}" aria-label="${list.length} model${list.length === 1 ? '' : 's'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>${list.length}</span>`;
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
        <summary style="${projStyle(p)}"><b class="cx-pname">${esc(p.name)}</b><small class="cx-n">${p.chatCount} chat${p.chatCount === 1 ? '' : 's'}${p.lastAt ? ` · ${ago(p.lastAt)}` : ''}</small><span class="cost-bar"><i style="width:${(p.cost / max) * 100}%"></i></span><span class="mono">${money(p.cost, 3)}</span></summary>
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
  ['Agent', [['newchats', '✨', 'New chats'], ['loop', '🔁', 'Agent loop'], ['deciders', '⚖️', 'Deciders'], ['tools', '🧰', 'Tools & media'], ['budget', '💵', 'Budget & approvals'], ['skills', '🧩', 'Skills']]],
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
        + stRow('Send a build back for', 'Every bug the reviewer reports says how bad it is. Minor bugs never send a build back; they go to the builder as notes.', stSeg('reviewSendBack', [['annoying', 'Breaks or annoying'], ['breaks', 'Only breaks']], S.reviewSendBack || 'annoying'))
        + stRow('Reviewer model', 'Default: gpt-6-luna, which is cheap, sees screenshots, and comes from a different family than most builders (qwen3.7-flash if your chat already uses gpt-6-luna). Pick one that can use tools and see images.', `<div class="st-fb"><button type="button" class="st-chip" data-act="pickReviewer" id="rvModel">${S.reviewModel ? `${recDot(S.reviewModel, 'chat')} ${esc(short(S.reviewModel))} <small>${esc(shortPrice(S.reviewModel))}</small>` : 'Default'}</button>${S.reviewModel ? '<button type="button" class="st-btn secondary sm" data-act="clearReviewer" title="Use the default reviewer">✕</button>' : ''}</div>`)
        + stRow('Rounds to fix', 'How many times the builder is sent back with the reviewer’s bugs. After that, what is still open shows in the reply.', stStep('reviewRounds', S.reviewRounds ?? 1, 0, 3))
        + stRow('Pass bar', 'Every score (function, craft, design, originality, accessibility, and brand fit when the project has a DESIGN.md) must reach this, out of 5.', stStep('reviewBar', S.reviewBar ?? 3, 1, 5))),
      stCard('Helpers', 'For exploring big projects: the agent hands read-only jobs (find, read, summarise) to a cheaper model with its own clean context. Only the helper’s short report comes back, so the agent’s context stays small. Several run at once.',
        stRow('Let the agent use helpers', 'Offered only in chats with a project folder.', stSwitch('helpers', S.helpers !== false))
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
      stCard('Paid calls', '', stRow('Budget per reply', 'A paid call that would go over this is stopped, in Strict and in YOLO.', stStep('budget', S.budget, 0, 20, 0.05, '$'))
        + stRow('Deciders check paid calls in ⚡ YOLO', 'Before each paid call: is it needed, is the price fair?', stSwitch('yoloCheck', S.yoloCheck !== false))),
      stCard('What ⚡ YOLO does by itself', 'Ticked: YOLO goes ahead without asking. Unticked: it asks you first, as Strict does (Always allow stops the asking for that chat). Reading files, listing and searching never ask.',
        YOLO_ROWS.map(([k, label, help]) => stRow(label, help, stSwitch(`yoloAuto.${k}`, S.yoloAuto?.[k] !== false))).join('')),
      stCard('Project budgets', 'Set a project\'s budget with the $ next to it in the sidebar.', stRow('Allowance to finish a reply', 'A new reply can\'t start once the project budget is used up. A reply already working may go this far past it to finish, then it is stopped. 0% stops it right at the budget.', stStep('budgetGrace', S.budgetGrace ?? 10, 0, 100, 5, '%'))),
    ]],
    skills: ['Skills', 'Playbooks the agent loads when a task fits. Agents can also save their own into a project.', ['<div id="skillList" class="st-skill-list"></div>']],
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
      stCard('Commands', 'Only these programs can be run, with plain arguments.', `<div class="st-chips">${(G.cfg.allowed || []).map((x) => `<span class="st-chip">${esc(x)}</span>`).join('')}</div>`),
      stCard('Agent folder', 'The agent keeps research scripts, downloads, undo history and deleted files in .quorx/ inside each project folder. Git ignores it, so it never ends up in your repo.', stRow('Ask me when it grows past', 'The chat shows a notice with what to clear, and the agent asks before adding more.', stStep('agentSpaceMB', S.agentSpaceMB ?? 500, 50, 50000, 50, 'MB'))
        + stRow('Undo for the newest', 'Replies per project that keep ↶ Undo. Older undo copies are removed when a new reply starts.', stStep('undoKeep', S.undoKeep ?? 10, 1, 100, 1, 'replies'))
        + stRow('Undo kept for at most', 'Even among the newest replies, Undo goes after this long. For history that lasts, use git.', stStep('undoDays', S.undoDays ?? 7, 1, 90, 1, 'days'))),
      stCard('Servers and browser', 'Servers are saved in .quorx/launch.json per project; run and stop them from 🖥 in the chat header, and watch them in the terminal.', stRow('Dev server ports', 'Each server gets a free port here unless it has a fixed one.', '<code>5300–5999</code>')
        + stRow('Headless browser', 'Used by the agent to check its own pages.', `<code class="blurable">${esc(G.cfg.browser || 'not found')}</code>`)
        + stRow('Secrets', 'Agent processes run without your API keys, tokens or passwords in their environment, and the file tools cannot read .env or data/keys.json.', '<span class="st-key-source-badge">protected</span>')),
    ]],
    usage: ['Usage & costs', 'What chats and projects cost.', [
      stCard('In chats', '', stRow('Show the cost badge in chat headers', 'The amber cost next to the model; click it for the per-chat usage breakdown (also /usage).', stSwitch('ui.usageBtn', U.usageBtn))),
      stCard('Everything', '', stRow('Costs per project and chat', '', '<button type="button" class="st-btn secondary sm" data-act="openCosts">💲 Open costs</button>')),
    ]],
    data: ['Data & storage', 'Where things are kept.', [
      stCard('Chats', 'Saved on this computer in data/chats; deleted chats move to data/trash.', stRow('Export all chats', 'One JSON file with every chat.', '<button type="button" class="st-btn secondary sm" data-act="exportChats">⬇ Export</button>')),
      stCard('Danger zone', '', stRow('Clear this browser\'s preferences', 'Settings, layout and theme go back to defaults. Chats, projects and keys are not touched.', '<button type="button" class="st-btn danger sm" data-act="clearPrefs">Clear</button>'), 'danger'),
    ]],
    setup: ['Setup check', 'What this computer has for QuorX, and what each thing is for. Amber rows are optional.', ['<div id="stSetup"><div class="st-row-help">Checking this computer…</div></div>']],
    shortcuts: ['Shortcuts', '', [stCard('Keyboard', '', `<table class="st-shortcuts-table"><tbody>${[['Ctrl + K', 'Search chats, commands, settings and files'], ['Enter', 'Send'], ['Shift + Enter', 'New line'], ['@', 'Add files, chats or projects as context'], ['/', 'Commands (/usage, /model, /strict, …)'], ['↑ ↓ then Enter or Tab', 'Pick a suggestion'], ['Esc', 'Close a dialog or suggestions']].map(([k, v]) => `<tr><td>${k.split(' ').map((x) => (/^[+]$|^then$|^or$/.test(x) ? x : `<kbd>${esc(x)}</kbd>`)).join(' ')}</td><td>${v}</td></tr>`).join('')}</tbody></table>`)]],
    about: ['About', '', [...(DESK ? ['<div id="stDesktop"></div>'] : []), '<div id="stDevices"></div>',stCard('QuorX', '', stRow('Version', DESK ? 'The desktop app and the harness it is attached to.' : '', `<code id="stVersion">v${esc(G.cfg?.version || '?')}</code>`) + stRow('Address', '', `<code>${esc(location.origin)}</code>`) + stRow('OpenRouter key', '', G.cfg.hasKey ? '<span class="st-key-active-badge">active</span>' : '<span class="st-nav-badge bad-dot"></span> none yet') + stRow('Your data', 'Chats, projects, keys and logs stay in this folder.', '<code>data/</code>'))]],
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
    if (act === 'pickReviewer') { const id = await pickModel('chat', S.reviewModel || '', { context: 'Reviewer: tests what was built' }); if (id) { S.reviewModel = id; mark(); drawSettings(); } }
    if (act === 'clearReviewer') { S.reviewModel = ''; mark(); drawSettings(); }
    if (act === 'pickHelper') { const id = await pickModel('chat', S.helperModel || '', { context: 'Helper: read-only jobs' }); if (id) { S.helperModel = id; mark(); drawSettings(); } }
    if (act === 'clearHelper') { S.helperModel = ''; mark(); drawSettings(); }
    if (act === 'refreshModels') { $('#stCatInfo').textContent = 'Refreshing…'; await loadModels(true); $('#stCatInfo').textContent = `${G.models?.length || 0} models loaded · refreshed ${new Date().toLocaleTimeString()}`; }
    if (act === 'resetOrder') { G.projectOrder = []; savePrefs(); renderSidebar(); e.target.textContent = 'Done'; }
    if (act === 'openCosts') openCosts();
    if (act === 'exportChats') exportChats(e.target);
    if (act === 'clearPrefs' && await uiConfirm('Clear this browser\'s preferences? Chats, projects and keys stay.')) { try { localStorage.removeItem(STORE); localStorage.removeItem('agent001-v1'); } catch { /* ignore */ } location.reload(); }
  };
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
  drawKeysPanel();
  drawSetupPanel();
  drawEmbedPick();
  drawDesktopSettings();
  drawDevices();
  showVersion();
}
// ⚙ Settings → About → Other devices: phones and other computers on your network open QuorX once with a
// pairing link (only shown on this computer). The links hide until you click Show, like API keys.
async function drawDevices(info) {
  const box = $('#stDevices'); if (!box) return;
  info ||= await fetch('/api/access').then((r) => r.json()).catch(() => null);
  if (!box.isConnected || !info || info.error) return;
  if (info.paired) { box.innerHTML = stCard('Other devices', 'This device is paired with the computer running QuorX. Pairing is managed on that computer.', ''); return; }
  const shown = !!ST.revealDevices;
  const links = info.links || [];
  box.innerHTML = stCard('Other devices', 'Phones and other computers on your network can use QuorX, with all its powers (including your terminals). Each device needs the pairing link once; anyone without it is refused.',
    stRow('Allow other devices', 'Off: only this computer can open QuorX.', `<label class="sq-check"><input type="checkbox" id="stLan"${info.lan ? ' checked' : ''}><span>On</span></label>`)
    + (info.lan ? (links.length
      ? links.map((l) => stRow(`Pairing link (${esc(l.ip)})`, 'Open it on the device, or type it there. Keep it private.', `<code class="${shown ? '' : 'blurable'}" style="word-break:break-all">${shown ? esc(l.url) : esc(l.url.replace(/pair=.*/, 'pair=••••••••'))}</code> <button type="button" class="st-btn ghost sm" data-copy-link="${esc(l.url)}">Copy</button>`)).join('')
        + stRow('', '', `<button type="button" class="st-btn ghost sm" id="stDevShow">${shown ? 'Hide' : 'Show'} links</button> <button type="button" class="st-btn danger sm" id="stDevReset" title="Every paired device has to pair again">New link…</button>`)
      : stRow('Pairing link', 'This computer has no network address right now (no Wi-Fi or cable).', ''))
      : ''));
  $('#stLan').onchange = async (e) => drawDevices(await postJ('/api/access', { lan: e.target.checked }).catch(() => null));
  const show = $('#stDevShow'); if (show) show.onclick = () => { ST.revealDevices = !shown; drawDevices(info); };
  const reset = $('#stDevReset');
  if (reset) reset.onclick = async () => { if (await uiConfirm('Make a new pairing link? Every phone or computer paired with the old one has to pair again.')) drawDevices(await postJ('/api/access/reset', {}).catch(() => null)); };
  for (const b of box.querySelectorAll('[data-copy-link]')) b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyLink); b.textContent = 'Copied ✓'; } catch { b.textContent = 'Copy failed'; } setTimeout(() => (b.textContent = 'Copy'), 1400); };
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
}
// Reset category: that category's settings go back to the defaults (still unsaved until Save).
function resetCategory() {
  const S = ST.draft, d = G.cfg.defaults, U = (S.ui ??= {});
  const uiKeys = { appearance: ['density', 'fontSize', 'reduceMotion', 'timestamps', 'notify'], layout: ['sidebarStart', 'paneMode'], privacy: ['showBalance', 'maskAmounts', 'blurPaths'], usage: ['usageBtn'] }[ST.cat];
  if (uiKeys) for (const k of uiKeys) U[k] = UI_DEFAULTS[k];
  if (ST.cat === 'appearance') { S.theme = null; G.theme = null; applyTheme(); }
  if (ST.cat === 'models') { S.model = d.chatModel || d.setups.C.model; S.reasoning = 'off'; Object.assign(S, { providerSort: 'auto', requireParams: true, zdrOnly: false, fallbackModel: '' }); }
  if (ST.cat === 'newchats') { S.approval = d.approval; S.strictAsk = d.strictAsk; S.strictAskHelpers = d.strictAskHelpers; S.strictAskDeciders = d.strictAskDeciders; S.newChatTools = { ...DEFAULT_CHAT_TOOLS }; }
  if (ST.cat === 'loop') { S.maxSteps = d.maxSteps; S.compact = true; S.compactAt = 24000; Object.assign(S, { planFirst: d.planFirst, planSteps: d.planSteps, continueRounds: d.continueRounds, maxOutput: d.maxOutput, thinkShare: d.thinkShare, review: d.review, reviewModel: '', reviewTier: d.reviewTier, reviewSendBack: d.reviewSendBack, reviewRounds: d.reviewRounds, reviewBar: d.reviewBar, helpers: d.helpers, helperModel: '', helperSteps: d.helperSteps, retries: d.retries, parallel: d.parallel, verify: d.verify, verifyRounds: d.verifyRounds, askLimit: d.askLimit, trimAt: d.trimAt, buildThinking: d.buildThinking }); }
  if (ST.cat === 'deciders') { S.voters = [...d.voters]; S.gate = { ...d.gate }; S.lookVoters = [...d.lookVoters]; S.lookEscalate = d.lookEscalate; S.checks = structuredClone(d.checks); }
  if (ST.cat === 'tools') S.tools = structuredClone(d.tools);
  if (ST.cat === 'budget') { S.budget = d.budget; S.yoloCheck = true; S.budgetGrace = d.budgetGrace; S.yoloAuto = {}; }
  if (ST.cat === 'skills') S.skillsOff = [];
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
    const load = async () => {
      const el = $('[data-usage]', card);
      const u = await fetch(`/api/keys/${id}/usage`).then((x) => x.json()).catch((e) => ({ error: e.message }));
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
      if (act === 'reveal') { ST.reveal.has(id) ? ST.reveal.delete(id) : ST.reveal.add(id); return drawKeysPanel(); }
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
    const loadAcc = async () => {
      const a = await fetch('/api/credits').then((x) => x.json()).catch((e) => ({ error: e.message }));
      const m = (v) => (showAcc() ? money(v ?? 0, 2) : '•••••');
      acc.innerHTML = a.error ? `<div class="kx-wait">Account credits aren't available for this key (${esc(a.error)}).</div>`
        : `<div class="kx-metric"><span>Total credits</span><b>${m(a.total)}</b></div><div class="kx-metric"><span>Total used</span><b>${m(a.used)}</b></div><div class="kx-metric left"><span>Left</span><b>${m((a.total ?? 0) - (a.used ?? 0))}</b></div><div class="kx-checked">Checked ${new Date(a.checked).toLocaleTimeString()}</div>`;
    };
    loadAcc();
    box.querySelector('[data-acc="reveal"]').onclick = () => { ST.revealAccount = !ST.revealAccount; drawKeysPanel(); };
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
const toPreview = () => { if (isPhone()) setMView('preview'); };
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
  const d = G.cfg.defaults;
  const saved = load();
  G.settings = { voters: d.voters, gate: d.gate, maxSteps: d.maxSteps, approval: d.approval, budget: d.budget, model: d.chatModel || d.setups.C.model, reasoning: 'off', ...(saved?.settings || {}) };
  G.settings.tools = Object.fromEntries(Object.entries(d.tools).map(([k, v]) => [k, { ...structuredClone(v), ...(saved?.settings?.tools?.[k] || {}) }]));
  delete G.settings.media; delete G.settings.mediaEnabled;
  if ((G.settings.maxSteps || 0) < d.maxSteps) G.settings.maxSteps = d.maxSteps; // building and checking needs room
  G.settings.maxSteps = Math.min(120, G.settings.maxSteps);
  G.sideHidden = !!saved?.sideHidden; G.chatOpts = !!saved?.chatOpts; G.projectOrder = saved?.projectOrder || []; G.foldedProjects = saved?.foldedProjects || []; G.favModels = saved?.favModels || {}; G.spaceSeen = saved?.spaceSeen || {}; G.followAgent = saved?.followAgent !== false; G.budgetSeen = saved?.budgetSeen || {}; G.recentModels = saved?.recentModels || {}; G.pickerSort = saved?.pickerSort || {}; G.sizes = saved?.sizes || {}; G.theme = saved?.theme || null;
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
  c.srvPop = { outside, timer: setInterval(() => renderServers(c), 2000), editing: null };
  pop.innerHTML = '<div class="srv-empty">Loading…</div>';
  renderServers(c);
}
function closeServers(c) {
  const s = c.srvPop; if (!s) return;
  clearInterval(s.timer); document.removeEventListener('pointerdown', s.outside, true); c.srvPop = null;
  if (!c.el) return;
  $('#paneSrvPop').hidden = true;
  const btn = $('#paneSrvBtn'); btn.classList.remove('active'); btn.setAttribute('aria-expanded', 'false');
}
// The 🖥 servers list: square icon buttons (colour only where it means something: stop red, run green).
const SRV_ICO = {
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/></svg>',
  run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg>',
  logs: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};
async function renderServers(c) {
  const pop = c.el && $('#paneSrvPop');
  if (!pop || pop.hidden || !c.srvPop || c.srvPop.editing || c.srvPop.busy) return;
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
  const pop = $('#paneSrvPop');
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
  const ids = new Set(G.panes.map((id) => G.open.get(id)?.projectId).filter(Boolean));
  for (const pid of ids) { if (G.projects.find((p) => p.id === pid)?.missing) continue; const r = await getJ(`/api/servers/overview?project=${encodeURIComponent(pid)}`); devBadges(pid, r); devAfter(pid, r); }
}
setInterval(pollDev, 3000);

// ---------- ⌨ terminal: live output of every command and server in the project ----------
function openTerminal(c, filter) {
  const t = termState(c.projectId);
  if (filter) t.filter = t.terms.some((u) => u.id === filter) || filter === 'all' || filter === 'agent' ? filter : `srv:${filter}`;
  G.view = { id: G.view.id, src: false, files: false, term: true };
  c.paneHidden = false;
  syncLayout(); renderPane(); toPreview();
}
function termState(projectId) {
  if (G.term?.projectId !== projectId) { closeTermStream(); G.term = { projectId, jobs: new Map(), order: [], seq: 0, filter: 'u1', cleared: 0, terms: [{ id: 'u1', name: 'Terminal 1', cwd: '', hist: [], hi: 0 }], nextTerm: 2 }; }
  return G.term;
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
    j = { id: e.job, label: e.label || '(earlier output)', source: e.source, server: e.server, chatId: e.chatId, tab: e.tab, at: e.at, lines: [], status: 'running', port: e.port };
    t.jobs.set(e.job, j); t.order.push(e.job);
    if (t.order.length > 300) t.jobs.delete(t.order.shift());
  }
  if (e.kind === 'start') Object.assign(j, { label: e.label, source: e.source, server: e.server, chatId: e.chatId, tab: e.tab, at: e.at, port: e.port, status: 'running' });
  else if (e.kind === 'out') { j.lines.push({ text: e.text, stream: e.stream }); if (j.lines.length > 3000) { j.lines.splice(0, j.lines.length - 3000); j.drawn = 0; j.redraw = true; } }
  else if (e.kind === 'end') {
    Object.assign(j, { status: 'done', code: e.code, ms: e.ms, error: e.error });
    const u = e.cwd && e.tab && t.terms?.find((x) => x.id === e.tab);
    if (u) { u.dir = e.cwd; renderTermInput(t); }
  }
  j.dirty = true;
  // A short timer, not requestAnimationFrame: frames are paused in background tabs and some embedded views.
  if (!t.raf) t.raf = setTimeout(() => { t.raf = null; termDraw(t); }, 40);
}
// Which output a terminal tab shows: Activity = everything, Agent = its commands, a server's own tab,
// or one of your terminals (only what was run from it).
const termShows = (t, j) => (t.filter === 'all' ? true : t.filter === 'agent' ? j.source === 'agent' && !j.server : t.filter.startsWith('srv:') ? j.server === t.filter.slice(4) : j.tab === t.filter)
  && (j.status === 'running' || j.at >= (t.clearedBy?.[t.filter] || 0));
function termHead(t, j) {
  const chat = j.chatId && G.chats.find((x) => x.id === j.chatId);
  const who = j.server ? `<span class="tj-srv">🖥 ${esc(j.server)}</span>` : '';
  const src = j.source === 'agent' ? `<span class="tj-src agent" title="${esc(chat ? `From the chat “${chat.title}”` : 'Run by the agent')}">🤖 agent${chat ? ` · ${esc(clip(chat.title, 24))}` : ''}</span>` : j.source === 'you' ? '<span class="tj-src you">👤 you</span>' : '';
  const st = j.status === 'running' ? `<span class="tj-st busy">● ${j.server ? 'running' : 'running…'}</span>`
    : j.error ? `<span class="tj-st bad">✗ ${esc(j.error)}</span>`
    : j.code === 0 || (j.server && j.code == null) ? `<span class="tj-st ok">✓ ${j.server ? 'stopped' : `done${j.ms != null ? ` in ${secs(j.ms)}` : ''}`}</span>`
    : `<span class="tj-st bad">✗ exit ${j.code ?? '?'}${j.ms != null ? ` · ${secs(j.ms)}` : ''}</span>`;
  return `${src}${who}<code class="tj-cmd"><span class="tj-ps">$</span> ${esc(j.label)}</code><span class="tj-time">${esc(new Date(j.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>${st}${j.status === 'running' ? '<button type="button" class="tj-stop" title="Stop it">■ Stop</button>' : ''}`;
}
function termDraw(t, full) {
  const out = $('#paneBody .term-out');
  if (!out || G.term !== t) return;
  const stick = full || out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  if (full) { out.innerHTML = ''; for (const j of t.jobs.values()) { j.el = null; j.drawn = 0; j.dirty = true; } }
  for (const id of t.order) {
    const j = t.jobs.get(id);
    if (!j || !termShows(t, j)) { if (j?.el) { j.el.remove(); j.el = null; j.drawn = 0; } continue; }
    if (!j.dirty && j.el) continue;
    if (!j.el) {
      j.el = document.createElement('div'); j.el.className = 'tj';
      j.el.innerHTML = '<div class="tj-head"></div><pre class="tj-out"></pre>';
      out.appendChild(j.el); j.drawn = 0;
    }
    j.el.classList.toggle('running', j.status === 'running');
    $('.tj-head', j.el).innerHTML = termHead(t, j);
    const stop = $('.tj-stop', j.el);
    if (stop) stop.onclick = () => { stop.disabled = true; if (j.server) postJ('/api/servers/stop', { key: j.id.slice(4, j.id.lastIndexOf(':')) }); else postJ('/api/term/stop', { job: j.id }); };
    const pre = $('.tj-out', j.el);
    if (j.redraw) { pre.textContent = ''; j.drawn = 0; j.redraw = false; }
    const frag = document.createDocumentFragment();
    for (const l of j.lines.slice(j.drawn)) { const s = document.createElement('span'); s.className = `tl ${l.stream || 'out'}`; s.textContent = `${l.text}\n`; frag.appendChild(s); }
    j.drawn = j.lines.length; pre.appendChild(frag);
    while (pre.childElementCount > 1500) pre.firstChild.remove();
    pre.hidden = !j.lines.length;
    j.dirty = false;
  }
  if (!out.childElementCount) out.innerHTML = `<div class="term-empty">${t.filter === 'all' ? 'Nothing has run in this project yet. Commands and servers started by the agent or by you show here live.' : t.terms.some((u) => u.id === t.filter) ? 'A fresh terminal in the project folder. Type a command below (help for what works).' : 'Nothing here yet.'}</div>`;
  else $('.term-empty', out)?.remove();
  if (stick) out.scrollTop = out.scrollHeight;
  termFilters(t);
}
function termFilters(t) {
  const box = $('#paneBody .ttabs'); if (!box) return;
  const servers = [...new Set([...t.jobs.values()].filter((j) => j.server).map((j) => j.server))];
  const agentRan = [...t.jobs.values()].some((j) => j.source === 'agent' && !j.server);
  const busy = (f) => [...t.jobs.values()].some((j) => j.status === 'running' && termShows({ ...t, filter: f, clearedBy: {} }, j));
  const tabs = [['all', '≡ Activity'], ...(agentRan ? [['agent', '🤖 Agent']] : []), ...servers.map((x) => [`srv:${x}`, `🖥 ${x}`]), ...t.terms.map((u) => [u.id, `⌨ ${u.name}`, true])];
  if (!tabs.some(([k]) => k === t.filter)) t.filter = t.terms[0]?.id || 'all';
  const html = tabs.map(([k, l, mine]) => `<span class="ttab ${t.filter === k ? 'on' : ''}" data-f="${esc(k)}" role="tab">${busy(k) ? '<i class="tr-dot busy"></i>' : ''}<span>${esc(l)}</span>${mine ? `<button type="button" class="bt-x" data-close="${esc(k)}" title="Close this terminal" aria-label="Close terminal">×</button>` : ''}</span>`).join('')
    + '<button type="button" class="btab-new ttab-new" title="New terminal">＋</button>';
  if (box.dataset.html === html) return;
  box.dataset.html = html; box.innerHTML = html;
  for (const el of box.querySelectorAll('.ttab')) el.onclick = (e) => { if (e.target.closest('.bt-x')) return; t.filter = el.dataset.f; renderTermInput(t); termDraw(t, true); };
  for (const b of box.querySelectorAll('.bt-x')) b.onclick = () => { postJ('/api/term/close', { projectId: t.projectId, tab: b.dataset.close }).catch(() => {}); dropXterm(t.projectId, b.dataset.close, true); t.terms = t.terms.filter((u) => u.id !== b.dataset.close); if (t.filter === b.dataset.close) t.filter = t.terms[0]?.id || 'all'; renderTermInput(t); termDraw(t, true); };
  $('.ttab-new', box).onclick = () => { const id = `u${t.nextTerm}`; t.terms.push({ id, name: `Terminal ${t.nextTerm++}`, cwd: '', hist: [], hi: 0 }); t.filter = id; renderTermInput(t); termDraw(t, true); $('#paneBody .term-in input')?.focus(); };
}
// The input row belongs to your own terminals; the other tabs only show output.
function renderTermInput(t) {
  const u = t.terms.find((x) => x.id === t.filter), form = $('#paneBody .term-in'), hint = $('#paneBody .term-hint');
  if (!form) return;
  const full = !!u && G.cfg.pty && !u.plain;
  form.hidden = !u || full; hint.hidden = !u || full;
  const note = $('#paneBody .term-note'); if (note) note.hidden = !!u;
  const xbox = $('#paneBody .term-x'), outBox = $('#paneBody .term-out');
  if (xbox) xbox.hidden = !full;
  if (outBox) outBox.hidden = full;
  if (full) { mountXterm(t, u, xbox); return; }
  if (!u) return;
  const p = G.projects.find((x) => x.id === t.projectId);
  const dir = u.dir || p?.dir || '';
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
async function mountXterm(t, u, box) {
  const k = `${t.projectId}:${u.id}`;
  G.xt ||= new Map();
  let x = G.xt.get(k);
  if (x) { if (x.el.parentElement !== box) box.replaceChildren(x.el); requestAnimationFrame(() => { try { x.fit.fit(); } catch { /* hidden */ } x.term.focus(); }); return; }
  // The pane can redraw while this one is still being set up: only one terminal per tab.
  if ((G.xtBusy ||= new Set()).has(k)) return;
  G.xtBusy.add(k);
  box.innerHTML = '<div class="fx-empty">Starting the terminal…</div>';
  try { await loadXterm(); } catch (e) { G.xtBusy.delete(k); u.plain = true; box.hidden = true; renderTermInput(t); return; }
  const el = document.createElement('div'); el.className = 'xt-host';
  const term = new window.Terminal({ cursorBlink: true, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'Consolas, monospace', fontSize: 13, lineHeight: 1.15, scrollback: 5000, allowProposedApi: false, theme: xtermTheme(), convertEol: false });
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
  term.focus();
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
function renderTerm(c) {
  const body = $('#paneBody'), bar = $('#appBar');
  const p = projectOf(c), t = termState(c.projectId);
  bar.hidden = false;
  bar.innerHTML = `<span class="term-title">${SVG_TERM}<b>Terminal</b></span><span class="dim">${esc(p?.name || c.projectId)}</span><span class="spacer"></span>
    <button type="button" class="term-clear" title="Clear this tab's finished output (running ones stay)">Clear</button><button type="button" class="back" title="Close the terminal">✕ Close</button>`;
  $('.term-clear', bar).onclick = () => { const x = G.xt?.get(`${t.projectId}:${t.filter}`); if (x && !$('#paneBody .term-x')?.hidden) { x.term.clear(); x.term.focus(); return; } (t.clearedBy ||= {})[t.filter] = Date.now(); termDraw(t, true); };
  $('.back', bar).onclick = () => { G.view.term = false; closeTermStream(); syncLayout(); renderPane(); };
  body.innerHTML = `<div class="term">
    <div class="ttabs" role="tablist" aria-label="Terminals"></div>
    <div class="term-running" id="termRunning"><span class="tr-label">Running</span><span class="dim">checking…</span></div>
    <div class="term-out" tabindex="0" aria-live="polite"></div>
    <div class="term-x" hidden></div>
    <div class="term-note dim" hidden>This tab only shows output. Open one of your terminals (⌨, or ＋) to run commands.</div>
    <form class="term-in"><span class="term-ps"></span><input aria-label="Command" placeholder="git status   ·   npm run dev   ·   dir" autocomplete="off" spellcheck="false"><button type="submit">Run</button></form>
    <div class="term-hint"><b>${esc(G.cfg.shell || 'Shell')}</b>, starting in the project folder · pipes, scripts, git and dev servers work · <code>clear</code> empties the tab · ■ stops a command (the shell restarts in the same folder) · ↑ ↓ earlier commands · full-screen programs (vim, htop) need a terminal app</div>
  </div>`;
  const form = $('.term-in', body), inp = $('input', form), hint = $('.term-hint', body);
  const say = (msg, bad) => { hint.classList.toggle('bad', !!bad); hint.innerHTML = msg; };
  const defaultHint = hint.innerHTML;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const u = t.terms.find((x) => x.id === t.filter); if (!u) return;
    const line = inp.value.trim(); if (!line) return;
    if (folderMissing(c)) return;
    u.hist.push(line); u.hi = u.hist.length; inp.value = '';
    const [cmd] = line.split(/\s+/);
    if (cmd === 'clear' || cmd === 'cls') { (t.clearedBy ||= {})[u.id] = Date.now(); termDraw(t, true); return; }
    // Your terminals are a real shell; the line goes to it as typed.
    const rs = await postJ('/api/term/run', { projectId: c.projectId, line, tab: u.id });
    if (rs.error) { say(`⚠ ${esc(rs.error)}`, true); termLocal(t, u, line, [`⚠ ${rs.error}`]); return; }
    say(defaultHint); renderTermInput(t);
  };
  inp.onkeydown = (e) => {
    const u = t.terms.find((x) => x.id === t.filter); if (!u) return;
    if (e.key === 'ArrowUp' && u.hi > 0) { u.hi--; inp.value = u.hist[u.hi]; e.preventDefault(); }
    if (e.key === 'ArrowDown') { u.hi = Math.min(u.hist.length, u.hi + 1); inp.value = u.hist[u.hi] || ''; e.preventDefault(); }
  };
  termOpenStream(t);
  termFilters(t); renderTermInput(t);
  termDraw(t, true);
  getJ(`/api/servers/overview?project=${encodeURIComponent(c.projectId)}`).then((r) => drawRunning(c, r));
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
  const lastRun = [...c.agent.messages].reverse().find((m) => m.role === 'assistant' && m.runId);
  if (tab === 'trace') G.traceRun = G.traceRun && c.agent.messages.some((m) => m.runId === G.traceRun) ? G.traceRun : lastRun?.runId || null;
  if (tab === 'browser') refreshAgentTab(c).then((ch) => { if (ch && G.view.browser) renderPane(); });
  G.view = { id: G.view.id, src: false, files: tab === 'files', term: tab === 'term', browser: tab === 'browser', trace: tab === 'trace' ? (G.traceRun || '(none)') : null };
  c.paneHidden = false;
  syncLayout(); renderPane(); refreshTraceButtons(); toPreview();
}
function renderPaneTabs(c) {
  const box = $('#paneTabs'); if (!box) return;
  const t = paneTab();
  for (const b of box.querySelectorAll('[data-tab]')) { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
  const n = planArts(c).length;
  $('[data-tab="art"] .pt-n', box).textContent = n || '';
  const dev = c && G.devCount?.[c.projectId], busyN = dev ? dev.running + dev.busy : 0;
  const tn = $('[data-tab="term"] .pt-n', box); tn.textContent = busyN || ''; tn.classList.toggle('busy', !!dev?.busy);
  const ag = c && G.agentTab?.[c.id];
  const dot = $('[data-tab="browser"] .pt-dot', box); dot.className = `pt-dot ${ag?.locked ? 'live' : ag || G.btabs?.length ? 'has' : ''}`;
  const fa = $('#followAgent'); if (fa) fa.checked = G.followAgent !== false;
}
// The address bar: the served address of what is open, editable to look at any address yourself.
function setUrlBar(url, { art = false } = {}) {
  const tab = paneTab(), wrap = $('#paneUrlWrap'), f = $('#paneUrl');
  wrap.hidden = tab === 'term' || tab === 'files' || tab === 'trace';
  $('#artSelect').hidden = !art;
  wrap.classList.toggle('art-mode', !!art);
  const full = absUrl(url);
  f.value = full;
  f.placeholder = url && url.startsWith('data:') ? 'Embedded in the chat (no address)' : 'Type an address and press Enter to look at it yourself';
  f.title = full || f.placeholder;
  $('#copyUrlBtn').disabled = !full; $('#popBtn').disabled = !full && !(url || '').startsWith('data:');
  G.paneUrl = full;
}
function wirePaneChrome() {
  $('#paneSrvBtn').innerHTML = `${SVG_SERVER}<span class="hdr-count" hidden></span>`;
  $('#paneSrvBtn').onclick = () => { const c = focused(); if (c?.el) toggleServers(c); };
  // ⤢ the pane takes the whole window (chat hidden); ⤡ puts the chat back. Remembered.
  const setMax = (on) => { G.paneMax = on; $('.layout').classList.toggle('pane-max', on); const b = $('#paneMaxBtn'); b.textContent = on ? '⤡' : '⤢'; b.title = on ? 'Show the chat again' : 'Make the pane full width (the chat hides until you press this again)'; b.setAttribute('aria-pressed', String(on)); try { localStorage.setItem('oh-pane-max', on ? '1' : ''); } catch { /* storage off */ } };
  $('#paneMaxBtn').onclick = () => setMax(!G.paneMax);
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
    let v = e.target.value.trim(); if (!v) return;
    if (v.startsWith('/')) v = location.origin + v;
    else if (!/^https?:\/\//i.test(v)) v = (/^(localhost|127\.0\.0\.1)(:\d+)?/i.test(v) ? 'http://' : 'https://') + v;
    browserGo(v);
  };
}

// Every page the agent's browser showed in a reply: browser steps and look's vision checks.
const isShot = (e) => !!e && !!e.image && (e.t === 'screenshot' || (e.t === 'decide_start' && e.look));
function agentShots(c) {
  for (const m of [...c.agent.messages].reverse()) {
    if (m.role !== 'assistant') continue;
    const shots = (m.trace || []).filter(isShot).map((e) => (e.t === 'screenshot'
      ? { url: e.url || '', image: e.image, what: `${e.action || 'open'}${e.target ? ` ${e.target}` : ''}`, at: e.at }
      : { url: String(e.state || '').replace(/^Screenshot of /, ''), image: e.image, what: 'look: checking it with the vision judges', at: e.at }));
    if (shots.length) return { m, shots };
  }
  return null;
}
function onAgentBrowse(c, m) {
  if (focused() !== c) return;
  renderPaneTabs(c);
  // The agent's page appears as a browser tab; with "Follow the agent" the pane switches to it.
  refreshAgentTab(c).then(() => {
    if (G.followAgent !== false && !(G.view.browser && G.bActive === `agent-${c.id}`)) { G.view = { id: G.view.id, src: false, files: false, browser: true }; G.bActive = `agent-${c.id}`; c.paneHidden = false; syncLayout(); renderPane(); }
    else if (G.view.browser) renderPane();
  });
}
// The Browser tab is a small browser of its own: the agent's page for this chat (live, and watch-only
// while its reply works), and your own tabs. Pages run in the harness's headless browser and show as a
// live picture you can click, scroll and type into; your own served pages can show in a frame instead.
function browserTabs(c) {
  const agentSid = `agent-${c.id}`;
  G.btabs ||= [];
  const list = [];
  if (G.agentTab?.[c.id]) list.push({ sid: agentSid, agent: true, ...G.agentTab[c.id] });
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
       <span class="spacer"></span>${REAL && t.url && !live ? '<button type="button" class="bv-dev" title="Open DevTools for this tab" aria-label="DevTools"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/></svg></button>' : ''}${!DESK && !t.agent && t.url ? `<button type="button" class="bv-mode ${t.mode === 'frame' ? 'on' : ''}" title="${t.mode === 'frame' ? 'Shown in a frame. Click to open it in the harness browser instead (for sites that refuse frames)' : 'Shown in the harness browser. Click to show it in a frame (works for your own served pages)'}" aria-label="Frame or harness browser"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg></button>` : ''}${downloadsHTML()}`;
  for (const b of bar.querySelectorAll('.bv-nav')) b.onclick = () => (REAL ? window.ohDesktop.nav(t.sid, b.dataset.op) : ubCall(b.dataset.op));
  const dv = $('.bv-dev', bar); if (dv) dv.onclick = () => window.ohDesktop.nav(t.sid, 'devtools');
  const ex = $('.bv-ext', bar); if (ex) ex.onclick = () => window.ohDesktop.openExternal(t.url);
  wireDownloads(bar);
  const mb = $('.bv-mode', bar); if (mb) mb.onclick = () => { t.mode = t.mode === 'frame' ? 'remote' : 'frame'; t.opened = null; renderPane(); };
  body.innerHTML = `<div class="bwin"><div class="btabs" role="tablist" aria-label="Browser tabs">${list.map((x) => `<span class="btab ${x.sid === t?.sid ? 'on' : ''} ${x.agent ? 'agent' : ''}" data-sid="${esc(x.sid)}" role="tab" title="${esc(x.url || 'New tab')}">${x.agent ? `<i class="bt-dot ${x.locked ? 'live' : ''}"></i>🤖` : '🌐'}<span class="bt-title">${esc(x.agent ? (x.title || 'Agent') : (x.title || (x.url ? x.url.replace(/^https?:\/\//, '').slice(0, 24) : 'New tab')))}</span><button type="button" class="bt-x" data-close="${esc(x.sid)}" title="Close this tab" aria-label="Close tab">×</button></span>`).join('')}<button type="button" class="btab-new" title="New tab">＋</button></div><div class="bstage"></div></div>`;
  for (const el of body.querySelectorAll('.btab')) el.onclick = (e) => { if (e.target.closest('.bt-x')) return; G.bActive = el.dataset.sid; renderPane(); };
  for (const b of body.querySelectorAll('.bt-x')) b.onclick = () => closeBTab(c, b.dataset.close);
  $('.btab-new', body).onclick = () => { newBTab(''); renderPane(); $('#paneUrl').focus(); };
  const stage = $('.bstage', body);
  if (!t || !t.url) return newTabPage(c, stage);
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
  stage.innerHTML = `<div class="bnew"><p class="dim">Type an address in the bar above and press Enter${links.length ? ', or open something from this chat:' : '.'}</p>${links.length ? `<div class="bnew-links">${links.map((l, i) => `<button type="button" class="bnew-link" data-i="${i}"><b>${esc(l.label)}</b><code>${esc(l.url)}</code></button>`).join('')}</div>` : ''}</div>`;
  for (const b of stage.querySelectorAll('.bnew-link')) b.onclick = () => browserGo(links[Number(b.dataset.i)].url);
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
function closeBTab(c, sid) {
  if (sid.startsWith('agent-')) { delete G.agentTab[c.id]; } else { G.btabs = (G.btabs || []).filter((x) => x.sid !== sid); if (DESK) window.ohDesktop.close(sid); }
  postJ('/api/ubrowser', { sid, op: 'close' }).catch(() => {});
  if (G.bActive === sid) G.bActive = null;
  renderPane();
}
// Is there an agent page for this chat, and is the agent still on it? (Checked while the Browser tab shows.)
async function refreshAgentTab(c) {
  const r = await postJ('/api/ubrowser', { sid: `agent-${c.id}`, op: 'peek' });
  G.agentTab ||= {};
  const had = G.agentTab[c.id];
  if (r.none || r.error) { if (had) { delete G.agentTab[c.id]; return true; } return false; }
  G.agentTab[c.id] = { ...had, url: r.url, title: r.title, locked: r.locked, w: r.w, h: r.h, desktop: r.desktop };
  return !had || had.locked !== r.locked || had.desktop !== r.desktop;
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
  Object.assign(t, { url: res.url, title: res.title, shot: res.shot, w: res.w, h: res.h, locked: res.locked });
  if (t.agent) Object.assign(G.agentTab[c.id] ||= {}, { url: res.url, title: res.title, locked: res.locked, shot: res.shot });
  if (lockChanged) return renderPane();
  $('#paneBody .ub-shot').src = res.shot;
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
  const [info, login] = await Promise.all([window.ohDesktop.info().catch(() => ({})), window.ohDesktop.loginItem().catch(() => false)]);
  if (!box.isConnected) return;
  box.innerHTML = stCard('Desktop app', `Version ${esc(info.version || '?')}${info.packaged ? '' : ' (running from the repo)'}. ${info.ownsServer ? 'It runs the harness itself; ✕ keeps it in the tray and Quit is in the tray menu.' : 'It is attached to a harness that was already running.'}`,
    stRow('Start at login', 'Opens QuorX in the tray when you sign in to Windows, so phones on your Wi-Fi can reach it. Applies right away.', '<label class="sq-check"><input type="checkbox" id="stDeskLogin"' + (login ? ' checked' : '') + '><span>On</span></label>')
    + stRow('Updates', '', '<span id="stDeskUpd" class="st-upd">…</span> <button type="button" class="st-btn ghost sm" id="stDeskCheck">Check now</button>')
    + stRow('Update feed', 'Where new versions are published (latest.yml and the installer), e.g. https://github.com/you/repo/releases/latest/download. Empty: no updates.', '<input type="url" class="st-input" id="stDeskFeed" placeholder="https://…" spellcheck="false" style="min-width:260px">')
    + stRow('Data folder', 'Chats, projects, keys and logs.', `<code class="blurable" title="${esc(info.home || '')}">${esc(info.home || '')}</code> <button type="button" class="st-btn ghost sm" id="stDeskHome">📂 Open</button>`));
  $('#stDeskLogin').onchange = async (e) => { e.target.checked = await window.ohDesktop.loginItem(e.target.checked).catch(() => !e.target.checked); };
  $('#stDeskHome').onclick = () => window.ohDesktop.openHome();
  const st = await window.ohDesktop.update('state').catch(() => ({}));
  $('#stDeskFeed').value = st.url || '';
  $('#stDeskFeed').onchange = async (e) => { try { await window.ohDesktop.update('setUrl', e.target.value); } catch (er) { uiAlert(er.message); } };
  $('#stDeskCheck').onclick = () => window.ohDesktop.update('check');
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
function drawUpdate(u) {
  const b = $('#updNote');
  if (b) {
    const t = updateText(u);
    // Short on the button (it shares the sidebar's footer with three icons); the whole sentence is in its tip.
    // While downloading, the button fills up like a progress bar.
    const short = { available: `Update ${u.version ? `v${u.version}` : ''}`.trim(), downloading: `${u.percent ?? 0}%`, ready: 'Restart', error: 'Retry' }[u.state] || '';
    b.hidden = !t; b.dataset.state = u.state || '';
    b.innerHTML = t ? `${UPD_ICO[u.state] || ''}<span class="un-txt">${esc(short)}</span>` : '';
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
  const s = $('#stDeskUpd');
  if (s) s.textContent = { dev: 'Running from the repo: updates come from git.', 'no-feed': 'No update feed set.', checking: 'Checking…', current: `Up to date (v${u.current || '?'}).`, available: `v${u.version} is available.`, downloading: `Downloading… ${u.percent ?? 0}%`, ready: `v${u.version} is downloaded: restart to install.`, error: `Couldn't check: ${u.error || 'unknown error'}` }[u.state] || `v${u.current || '?'}`;
}
if (DESK) {
  window.ohDesktop.on((ev) => { if (ev.type === 'update') drawUpdate(ev); });
  setTimeout(() => window.ohDesktop.update('state').then(drawUpdate).catch(() => {}), 1500);
  const ub = $('#updNote');
  const rb = $('#railUpd'); if (rb) rb.onclick = () => ub?.click();
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
