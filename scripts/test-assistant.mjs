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
  const r = await A.assistantTurn({ text: 'make text bigger', prefs: { ui: { fontSize: 14 } }, call });
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
  const r = await A.assistantTurn({ text: 'budget 0.01', call: scripted(['{"say":"","do":[{"tool":"budget_set","args":{"monthly":0.1}}]}', '{"say":"Card is up.","do":[]}']) });
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
