// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The sidebar's own rows for open chats the server's list doesn't have yet (public/sidebar-rows.js): a chat you sent a
// message in stays listed when you go to another chat while its first save is on the way or failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openRows, latestOnly } from '../public/sidebar-rows.js';

const chat = (id, { asked = 0, running = false, projectId = 'alpha' } = {}) => ({
  id, title: id, projectId, created: 100, running,
  agent: { setup: { model: 'x/y' }, messages: Array.from({ length: asked }, (_, i) => [{ role: 'user', content: 'hi', at: 200 + i }, { role: 'assistant', content: '', at: 201 + i }]).flat() },
});

test('a sent chat off screen stays in its project until the server lists it; a blank one only while on screen', () => {
  const open = [chat('blank'), chat('sent', { asked: 1, running: true }), chat('saved', { asked: 2 }), chat('blankShown')];
  const rows = openRows(open, new Set(['saved']), ['blankShown']);
  assert.deepEqual(rows.map((r) => r.id), ['sent', 'blankShown'], 'the new running chat is listed though another chat is on screen');
  const sent = rows[0];
  assert.equal(sent.projectId, 'alpha');
  assert.equal(sent.messages, 1, 'counted as a chat with messages, so the project list keeps it');
  assert.equal(sent.lastAt, 201, 'sorted by its newest message, as the server would');
  assert.equal(sent.model, 'x/y');
  // A reply resumed with no new message of yours (a chat the page opened in the background) still shows while it runs.
  assert.deepEqual(openRows([chat('bg', { running: true })], new Set(), []).map((r) => r.id), ['bg']);
});

test('an older sidebar refresh that comes back after a newer one started is dropped', () => {
  const seq = latestOnly();
  const a = seq.start(), b = seq.start();
  assert.equal(seq.current(a), false);
  assert.equal(seq.current(b), true);
});

test('the page uses both, and retries a failed save without waiting for the next change', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /openRows\(G\.open\.values\(\), known, G\.panes\)/);
  assert.doesNotMatch(app, /filter\(\(c\) => !known\.has\(c\.id\) && G\.panes\.includes\(c\.id\)\)/, 'no longer only the chats on screen');
  assert.match(app, /if \(!sbFetch\.current\(turn\)\) return;/);
  assert.match(app, /unsaved\.add\(c\.id\); if \(!timers\.has\(c\.id\)\) timers\.set\(c\.id, setTimeout\(go, 5000\)\);/);
});
