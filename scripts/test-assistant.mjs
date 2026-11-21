// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ✦ The QuorX assistant (server/assistant.js): its reply format, its tool loop, cards for changes, and its budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-assist-'));
fs.mkdirSync(path.join(home, 'data'), { recursive: true });
process.env.OH_HOME = home;
process.env.OH_NO_SCHEDULES = '1';
const A = await import('../server/assistant.js');

// A scripted model: each call answers with the next reply, and costs `cost`.
const scripted = (replies, cost = 0.001) => { let i = 0; const seen = []; const call = async (b) => { seen.push(b); return { message: { content: replies[Math.min(i++, replies.length - 1)] }, usage: { cost }, model: 'test/model' }; }; call.seen = seen; return call; };

test('parseReply reads JSON, fenced JSON, and plain words', () => {
  assert.deepEqual(A.parseReply('{"say":"hi","do":[]}'), { say: 'hi', do: [] });
  assert.equal(A.parseReply('```json\n{"say":"ok","do":[{"tool":"status"}]}\n```').do[0].tool, 'status');
  assert.deepEqual(A.parseReply('just words'), { say: 'just words', do: [] });
});

test('a turn looks things up, then answers; a setting change becomes a card, not a change', async () => {
  const call = scripted([
    '{"say":"Let me check.","do":[{"tool":"settings_find","args":{"query":"text size"}},{"tool":"settings_set","args":{"key":"ui.fontSize","value":16}}]}',
    '{"say":"I put up a card to make text 16px.","do":[]}',
  ]);
  const r = await A.assistantTurn({ text: 'make text bigger', prefs: { ui: { fontSize: 14 }, assistant: { access: 'ask' } }, call });
  assert.equal(r.say, 'I put up a card to make text 16px.');
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].kind, 'setting');
  assert.equal(r.cards[0].value, 16);
  assert.match(call.seen[1].messages.at(-1).content, /ui\.fontSize/);
  assert.ok(r.cost > 0.0019 && r.budget.spent > 0);
});

test('open is done at once; unknown places are refused', async () => {
  const r = await A.assistantTurn({ text: 'open budget', call: scripted(['{"say":"Opening.","do":[{"tool":"open","args":{"where":"budget"}},{"tool":"open","args":{"where":"../etc"}}]}', '{"say":"There.","do":[]}']) });
  assert.deepEqual(r.actions, [{ kind: 'open', where: 'budget' }]);
});

test('its budget: a card to change it, and at the limit it stops without calling a model', async () => {
  const r = await A.assistantTurn({ text: 'budget 0.01', prefs: { assistant: { access: 'ask' } }, call: scripted(['{"say":"","do":[{"tool":"budget_set","args":{"monthly":0.1}}]}', '{"say":"Card is up.","do":[]}']) });
  assert.equal(r.cards[0].kind, 'setting');
  assert.equal(r.cards[0].key, 'assistant.monthly');
  A.syncPrefs({ assistant: { monthly: r.cards[0].value } }); // the page applies the card and its prefs come back
  assert.equal(A.budgetInfo().monthly, 0.1);
  const spend = scripted(['{"say":"ok","do":[]}'], 0.2);
  await A.assistantTurn({ text: 'spend it', call: spend });
  const none = scripted(['{"say":"should not run","do":[]}']);
  const stop = await A.assistantTurn({ text: 'again', call: none });
  assert.equal(none.seen.length, 0);
  assert.match(stop.say, /used my \$0\.10/);
  assert.equal(stop.cards[0].key, 'assistant.monthly');
});

test('API keys are never settable', async () => {
  const call = scripted(['{"say":"","do":[{"tool":"settings_set","args":{"key":"keys.openrouter","value":"x"}}]}', '{"say":"Can\'t.","do":[]}']);
  A.resetAssistant(); fs.rmSync(path.join(home, 'data', 'assistant.json'), { force: true });
  const r = await A.assistantTurn({ text: 'set key', call });
  assert.equal(r.cards.length, 0);
});

test('settings search forgives wording: "image generation model" finds the pictures models', () => {
  const keys = A.settingsFind({ query: 'image generation model' }).map((s) => s.key);
  assert.ok(keys.includes('tools.image.models'), keys.join(', '));
  assert.ok(A.settingsFind({ query: 'microphone' }).some((s) => s.key.startsWith('tools.listen')));
});

test('chats: an unknown project says which projects there are', async () => {
  const r = await A.assistantTurn({ text: 'chats', call: scripted(['{"say":"","do":[{"tool":"chats","args":{"project":"nope-nothing"}}]}', '{"say":"No such project.","do":[]}']) });
  assert.equal(r.steps[0], 'chats');
});

test('its settings come from ⚙ Settings (the page prefs): empty means auto, PC voice costs nothing', async () => {
  A.syncPrefs({ assistant: { talkModel: 'opencode-go/claude-haiku-5-5', codeModel: '', voiceModel: 'elevenlabs/eleven-v4-turbo', voice: 'sarah', listenModel: 'google/gemini-3.1-flash-lite', monthly: 4 } });
  const s = A.load();
  assert.equal(s.talkModel, 'opencode-go/claude-haiku-5-5');
  assert.equal(s.codeModel, undefined);
  assert.equal(s.voice, 'sarah');
  assert.equal(s.monthly, 4);
  A.syncPrefs({ assistant: { monthly: 9999 } });
  assert.equal(A.load().monthly, 4, 'out-of-range budgets are ignored');
  A.syncPrefs({ assistant: { voiceWith: 'pc' } });
  assert.deepEqual(await A.assistantSpeak({ text: 'hi' }), { pc: true });
});

test('⚙ Settings knows every assistant setting, in its own category', async () => {
  const { SETTINGS, CATS } = await import('../server/quorxsettings.js');
  assert.ok(CATS.assistant);
  const keys = SETTINGS.filter((s) => s.cat === 'assistant').map((s) => s.key);
  for (const k of ['assistant.talkModel', 'assistant.codeModel', 'assistant.voiceWith', 'assistant.voiceModel', 'assistant.voice', 'assistant.listenModel', 'assistant.monthly']) assert.ok(keys.includes(k), k);
});

test('a reply cut off mid-JSON still shows its words, not the JSON', () => {
  const r = A.parseReply('{"say":"SFW18 has one chat: \\"Cosplay\\". The image model is chosen by');
  assert.equal(r.say, 'SFW18 has one chat: "Cosplay". The image model is chosen by…');
  assert.deepEqual(r.do, []);
});

test('the API map comes from server.js itself, with notes, and leaves out keys and streams', async () => {
  const X = await import('../server/assistantapi.js');
  const map = X.apiMap();
  assert.ok(map.length > 100, `only ${map.length} routes`);
  assert.ok(map.some((e) => e.path === '/api/costs' && e.methods.includes('GET')));
  assert.ok(map.some((e) => e.path.startsWith('/api/chats/:id')));
  assert.ok(!map.some((e) => /\/keys?(\/|$)/.test(e.path)));
  assert.ok(X.blockedPath('/api/keys') && X.blockedPath('/api/runs/r1/events') && X.blockedPath('/api/run') && !X.blockedPath('/api/costs'));
  const small = X.apiMap("    // A chat's budget\n    const cbm = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)\/budget$/i);\n    if (url.pathname === '/api/x' && req.method === 'POST') return 1;");
  assert.deepEqual(small.map((e) => e.path), ['/api/chats/:id/budget', '/api/x']);
  assert.equal(small[0].note, "A chat's budget");
});

test('answers lose anything that looks like a secret, and big inline data', async () => {
  const X = await import('../server/assistantapi.js');
  const out = X.scrub({ name: 'a', apiKey: 'sk-1', nested: { github_token: 'x', ok: 1 }, img: `data:image/png;base64,${'A'.repeat(5000)}` });
  assert.deepEqual(Object.keys(out), ['name', 'nested', 'img']);
  assert.deepEqual(out.nested, { ok: 1 });
  assert.match(out.img, /^\[data, \d+ characters\]$/);
});

test('acting through the API is always a card; keys and streams are refused', async () => {
  A.resetAssistant(); fs.rmSync(path.join(home, 'data', 'assistant.json'), { force: true });
  const r = await A.assistantTurn({ text: 'stop that run', prefs: { assistant: { access: 'ask' } }, call: scripted(['{"say":"","do":[{"tool":"api_how","args":{"path":"/api/runs/r1/stop"}},{"tool":"api_call","args":{"method":"POST","path":"/api/runs/r1/stop","why":"Stop the reply"}},{"tool":"api_call","args":{"method":"POST","path":"/api/keys","body":{}}},{"tool":"api_call","args":{"method":"GET","path":"/api/costs"}}]}', '{"say":"Card is up.","do":[]}']) });
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].kind, 'api');
  assert.equal(r.cards[0].path, '/api/runs/r1/stop');
});

test('read_chat: messages, what a reply did, and how a running reply is doing', async () => {
  const S = await import('../server/store.js');
  const id = 'cmtestread01';
  fs.mkdirSync(path.join(home, 'data', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'chats', `${id}.json`), JSON.stringify({ id, title: 'Read me', projectId: 'scratch', created: 1, agent: { setup: { model: 'x/y' }, messages: [
    { role: 'user', content: 'make a picture', at: 1 },
    { role: 'assistant', content: 'Made it.', at: 2, trace: [{ t: 'tool', name: 'imagine' }, { t: 'tool', name: 'imagine' }, { t: 'tool', name: 'write_file' }], stats: { cost: 0.12 } },
    { role: 'user', content: 'another', at: 3 },
    { role: 'assistant', content: '', at: 4, runId: 'r9', runActive: true, trace: [] },
  ] } }));
  S.getChat(id); // warm the index
  const X = await import('../server/assistantapi.js');
  const r = await X.readChat({ id, runLog: async () => ({ status: 'running', events: [{ t: 'tool', name: 'imagine' }, { t: 'approval', id: 'a1', what: 'Make 1 picture ($0.04)' }] }) });
  assert.equal(r.messages, 4);
  assert.equal(r.rows[1].did, 'imagine×2, write_file×1');
  assert.equal(r.rows[1].cost, '0.1200');
  assert.equal(r.running.status, 'waiting for the user');
  assert.match(r.running.approval, /Make 1 picture/);
});

test('context: old tool results shrink when a turn grows; the newest stays whole', () => {
  const big = `Tool results:\n${'x'.repeat(40000)}`;
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: big }, { role: 'assistant', content: '{}' }, { role: 'user', content: big }];
  A.fitContext(msgs, 50000);
  assert.ok(msgs[1].content.length < 1000);
  assert.equal(msgs[3].content.length, big.length);
});

test('it must read how a route works before proposing to call it', async () => {
  const r = await A.assistantTurn({ text: 'resume it', call: scripted(['{"say":"","do":[{"tool":"api_call","args":{"method":"PUT","path":"/api/schedules/s1","body":{"paused":false}}}]}', '{"say":"Let me check first.","do":[]}']) });
  assert.equal(r.cards.length, 0);
});

test('access "auto": it does what you ask at once, and asks only before risky things', async () => {
  A.resetAssistant(); fs.rmSync(path.join(home, 'data', 'assistant.json'), { force: true });
  const r = await A.assistantTurn({ text: 'bigger text, and raise your budget', prefs: { ui: { fontSize: 14 }, assistant: { access: 'auto' } }, call: scripted([
    '{"say":"","do":[{"tool":"settings_set","args":{"key":"ui.fontSize","value":16}},{"tool":"budget_set","args":{"monthly":50}}]}', '{"say":"Text is 16px now; the budget raise is yours to approve.","do":[]}']) });
  assert.deepEqual(r.actions, [{ kind: 'setting', key: 'ui.fontSize', value: 16 }]);
  assert.equal(r.done.length, 1);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].key, 'assistant.monthly');
  assert.equal(A.needsAsk({ kind: 'api', method: 'PUT', path: '/api/schedules/s1', body: { paused: false } }, 'auto'), false);
  assert.equal(A.needsAsk({ kind: 'api', method: 'DELETE', path: '/api/schedules/s1' }, 'auto'), true);
  assert.equal(A.needsAsk({ kind: 'api', method: 'POST', path: '/api/storage/clear' }, 'auto'), true);
  assert.equal(A.needsAsk({ kind: 'api', method: 'DELETE', path: '/api/schedules/s1' }, 'full'), false);
  assert.equal(A.needsAsk({ kind: 'setting', key: 'ui.fontSize', value: 16 }, 'ask'), true);
  assert.equal(A.needsAsk({ kind: 'setting', key: 'approval', value: 'yolo' }, 'auto'), !!(await import('../server/quorxsettings.js')).SETTINGS_BY_KEY.get('approval')?.guard);
});

test('a reply that only says what it will do is told to do it', async () => {
  const call = scripted(['{"say":"I\'ll pin it now.","do":[]}', '{"say":"","do":[{"tool":"open","args":{"where":"budget"}}]}', '{"say":"Opened it.","do":[]}']);
  const r = await A.assistantTurn({ text: 'open budget', prefs: { assistant: { access: 'auto' } }, call });
  assert.equal(r.say, 'Opened it.');
  assert.deepEqual(r.actions, [{ kind: 'open', where: 'budget' }]);
});

test('send_to_chat: continues an existing chat from its own box (a page action), or a card in "ask" mode', async () => {
  const id = 'cmtestread01'; // written by the read_chat test above
  const r = await A.assistantTurn({ text: 'resume it there', prefs: { assistant: { access: 'auto' } }, call: scripted([`{"say":"","do":[{"tool":"send_to_chat","args":{"id":"${id}","message":"Carry on where you left off."}}]}`, '{"say":"Done: resumed it in that chat.","do":[]}']) });
  assert.deepEqual(r.actions, [{ kind: 'send', chatId: id, text: 'Carry on where you left off.' }]);
  assert.equal(r.done[0].kind, 'send');
  const ask = await A.assistantTurn({ text: 'resume it there', prefs: { assistant: { access: 'ask' } }, call: scripted([`{"say":"","do":[{"tool":"send_to_chat","args":{"id":"${id}","message":"Go on."}}]}`, '{"say":"Card is up.","do":[]}']) });
  assert.equal(ask.cards[0].kind, 'send');
  assert.equal(ask.actions.length, 0);
  const none = await A.assistantTurn({ text: 'x', prefs: { assistant: { access: 'auto' } }, call: scripted(['{"say":"","do":[{"tool":"send_to_chat","args":{"id":"nope","message":"hi"}}]}', '{"say":"No such chat.","do":[]}']) });
  assert.equal(none.actions.length, 0);
});
