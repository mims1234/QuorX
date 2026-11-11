// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Desktop rules that need no window: which hidden browser tabs go to sleep (desktop/tab-sleep.js), and the summon
// key (desktop/summon.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickSleepers, sleepOptions, SLEEP_AFTER, MAX_AWAKE, GRACE } = require('../desktop/tab-sleep.js');
const { SUMMON_DEFAULT, toAccelerator, applySummon } = require('../desktop/summon.js');

const NOW = 10_000_000;
const tab = (sid, hiddenFor, extra = {}) => ({ sid, agent: false, shown: hiddenFor == null, hiddenAt: hiddenFor == null ? null : NOW - hiddenFor, audible: false, dirty: false, debugged: false, ...extra });

test('a tab hidden past the sleep time goes to sleep; a fresh one and the one on screen stay', () => {
  const tabs = [tab('shown', null), tab('old', SLEEP_AFTER + 1), tab('fresh', 1000)];
  assert.deepEqual(pickSleepers(tabs, { now: NOW }), ['old']);
});

test(`more than ${MAX_AWAKE} hidden tabs awake: the longest hidden sleep first, once past their grace`, () => {
  const tabs = [tab('a', 60e3), tab('b', 50e3), tab('c', 40e3), tab('d', 30e3), tab('shown', null)];
  // 4 hidden, 2 may stay awake: a and b (hidden longest) sleep.
  assert.deepEqual(pickSleepers(tabs, { now: NOW }), ['a', 'b']);
  // Hidden only a moment: nothing sleeps yet, so flicking between tabs never reloads them.
  const quick = [tab('a', GRACE - 1), tab('b', 2000), tab('c', 1000)];
  assert.deepEqual(pickSleepers(quick, { now: NOW }), []);
});

test('never asleep: the agent\'s tab, one playing sound, one with typing not sent, one a debugger is on', () => {
  const old = SLEEP_AFTER * 2;
  const tabs = [tab('agent', old, { agent: true }), tab('music', old, { audible: true }), tab('form', old, { dirty: true }), tab('lent', old, { debugged: true }), tab('plain', old)];
  assert.deepEqual(pickSleepers(tabs, { now: NOW }), ['plain']);
});

test('tabs that may not sleep still count as awake, so the others make room', () => {
  // Two music tabs fill the awake places: the plain one, past its grace, sleeps though it is young.
  const tabs = [tab('m1', 90e3, { audible: true }), tab('m2', 80e3, { audible: true }), tab('plain', 30e3)];
  assert.deepEqual(pickSleepers(tabs, { now: NOW }), ['plain']);
});

test('the sleep time and the number awake can be set; bad values are ignored', () => {
  assert.deepEqual(sleepOptions({ QX_TAB_SLEEP_MS: '15000', QX_TAB_AWAKE: '0' }), { after: 15000, grace: 15000, maxAwake: 0 });
  assert.deepEqual(sleepOptions({ QX_TAB_SLEEP_MS: 'soon', QX_TAB_AWAKE: '-1' }), {});
  const tabs = [tab('a', 16e3), tab('b', 5000)];
  assert.deepEqual(pickSleepers(tabs, { now: NOW, ...sleepOptions({ QX_TAB_SLEEP_MS: '15000' }) }), ['a']);
});

// ---------- keeping the PC awake while QuorX works (desktop/keep-awake.js) ----------
const { KEEP_AWAKE_DEFAULT, keepAwakeOn, wantAwake, createAwake } = require('../desktop/keep-awake.js');

test('keep awake: only while a reply or a command works, and only when the setting is on', () => {
  assert.equal(KEEP_AWAKE_DEFAULT, true);
  assert.equal(keepAwakeOn({}), true, 'missing: the default');
  assert.equal(keepAwakeOn({ keepAwake: false }), false);
  assert.equal(keepAwakeOn(null), true);
  const idle = { replies: [], servers: [], commands: [] };
  assert.equal(wantAwake(idle, true), false);
  assert.equal(wantAwake({ ...idle, replies: [{ title: 'Snake game' }] }, true), true);
  assert.equal(wantAwake({ ...idle, commands: [{ label: 'npm run build' }] }, true), true);
  assert.equal(wantAwake({ ...idle, servers: [{ name: 'dev' }] }, true), false, 'a server on its own never keeps the PC awake');
  assert.equal(wantAwake({ ...idle, replies: [{}] }, false), false, 'setting off');
  assert.equal(wantAwake(null, true), false, 'the harness could not be asked');
});

test('keep awake: one blocker, started once and stopped once', () => {
  const calls = [];
  let next = 7;
  const live = new Set();
  const psb = { start: (t) => { calls.push(['start', t]); live.add(next); return next++; }, stop: (id) => { calls.push(['stop', id]); live.delete(id); }, isStarted: (id) => live.has(id) };
  const a = createAwake(psb);
  assert.equal(a.set(true), true);
  assert.equal(a.set(true), true);
  assert.equal(a.held, true);
  assert.equal(a.set(false), false);
  assert.equal(a.set(false), false);
  assert.deepEqual(calls, [['start', 'prevent-app-suspension'], ['stop', 7]]);
  // Windows let go of it on its own (it is no longer started): letting go again doesn't throw, and it can be held again.
  a.set(true); live.clear();
  assert.equal(a.set(false), false);
  assert.equal(a.set(true), true);
  assert.equal(calls.filter(([k]) => k === 'start').length, 3);
});

test('the summon key: key names from the page become global keys; Shift alone or no key is refused', () => {
  assert.equal(SUMMON_DEFAULT, 'Ctrl+Shift+Space');
  assert.equal(toAccelerator('Ctrl+Shift+Space'), 'Ctrl+Shift+Space');
  assert.equal(toAccelerator('Shift+Alt+Q'), 'Alt+Shift+Q', 'modifiers in one order');
  assert.equal(toAccelerator('Ctrl+Alt+ArrowUp'), 'Ctrl+Alt+Up');
  assert.equal(toAccelerator('Meta+K'), 'Super+K');
  assert.equal(toAccelerator('Ctrl+F12'), 'Ctrl+F12');
  assert.equal(toAccelerator('Ctrl++'), 'Ctrl+Plus');
  for (const bad of ['', 'Space', 'Shift+A', 'Ctrl', 'Ctrl+Shift', 'Hyper+A', 'Ctrl+ContextMenu']) assert.equal(toAccelerator(bad), null, bad);
});

test('the summon key: registered when on, the old key let go on a change, off when Windows refuses it', () => {
  const held = new Set(['Ctrl+Alt+K']); // another app's
  const mine = new Map();
  const gs = { register: (a, fn) => { if (held.has(a) || mine.has(a)) return false; mine.set(a, fn); return true; }, isRegistered: (a) => mine.has(a), unregister: (a) => mine.delete(a) };
  let fired = 0;
  const fire = () => fired++;
  let st = applySummon(gs, { on: false }, null, fire);
  assert.deepEqual(st, { on: false, key: SUMMON_DEFAULT, ok: true });
  assert.equal(mine.size, 0, 'off by default: nothing registered');
  st = applySummon(gs, { on: true, key: 'Ctrl+Shift+Space' }, st, fire);
  assert.ok(st.on && st.ok && mine.has('Ctrl+Shift+Space'));
  mine.get('Ctrl+Shift+Space')(); assert.equal(fired, 1);
  st = applySummon(gs, { on: true, key: 'Alt+Shift+Q' }, st, fire);
  assert.deepEqual([...mine.keys()], ['Alt+Shift+Q'], 'the old key is let go');
  const taken = applySummon(gs, { on: true, key: 'Ctrl+Alt+K' }, st, fire);
  assert.equal(taken.on, false); assert.equal(taken.ok, false); assert.match(taken.error, /Another app already uses Ctrl\+Alt\+K/);
  assert.equal(mine.size, 0);
  const stop = applySummon(gs, { on: true, key: 'Ctrl+Alt+Backspace' }, null, fire);
  assert.equal(stop.on, false); assert.match(stop.error, /stopping computer use/);
  const bad = applySummon(gs, { on: true, key: 'Shift+A' }, null, fire);
  assert.equal(bad.on, false); assert.match(bad.error, /Ctrl, Alt or the Windows key/);
  st = applySummon(gs, { on: true }, null, fire);
  st = applySummon(gs, { on: false, key: st.key }, st, fire);
  assert.equal(mine.size, 0, 'turned off: unregistered');
});
