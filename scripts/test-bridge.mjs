// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The desktop bridge (docs/desktop-bridge.md) matches the code: every window.ohDesktop call the page uses is exposed by
// desktop/preload.js and listed in the document, every listed call still exists and is answered by desktop/main.js,
// and every event the shell sends is described. A new call or event goes into the document in the same change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const preload = read('desktop/preload.js'), main = read('desktop/main.js'), doc = read('docs/desktop-bridge.md');

// Names exposed on window.ohDesktop: the keys of the object given to contextBridge.
const exposed = new Set([...preload.slice(preload.indexOf("exposeInMainWorld('ohDesktop'")).matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]));
// Names the preload forwards to the shell: call('<name>' ...).
const forwarded = new Set([...preload.matchAll(/call\('([a-zA-Z]+)'/g)].map((m) => m[1]));
// Names the shell answers: handle('<name>', ...).
const handled = new Set([...main.matchAll(/^handle\('([a-zA-Z]+)'/gm)].map((m) => m[1]));
// Calls and events the document lists: the first column of each table, `name`.
const section = (title) => { const at = doc.indexOf(`## ${title}`); const end = doc.indexOf('\n## ', at + 3); return doc.slice(at, end < 0 ? undefined : end); };
const listed = (title) => new Set([...section(title).matchAll(/^\| `([a-zA-Z-]+)` \|/gm)].map((m) => m[1]));
const docCalls = listed('Calls'), docEvents = listed('Events');
// What the page uses: window.ohDesktop.<name> and ohDesktop?.<name>, in every page script.
const used = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((x) => x.endsWith('.js'))) {
  for (const m of read(`public/${f}`).matchAll(/ohDesktop\??\.([a-zA-Z]+)/g)) used.add(m[1]);
}
// Events the shell sends: send({ ..., type: '<name>' ... }).
const sent = new Set([...main.matchAll(/send\(\{[^}]*?type: '([a-z-]+)'/g)].map((m) => m[1]));

const missing = (a, b) => [...a].filter((x) => !b.has(x)).sort();

test('the bridge has calls, events and a document to check', () => {
  assert.ok(exposed.size > 20 && docCalls.size > 20 && used.size > 10 && sent.size > 10, `exposed ${exposed.size}, documented ${docCalls.size}, used ${used.size}, sent ${sent.size}`);
});

test('every call the page uses is on the bridge', () => {
  assert.deepEqual(missing(used, exposed), [], 'used by public/*.js but not exposed by desktop/preload.js');
});

test('every call on the bridge is in docs/desktop-bridge.md, and nothing listed there is gone', () => {
  assert.deepEqual(missing(exposed, docCalls), [], 'exposed but not documented');
  assert.deepEqual(missing(docCalls, exposed), [], 'documented but no longer exposed');
});

test('every call the preload forwards is answered by the shell', () => {
  assert.deepEqual(missing(forwarded, handled), [], 'forwarded by desktop/preload.js but no handle() in desktop/main.js');
});

test('every event the shell sends is described', () => {
  assert.deepEqual(missing(sent, docEvents), [], 'sent by desktop/main.js but not in the Events table');
  assert.deepEqual(missing(docEvents, sent), [], 'in the Events table but never sent');
});
