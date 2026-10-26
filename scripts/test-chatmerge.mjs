// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A chat saved from two windows (public/chat-merge.js): a refused save merges this page's copy with the server's
// instead of saving over it. base = what this page last saved, mine = the page now, theirs = the server now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeChat, msgKey } from '../public/chat-merge.js';

const user = (at, content) => ({ role: 'user', content, at });
const reply = (runId, at, content, extra = {}) => ({ role: 'assistant', runId, at, content, stats: { cost: 0.01 }, trace: [{ t: 'llm_start', step: 0 }], ...extra });
const chat = (messages, { artifacts = {}, ...head } = {}, agent = {}) => ({ id: 'c1', title: 'Chat', projectId: 'scratch', created: 1, approval: 'strict', tools: { web: true },
  ...head, agent: { setup: { model: 'm1', reasoning: 'off' }, allowed: [], extraUsage: [], ...agent, messages, artifacts } });
const copy = (x) => structuredClone(x);
const contents = (doc) => doc.agent.messages.map((m) => m.content);

test('chat merge: messages added in both windows are all kept, in time order', () => {
  const base = chat([user(100, 'hi'), reply('r1', 101, 'hello')]);
  const mine = copy(base); mine.agent.messages.push(user(400, 'mine q'), reply('r2', 401, 'mine a'));
  const theirs = copy(base); theirs.agent.messages.push(user(300, 'their q'), reply('r3', 301, 'their a'));
  const r = mergeChat(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(contents(r.doc), ['hi', 'hello', 'their q', 'their a', 'mine q', 'mine a']);
  assert.deepEqual(r.from, [['mine', 0], ['mine', 1], ['theirs', 2], ['theirs', 3], ['mine', 2], ['mine', 3]]);
  assert.equal(r.changed, true);
});

test('chat merge: nothing new on the server keeps this page as it is', () => {
  const base = chat([user(100, 'hi'), reply('r1', 101, 'hello')]);
  const mine = copy(base); mine.agent.messages[1].content = 'hello there'; mine.agent.messages.push(user(200, 'next'));
  const r = mergeChat(base, mine, copy(base));
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.deepEqual(contents(r.doc), ['hi', 'hello there', 'next']);
});

test('chat merge: a reply edited in only one window takes that edit', () => {
  const base = chat([user(100, 'hi'), reply('r1', 101, 'draft', { stats: { partial: true } })]);
  const mine = copy(base); mine.agent.messages.push(user(200, 'next'));
  const theirs = copy(base); theirs.agent.messages[1] = { ...theirs.agent.messages[1], content: 'final', stats: { cost: 0.02 } };
  const r = mergeChat(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(contents(r.doc), ['hi', 'final', 'next']);
  assert.deepEqual(r.from[1], ['theirs', 1]);
});

test('chat merge: the same message changed in both windows is not merged', () => {
  const base = chat([user(100, 'hi'), reply('r1', 101, 'hello')]);
  const mine = copy(base); mine.agent.messages[1].content = 'mine';
  const theirs = copy(base); theirs.agent.messages[1].content = 'theirs';
  const r = mergeChat(base, mine, theirs);
  assert.equal(r.ok, false);
  assert.match(r.why, /run:r1/);
});

test('chat merge: a reply running in this page stays this page\'s', () => {
  const base = chat([user(100, 'hi'), reply('r1', 101, '', { stats: undefined, runActive: true })]);
  const mine = copy(base); mine.agent.messages[1].content = 'streaming…';
  const theirs = copy(base); theirs.agent.messages[1].content = 'other';
  assert.equal(mergeChat(base, mine, theirs).ok, false);
  const r = mergeChat(base, mine, theirs, { live: (i) => i === 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(contents(r.doc), ['hi', 'streaming…']);
});

test('chat merge: steps kept apart on the server and key order are not changes', () => {
  const base = chat([user(100, 'hi'), reply('r1', 101, 'hello')]);
  const mine = copy(base); mine.agent.messages[1].content = 'edited here';
  const theirs = copy(base);
  const { trace, ...rest } = theirs.agent.messages[1];
  theirs.agent.messages[1] = Object.fromEntries(Object.entries({ ...rest, trace: [], traceRef: { n: 1, bytes: 30 } }).reverse());
  const r = mergeChat(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.equal(r.doc.agent.messages[1].content, 'edited here');
  assert.equal(r.changed, false);
});

test('chat merge: removing on one side, when the other left it alone, removes it', () => {
  const base = chat([user(100, 'a'), reply('r1', 101, 'b'), user(200, 'c'), reply('r2', 201, 'd')]);
  // Cleared here; the other window added one more turn since.
  const mine = chat([]);
  const theirs = copy(base); theirs.agent.messages.push(user(300, 'e'));
  let r = mergeChat(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(contents(r.doc), ['e']);
  // Undone in the other window (its last turn cut); this page added a turn.
  const mine2 = copy(base); mine2.agent.messages.push(user(300, 'f'));
  const theirs2 = copy(base); theirs2.agent.messages.splice(2);
  r = mergeChat(base, mine2, theirs2);
  assert.equal(r.ok, true);
  assert.deepEqual(contents(r.doc), ['a', 'b', 'f']);
  // Removed there but edited here: not merged.
  const mine3 = copy(base); mine3.agent.messages[3].content = 'd2';
  assert.equal(mergeChat(base, mine3, theirs2).ok, false);
});

test('chat merge: head fields take this page\'s change only when it made one', () => {
  const base = chat([user(100, 'hi')]);
  const mine = copy(base); mine.title = 'Renamed here'; mine.agent.setup = { model: 'm2', reasoning: 'off' };
  const theirs = copy(base); theirs.approval = 'yolo'; theirs.tools = { web: false }; theirs.agent.setup = { model: 'm3', reasoning: 'high' }; theirs.title = 'Renamed there';
  const r = mergeChat(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.equal(r.doc.title, 'Renamed here');
  assert.equal(r.doc.approval, 'yolo');
  assert.deepEqual(r.doc.tools, { web: false });
  assert.deepEqual(r.doc.agent.setup, { model: 'm2', reasoning: 'off' });
  assert.equal(r.changed, true);
});

test('chat merge: spending added on both sides is all kept', () => {
  const was = { kind: 'summary', cost: 0.001, at: 5 };
  const base = chat([user(100, 'hi')], {}, { extraUsage: [was] });
  const mine = copy(base); mine.agent.extraUsage.push({ kind: 'review', cost: 0.003, at: 9 });
  const theirs = copy(base); theirs.agent.extraUsage.push({ kind: 'summary', cost: 0.002, at: 8 });
  const r = mergeChat(base, mine, theirs);
  assert.deepEqual(r.doc.agent.extraUsage.map((x) => x.at), [5, 8, 9]);
});

test('chat merge: artifacts merge one by one', () => {
  const base = chat([user(100, 'hi')], { artifacts: { a: { id: 'a', kind: 'html', title: 'A' }, gone: { id: 'gone', kind: 'html', title: 'G' } } });
  const mine = copy(base); mine.agent.artifacts.m = { id: 'm', kind: 'html', title: 'M' }; mine.agent.artifacts.a.title = 'A2';
  const theirs = copy(base); theirs.agent.artifacts.t = { id: 't', kind: 'image', title: 'T' }; delete theirs.agent.artifacts.gone;
  const r = mergeChat(base, mine, theirs);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.doc.agent.artifacts).sort(), ['a', 'm', 't']);
  assert.equal(r.doc.agent.artifacts.a.title, 'A2');
  const theirs2 = copy(base); theirs2.agent.artifacts.a.title = 'A3';
  assert.equal(mergeChat(base, mine, theirs2).ok, false);
});

test('chat merge: messages are known by run id, else kind and time', () => {
  assert.equal(msgKey({ role: 'assistant', runId: 'r9', at: 1 }), 'run:r9');
  assert.equal(msgKey({ role: 'usage', at: 7 }), 'usage:7');
  // Two notes made in the same millisecond stay two.
  const base = chat([]);
  const mine = chat([{ role: 'usage', at: 7, n: 1 }, { role: 'usage', at: 7, n: 2 }]);
  const r = mergeChat(base, mine, copy(base));
  assert.equal(r.doc.agent.messages.length, 2);
});
