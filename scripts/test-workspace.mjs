// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The workspace layout (public/workspace.js): a tree of splits and groups, at most 4 groups, saved per project; and
// back / forward through what you looked at (public/nav-history.js); and the keyboard shortcuts table (public/keymap.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../public/workspace.js';
import { createHistory, HISTORY_CAP } from '../public/nav-history.js';
import * as K from '../public/keymap.js';
import * as QF from '../public/frame-model.js';
import fs from 'node:fs';

const shape = (n) => (n.t === 'g' ? `${n.id}[${n.tabs.join(',')}]` : `${n.dir}(${n.kids.map(shape).join(' ')})`);
const ids = (lay) => W.groups(lay).map((g) => g.id);

test('workspace layout: groups split beside their target, never past 4; tabs move between groups; empty groups go', () => {
  { // workspace layout: the default is today's screen, a chat group and one side group on Artifact
    const lay = W.defaultLayout();
    assert.equal(shape(lay.root), 'row(chat[chat:main] g1[artifact:g1,browser:g1,steps:g1,terminal:g1,files:g1])');
    assert.equal(lay.focus, 'g1');
    assert.equal(W.groupPane(W.findGroup(lay, 'g1')), 'art');
    assert.equal(W.groupPane(W.findGroup(W.defaultLayout('term'), 'g1')), 'term');
  }
  { // workspace layout: a group splits below its target into a column, sharing its space, and takes the focus
    let lay = W.defaultLayout();
    const r = W.addGroup(lay, 'g1', 'bottom', W.paneTabs('g2'), { active: 'browser:g2' });
    assert.equal(r.ok, true); lay = r.layout;
    assert.equal(shape(lay.root).replace(/\[[^\]]*\]/g, ''), 'row(chat col(g1 g2))');
    assert.equal(lay.focus, 'g2');
    assert.equal(W.findGroup(lay, 'g2').active, 'browser:g2');
    // A third, above the second: it joins the same column (no column inside a column), halving g2.
    lay = W.addGroup(lay, 'g2', 'top', ['x']).layout;
    assert.deepEqual(ids(lay), ['chat', 'g1', 'g3', 'g2']);
    assert.equal(W.findGroup(lay, 'g3').w, 0.5);
    assert.equal(W.findGroup(lay, 'g2').w, 0.5);
    // The fourth fits, the fifth is refused.
    lay = W.addGroup(lay, 'chat', 'left', ['y']).layout;
    assert.equal(W.groups(lay).length, W.MAX_GROUPS);
    const no = W.addGroup(lay, 'g1', 'right', ['z']);
    assert.deepEqual([no.ok, no.reason, no.layout], [false, 'max', lay]);
  }
  { // workspace layout: placing a tab in the middle moves it; on an edge it gets its own group; its old group goes when empty
    let lay = W.createLayout(W.split('row', [W.group('g1', ['a', 'b']), W.group('g2', ['c'])]));
    lay = W.placeTab(lay, 'b', 'g2', 'center').layout;
    assert.equal(shape(lay.root), 'row(g1[a] g2[c,b])');
    assert.equal(W.findGroup(lay, 'g2').active, 'b');
    lay = W.placeTab(lay, 'a', 'g2', 'bottom').layout; // g1 empties and goes
    assert.equal(shape(lay.root), 'col(g2[c,b] g3[a])');
    assert.equal(W.placeTab(lay, 'a', 'g3', 'right').reason, 'same', 'a lone tab can\'t split off its own group');
    // At the cap, moving a group's only tab to an edge is allowed (it frees its group first).
    let full = W.createLayout(W.split('row', ['g1', 'g2', 'g3', 'g4'].map((g) => W.group(g, [`t${g}`]))));
    const r = W.placeTab(full, 'tg4', 'g1', 'bottom');
    assert.equal(r.ok, true);
    assert.equal(shape(r.layout.root), 'row(col(g1[tg1] g5[tg4]) g2[tg2] g3[tg3])');
    full = W.placeTab(full, 'tg1', 'g2', 'center').layout;
    full = W.addGroup(full, 'g2', 'right', ['n']).layout;
    full = W.placeTab(full, 'tg2', 'g3', 'center').layout; // g2 had tg1 too, so g2 stays
    assert.equal(W.placeTab(full, 'tg3', 'g4', 'top').reason, 'max');
  }
  { // workspace layout: removing tabs picks the neighbour to show, and the last group stays even when empty
    let lay = W.createLayout(W.group('g1', ['a', 'b', 'c'], 'b'));
    lay = W.removeTab(lay, 'b');
    assert.equal(W.findGroup(lay, 'g1').active, 'a');
    lay = W.removeTab(W.removeTab(lay, 'a'), 'c');
    assert.equal(shape(lay.root), 'g1[]');
    assert.equal(lay.focus, 'g1');
  }
  { // workspace layout: removing a group gives its space to the one before it (or after, for the first)
    let lay = W.createLayout(W.split('col', [W.group('g1', ['a'], 'a', 1), W.group('g2', ['b'], 'b', 0.5), W.group('g3', ['c'], 'c', 0.5)]), 'g2');
    lay = W.removeGroup(lay, 'g2');
    assert.deepEqual(ids(lay), ['g1', 'g3']);
    assert.equal(W.findGroup(lay, 'g1').w, 1.5);
    assert.equal(lay.focus, 'g1');
    lay = W.removeGroup(lay, 'g1');
    assert.equal(shape(lay.root), 'g3[c]');
    assert.equal(W.removeGroup(lay, 'g3'), lay, 'the last group stays');
  }
  { // workspace layout: norm flattens a split into a same-direction parent, keeping each group's share of the space
    const root = W.norm(W.split('row', [W.group('a', ['1'], '1', 1), W.split('row', [W.group('b', ['2'], '2', 1), W.group('c', ['3'], '3', 3)], 2), W.split('col', [W.group('d', [], null)])]));
    assert.equal(shape(root), 'row(a[1] b[2] c[3])');
    assert.deepEqual(W.groups(root).map((g) => g.w), [1, 0.5, 1.5]);
  }
  { // workspace layout: changes never touch the layout they were given
    const lay = W.defaultLayout(), before = JSON.stringify(lay);
    W.addGroup(lay, 'g1', 'bottom', ['x']); W.placeTab(lay, 'browser:g1', 'chat', 'center'); W.removeTab(lay, 'files:g1'); W.setActive(lay, 'g1', 'steps:g1'); W.setWeights(lay, { g1: 2 });
    assert.equal(JSON.stringify(lay), before);
  }
});

test('workspace layout: saved as JSON and read back; a broken or over-full save is cleaned up instead of trusted', () => {
  { // workspace save: round trip keeps the tree, the focus and the state of tabs still in it
    let lay = W.addGroup(W.defaultLayout('browser'), 'g1', 'bottom', W.paneTabs('g2'), { active: 'terminal:g2' }).layout;
    const text = W.serialise(lay, { 'browser:g1': { kind: 'browser', b: 's1' }, 'terminal:g2': { kind: 'terminal', tf: ['all'] }, 'gone:g9': { kind: 'files' } });
    const back = W.parse(text);
    assert.deepEqual(back.layout.root, lay.root);
    assert.equal(back.layout.focus, 'g2');
    assert.deepEqual(Object.keys(back.tabs).sort(), ['browser:g1', 'terminal:g2']);
    assert.equal(back.layout.next, 3, 'new groups are numbered after the saved ones');
  }
  { // workspace save: junk, an unknown version or an empty tree reads as nothing
    for (const bad of ['', 'nope', '{}', '{"v":2,"root":{}}', JSON.stringify({ v: 1, root: { t: 'g', id: 'g1', tabs: [] } }), JSON.stringify({ v: 1, root: { t: 'x' } })]) assert.equal(W.parse(bad), null, bad);
  }
  { // workspace save: more than 4 groups (an old or edited save) keeps the first 4, the rest's tabs join the 4th; repeats go
    const root = W.split('row', [1, 2, 3, 4, 5, 6].map((n) => W.group(`g${n}`, [`t${n}`, 't1'])));
    const back = W.parse(JSON.stringify({ v: 1, root, focus: 'g6' }));
    assert.equal(W.groups(back.layout).length, 4);
    assert.deepEqual(W.findGroup(back.layout, 'g4').tabs, ['t4', 't5', 't6']);
    assert.deepEqual(W.findGroup(back.layout, 'g1').tabs, ['t1']);
    assert.equal(back.layout.focus, 'g1', 'a focus on a dropped group falls back to the first');
  }
});

test('workspace layout: a chat\'s saved pane areas convert to its project\'s layout, the most recent chat winning, and back', () => {
  const old = { areas: [{ tab: 'art', grow: 0.6, art: 'plan1', b: null }, { tab: 'browser', grow: 0.4, art: null, b: 'sid2' }, { tab: 'term', grow: 1, tf: ['srv:web', 'all'] }], f: 1 };
  { // area conversion: three stacked areas become three groups in a column beside the chat, with their tabs' state
    const r = W.fromAreas(old);
    assert.equal(shape(r.layout.root).replace(/\[[^\]]*\]/g, ''), 'row(chat col(g1 g2 g3))');
    assert.deepEqual(W.sideGroups(r.layout).map(W.groupPane), ['art', 'browser', 'term']);
    assert.deepEqual(W.sideGroups(r.layout).map((g) => g.w), [0.6, 0.4, 1]);
    assert.equal(r.layout.focus, 'g2');
    assert.deepEqual(r.tabs, { 'artifact:g1': { kind: 'artifact', art: 'plan1' }, 'browser:g2': { kind: 'browser', b: 'sid2' }, 'terminal:g3': { kind: 'terminal', tf: ['srv:web', 'all'] } });
    // And back to the old shape, for an older QuorX after a downgrade.
    assert.deepEqual(W.toAreas(r.layout, r.tabs), { areas: [{ tab: 'art', grow: 0.6, art: 'plan1', b: null }, { tab: 'browser', grow: 0.4, art: null, b: 'sid2' }, { tab: 'term', grow: 1, art: null, b: null, tf: ['srv:web', 'all'] }], f: 1 });
    assert.equal(W.toAreas(W.defaultLayout()), null, 'one area was never saved');
    assert.equal(W.fromAreas({ areas: [] }), null);
    assert.equal(W.sideGroups(W.fromAreas({ areas: [1, 2, 3, 4, 5].map(() => ({ tab: 'files' })) }).layout).length, 3, 'never past 4 groups with the chat');
  }
  { // area conversion: per project, the most recently updated chat's split wins; unknown chats and projects with a layout are skipped
    const two = JSON.stringify({ areas: [{ tab: 'files' }, { tab: 'trace' }] });
    const out = W.migrateAreas(
      [{ chatId: 'c1', value: JSON.stringify(old) }, { chatId: 'c2', value: two }, { chatId: 'c3', value: two }, { chatId: 'ghost', value: two }, { chatId: 'c4', value: '{broken' }, { chatId: 'c5', value: two }],
      [{ id: 'c1', projectId: 'p1', updated: 200 }, { id: 'c2', projectId: 'p1', updated: 100 }, { id: 'c3', updated: 5 }, { id: 'c4', projectId: 'p2', updated: 9 }, { id: 'c5', projectId: 'p3', updated: 1 }],
      new Set(['p3']));
    assert.deepEqual(Object.keys(out).sort(), ['p1', 'scratch']);
    assert.deepEqual(W.sideGroups(W.parse(out.p1).layout).map(W.groupPane), ['art', 'browser', 'term']);
    assert.deepEqual(W.sideGroups(W.parse(out.scratch).layout).map(W.groupPane), ['files', 'trace']);
  }
});

test('workspace tab kinds: every kind says its owner and pane, saves only what should survive, and draws once app.js says how', () => {
  for (const k of ['chat', 'artifact', 'browser', 'steps', 'terminal', 'files', 'viewer', 'page', 'running', 'servers']) {
    const d = W.tabKind(k);
    assert.ok(d && d.name && d.icon && 'owner' in d && Array.isArray(d.keys), k);
    assert.deepEqual(d.load(JSON.parse(JSON.stringify(d.save({})))), {}, `${k}: nothing set saves nothing`);
  }
  // The browser saves which of its page tabs is shown, never the live placement box; the terminal its views.
  assert.deepEqual(W.tabKind('browser').save({ bActive: 's1', dsk: { ph: {} } }), { b: 's1' });
  assert.deepEqual(W.tabKind('browser').load({ b: 's1' }), { bActive: 's1' });
  assert.deepEqual(W.tabKind('terminal').save({ termLay: { panes: [{ filter: 'all' }, { filter: 'srv:x' }] } }), { tf: ['all', 'srv:x'] });
  assert.deepEqual(W.tabKind('terminal').load({ tf: [1, 2] }), { termTf: ['1', '2'] });
  // No two kinds claim the same per-tab value.
  const keys = Object.values(W.TAB_KINDS).flatMap((d) => d.keys);
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(() => W.defineTabKind('nope', {}), /unknown tab kind/);
  const r = () => 'drawn'; W.defineTabKind('files', { render: r });
  assert.equal(W.tabKind('files').render, r);
  assert.equal(W.kindOf(W.tabId('browser', 'g2')), 'browser');
});

test('workspace history: back and forward through what you brought to the front, capped, skipping what closed', () => {
  { // history: push, back, forward; the same place twice counts once; pushing after going back drops what was forward
    const h = createHistory();
    assert.equal(h.back(), null);
    h.push({ kind: 'chat', id: 'a' }); h.push({ kind: 'chat', id: 'a' }); h.push({ kind: 'tab', id: 'browser:g1' }); h.push({ kind: 'file', id: 'x.png' });
    assert.equal(h.entries.length, 3);
    assert.deepEqual(h.back(), { kind: 'tab', id: 'browser:g1' });
    assert.deepEqual(h.back(), { kind: 'chat', id: 'a' });
    assert.equal(h.canBack, false);
    assert.deepEqual(h.forward(), { kind: 'tab', id: 'browser:g1' });
    h.push({ kind: 'settings', id: 'providers' });
    assert.equal(h.canForward, false);
    assert.deepEqual(h.entries.map((e) => e.id), ['a', 'browser:g1', 'providers']);
  }
  { // history: showing an entry while stepping doesn't push it again
    const h = createHistory();
    h.push({ kind: 'chat', id: 'a' }); h.push({ kind: 'chat', id: 'b' });
    const e = h.back();
    h.quietly(() => h.push(e.kind === 'chat' ? { kind: 'chat', id: 'z' } : e));
    assert.deepEqual(h.entries.map((x) => x.id), ['a', 'b']);
    assert.equal(h.current.id, 'a');
  }
  { // history: at most 50 entries, the oldest go
    const h = createHistory();
    for (let i = 0; i < 70; i++) h.push({ kind: 'chat', id: i });
    assert.equal(HISTORY_CAP, 50);
    assert.equal(h.entries.length, 50);
    assert.equal(h.entries[0].id, 20);
    assert.equal(h.current.id, 69);
  }
  { // history: a deleted chat leaves it, and repeats it left side by side merge
    const h = createHistory();
    for (const id of ['a', 'b', 'a', 'c']) h.push({ kind: 'chat', id });
    h.back();
    h.forget((e) => e.id === 'b');
    assert.deepEqual(h.entries.map((x) => x.id), ['a', 'c']);
    assert.equal(h.current.id, 'a');
    const back = createHistory(h.toJSON());
    assert.deepEqual([back.index, back.entries.length], [0, 2]);
  }
});

test('workspace history: stepping over places that can\'t be shown, and back to them once they can', () => {
  const h = createHistory(), closed = new Set(['b']);
  for (const id of ['a', 'b', 'c']) h.push({ kind: 'chat', id });
  const ok = (e) => !closed.has(e.id);
  assert.equal(h.canGo(-1, ok), true);
  assert.deepEqual(h.back(ok), { kind: 'chat', id: 'a' }); // b's tab is closed: stepped over
  assert.equal(h.canGo(-1, ok), false);
  assert.equal(h.back(ok), null);
  assert.equal(h.current.id, 'a');
  closed.delete('b'); // b reopened: a stop again
  assert.deepEqual(h.forward(ok), { kind: 'chat', id: 'b' });
  assert.deepEqual(h.entries.map((e) => e.id), ['a', 'b', 'c']); // nothing was dropped
  closed.add('c');
  assert.equal(h.canGo(1, ok), false);
  assert.equal(h.forward(ok), null);
  assert.equal(h.current.id, 'b');
});

test('workspace chat tabs: kept in the chat group, opened after the one on screen, moved, cycled, closed', () => {
  { // chat tabs: the chat group holds them, the one on screen active; none gives the placeholder back
    let lay = W.withChatTabs(W.defaultLayout(), ['a', 'b', 'c'], 'b');
    assert.deepEqual(W.chatTabIds(lay), ['a', 'b', 'c']);
    assert.equal(W.findGroup(lay, W.CHAT_GROUP).active, 'chat:b');
    lay = W.withChatTabs(lay, [], null);
    assert.deepEqual(W.findGroup(lay, W.CHAT_GROUP).tabs, ['chat:main']);
    assert.deepEqual(W.chatTabIds(lay), []);
  }
  { // chat tabs: saved with the layout and read back, with the closed stack
    const lay = W.withChatTabs(W.defaultLayout(), ['a', 'b'], 'a');
    const r = W.parse(W.serialise(lay, {}, [{ kind: 'chat', id: 'x' }, { kind: 'page', url: 'https://example.com/' }, { kind: 'bogus' }, null]));
    assert.deepEqual(W.chatTabIds(r.layout), ['a', 'b']);
    assert.deepEqual(r.closed, [{ kind: 'chat', id: 'x' }, { kind: 'page', url: 'https://example.com/' }]);
    assert.deepEqual(W.parse(W.serialise(lay)).closed, []); // an older save has none
  }
  { // chat tabs: a chat opened from elsewhere goes after the one on screen; one already open stays put
    assert.deepEqual(W.insertTab(['a', 'b', 'c'], 'x', 'a'), ['a', 'x', 'b', 'c']);
    assert.deepEqual(W.insertTab(['a', 'b'], 'x', null), ['a', 'b', 'x']);
    assert.deepEqual(W.insertTab(['a', 'b'], 'a', 'b'), ['a', 'b']);
  }
  { // chat tabs: drag to reorder (before a tab, or to the end)
    assert.deepEqual(W.moveTab(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c']);
    assert.deepEqual(W.moveTab(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
    assert.deepEqual(W.moveTab(['a', 'b'], 'z', 'a'), ['a', 'b']);
  }
  { // chat tabs: Ctrl+Tab goes round; closing the one on screen hands over to the right, else the left
    assert.equal(W.cycleTab(['a', 'b', 'c'], 'c', 1), 'a');
    assert.equal(W.cycleTab(['a', 'b', 'c'], 'a', -1), 'c');
    assert.equal(W.cycleTab(['a', 'b'], null, 1), 'a');
    assert.equal(W.cycleTab([], 'a', 1), null);
    assert.equal(W.afterClose(['a', 'b', 'c'], 'b'), 'c');
    assert.equal(W.afterClose(['a', 'b', 'c'], 'c'), 'b');
    assert.equal(W.afterClose(['a'], 'a'), null);
  }
});

test('workspace closed tabs: a stack of the last 50 per project, the newest first back, repeats merged', () => {
  let list = [];
  for (let i = 0; i < 60; i++) list = W.pushClosed(list, { kind: 'chat', id: `c${i}` });
  assert.equal(W.CLOSED_CAP, 50);
  assert.equal(list.length, 50);
  assert.equal(list[0].id, 'c10');
  list = W.pushClosed(list, { kind: 'chat', id: 'c20' }); // closed again: one entry, now the newest
  assert.equal(list.filter((e) => e.id === 'c20').length, 1);
  assert.equal(list.at(-1).id, 'c20');
  let r = W.popClosed(list);
  assert.equal(r.entry.id, 'c20');
  assert.equal(r.list.length, 49);
  r = W.popClosed([{ kind: 'area', pane: 'browser' }, { kind: 'file', chat: 'a', f: { id: 'file:x' } }], (e) => e.kind === 'area');
  assert.deepEqual(r.entry, { kind: 'area', pane: 'browser' });
  assert.deepEqual(r.list, [{ kind: 'file', chat: 'a', f: { id: 'file:x' } }]);
  assert.deepEqual(W.popClosed([]), { entry: null, list: [] });
});

test('shortcuts: one table; Ctrl+1 to Ctrl+9 jump to chat tabs; changed keys win; ids are unique', () => {
  const ids = K.SHORTCUTS.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'every id once');
  for (const id of ['palette', 'tab.next', 'tab.prev', 'tab.close', 'tab.reopen', 'nav.back', 'nav.forward', 'mic']) assert.ok(K.byId.has(id), id);
  for (let n = 1; n <= 9; n++) assert.equal(K.byId.get(`tab.${n}`).keys, `Ctrl+${n}`);
  assert.match(K.byId.get('tab.9').label, /last/);
  for (const x of K.SHORTCUTS) assert.ok(K.KEY_GROUPS[x.group], `${x.id} has a known group`);
  const def = K.bindings({});
  assert.equal(K.actionFor('Ctrl+K', def), 'palette');
  assert.equal(K.actionFor('Ctrl+3', def), 'tab.3');
  assert.equal(K.actionFor('Alt+ArrowLeft', def), 'nav.back');
  assert.equal(K.actionFor('Ctrl+,', def), 'mic');
  assert.equal(K.actionFor('Enter', def), null, 'fixed keys are not run from the table');
  assert.equal(K.actionFor('Ctrl+Q', def), null);
  const mine = K.bindings({ keys: { 'tab.close': 'Alt+X', 'tab.3': '' }, micKey: 'Ctrl+M' });
  assert.equal(K.actionFor('Alt+X', mine), 'tab.close');
  assert.equal(K.actionFor('Ctrl+W', mine), null, 'the old key is free again');
  assert.equal(K.actionFor('Ctrl+3', mine), null, 'no key');
  assert.equal(mine.get('mic'), 'Ctrl+M', 'the mic key keeps its own setting');
});

test('shortcuts: keys read the same however they are written; typing keys, clashes and system keys', () => {
  assert.equal(K.normCombo('shift+control+t'), 'Ctrl+Shift+T');
  assert.equal(K.normCombo('Ctrl+Esc'), 'Ctrl+Escape');
  assert.equal(K.normCombo('alt+left'), 'Alt+ArrowLeft');
  assert.equal(K.normCombo('Ctrl++'), 'Ctrl++');
  assert.equal(K.normCombo(''), '');
  assert.equal(K.checkCombo('Ctrl+Shift').ok, false, 'a modifier alone');
  assert.match(K.checkCombo('Shift+A').error, /typing never/);
  assert.equal(K.checkCombo('G').ok, false);
  assert.deepEqual(K.checkCombo('F7'), { ok: true }, 'an F key on its own');
  assert.deepEqual(K.checkCombo('Ctrl+Alt+J'), { ok: true });
  assert.match(K.checkCombo('Ctrl+C').warn, /copies/);
  const def = K.bindings({});
  assert.equal(K.clashWith('tab.close', 'Ctrl+K', def).id, 'palette');
  assert.equal(K.clashWith('palette', 'Ctrl+K', def), null, 'its own key is no clash');
  assert.equal(K.clashWith('tab.close', 'Ctrl+=', def).id, 'zoom.in', 'fixed keys count');
  assert.equal(K.clashWith('tab.close', 'Ctrl+Alt+J', def), null);
  const both = K.conflicts(K.bindings({ keys: { 'tab.close': 'Ctrl+K' } }));
  assert.deepEqual([...both.keys()].sort(), ['palette', 'tab.close']);
  assert.equal(both.get('palette')[0].id, 'tab.close');
  assert.equal(K.conflicts(def).size, 0, 'the defaults never clash');
  assert.deepEqual(K.comboParts('Alt+ArrowLeft'), ['Alt', '←']);
  assert.deepEqual(K.comboParts('Ctrl++'), ['Ctrl', '+']);
  assert.deepEqual(K.comboParts('↑ ↓ then Enter or Tab'), ['↑ ↓ then Enter or Tab']);
  assert.equal(K.comboText('Ctrl+Shift+T'), 'Ctrl+Shift+T');
});

test('workspace W2: groups placed by rectangles; bars resize neighbours; the chat moves as a whole group', () => {
  { // workspace W2: rectangles split the box by shares, with a bar between neighbours
    const lay = W.createLayout(W.split('row', [W.group('chat', ['chat:a'], null, 3), W.split('col', [W.group('g1', ['x']), W.group('g2', ['y'])], 1)]));
    const r = W.rects(lay, { x: 0, y: 0, w: 806, h: 406 }, 6);
    assert.deepEqual(r.groups.chat, { x: 0, y: 0, w: 600, h: 406 });
    assert.deepEqual(r.groups.g1, { x: 606, y: 0, w: 200, h: 200 });
    assert.deepEqual(r.groups.g2, { x: 606, y: 206, w: 200, h: 200 });
    assert.equal(r.bars.length, 2);
    assert.deepEqual(r.bars[0], { path: [], i: 0, dir: 'row', x: 600, y: 0, w: 6, h: 406 });
    assert.deepEqual(r.bars[1], { path: [1], i: 0, dir: 'col', x: 606, y: 200, w: 200, h: 6 });
    assert.deepEqual(W.rects(W.createLayout(W.group('g1', ['x'])), { w: 10, h: 10 }).groups.g1, { x: 0, y: 0, w: 10, h: 10 });
    // A bar dragged: only its two neighbours change; a double-click shares the split evenly.
    const l2 = W.resizePair(lay, [], 0, 300, 500);
    assert.equal(W.nodeAt(l2, [0]).w, 1.5);
    assert.equal(W.nodeAt(l2, [1]).w, 2.5);
    assert.equal(W.nodeAt(lay, [0]).w, 3, 'the old layout is untouched');
    assert.deepEqual(W.nodeAt(W.evenShares(l2, []), []).kids.map((k) => k.w), [1, 1]);
    assert.equal(W.resizePair(lay, [0], 0, 1, 1), lay, 'a group has no kids to resize');
    assert.equal(W.nodeAt(lay, [5]), null);
  }
  { // workspace W2: the edge a point is nearest decides the drop zone; the middle is the middle
    const r = { x: 0, y: 0, w: 100, h: 100 };
    assert.equal(W.zoneAt(r, 10, 50), 'left');
    assert.equal(W.zoneAt(r, 95, 40), 'right');
    assert.equal(W.zoneAt(r, 50, 5), 'top');
    assert.equal(W.zoneAt(r, 40, 90), 'bottom');
    assert.equal(W.zoneAt(r, 50, 50), 'center');
  }
  { // workspace W2: the chat group moves beside another group, or to one side of everything, keeping its tabs
    let lay = W.defaultLayout();
    lay = W.addGroup(lay, 'g1', 'bottom', ['t2'], { id: 'g2' }).layout;
    const r = W.moveGroup(lay, 'chat', 'g2', 'right');
    assert.equal(r.ok, true);
    assert.equal(shape(r.layout.root).replace(/\[[^\]]*\]/g, ''), 'col(g1 row(g2 chat))');
    assert.deepEqual(W.findGroup(r.layout, 'chat').tabs, ['chat:main']);
    assert.equal(r.layout.next, lay.next, 'no new group was made');
    assert.equal(W.moveGroup(lay, 'chat', 'chat', 'left').ok, false);
    assert.equal(W.moveGroup(lay, 'chat', 'g1', 'center').ok, false);
    const e = W.moveGroupToEdge(lay, 'chat', 'right');
    assert.equal(shape(e.layout.root).replace(/\[[^\]]*\]/g, ''), 'row(col(g1 g2) chat)');
    assert.equal(shape(W.moveGroupToEdge(lay, 'chat', 'top').layout.root).replace(/\[[^\]]*\]/g, ''), 'col(chat g1 g2)');
    // At the cap the chat still moves: it never adds a group.
    let full = W.addGroup(W.addGroup(lay, 'g2', 'right', ['t3']).layout, 'chat', 'top', ['t4']).layout;
    assert.equal(W.groups(full).length, W.MAX_GROUPS);
    assert.equal(W.moveGroup(full, 'chat', 'g1', 'left').ok, true);
  }
  { // workspace W2: a preview tab is swapped in place; files open in the nearest group that isn't the chat
    let lay = W.createLayout(W.split('row', [W.group('chat', ['chat:a']), W.group('g1', ['artifact:g1', 'viewer:v1'], 'viewer:v1'), W.group('g2', ['files:g2'])]));
    lay = W.replaceTab(lay, 'viewer:v1', 'viewer:v2');
    assert.deepEqual(W.findGroup(lay, 'g1').tabs, ['artifact:g1', 'viewer:v2']);
    assert.equal(W.findGroup(lay, 'g1').active, 'viewer:v2');
    assert.equal(W.replaceTab(lay, 'viewer:v2', 'files:g2'), lay, 'a tab already in the tree is not doubled');
    const rs = { chat: { x: 0, y: 0, w: 100, h: 100 }, g1: { x: 400, y: 0, w: 100, h: 100 }, g2: { x: 110, y: 0, w: 100, h: 100 } };
    assert.equal(W.nearestGroup(lay, 'chat', rs), 'g2');
    assert.equal(W.nearestGroup(lay, 'g1', rs), 'g1');
    assert.equal(W.nearestGroup(W.createLayout(W.group('chat', ['chat:a'])), 'chat', {}), null);
  }
  { // workspace W2: the follow mark and the maximised group are saved with the layout
    const lay = W.defaultLayout();
    const back = W.parse(W.serialise(lay, {}, [], { follow: 'g1', max: 'nope' }));
    assert.equal(back.follow, 'g1');
    assert.equal(back.max, null, 'a group that is not there is not kept');
    assert.equal(W.parse(W.serialise(lay)).follow, null);
    // A file tab saves the file, its chat and whether it is still a preview.
    const v = W.tabKind('viewer');
    assert.deepEqual(v.load(v.save({ f: { id: 'file:a.png', src: '/f/a.png', kind: 'image' }, chat: 'c1', preview: true })), { f: { id: 'file:a.png', src: '/f/a.png', kind: 'image' }, chat: 'c1', preview: true });
    assert.deepEqual(v.load({ f: { name: 'x' } }), {});
  }
});

test('workspace W3: a second chat in a group of its own; only some groups shown; pins saved', () => {
  let lay = W.defaultLayout();
  let r = W.placeChat2(lay, 'b', W.CHAT_GROUP, 'right');
  assert.equal(r.ok, true); lay = r.layout;
  assert.equal(shape(lay.root), 'row(chat[chat:main] chat2[chat:b] g1[artifact:g1,browser:g1,steps:g1,terminal:g1,files:g1])');
  assert.equal(W.chat2Id(lay), 'b');
  assert.deepEqual(W.chatGroups(lay).map((g) => g.id), ['chat', 'chat2']);
  assert.deepEqual(W.sideGroups(lay).map((g) => g.id), ['g1'], 'the second chat is not a pane group');
  // Placed again: the same group shows the other chat, nothing new is added.
  lay = W.placeChat2(lay, 'c').layout;
  assert.equal(W.chat2Id(lay), 'c');
  assert.equal(W.groups(lay).length, 3);
  // At the cap a second chat is refused like any new group.
  const full = W.addGroup(W.addGroup(W.defaultLayout(), 'g1', 'bottom', ['x']).layout, 'g1', 'right', ['y']).layout;
  assert.equal(W.placeChat2(full, 'b').reason, 'max');
  // Only some groups: the others give their space away; the tree is not changed.
  const only = W.keepGroups(lay, ['chat', 'chat2']);
  assert.equal(shape(only.root).replace(/\[[^\]]*\]/g, ''), 'row(chat chat2)');
  assert.equal(W.groups(lay).length, 3);
  assert.equal(W.nearestGroup(lay, 'chat2', {}), 'g1', 'files never open in a chat group');
  // A group pinned to a chat is saved; a pin on a group that is gone is not.
  const back = W.parse(W.serialise(lay, {}, [], { pins: { g1: 'b', g9: 'c', chat: '' } }));
  assert.deepEqual(back.pins, { g1: 'b' });
});

test('workspace W4: layouts fit the project without closing anything; your own are saved as shapes', () => {
  { // workspace W4: every built-in layout fits a fresh project, within the cap
    for (const k of W.LAYOUT_ORDER) {
      const r = W.fitLayout(W.defaultLayout(), W.LAYOUTS[k], { chat2: 'b' });
      assert.ok(W.groups(r.layout).length <= W.MAX_GROUPS, k);
      assert.equal(W.findGroup(r.layout, 'chat').active, 'chat:main', `${k} keeps the chat`);
      assert.equal(W.findGroup(r.layout, 'g1')?.id, 'g1', `${k} keeps the first pane group (its box stays)`);
    }
    const b = W.fitLayout(W.defaultLayout(), W.LAYOUTS.build);
    assert.deepEqual(W.groups(b.layout).map((g) => g.active), ['chat:main', 'browser:g1', 'terminal:g2']);
    assert.equal(b.follow, 'g1');
    assert.deepEqual(b.added, ['g2']);
    const c = W.fitLayout(W.defaultLayout(), W.LAYOUTS.compare, { chat2: 'b' });
    assert.equal(shape(c.layout.root).replace(/\[[^\]]*\]/g, ''), 'row(col(chat g1) col(chat2 g2))');
    assert.deepEqual(c.pins, { g1: 0, g2: 1 });
    // Without a second chat Compare drops its second chat group.
    assert.equal(W.findGroup(W.fitLayout(W.defaultLayout(), W.LAYOUTS.compare).layout, 'chat2'), null);
  }
  { // workspace W4: switching keeps every tab: file tabs go to the nearest group, pane groups keep their ids
    let lay = W.fitLayout(W.defaultLayout(), W.LAYOUTS.debug).layout; // chat, g1, g2, g3
    lay = W.placeTab(lay, 'viewer:a', 'g3', 'center').layout;
    lay = W.placeTab(lay, 'viewer:b', 'g1', 'center').layout;
    const r = W.fitLayout(lay, W.LAYOUTS.review); // one pane group
    assert.deepEqual(r.removed, ['g2', 'g3']);
    const g1 = W.findGroup(r.layout, 'g1');
    assert.ok(g1.tabs.includes('viewer:a') && g1.tabs.includes('viewer:b'), 'nothing closes');
    assert.equal(g1.active, 'files:g1');
    assert.deepEqual(W.allTabs(r.layout).filter((t) => t.startsWith('viewer:')).sort(), ['viewer:a', 'viewer:b']);
  }
  { // workspace W4: what is on screen saves as a shape that fits again; stored shapes are checked
    let lay = W.fitLayout(W.defaultLayout(), W.LAYOUTS.compare, { chat2: 'b' }).layout;
    const sh = W.shapeOf(lay, { follow: 'g2', pins: { g1: 'a', g2: 'b' }, chats: ['a', 'b'] });
    assert.equal(sh.follow, 's2');
    assert.deepEqual(sh.pins, { s1: 0, s2: 1 });
    assert.equal(sh.chats, 2);
    assert.deepEqual(W.cleanShape(JSON.parse(JSON.stringify(sh))), sh);
    const again = W.fitLayout(W.defaultLayout(), W.cleanShape(sh), { chat2: 'b' });
    assert.equal(shape(again.layout.root).replace(/\[[^\]]*\]/g, ''), 'row(col(chat g1) col(chat2 g2))');
    assert.equal(W.cleanShape({ root: { t: 'g', id: 's1', kind: 'art' } }), null, 'a layout needs the chat');
    assert.equal(W.cleanShape({ root: { t: 's', dir: 'row', kids: [{ t: 'g', id: 'chat' }, { t: 'g', id: 's1', kind: 'nope' }] } }), null);
    assert.equal(W.cleanShape(null), null);
  }
  { // workspace W4: a second chat stays beside the first when the layout has room; the first area is kept first
    const two = W.withChat2(W.LAYOUTS.build);
    assert.equal(W.groups(two.root).map((g) => g.id).join(), 'chat,chat2,s1,s2');
    assert.equal(W.withChat2(W.LAYOUTS.debug), W.LAYOUTS.debug, 'no room past the cap');
    let lay = W.fitLayout(W.defaultLayout(), W.LAYOUTS.debug).layout;
    const r = W.fitLayout(lay, W.LAYOUTS.review, { order: ['g3', 'g1', 'g2'] });
    assert.deepEqual(W.sideGroups(r.layout).map((g) => g.id), ['g3']);
    assert.equal(W.parse(W.serialise(r.layout, {}, [], { preset: 'review' })).preset, 'review');
  }
});

test('workspace W4: where things open: one rule set, never in a chat group', () => {
  const lay = W.createLayout(W.split('row', [W.group('chat', ['chat:a']), W.group('chat2', ['chat:b']), W.split('col', [W.group('g1', ['browser:g1']), W.group('g2', ['steps:g2']), W.group('g3', ['files:g3'])])]));
  const rects = { chat: { x: 0, y: 0, w: 100, h: 300 }, chat2: { x: 110, y: 0, w: 100, h: 300 }, g1: { x: 220, y: 0, w: 100, h: 100 }, g2: { x: 220, y: 100, w: 100, h: 100 }, g3: { x: 220, y: 200, w: 100, h: 100 } };
  const shows = { g1: 'browser', g2: 'trace', g3: 'files' };
  // A server: the follow group, else the group showing the Browser.
  assert.equal(W.openTarget('server', { lay, rects, shows, follow: 'g3' }), 'g3');
  assert.equal(W.openTarget('server', { lay, rects, shows }), 'g1');
  assert.equal(W.openTarget('server', { lay, rects, shows: {}, from: 'chat' }), 'g2', 'no Browser anywhere: the nearest group');
  // Steps: the group showing Steps for that chat; one pinned to the other chat doesn't count.
  assert.equal(W.openTarget('steps', { lay, rects, shows, chat: 'a', owner: { g2: 'a' } }), 'g2');
  assert.notEqual(W.openTarget('steps', { lay, rects, shows, chat: 'b', owner: { g1: 'a', g2: 'a', g3: 'b' }, chatGroup: 'chat2' }), 'g2');
  // Files: the nearest group to where you clicked; a side question or Changes: beside its chat.
  assert.equal(W.openTarget('file', { lay, rects, from: 'g3' }), 'g3');
  assert.equal(W.openTarget('changes', { lay, rects, chatGroup: 'chat2' }), 'g2');
  // Never a chat group, whatever is asked.
  for (const k of ['server', 'steps', 'file', 'page', 'side', 'changes']) assert.ok(!W.isChatGroup(W.openTarget(k, { lay, rects, from: 'chat', shows, chat: 'a' })), k);
  assert.equal(W.openTarget('file', { lay: W.createLayout(W.group('chat', ['chat:a'])) }), null);
});

test('shortcuts: find (Ctrl+F) and search inside chats (Ctrl+Shift+F) are on the table and can be changed; Settings-only keys never clash', () => {
  const def = K.bindings({});
  assert.equal(K.actionFor('Ctrl+F', def), 'find');
  assert.equal(K.actionFor('Ctrl+Shift+F', def), 'chatsearch');
  assert.equal(K.clashWith('find', 'Ctrl+F', def), null, 'Settings keeps its own Ctrl+F apart');
  assert.equal(K.clashWith('tab.close', 'Ctrl+Shift+F', def).id, 'chatsearch');
  const mine = K.bindings({ keys: { find: 'Ctrl+Alt+F' } });
  assert.equal(K.actionFor('Ctrl+Alt+F', mine), 'find');
  assert.equal(K.actionFor('Ctrl+F', mine), null);
  assert.equal(K.conflicts(def).size, 0);
});

test('workspace W5: pop-out windows: what goes there, docking back where it was, remembered boxes on a screen that is there', async () => {
  { // workspace W5: a whole group out and back in the same place; the last pane group stays
    const lay = W.fitLayout(W.defaultLayout(), W.LAYOUTS.build).layout; // chat | g1 over g2
    const r = W.popGroup(lay, 'g2');
    assert.equal(r.ok, true);
    assert.deepEqual(W.groups(r.layout).map((g) => g.id), ['chat', 'g1']);
    assert.deepEqual([r.rec.near, r.rec.zone, r.rec.active], ['g1', 'bottom', 'terminal:g2']);
    const d = W.dockBack(r.layout, r.rec);
    assert.equal(d.gid, 'g2');
    assert.equal(shape(d.layout.root).replace(/\[[^\]]*\]/g, ''), 'row(chat col(g1 g2))');
    assert.equal(W.findGroup(d.layout, 'g2').active, 'terminal:g2');
    assert.equal(W.popGroup(W.defaultLayout(), 'g1').reason, 'last');
    assert.equal(W.popGroup(lay, 'chat').ok, false, 'a chat pops out on its own, not as a pane group');
  }
  { // workspace W5: one tab out: a file leaves its group; a pane tab gets a group of its own in the window
    let lay = W.placeTab(W.defaultLayout(), 'viewer:a', 'g1', 'center').layout;
    const f = W.popTab(lay, 'viewer:a', 'g7');
    assert.ok(!W.allTabs(f.layout).includes('viewer:a'));
    assert.deepEqual([f.rec.active, f.rec.near, f.rec.tabs.length], ['viewer:a', 'g1', 6]);
    const b = W.popTab(lay, 'browser:g1', 'g7');
    assert.equal(b.layout, lay, 'every group keeps its five pane tabs');
    assert.equal(b.rec.active, 'browser:g7');
    // Docked back: the file comes back beside where it came from, shown.
    const d = W.dockBack(f.layout, { ...f.rec, tabs: [...f.rec.tabs, 'viewer:b'] });
    assert.equal(W.findGroup(d.layout, d.gid).active, 'viewer:a');
    assert.ok(W.findGroup(d.layout, d.gid).tabs.includes('viewer:b'), 'a file opened in the window comes back too');
  }
  { // workspace W5: at the cap, docking back puts the files in the nearest group: nothing is lost
    const full = W.fitLayout(W.defaultLayout(), W.LAYOUTS.debug).layout; // 4 groups
    const d = W.dockBack(full, { gid: 'g9', tabs: [...W.paneTabs('g9'), 'viewer:x'], active: 'viewer:x', near: 'g2', zone: 'right' });
    assert.equal(d.merged, true);
    assert.equal(W.groups(d.layout).length, 4);
    assert.ok(W.findGroup(d.layout, 'g2').tabs.includes('viewer:x'));
    // A gid taken meanwhile: a fresh one.
    const lay = W.fitLayout(W.defaultLayout(), W.LAYOUTS.build).layout;
    assert.notEqual(W.dockBack(lay, { gid: 'g1', tabs: W.paneTabs('g1'), active: 'browser:g1', near: 'g1', zone: 'right' }).gid, 'g1');
  }
  { // workspace W5: remembered boxes per kind of window; records are checked
    assert.equal(W.popKey({ gid: 'g2', active: 'terminal:g2' }), 'group:term');
    assert.equal(W.popKey({ gid: 'g2', active: 'viewer:a' }), 'group:file');
    assert.equal(W.popKey({ chat: 'c1' }), 'chat');
    let boxes = W.rememberBox({}, 'chat', { x: 10.4, y: 20, width: 800, height: 600 });
    assert.deepEqual(boxes, { chat: { x: 10, y: 20, width: 800, height: 600 } });
    assert.deepEqual(W.rememberBox(boxes, 'chat', { x: 1, y: 1, width: 50, height: 50 }), {}, 'a box too small to use is not kept');
    assert.deepEqual(W.cleanPopped([{ id: 'p1', chat: 'c1' }, { id: 'p2', rec: { gid: 'g2', tabs: [] } }, { nope: 1 }, null]).map((x) => x.id), ['p1', 'p2']);
  }
  { // workspace W5: a window box stays on a screen that is there (a monitor unplugged since moves it back)
    const { createRequire } = await import('node:module');
    const { fitBox } = createRequire(import.meta.url)('../desktop/popbox.js');
    const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 1000 }];
    assert.deepEqual(fitBox({ x: 2000, y: 100, width: 700, height: 500 }, screens), { x: 2000, y: 100, width: 700, height: 500 }, 'on the second screen, as it was');
    assert.deepEqual(fitBox({ x: 4000, y: 100, width: 700, height: 500 }, screens), { x: 2500, y: 100, width: 700, height: 500 }, 'past every screen: back on the nearest');
    assert.deepEqual(fitBox({ x: 1900, y: 0, width: 3000, height: 900 }, screens), { x: 1920, y: 0, width: 1280, height: 900 }, 'on the screen it is mostly on, never bigger than it');
    assert.deepEqual(fitBox(null, screens), { x: 580, y: 240, width: 760, height: 560 }, 'no box: in the middle of the first screen');
  }
});

test('window frame: every menu item runs a real action and shows the key the shortcuts table gives it', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const block = (name) => { const at = app.indexOf(`const ${name} = {`); assert.ok(at > 0, `${name} is in app.js`); return app.slice(at, app.indexOf('\n};', at)); };
  const keysOf = (src) => new Set([...src.matchAll(/^ {2}([A-Za-z]+): /gm)].map((m) => m[1]));
  const acts = keysOf(block('FRAME_ACTS')), subs = keysOf(block('FRAME_SUBS'));
  const refs = QF.menuRefs();
  for (const a of refs.acts) assert.ok(acts.has(a), `menu action ${a} is in FRAME_ACTS (no dead items)`);
  for (const s of refs.subs) assert.ok(subs.has(s), `submenu ${s} is in FRAME_SUBS`);
  for (const k of refs.keys) assert.ok(K.byId.has(k), `menu key ${k} is a row of the shortcuts table`);
  assert.deepEqual(QF.MENUS.map((m) => m.name), ['QuorX', 'File', 'Edit', 'View', 'Chat', 'Agent', 'Run', 'Window', 'Help']);
  // A key changed in Settings → Shortcuts is the key the menu shows: both read bindings().
  const mine = K.bindings({ keys: { 'tab.reopen': 'Ctrl+Alt+R' } });
  assert.equal(mine.get(QF.MENUS[1].items.find((x) => x.act === 'reopenTab').key), 'Ctrl+Alt+R');
});

test('window frame: desktop-only items and stray dividers go in a browser; arrows and letters step over what can\'t run', () => {
  const items = [{ label: 'About', act: 'a' }, { label: 'Updates', act: 'u', only: 'desk' }, '-', '-', { label: 'Quit', act: 'q', only: 'desk' }];
  assert.deepEqual(QF.visibleItems(items, { desk: false }).map((x) => x.label || x), ['About'], 'no divider left at the end');
  assert.deepEqual(QF.visibleItems(items, { desk: true }).map((x) => x.label || x), ['About', 'Updates', '-', 'Quit'], 'two dividers in a row become one');
  assert.deepEqual(QF.visibleItems(['-', { label: 'A' }]).map((x) => x.label || x), ['A'], 'none at the start');
  const list = [{ label: 'New chat' }, '-', { label: 'Attach', disabled: true }, { label: 'Close tab' }, { label: 'Close project' }];
  assert.equal(QF.stepItem(list, -1, 1), 0, 'down from nothing: the first');
  assert.equal(QF.stepItem(list, 0, 1), 3, 'over the divider and the disabled one');
  assert.equal(QF.stepItem(list, 0, -1), 4, 'up from the top wraps to the bottom');
  assert.equal(QF.stepItem([], 0, 1), -1);
  assert.equal(QF.stepItem(['-', { label: 'x', disabled: true }], -1, 1), -1, 'nothing can run');
  assert.equal(QF.itemByLetter(list, 'c', -1), 3);
  assert.equal(QF.itemByLetter(list, 'C', 3), 4, 'the next one with that letter');
  assert.equal(QF.itemByLetter(list, 'a', -1), -1, 'a disabled one is skipped');
});

test('window frame: project tabs keep your order, always show the project on screen, and close to a neighbour', () => {
  const known = [{ id: 'scratch' }, { id: 'arcade' }, { id: 'shop' }, { id: 'old', archived: true }];
  assert.deepEqual(QF.openTabs(['shop', 'gone', 'shop', 'old', 'arcade'], { known }), ['shop', 'arcade'], 'deleted, archived and repeated ones drop off');
  assert.deepEqual(QF.openTabs(['shop'], { known, current: 'arcade' }), ['shop', 'arcade'], 'the project on screen joins at the end');
  assert.deepEqual(QF.openTabs(null, { known, current: 'scratch' }), ['scratch']);
  assert.deepEqual(QF.openTabs(['shop'], { known, current: 'old' }), ['shop'], 'an archived project is not opened');
  const used = { scratch: 1, arcade: 30, shop: 20 };
  assert.deepEqual(QF.firstTabs({ known, withTabs: new Set(['arcade', 'shop', 'old']), lastUsed: (id) => used[id], current: 'scratch' }), ['arcade', 'shop', 'scratch'], 'first row: projects with open chat tabs, latest first');
  assert.deepEqual(QF.closeTab(['a', 'b', 'c'], 'b', 'b'), { list: ['a', 'c'], next: 'c' }, 'the one on screen hands over to its right');
  assert.deepEqual(QF.closeTab(['a', 'b', 'c'], 'c', 'c'), { list: ['a', 'b'], next: 'b' }, 'or its left');
  assert.deepEqual(QF.closeTab(['a', 'b'], 'a', 'b'), { list: ['b'], next: undefined }, 'another one: nothing to switch');
  assert.deepEqual(QF.closeTab(['a'], 'a', 'a'), { list: [], next: null });
  const same = ['a', 'b']; assert.equal(QF.closeTab(same, 'z', 'a').list, same, 'not on the row: unchanged');
  assert.deepEqual(QF.moveTab(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(QF.moveTab(['a', 'b', 'c'], 'a', 'b', true), ['b', 'a', 'c']);
  assert.deepEqual(QF.moveTab(['a', 'b'], 'a', 'zz'), ['a', 'b']);
});

test('window frame: the shortcuts table has the window and editing keys the menus show, and they never clash', () => {
  const def = K.bindings({});
  assert.equal(K.actionFor('Ctrl+B', def), 'view.sidebar');
  for (const id of ['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.all', 'view.fullscreen', 'menu.focus']) assert.equal(K.byId.get(id)?.fixed, true, `${id} is shown but can't be changed`);
  assert.equal(K.actionFor('Ctrl+V', def), null, 'Paste is the system\'s, not run from the table');
  assert.equal(K.clashWith('tab.close', 'Ctrl+C', def).id, 'edit.copy', 'a key Copy has is refused for another shortcut');
  assert.equal(K.conflicts(def).size, 0);
  // The page: rows 1 and 2 exist, and the desktop window draws its own controls over row 1.
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['qfTitle', 'qfMenubar', 'qfProj', 'qfTabs', 'qfAdd', 'qfCmdSlot']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="wtProj"/, 'the old project label beside the chat tabs is gone (the project tab names it)');
  const main = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.match(main, /titleBarStyle: 'hidden', titleBarOverlay:/);
  assert.match(main, /handle\('frame'/);
});

test('activity bar: the views in order, each opened by a row of the shortcuts table; clicking the open one hides the sidebar', () => {
  assert.deepEqual(QF.VIEWS.map((v) => v.id), ['chats', 'search', 'running', 'servers', 'source', 'extensions', 'schedules']);
  assert.deepEqual(QF.VIEWS_BOTTOM.map((v) => v.id), ['spending']);
  for (const v of [...QF.VIEWS, ...QF.VIEWS_BOTTOM]) assert.ok(K.byId.has(v.key), `${v.id} opens with ${v.key}, a row of the table`);
  const def = K.bindings({});
  assert.equal(K.actionFor('Ctrl+Shift+F', def), 'chatsearch', 'Search keeps the key search inside chats had');
  assert.equal(K.actionFor('Ctrl+Shift+E', def), 'view.chats');
  assert.equal(K.actionFor('Ctrl+Shift+G', def), 'view.source');
  assert.equal(K.actionFor('Ctrl+Shift+X', def), 'view.extensions');
  assert.equal(def.get('view.schedules'), '', 'some views start with no key');
  assert.equal(K.conflicts(def).size, 0);
  assert.deepEqual(QF.pickView({ view: 'chats', open: true }, 'search'), { view: 'search', open: true });
  assert.deepEqual(QF.pickView({ view: 'search', open: true }, 'search'), { view: 'search', open: false }, 'the open view again: the sidebar hides');
  assert.deepEqual(QF.pickView({ view: 'search', open: false }, 'search'), { view: 'search', open: true }, 'and comes back');
  assert.deepEqual(QF.pickView({ view: 'running', open: false }, 'chats'), { view: 'chats', open: true });
  assert.deepEqual(QF.pickView({ view: 'chats', open: true }, 'nope'), { view: 'chats', open: true }, 'an unknown view changes nothing');
  assert.ok(QF.menuRefs().subs.has('views'), 'View › Views lists them');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const defs = app.slice(app.indexOf('const AV_DEF = {'), app.indexOf('\n};', app.indexOf('const AV_DEF = {')));
  for (const v of QF.VIEWS.filter((x) => x.id !== 'chats').concat(QF.VIEWS_BOTTOM)) assert.match(defs, new RegExp(`\n  ${v.id}: \{`), `${v.id} has what it shows (AV_DEF)`);
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="avTools"/); assert.match(html, /id="avChatsTools"/);
  assert.doesNotMatch(html, /data-rail="files"/, 'the rail\'s Files and Servers buttons are gone (the views replace them)');
});
