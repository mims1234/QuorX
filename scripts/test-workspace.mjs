// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The workspace layout (public/workspace.js): a tree of splits and groups, at most 4 groups, saved per project; and
// back / forward through what you looked at (public/nav-history.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../public/workspace.js';
import { createHistory, HISTORY_CAP } from '../public/nav-history.js';

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
