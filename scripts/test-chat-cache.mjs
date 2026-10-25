// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Opened chats the page lets go of (public/chat-cache.js): past the limit, the idle ones least recently shown, never
// one on screen or busy.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatsToRelease, KEEP_OPEN } from '../public/chat-cache.js';

const chat = (id, shownAt, more = {}) => ({ id, shownAt, visible: false, busy: false, ...more });

test('chat cache: nothing goes while there are no more idle chats than the limit', () => {
  assert.deepEqual(chatsToRelease([]), []);
  assert.deepEqual(chatsToRelease([chat('a', 1), chat('b', 2)], 2), []);
  const many = Array.from({ length: KEEP_OPEN }, (_, i) => chat(`c${i}`, i));
  assert.deepEqual(chatsToRelease(many), []);
});

test('chat cache: past the limit, the least recently shown idle chats go', () => {
  const list = [chat('new', 50), chat('old', 10), chat('mid', 30), chat('older', 5)];
  assert.deepEqual(chatsToRelease(list, 2), ['older', 'old']);
  assert.deepEqual(chatsToRelease(list, 3), ['older']);
  assert.deepEqual(chatsToRelease(list, 0), ['older', 'old', 'mid', 'new']);
});

test('chat cache: a chat on screen or busy never goes, and does not count toward the limit', () => {
  const list = [chat('shown', 1, { visible: true }), chat('running', 2, { busy: true }), chat('a', 3), chat('b', 4), chat('c', 5)];
  assert.deepEqual(chatsToRelease(list, 3), [], 'three idle chats fit');
  assert.deepEqual(chatsToRelease(list, 1), ['a', 'b']);
  assert.ok(!chatsToRelease(list, 0).includes('shown'));
  assert.ok(!chatsToRelease(list, 0).includes('running'));
});

test('chat cache: a chat never shown (loaded for a background reply) goes first; ties keep their order', () => {
  const list = [chat('seen', 7), chat('never1', undefined), chat('never2', 0), chat('seen2', 7)];
  assert.deepEqual(chatsToRelease(list, 2), ['never1', 'never2']);
  assert.deepEqual(chatsToRelease(list, 1), ['never1', 'never2', 'seen']);
});

test('chat cache: the default limit is twelve idle chats', () => {
  assert.equal(KEEP_OPEN, 12);
  const list = Array.from({ length: 20 }, (_, i) => chat(`c${i}`, 100 - i)); // c0 is the most recent
  assert.deepEqual(chatsToRelease(list), ['c19', 'c18', 'c17', 'c16', 'c15', 'c14', 'c13', 'c12']);
});
