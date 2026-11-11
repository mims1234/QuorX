// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Performance rules that need no window: which hidden browser tabs go to sleep (desktop/tab-sleep.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickSleepers, sleepOptions, SLEEP_AFTER, MAX_AWAKE, GRACE } = require('../desktop/tab-sleep.js');

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

test('device sizes for the Browser tab: presets, your own size, turning sideways, and fitting the pane', async () => {
  const { DEVICES, preset, parseSize, custom, rotate, fitBox, deviceLabel, deviceMetrics } = await import('../public/devices.js');
  assert.deepEqual(DEVICES.map((d) => d.id), ['phone', 'phone-l', 'tablet', 'laptop', 'desktop']);
  const phone = preset('phone');
  assert.deepEqual(phone, { id: 'phone', name: 'Phone', w: 390, h: 844, mobile: true });
  assert.equal(preset('nope'), null);
  assert.deepEqual(parseSize('1024x768'), { w: 1024, h: 768 });
  assert.deepEqual(parseSize(' 800 × 600 '), { w: 800, h: 600 });
  assert.deepEqual(parseSize('640,480'), { w: 640, h: 480 });
  for (const bad of ['', 'big', '100x100', '5000x800', '1024']) assert.equal(parseSize(bad), null, bad);
  assert.equal(custom(500, 900).mobile, true, 'a narrow size of your own is a touch screen');
  assert.equal(custom(1280, 720).mobile, false);
  const side = rotate(phone);
  assert.deepEqual([side.w, side.h, side.turned], [844, 390, true]);
  assert.deepEqual([rotate(side).w, rotate(side).turned], [390, false]);
  assert.equal(rotate(null), null);
  assert.deepEqual(fitBox(phone, { width: 800, height: 1000 }), { scale: 1, width: 390, height: 844 }, 'never scaled up');
  const f = fitBox(phone, { width: 600, height: 422 });
  assert.equal(f.scale, 0.5); assert.deepEqual([f.width, f.height], [195, 422]);
  assert.equal(fitBox(preset('desktop'), { width: 960, height: 2000 }).scale, 0.5, 'the narrower side decides');
  assert.equal(deviceLabel(null), 'Fit');
  assert.equal(deviceLabel(phone), 'Phone 390×844');
  assert.equal(deviceLabel(phone, 0.62), 'Phone 390×844 · 62%');
  assert.equal(deviceLabel(custom(1000, 700)), '1000×700');
  assert.deepEqual(deviceMetrics(phone), { width: 390, height: 844, mobile: true });
  assert.equal(deviceMetrics(null), null);
});
