// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Recorded chats played back: real model replies from scripts/fixtures/replay (made with record-chat.mjs) drive the
// agent loop with no key and no network. Each must take the same steps and end with the same answer as when it was
// recorded. A loop change that alters them shows up here: re-record the chat if the change is meant.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './agent-harness.mjs';
import { replayer, outcomeOf, scrub, recorder, requestSummary, answerOf, RECORDING_VERSION } from '../server/replay.js';
import { REPLAY_SETTINGS } from './replay-settings.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay');
const recordings = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));

test('there are recordings from more than one model maker', () => {
  assert.ok(recordings.length >= 3);
  assert.ok(new Set(recordings.map((r) => r.model.split('/')[0])).size >= 3);
});

for (const rec of recordings) {
  test(`replay: ${rec.name} (${rec.model}) takes the recorded steps`, async () => {
    assert.equal(rec.version, RECORDING_VERSION);
    const files = (d) => { for (const [p, c] of Object.entries(rec.files || {})) { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); } };
    const r = await run(replayer(rec), { text: rec.text, settings: REPLAY_SETTINGS, prep: files });
    assert.equal(r.bodies.length, rec.calls.length, 'one model call per recorded call');
    const got = outcomeOf(r.events);
    assert.deepEqual(got.tools, rec.outcome.tools);
    assert.equal(got.stop, rec.outcome.stop);
    assert.equal(got.reply, rec.outcome.reply);
    // The loop offered the same tools at each step as when the call was recorded.
    r.bodies.forEach((b, i) => assert.deepEqual(requestSummary(b).tools, rec.calls[i].request.tools, `tools offered at call ${i + 1}`));
  });
}

test('the replayer says clearly when the loop asks for more calls than were recorded', () => {
  const play = replayer({ name: 'short', calls: [{ request: { tools: [] }, answer: answerOf({ text: 'hi' }) }] });
  assert.equal(play({ tools: [] }, 0).text, 'hi');
  assert.throws(() => play({ tools: [] }, 1), /asked for model call 2, but the recording "short" has 1/);
});

test('the replayer refuses a recorded call to a tool the loop stopped offering', () => {
  const call = { id: 'x', type: 'function', function: { name: 'write_file', arguments: '{}' } };
  const play = replayer({ name: 'gone', calls: [{ request: { tools: ['write_file'] }, answer: answerOf({ toolCalls: [call] }) }] });
  assert.throws(() => play({ tools: [{ type: 'function', function: { name: 'read_file' } }] }, 0), /uses the tool write_file, which the loop no longer offers/);
  // A tool that wasn't offered when recorded either (a rare tool loaded by calling it) is left to the loop.
  const lazy = replayer({ name: 'lazy', calls: [{ request: { tools: ['load_tools'] }, answer: answerOf({ toolCalls: [call] }) }] });
  assert.equal(lazy({ tools: [{ type: 'function', function: { name: 'load_tools' } }] }, 0).toolCalls[0].function.name, 'write_file');
});

test('recordings lose folder paths and keys', () => {
  const v = scrub({ a: 'C:\\Users\\pat\\AppData\\Local\\Temp\\quorx-run-1\\hello.py', b: ['see C:/Users/pat/AppData/Local/Temp/quorx-run-1/x and C:\\\\Users\\\\pat'], k: 'key sk-or-v1-0123456789abcdef0123456789abcdef', h: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' },
    { project: 'C:\\Users\\pat\\AppData\\Local\\Temp\\quorx-run-1', temp: 'C:\\Users\\pat\\AppData\\Local\\Temp', home: 'C:\\Users\\pat' });
  assert.equal(v.a, '<project>\\hello.py');
  assert.equal(v.b[0], 'see <project>/x and <home>');
  assert.equal(v.k, 'key <secret>');
  assert.match(v.h, /Authorization: <secret>/);
  for (const rec of recordings) assert.doesNotMatch(JSON.stringify(rec), /sk-or-v1-|Bearer [A-Za-z0-9]{16}|[A-Z]:\\\\Users\\\\|\/Users\//, rec.name);
});

test('the recorder passes the call on with the real model id and keeps what the loop reads', async () => {
  const seen = [], kept = [];
  const stream = recorder(async (body) => { seen.push(body.model); return { text: 'ok', toolCalls: [], usage: { cost: 0.001, prompt_tokens: 9 }, ms: 812, provider: 'X', finishReason: 'stop' }; }, { model: 'real/model', onCall: (c) => kept.push(c) });
  const r = await stream({ model: 'test/model', messages: [{ role: 'system' }, { role: 'user' }], tools: [{ type: 'function', function: { name: 'read_file' } }], tool_choice: 'auto' });
  assert.equal(r.provider, 'X'); // the loop still gets the whole answer
  assert.deepEqual(seen, ['real/model']);
  assert.deepEqual(kept[0].request, { tools: ['read_file'], tool_choice: 'auto', roles: ['system', 'user'] });
  assert.equal(kept[0].answer.ms, 1);
  assert.equal(kept[0].answer.provider, undefined);
});
