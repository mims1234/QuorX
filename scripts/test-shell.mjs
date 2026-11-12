// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The IDE shell's bottom edge: the status bar (each item only when it means something, each opening its one home),
// the bottom panel (Terminal, Checks, Debug; its size and tab per project; Ctrl+J and View › Bottom panel) and the 🔔
// list (what finished, failed or warned, kept newest first, one per key, with an unread count).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as SS from '../public/shell-status.js';
import * as QF from '../public/frame-model.js';
import { SHORTCUTS } from '../public/keymap.js';

const page = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/panel.css', import.meta.url), 'utf8');
const between = (from, to) => { const i = page.indexOf(from), j = page.indexOf(to, i); assert.ok(i >= 0 && j > i, `${from} … ${to}`); return page.slice(i, j); };

test('status bar: only what means something shows, left to right, each with where a click goes', () => {
  const quiet = SS.statusItems({ project: { id: 'p', name: 'Snake game' } });
  assert.deepEqual(quiet.map((x) => x.id), ['sidebar', 'panel', 'project', 'bell'], 'idle: the toggles, the project and 🔔 only (no "0 running")');
  const busy = SS.statusItems({
    sidebar: false, panel: true, project: { id: 'p', name: 'Snake game' }, branch: 'qx/walls',
    check: { ok: false, problems: 2 }, servers: 1, running: 3, need: [{ title: 'Inventory', kind: 'approval' }, { title: 'Breakout', kind: 'answer' }],
    ctx: { text: '45k used', tone: 'amber' }, spend: 0.01234, unread: 4,
  });
  assert.deepEqual(busy.map((x) => x.id), ['sidebar', 'panel', 'project', 'check', 'servers', 'running', 'need', 'ctx', 'spend', 'bell']);
  const by = Object.fromEntries(busy.map((x) => [x.id, x]));
  assert.deepEqual(Object.fromEntries(busy.map((x) => [x.id, x.act])), { sidebar: 'sidebar', panel: 'panel', project: 'source', check: 'checks', servers: 'servers', running: 'running', need: 'need', ctx: 'ctx', spend: 'spending', bell: 'bell' });
  assert.equal(by.sidebar.on, false); assert.equal(by.panel.on, true);
  assert.equal(by.project.branch, 'qx/walls');
  assert.equal(by.check.text, '2 problems'); assert.equal(by.check.tone, 'amber');
  assert.equal(by.need.text, '2 need you'); assert.match(by.need.title, /Inventory: an approval\nBreakout: a question/);
  assert.equal(by.running.tone, 'violet');
  assert.equal(by.spend.kind, 'money'); assert.equal(by.spend.text, '$0.0123');
  assert.equal(by.bell.count, 4);
  assert.equal(SS.statusItems({ check: { ok: true, problems: 0 } }).find((x) => x.id === 'check').text, 'Checked');
  assert.equal(SS.statusItems({ need: [{ title: 'A' }] }).find((x) => x.id === 'need').text, '1 needs you');
  assert.equal(SS.statusItems({ spend: 12.5 }).find((x) => x.id === 'spend').text, '$12.50');
  // Change 7: the status bar no longer repeats the message box (mode, Quorium, chat money) and has no right dock.
  assert.ok(!busy.some((x) => /mode|quorium|dock/.test(x.id)));
});

test('status bar: every item\'s place exists in the page, and the old homes are gone from row 2', () => {
  const acts = between('const SB_ACTS = {', 'function wsStatusWire');
  for (const it of SS.statusItems({ project: { name: 'P' }, check: { ok: true }, servers: 1, running: 1, need: [{ title: 'x' }], ctx: { text: 'c' }, spend: 1, unread: 1 })) assert.match(acts, new RegExp(`\\b${it.act}: `), `${it.act} has an action`);
  assert.match(acts, /checks: \(\) => panelShow\('checks'\)/, '✓ / problems open the Checks panel');
  assert.match(acts, /source: .*avShow\('source'\)/, 'project and branch open Source control');
  assert.match(acts, /ctx: .*openTrace/, 'the context figure still opens Steps (phase 7)');
  // ⬆ Update, ⟳ Restart needed and 💲 move from row 2's right end into the status bar.
  assert.match(page, /\$\('#wsbUpd'\)\?\.append\(upd\)/);
  assert.match(page, /\$\('#wsbFixed'\)\?\.append\(el\)/);
  assert.doesNotMatch(page, /\$\('#qfRight'\)\.(append|prepend)\(/, 'nothing is put in row 2\'s right end any more (Layout ▾ goes there)');
  for (const id of ['wsbLeft', 'wsbRight', 'wsbFixed', 'wsbBell', 'wsbUpd']) assert.match(html, new RegExp(`id="${id}"`));
  // 💲 opens upwards when it sits at the bottom of the window.
  assert.match(page, /const below = at\.bottom \+ 6 \+ card\.offsetHeight <= innerHeight - 8/);
});

test('bottom panel: Terminal, Checks, Debug; height, open, maximised and tab per project', () => {
  assert.deepEqual(SS.PANEL_TABS.map((t) => t.id), ['terminal', 'checks', 'debug']);
  assert.deepEqual(SS.panelPrefs({}, 'p'), { open: false, h: SS.PANEL_DEFAULT, max: false, tab: 'terminal' });
  let all = SS.setPanelPrefs({}, 'a', { open: true, h: 400, tab: 'checks' });
  all = SS.setPanelPrefs(all, 'b', { max: true });
  assert.deepEqual(SS.panelPrefs(all, 'a'), { open: true, h: 400, max: false, tab: 'checks' });
  assert.deepEqual(SS.panelPrefs(all, 'b'), { open: false, h: SS.PANEL_DEFAULT, max: true, tab: 'terminal' });
  assert.equal(SS.panelPrefs({ x: { tab: 'nope', h: -3 } }, 'x').tab, 'terminal', 'an unknown tab falls back to Terminal');
  assert.equal(SS.clampPanelH(50, 900), SS.PANEL_MIN);
  assert.equal(SS.clampPanelH(2000, 900), 900 - 160, 'the groups above keep room');
  assert.equal(SS.clampPanelH(undefined, 900), SS.PANEL_DEFAULT);
  assert.equal(SS.clampPanelH(300, 100), SS.PANEL_MIN, 'a tiny window still gets the smallest panel');
});

test('bottom panel: toggled by Ctrl+J (in a terminal too) and View › Bottom panel; Run lists Checks and Debug', () => {
  const row = SHORTCUTS.find((s) => s.id === 'view.panel');
  assert.equal(row?.keys, 'Ctrl+J');
  assert.equal(SHORTCUTS.filter((s) => s.keys === 'Ctrl+J').length, 1, 'no other shortcut has Ctrl+J');
  assert.match(page, /'view\.panel': \{ capture: true, run: /, 'caught before a terminal takes the key');
  const view = QF.MENUS.find((m) => m.name === 'View').items, run = QF.MENUS.find((m) => m.name === 'Run').items;
  assert.ok(view.some((x) => x.act === 'togglePanel' && x.key === 'view.panel'));
  assert.ok(run.some((x) => x.act === 'panelChecks') && run.some((x) => x.act === 'panelDebug'));
  for (const a of ['togglePanel', 'panelChecks', 'panelDebug']) assert.match(page, new RegExp(`\\n  ${a}: \\{ run: `), `FRAME_ACTS.${a}`);
});

test('bottom panel: its Terminal is QuorX\'s own terminal in an area of its own, with panes of its own', () => {
  // The panel's area is outside the layout (never in PA.list), but the area code reaches it.
  assert.match(page, /function areaLive\(a\) \{ return PA\.list\.includes\(a\) \|\| \(!!a && a === QP\.a && a\.el\.isConnected\); \}/);
  assert.match(page, /function eachArea\(fn\) \{ for \(const a of \[\.\.\.PA\.list, \.\.\.\(qpTermShown\(\) \? \[QP\.a\] : \[\]\)\]\)/);
  assert.doesNotMatch(between('function qpArea()', 'function qpUse('), /PA\.list\.push/);
  // Its panes are its own (ids qp1…), remembered per project, so picking a tab there doesn't move the Terminal tab's.
  assert.match(page, /if \(AREA\.panel\) return qpTermLay\(t\);/);
  assert.match(page, /if \(AREA\.panel\) return qpTermSave\(t\);/);
  assert.match(page, /id: `qp\$\{i \+ 1\}`/);
  // Drawn by renderTerm itself (no copy of the terminal's code).
  assert.match(between('function qpTermBody()', 'function panelDraw()'), /renderTerm\(c\)/);
  // Where commands, servers and terminals open from elsewhere: the panel (a server's Logs, Run › Terminal, a running
  // command's output, Servers' ⌨ Terminal); ＋ › Terminal still opens a Terminal tab.
  assert.match(page, /if \(act === 'logs'\) \{ closeServers\(c\); return termHere\(c, s\.name\); \}/);
  assert.match(page, /terminal: \{ run: async \(\) => \{ const c = await wrChat\(\); if \(c\) termHere\(c\); \} \}/);
  assert.match(page, /\['⌨ Terminal', here\(\(\) => openTerminal\(c, null, 'term'\)\)\]/);
  // Without xterm, the plain input shows in every area showing that terminal (the panel was left blank before).
  assert.match(page, /u\.plain = true; box\.hidden = true; eachArea\(\(\) => \{ if \(G\.view\.term\) renderTermInput\(t\); \}\);/);
  // The markup: under the groups, above the status bar; maximised, the groups fold away.
  const i = html.indexOf('<main class="layout">'), j = html.indexOf('id="qxPanel"'), k = html.indexOf('id="wsStatus"');
  assert.ok(i > 0 && j > i && k > j);
  assert.match(css, /body\.qp-max \.ws-main > \.layout \{ flex: 0 0 0 !important;/);
});

test('bottom panel: Checks and Debug read the newest reply (checks, reviewer, /review; errors, warnings, debugger)', () => {
  const src = between('function checksReply(c) {', 'function qpPageDraw(');
  const checksReply = new Function(`${src}; return checksReply;`)();
  const ms = [{ role: 'assistant', runId: 'a', stats: {} }, { role: 'user' }, { role: 'assistant', runId: 'b', live: true }, { role: 'codereview' }];
  assert.equal(checksReply({ agent: { messages: ms } }).runId, 'b', 'the newest reply, even while it runs');
  assert.equal(checksReply({ agent: { messages: [{ role: 'user' }] } }), null);
  const ck = between('function qpChecksHTML(c) {', '// The Steps rows of the newest reply');
  assert.match(ck, /reviewCardHTML\(m, r, true\)/, 'the Reviewer card as it looks in the pane');
  assert.match(ck, /codeReviewHTML\(cr, true\)/, 'the /review card as it looks in the pane');
  assert.match(ck, /data-qp-fix/, '↪ Fix in chat puts the problems in the message box');
  const dbg = between('function qpDebugRows(c) {', 'function qpDebugHTML(');
  assert.match(dbg, /traceRows\(m\)/, 'the Steps rows themselves');
  assert.match(dbg, /data-k="err"/); assert.match(dbg, /data-k="warn"/); assert.match(dbg, /🐞 debugger/);
  // The status bar's check figure: verify's and the reviewer's problems.
  const ws = between('function wsCheckState(c) {', 'const SB_ICO');
  const wsCheckState = new Function('checksReply', `${ws}; return wsCheckState;`)((c) => c.m);
  assert.equal(wsCheckState({ m: { stats: {} } }), null, 'no checks ran: nothing shown');
  assert.deepEqual(wsCheckState({ m: { stats: { verify: { ok: true, problems: [] } } } }), { ok: true, problems: 0 });
  assert.deepEqual(wsCheckState({ m: { stats: { verify: { ok: false, problems: ['a', 'b'] }, review: { pass: false, bugs: ['c'] } } } }), { ok: false, problems: 3 });
});

test('🔔 notifications: newest first, one per key, an unread count, cleared and capped', () => {
  const n = SS.createNotes([], 3);
  n.add({ kind: 'done', title: 'Snake game finished', chatId: 'c1', key: 'run:c1' });
  n.add({ kind: 'error', title: 'Breakout stopped', chatId: 'c2', key: 'run:c2' });
  assert.equal(n.unread(), 2);
  n.add({ kind: 'done', title: 'Snake game finished again', chatId: 'c1', key: 'run:c1', read: true });
  assert.deepEqual(n.list.map((x) => x.title), ['Snake game finished again', 'Breakout stopped'], 'the same key replaces the older one');
  assert.equal(n.unread(), 1, 'one you saw happen comes in read');
  assert.equal(n.add({ kind: 'nope', title: 'x' }), null); assert.equal(n.add({ kind: 'done' }), null);
  n.add({ kind: 'warn', title: 'Restart the harness' }); n.add({ kind: 'info', title: 'Update ready' });
  assert.equal(n.list.length, 3, 'capped: the oldest (Breakout) goes');
  assert.deepEqual(SS.noteGroups(n.list).map((g) => g.kind), ['warn', 'done', 'info'], 'Failed, Warnings, Done, News');
  assert.deepEqual(SS.noteGroups([{ kind: 'info' }, { kind: 'done' }, { kind: 'error' }]).map((g) => g.label), ['Failed', 'Done', 'News']);
  n.readAll(); assert.equal(n.unread(), 0);
  n.keepChats((id) => id !== 'c1'); assert.ok(!n.list.some((x) => x.chatId === 'c1'), 'a deleted chat\'s notes go');
  const again = SS.createNotes(JSON.parse(JSON.stringify(n.toJSON())));
  assert.deepEqual(again.list, n.list, 'kept across a reload');
  assert.ok(Number(again.add({ kind: 'done', title: 'later' }).id.slice(1)) > Math.max(...n.list.map((x) => Number(x.id.slice(1)))), 'ids keep counting up');
  again.remove(again.list[0].id); again.clear('warn');
  assert.ok(!again.list.some((x) => x.kind === 'warn'));
  again.clear(); assert.equal(again.list.length, 0);
  assert.equal(SS.ago(1000, 1000 + 10e3), 'now'); assert.equal(SS.ago(0, 4 * 60e3), '4m'); assert.equal(SS.ago(0, 2 * 3600e3), '2h'); assert.equal(SS.ago(0, 3 * 86400e3), '3d');
});

test('🔔 notifications: what QuorX tells you collects there; real warnings still show where they did; needs-you is live', () => {
  // A finished or stopped reply, before notifyRun's own settings and focus checks (the OS notification is unchanged).
  const nr = between('function notifyRun(c, kind, tags = []) {', '\n}');
  assert.ok(nr.indexOf('noteRun(c, kind, tags)') < nr.indexOf("const pref = uiOf(G.settings).notify"));
  assert.match(between('function noteRun(', '\n}'), /if \(kind !== 'done' && kind !== 'error'\) return;/, 'approvals, questions and budgets are live, not kept');
  // A schedule that ran, an update, a restart needed, a budget and a missing folder: noted once each.
  assert.match(between('async function scheduleNoticed(n) {', '\n}'), /noteAdd\(\{ kind: n\.kind, title: `⏰/);
  assert.match(between('function drawUpdate(u) {', '\n}'), /noteAdd\(\{ kind: 'info'.*\{ once: true \}\)/);
  assert.match(between('async function checkStale() {', '\n}'), /if \(stale\) noteAdd\(\{ kind: 'warn'/);
  assert.match(between('function budgetNotices() {', '\n}'), /noteAdd\(\{ kind: 'warn'.*\{ once: true \}\)/);
  assert.match(between('function folderNotices() {', '\n}'), /noteAdd\(\{ kind: 'warn'.*\{ once: true \}\)/);
  // The chat's own notices stay (real warnings still show as they do now).
  assert.match(between('function budgetNotices() {', '\n}'), /insertAdjacentHTML\('afterend', html\)/);
  // The list: Needs you (live) on top, then the kept sections; opening it marks everything read.
  const open = between('function notesOpen() {', 'function notesRedraw()');
  assert.match(open, /NOTES\.store\.readAll\(\)/);
  assert.match(between('function notesRedraw() {', "document.addEventListener('mousedown'"), /const need = needsYou\(\)/);
  // Housekeeping stays silent: flashTip confirmations and the pages notice never reach the bell.
  assert.doesNotMatch(between('function flashTip(', '\n}'), /noteAdd/);
  assert.doesNotMatch(between('function pagesNotice(', '\n}'), /noteAdd/);
});
