// The QuorX popup: connect once, give the current tab to a chat or take it back, see and stop the agent, allow
// reading without the debugging bar, and record a routine.
const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((ok, no) => chrome.runtime.sendMessage(msg, (r) => (r?.ok ? ok(r.r) : no(new Error(r?.error || chrome.runtime.lastError?.message || 'no answer')))));
const say = (t) => { $('err').textContent = t || ''; $('err').style.color = ''; $('err').hidden = !t; };
let tab = null, chats = [], lentChatId = null;
const STATES = { working: 'Working', needs: 'Needs you in QuorX', done: 'Done' };

function status(s) {
  const d = $('dot');
  d.className = `dot ${s.state === 'on' ? 'on' : s.state === 'denied' || s.state === 'error' ? 'bad' : ''}`;
  $('dotText').textContent = s.state === 'on' ? 'connected' : s.state === 'connecting' ? 'connecting…' : s.state === 'pairing' ? 'waiting for Allow' : s.state === 'unpaired' ? 'not set up' : 'not connected';
}
async function draw() {
  say('');
  const s = await ask({ q: 'state' });
  status(s);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const showPair = s.state === 'pairing' || !s.paired || s.state === 'denied';
  $('pairWait').hidden = s.state !== 'pairing'; $('pairBtn').disabled = s.state === 'pairing';
  $('pairCode').textContent = s.code || ''; $('pairCode').hidden = !s.code;
  $('pair').hidden = !showPair; $('give').hidden = showPair;
  $('address').value = s.address || 'http://127.0.0.1:5188';
  if (s.error && s.state !== 'on') say(s.error);
  if (showPair) return;
  $('allowOpen').checked = s.allowOpen;
  $('tabTitle').textContent = tab?.title || 'This tab'; $('tabUrl').textContent = tab?.url || '';
  const lent = tab && s.lent[tab.id];
  lentChatId = lent?.chatId || null;
  if (s.state === 'on') chats = await ask({ q: 'chats' }).catch(() => []);
  $('giveForm').hidden = !!lent; $('lentNote').hidden = !lent;
  $('thisTab').classList.toggle('lent', !!lent);
  if (lent) {
    $('lentChat').textContent = chats.find((c) => c.id === lent.chatId)?.title || 'a chat';
    const st = s.status[lent.chatId];
    $('agentState').textContent = STATES[st?.state] || 'Idle';
    $('agentState').className = `state ${st?.state || ''}`;
    $('agentWhat').textContent = st?.state === 'needs' ? st.what : '';
    $('stopBtn').disabled = !st || st.state === 'done';
  }
  const options = chats.map((c) => `<option value="${c.id}">${esc(c.title)}${c.project ? ` · ${esc(c.project)}` : ''}</option>`).join('') || '<option value="">No chats yet: start one in QuorX</option>';
  $('chat').innerHTML = options; $('recChat').innerHTML = options;
  $('giveBtn').disabled = s.state !== 'on' || !chats.length || !/^https?:/i.test(tab?.url || '');
  if (!/^https?:/i.test(tab?.url || '')) say('Only web pages (http or https) can be given.');
  $('scriptBox').hidden = !!s.script;
  // Recording
  $('recIdle').hidden = !!s.rec; $('recOn').hidden = !s.rec;
  $('recBtn').disabled = s.state !== 'on' || !/^https?:/i.test(tab?.url || '');
  if (s.rec) $('recCount').textContent = `${s.rec.steps.length} step${s.rec.steps.length === 1 ? '' : 's'} so far${s.rec.tab !== tab?.id ? ' (in another tab)' : ''}`;
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('pairBtn').onclick = async () => {
  $('pairBtn').disabled = true;
  try { const r = await ask({ q: 'pair', address: $('address').value }); if (r.state !== 'pairing' && r.state !== 'on') say(r.error || 'Could not reach QuorX: is it running?'); } catch (e) { say(e.message); }
  draw();
  // Back to the normal view once you Allow it in QuorX.
  const poll = setInterval(async () => { const s = await ask({ q: 'state' }).catch(() => null); if (!s || s.state !== 'pairing') { clearInterval(poll); draw(); } }, 1000);
};
$('save').onclick = async () => {
  $('save').disabled = true;
  try { const r = await ask({ q: 'save', address: $('address').value, key: $('key').value }); $('key').value = ''; if (r.state !== 'on') say(r.error || 'Could not connect.'); } catch (e) { say(e.message); }
  $('save').disabled = false; draw();
};
$('giveBtn').onclick = async () => { try { await ask({ q: 'give', tab: tab.id, chatId: $('chat').value }); } catch (e) { say(e.message); } draw(); };
$('backBtn').onclick = async () => { try { await ask({ q: 'takeBack', tab: tab.id }); } catch (e) { say(e.message); } draw(); };
$('stopBtn').onclick = async () => { try { const r = await ask({ q: 'stop', chatId: lentChatId }); if (!r?.stopped) say('Nothing was running in that chat.'); } catch (e) { say(e.message); } draw(); };
$('openBtn').onclick = () => ask({ q: 'open', chatId: lentChatId }).catch((e) => say(e.message));
// Chrome only asks for a permission from a click in the extension's own page, so the request runs here.
$('scriptBtn').onclick = async () => {
  try { const ok = await chrome.permissions.request({ origins: ['<all_urls>'] }); if (!ok) say('Not allowed: reading keeps using the debugger.'); await ask({ q: 'caps' }); } catch (e) { say(e.message); }
  draw();
};
$('recBtn').onclick = async () => { try { await ask({ q: 'rec-start', tab: tab.id }); } catch (e) { say(e.message); } draw(); };
$('recSave').onclick = async () => {
  const name = $('recName').value.trim();
  if (!name) { say('Give the routine a name first.'); return; }
  let done = '';
  try { const r = await ask({ q: 'rec-stop', chatId: $('recChat').value, name }); if (r?.saved) done = `Saved “${r.name}” (${r.steps} steps) as a skill in ${r.project}.`; } catch (e) { say(e.message); return draw(); }
  await draw();
  if (done) { $('err').textContent = done; $('err').style.color = 'var(--ok)'; $('err').hidden = false; }
};
$('recDrop').onclick = async () => { await ask({ q: 'rec-stop', discard: true }).catch(() => {}); draw(); };
$('allowOpen').onchange = (e) => ask({ q: 'allowOpen', on: e.target.checked }).catch((x) => say(x.message));
$('repair').onclick = () => { $('pair').hidden = false; $('give').hidden = true; };
draw().catch((e) => say(e.message));
