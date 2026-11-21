// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ✦ The QuorX assistant's drawer (server/assistant.js does the thinking): talk to it by typing or by voice, hear its
// replies, and click the cards it puts up for changes. app.js hands it the page's own helpers (initAssistant).
import { pickVoice } from './speak.js';

let H = null; // the page's helpers
const A = { open: false, busy: false, msgs: [], state: null, speak: false, showMoney: false, rec: null };
const SPEAK_KEY = 'qx.assistant.speak';
const ideas = [
  'Which of my providers gives the best value for you?',
  'Give yourself a $3 monthly budget',
  'Make message text a bit bigger',
  'Open the budget settings',
  'Add a "copy chat link" button to the chat header',
];

export function initAssistant(helpers) {
  H = helpers;
  try { A.speak = localStorage.getItem(SPEAK_KEY) === '1'; } catch { /* no storage */ }
  const btn = document.createElement('button');
  btn.id = 'qxaBtn'; btn.className = 'qxa-launch'; btn.type = 'button';
  btn.title = 'Talk to the QuorX assistant (Ctrl+Shift+K)'; btn.setAttribute('aria-label', 'QuorX assistant');
  btn.innerHTML = '<span aria-hidden="true">✦</span>';
  btn.addEventListener('click', () => toggle());
  document.body.append(btn);
  const el = document.createElement('aside');
  el.id = 'qxa'; el.className = 'qxa'; el.hidden = true; el.setAttribute('aria-label', 'QuorX assistant');
  document.body.append(el);
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); toggle(); } if (e.key === 'Escape' && A.open && el.contains(document.activeElement)) toggle(false); });
}

async function toggle(force) {
  A.open = force ?? !A.open;
  const el = document.getElementById('qxa');
  el.hidden = !A.open;
  document.getElementById('qxaBtn').classList.toggle('on', A.open);
  if (!A.open) { stopVoice(); return; }
  if (!A.state) {
    A.state = await H.getJ('/api/assistant');
    A.msgs = (A.state.history || []).map((m) => ({ role: m.role, text: m.content }));
  }
  draw();
  el.querySelector('textarea')?.focus();
}

const money = (n) => `$${Number(n || 0).toFixed(n && n < 0.01 ? 4 : 2)}`;
const shortModel = (id) => String(id || '').split('/').slice(-1)[0];
function draw() {
  const el = document.getElementById('qxa'), s = A.state || {}, b = s.budget || {};
  const pct = b.monthly ? Math.min(100, Math.round((b.spent / b.monthly) * 100)) : 0;
  el.innerHTML = `
  <header class="qxa-head">
    <div class="qxa-title"><span class="qxa-mark" aria-hidden="true">✦</span><b>QuorX assistant</b></div>
    <span class="qxa-tag" title="Talking with ${H.esc(s.models?.talk || '')}${s.auto?.talk ? ' (picked for value)' : ''}">${H.esc(shortModel(s.models?.talk))}</span>
    <button class="qxa-icon" data-a="settings" title="Assistant settings (⚙ Settings → Assistant): models, voice, budget" aria-label="Assistant settings">⚙</button>
    <button class="qxa-icon" data-a="clear" title="Start a fresh conversation" aria-label="Start a fresh conversation">⟲</button>
    <button class="qxa-icon" data-a="close" title="Close (Esc)" aria-label="Close">✕</button>
  </header>
  <div class="qxa-budget" title="The assistant's own budget for ${H.esc(b.month || '')}. It stops at the limit.">
    <span>Budget</span>
    <span class="qxa-meter" aria-hidden="true"><i style="width:${pct}%"></i></span>
    <button class="qxa-money" data-a="money" aria-label="${A.showMoney ? 'Hide amounts' : 'Show amounts'}">${A.showMoney ? `${money(b.spent)} of ${money(b.monthly)}` : '•••• of ••••'}</button>
  </div>
  <div class="qxa-log" role="log" aria-live="polite">
    ${A.msgs.length ? A.msgs.map(msgHTML).join('') : `<div class="qxa-empty"><p>Hi! Ask me anything about QuorX, or tell me what to change. I can check your providers and spend, change settings and even improve QuorX's own code (in a branch you test first).</p>${ideas.map((t) => `<button class="qxa-idea" data-idea="${H.esc(t)}">${H.esc(t)}</button>`).join('')}</div>`}
    ${A.busy ? '<div class="qxa-msg bot qxa-typing"><span></span><span></span><span></span></div>' : ''}
  </div>
  <form class="qxa-compose">
    <textarea rows="2" placeholder="Talk to QuorX… (Enter to send)" ${A.busy ? 'disabled' : ''}></textarea>
    <div class="qxa-row">
      <label class="qxa-check"><input type="checkbox" data-a="speak" ${A.speak ? 'checked' : ''}><span class="box" aria-hidden="true"></span>Speak replies</label>
      ${hasMic() ? `<button type="button" class="qxa-btn ${A.rec ? 'rec' : ''}" data-a="mic" ${A.hearing ? 'disabled' : ''} title="${A.rec ? 'Stop and send' : 'Talk instead of typing'}">${A.rec ? '■ Stop' : A.hearing ? 'Hearing…' : '🎤 Talk'}</button>` : ''}
      <button type="submit" class="qxa-btn primary" ${A.busy ? 'disabled' : ''}>Send</button>
    </div>
  </form>`;
  const log = el.querySelector('.qxa-log'); log.scrollTop = log.scrollHeight;
  wire(el);
}

function msgHTML(m, i) {
  if (m.role === 'user') return `<div class="qxa-msg me">${H.esc(m.text)}</div>`;
  if (m.role === 'card') {
    const c = m.card;
    const state = m.done ? `<span class="qxa-status ${m.done}">${m.done === 'yes' ? '✓ Done' : m.done === 'no' ? 'Kept as it was' : H.esc(m.err || 'Failed')}</span>` : '';
    return `<div class="qxa-card" data-i="${i}">
      <div class="qxa-card-t">${H.esc(c.title)}</div>
      ${c.goal ? `<div class="qxa-card-goal">${H.esc(c.goal)}</div>` : ''}
      <div class="qxa-card-ft"><s>${H.esc(c.from)}</s> → <b>${H.esc(c.to)}</b>${c.where ? ` <small>· ${H.esc(c.where)}</small>` : ''}</div>
      ${m.done ? state : `<div class="qxa-card-act"><button class="qxa-btn primary" data-yes="${i}">${c.kind === 'self_edit' ? 'Start it' : 'Change it'}</button><button class="qxa-btn" data-no="${i}">Keep it as it is</button></div>`}
    </div>`;
  }
  const bits = m.meta ? [m.meta.steps?.length ? `looked at ${[...new Set(m.meta.steps)].join(', ')}` : '', A.showMoney ? (m.meta.cost ? money(m.meta.cost) : 'on your plan, $0') : ''].filter(Boolean) : [];
  const meta = bits.length ? `<div class="qxa-meta">${H.esc(bits.join(' · '))}</div>` : '';
  return `<div class="qxa-msg bot">${H.esc(m.text)}${meta}</div>`;
}

function wire(el) {
  const ta = el.querySelector('textarea');
  el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); send(ta.value); });
  ta?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } });
  el.onclick = async (e) => {
    const t = e.target;
    const a = t.closest('[data-a]')?.dataset.a;
    if (a === 'close') return toggle(false);
    if (a === 'money') { A.showMoney = !A.showMoney; return draw(); }
    if (a === 'clear') { await H.postJ('/api/assistant/clear', {}); A.msgs = []; return draw(); }
    if (a === 'mic') return mic();
    if (a === 'settings') { toggle(false); return H.openSettings('assistant'); }
    if (t.closest('[data-idea]')) return send(t.closest('[data-idea]').dataset.idea);
    const yes = t.closest('[data-yes]'), no = t.closest('[data-no]');
    if (no) { const m = A.msgs[no.dataset.no]; m.done = 'no'; H.postJ('/api/assistant/card', { title: m.card.title, outcome: 'no' }); return draw(); }
    if (yes) return confirm(A.msgs[yes.dataset.yes]);
  };
  el.querySelector('[data-a="speak"]')?.addEventListener('change', (e) => { A.speak = e.target.checked; try { localStorage.setItem(SPEAK_KEY, A.speak ? '1' : '0'); } catch { /* no storage */ } if (!A.speak) stopVoice(); });
}

async function send(text) {
  text = String(text || '').trim();
  if (!text || A.busy) return;
  A.msgs.push({ role: 'user', text }); A.busy = true; draw();
  const r = await H.postJ('/api/assistant', { text, prefs: { ...H.G.settings, theme: H.G.theme || 'system' } });
  A.busy = false;
  if (r.error) { A.msgs.push({ role: 'bot', text: `⚠ ${r.error}` }); return draw(); }
  A.msgs.push({ role: 'bot', text: r.say, meta: { steps: r.steps, cost: r.cost } });
  for (const c of r.cards || []) A.msgs.push({ role: 'card', card: c });
  if (r.budget) A.state.budget = r.budget;
  draw();
  for (const act of r.actions || []) doAction(act);
  if (A.speak) say(r.say);
}

async function doAction(act) {
  if (act.kind !== 'open') return;
  const [kind, id] = act.where.split(':');
  if (kind === 'chat') { await H.refreshSidebar(); return H.showChat(id); }
  H.openSettings(act.where);
}

async function confirm(m) {
  const c = m.card;
  if (c.kind === 'setting') {
    H.settingChanged({ where: 'quorx', key: c.key, value: c.value });
    m.done = 'yes'; draw();
    await H.postJ('/api/assistant/card', { title: c.title, outcome: 'yes', prefs: { assistant: H.G.settings.assistant || {} } });
    if (c.key.startsWith('assistant.')) { A.state = await H.getJ('/api/assistant'); draw(); }
    return;
  }
  m.done = 'busy'; m.err = c.kind === 'self_edit' ? 'Starting…' : 'Saving…'; draw();
  const r = await H.postJ('/api/assistant/confirm', { card: c, prefs: { assistant: H.G.settings.assistant || {} } });
  if (r.error) { m.done = 'err'; m.err = r.error; H.postJ('/api/assistant/card', { title: c.title, outcome: 'err' }); return draw(); }
  m.done = 'yes'; H.postJ('/api/assistant/card', { title: c.title, outcome: 'yes' });
  if (r.budget) A.state.budget = r.budget;
  if (r.models) A.state.models = r.models;
  if (c.kind === 'self_edit') {
    A.msgs.push({ role: 'bot', text: `On it. QuorX's agent is working on branch ${r.branch} with ${shortModel(r.model)}, in its own copy. I've opened the chat so you can watch; when it's done, try it and merge it if you like it.` });
    await H.refreshSidebar(); H.showChat(r.chatId);
  }
  draw();
}

// ---------- voice ----------
// Talk: records with QuorX's own mic (the chat's 🎤: same consent, same silence check) and transcribes on QuorX's
// server, so it works in the desktop app too, where the browser's own speech recognition can't reach its servers.
const hasMic = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
async function mic() {
  if (A.rec) { A.rec.stop(); return; }
  if (!(await H.micAllowed())) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { A.msgs.push({ role: 'bot', text: `⚠ The microphone isn't available (${e.message}). Typing works too.` }); return draw(); }
  const rec = new MediaRecorder(stream), chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    A.rec = null; A.hearing = true; draw();
    try {
      const decoded = await new AudioContext().decodeAudioData(await new Blob(chunks).arrayBuffer());
      const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
      const samples = (await off.startRendering()).getChannelData(0);
      if (!H.heardSpeech(samples, 16000)) { A.hearing = false; A.msgs.push({ role: 'bot', text: "I didn't hear anything, so nothing was sent." }); return draw(); }
      const audio = (await H.asDataURL(H.encodeWav(samples, 16000))).split(',')[1];
      const r = await H.postJ('/api/transcribe', { audio, model: H.G.settings.assistant?.listenModel || 'google/gemini-3.1-flash-lite' });
      A.hearing = false;
      if (r.error) throw new Error(r.error);
      if (String(r.text || '').trim()) return send(r.text);
      draw();
    } catch (e) { A.hearing = false; A.msgs.push({ role: 'bot', text: `⚠ I couldn't turn that into text (${e.message}). Typing works too.` }); draw(); }
  };
  A.rec = rec; rec.start(); draw();
}
// Replies are read with its AI voice (⚙: ElevenLabs v4 Turbo, Sarah, by default); Windows' voice when that is chosen,
// or when the AI voice can't (no OpenRouter key, budget used up, the model failed).
let playing = null;
function stopVoice() { playing?.pause(); playing = null; window.speechSynthesis?.cancel(); }
async function say(text) {
  if (!text) return;
  stopVoice();
  const r = await H.postJ('/api/assistant/speak', { text: String(text).replace(/[*_`#]/g, '').slice(0, 2000), prefs: { assistant: H.G.settings.assistant || {} } });
  if (r.url) {
    if (r.budget && A.state) { A.state.budget = r.budget; draw(); }
    playing = new Audio(r.url); playing.play().catch(() => pcSay(text));
    return;
  }
  pcSay(text);
}
function pcSay(text) {
  if (!window.speechSynthesis || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).replace(/[*_`#]/g, ''));
  const v = pickVoice(speechSynthesis.getVoices(), navigator.language || 'en-US');
  if (v) u.voice = v;
  u.rate = 1.03;
  speechSynthesis.speak(u);
}
