// The QuorX popup: connect once, then give the current tab to a chat or take it back.
const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((ok, no) => chrome.runtime.sendMessage(msg, (r) => (r?.ok ? ok(r.r) : no(new Error(r?.error || chrome.runtime.lastError?.message || 'no answer')))));
const say = (t) => { $('err').textContent = t || ''; $('err').hidden = !t; };
let tab = null, chats = [];

function status(s) {
  const d = $('dot');
  d.className = `dot ${s.state === 'on' ? 'on' : s.state === 'denied' || s.state === 'error' ? 'bad' : ''}`;
  $('dotText').textContent = s.state === 'on' ? 'connected' : s.state === 'connecting' ? 'connecting…' : s.state === 'unpaired' ? 'not set up' : 'not connected';
}
async function draw() {
  say('');
  const s = await ask({ q: 'state' });
  status(s);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const showPair = !s.paired || s.state === 'denied';
  $('pair').hidden = !showPair; $('give').hidden = showPair;
  $('address').value = s.address || 'http://127.0.0.1:5188';
  if (s.error && s.state !== 'on') say(s.error);
  if (showPair) return;
  $('tabTitle').textContent = tab?.title || 'This tab'; $('tabUrl').textContent = tab?.url || '';
  const lent = tab && s.lent[tab.id];
  if (s.state === 'on') chats = await ask({ q: 'chats' }).catch(() => []);
  $('giveForm').hidden = !!lent; $('lentNote').hidden = !lent;
  $('thisTab').classList.toggle('lent', !!lent);
  if (lent) $('lentChat').textContent = chats.find((c) => c.id === lent.chatId)?.title || 'a chat';
  $('chat').innerHTML = chats.map((c) => `<option value="${c.id}">${esc(c.title)}${c.project ? ` · ${esc(c.project)}` : ''}</option>`).join('') || '<option value="">No chats yet: start one in QuorX</option>';
  $('giveBtn').disabled = s.state !== 'on' || !chats.length || !/^https?:/i.test(tab?.url || '');
  if (!/^https?:/i.test(tab?.url || '')) say('Only web pages (http or https) can be given.');
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('save').onclick = async () => {
  $('save').disabled = true;
  try { const r = await ask({ q: 'save', address: $('address').value, key: $('key').value }); $('key').value = ''; if (r.state !== 'on') say(r.error || 'Could not connect.'); } catch (e) { say(e.message); }
  $('save').disabled = false; draw();
};
$('giveBtn').onclick = async () => { try { await ask({ q: 'give', tab: tab.id, chatId: $('chat').value }); } catch (e) { say(e.message); } draw(); };
$('backBtn').onclick = async () => { try { await ask({ q: 'takeBack', tab: tab.id }); } catch (e) { say(e.message); } draw(); };
$('repair').onclick = () => { $('pair').hidden = false; $('give').hidden = true; };
draw().catch((e) => say(e.message));
