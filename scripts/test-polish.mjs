// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The shell's last pass: Home in the editor area, narrow windows (the phone layout only below 720px, the sidebar as a
// drawer, the menus in ≡, the status bar dropping its least needed items), the frame in pop-out windows, and room for
// the window's buttons when the desktop app is phone-sized for computer use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as SS from '../public/shell-status.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = read('public/app.js'), html = read('public/index.html'), polish = read('public/shell-polish.css'), main = read('desktop/main.js');
const css = fs.readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.css')).map((f) => [f, read(`public/${f}`)]);

test('narrow windows: the phone layout starts below 720px everywhere, under the desktop window\'s smallest width', () => {
  assert.match(app, /const PHONE_MQ = '\(max-width: 720px\)';/);
  assert.doesNotMatch(app, /matchMedia\('\(max-width: 900px\)'\)/, 'every phone check uses PHONE_MQ');
  for (const [f, s] of css) {
    // (shell-polish.css folds the menus at 900px: that one is the fold, not the phone layout.)
    assert.doesNotMatch(f === 'shell-polish.css' ? s.replace('@media (max-width: 900px) {\n  body.qf-on .qf-burger', '') : s, /@media \(max-width: 900px\)/, `${f}: phone rules use 720px`);
    assert.doesNotMatch(s, /@media \(min-width: 901px\)/, `${f}: desktop rules start at 721px`);
  }
  // A normal desktop window is never phone-sized (only the computer-use window, 412px wide, is).
  const minW = Number(main.match(/width: 1440, height: 900, minWidth: (\d+)/)?.[1]);
  assert.ok(minW > 720, `desktop minWidth ${minW}`);
  // The drawer, ≡ and the dropping status items.
  assert.match(app, /const NARROW_MQ = '\(max-width: 1000px\)';/);
  assert.match(app, /narrowInit\(\); \/\/ narrow windows/);
  assert.match(polish, /body\.qx-narrow \.shell > \.sidebar, body\.qx-narrow \.shell > \.ws-panel \{ position: absolute;/);
  assert.match(html, /id="qfBurger"[^>]*aria-haspopup="menu"/);
  assert.match(polish, /@media \(max-width: 900px\) \{\n  body\.qf-on \.qf-burger \{ display: grid; \}\n  body\.qf-on \.qf-menubar \{ display: none; \}/);
  for (const n of [5, 4, 3]) assert.match(polish, new RegExp(`\\.ws-status \\[data-prio="${n}"\\] \\{ display: none !important; \\}`));
});

test('status bar: every item says how much it is needed; what needs you, the bell and the sidebar stay longest', () => {
  const items = SS.statusItems({ project: { id: 'p', name: 'Arcade games' }, branch: 'snake/wall-wrap', check: { ok: false, problems: 2 }, servers: 1, running: 2, need: [{ title: 'Snake game', kind: 'answer' }], ctx: { text: '4%' }, spend: 0.0042, unread: 3 });
  assert.ok(items.every((x) => Number.isInteger(x.prio) && x.prio >= 1 && x.prio <= 5), 'a priority on each');
  const prio = Object.fromEntries(items.map((x) => [x.id, x.prio]));
  for (const id of ['need', 'bell', 'sidebar']) assert.equal(prio[id], 1, id);
  assert.ok(prio.running < prio.project && prio.check < prio.spend && prio.panel < prio.servers);
  assert.deepEqual(SS.STATUS_PRIO, { sidebar: 1, need: 1, bell: 1, panel: 2, running: 2, check: 3, project: 4, ctx: 4, servers: 5, spend: 5 });
  assert.match(app, /const btn = \(it\) => btnOf\(it\)\.replace\('<button ', `<button data-prio="\$\{it\.prio \|\| 3\}" `\);/);
});

test('home: in the editor area, the project, the start box, its recent chats and quick actions QuorX already has', () => {
  const i = app.indexOf('box.innerHTML = `<section class="landing qx-home">');
  assert.ok(i > 0);
  const page = app.slice(i, app.indexOf('</section>`;', i));
  const at = (s) => { const n = page.indexOf(s); assert.ok(n >= 0, s); return n; };
  assert.ok(at('id="homeHead"') < at('id="ldStart"') && at('id="ldStart"') < at('class="home-cols"') && at('class="home-cols"') < at('class="ld-projects"'), 'order: project, start box, recent + actions, every project');
  // Every quick action does something that exists.
  const block = app.slice(app.indexOf('const HOME_ACTS = ['), app.indexOf('];', app.indexOf('const HOME_ACTS = [')));
  const acts = [...block.matchAll(/^ {2}\['(\w+)', /gm)].map((m) => m[1]);
  assert.deepEqual(acts, ['new', 'search', 'running', 'servers', 'schedules', 'projset', 'settings', 'news']);
  const body = app.slice(app.indexOf('function homeAct(k) {'), app.indexOf('function drawHomeProject('));
  for (const k of acts) assert.match(body, new RegExp(`\\b${k}: \\(\\) =>`), k);
  for (const fn of ['newChat', 'openChatSearch', 'wrRunning', 'wrServers', 'openSchedules', 'openProjectSettings', 'openSettings', 'openNews']) assert.match(app, new RegExp(`(async )?function ${fn}\\(`), fn);
  // The start box's project picker redraws Home's top; Home hides the empty chat-tab row.
  assert.match(app, /closeMenu\(\); drawHomeProject\(\); ta\.focus\(\);/);
  assert.match(app, /document\.body\.classList\.toggle\('qx-home', on\);/);
  assert.match(polish, /body\.qf-on\.qx-home #wsTop:has\(\.wt-none\) \{ display: none !important; \}/);
});

test('pop-out windows get the frame; the phone-sized desktop window leaves room for its buttons', () => {
  // The page: row 1 (menus, the window's name, Dock back) in a pop-out, no project row.
  assert.match(app, /const frame = qfPlace\(desk\);/);
  assert.match(app, /if \(on && POP\) \{[\s\S]{0,400}title\.append\(bar\);/);
  assert.match(app, /qfMenubarDraw\(\); qfWireBar\(\); if \(!POP\) qfWireTabs\(\);/);
  assert.match(polish, /body\.qx-pop\.qf-on \.qf-title \{ display: flex !important; \}/);
  // The desktop app: pop-out windows have the hidden title bar with Windows' buttons over row 1.
  const pop = main.slice(main.indexOf('function openPopout('), main.indexOf("popouts.set(id"));
  assert.match(pop, /titleBarStyle: 'hidden', titleBarOverlay: \{ color: FRAME_BAR\.color, symbolColor: FRAME_BAR\.symbolColor, height: FRAME_BAR\.height \}/);
  assert.match(pop, /pw\.setMenuBarVisibility\(false\);/);
  // Computer use (phone layout in the desktop app): the top bar stops where − □ × start and takes their colours.
  assert.match(polish, /body\.qx-desk:not\(\.qf-on\) > header\.top \{ padding-right: calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width/);
  assert.match(app, /const el = qfOn\(\) \? \$\('#qfTitle'\) : \$\('header\.top'\);/);
  assert.match(app, /if \(!frame\) qfOverlay\(\);/);
});

test('after a full test pass: the tour points at the new shell, ＋ stays reachable, the model chip wraps, commands leave no draft', () => {
  const tour = read('public/tour.js'), tabs = read('public/tabs.css'), comp = read('public/composer.css');
  // Each tour step names a target of the new shell first (the old ids stay as fallbacks).
  for (const sel of ['.wr-btn[data-view="chats"]', '.cq-mode-ico', '.wr-btn[data-act="settings"]', '.wr-btn[data-view="spending"]', '.ws-status [data-sb="panel"]']) assert.ok(tour.includes(sel), `tour targets ${sel}`);
  assert.doesNotMatch(tour, /row of switches above its message box/);
  assert.doesNotMatch(tour, /the side panel has a <b>Terminal<\/b>/);
  // With more tabs than fit, ＋ and ⋯ stay at the strip's right end.
  assert.match(tabs, /\.ws-top \.wt-ptabs \.wt-padd, \.ws-top \.wt-ptabs \.wt-pmore \{ position: sticky;/);
  // The narrowest message box wraps instead of squeezing the model chip to nothing (the Quorium squares never shrink).
  assert.match(comp, /\.composer-box\.fold6 \.cmp-foot \.cmp-model-slot \{ flex: 0 1 auto; min-width: 56px; \}/);
  assert.match(comp, /\.composer-box\.fold6 \.cmp-control-rack \{ flex-wrap: wrap !important;/);
  // A slash command clears the saved draft too, even when its card redraws the chat before the save.
  assert.match(app, /runCommand\(c, t\.trim\(\)\)\) \{ ta\.value = ''; c\.unsent = ''; return; \}/);
});

test('activity bar: ⟳ restarts the harness from just above ⚙, turns amber when a restart is needed and spins while it runs', () => {
  const ws = read('public/workspace.css'), last = read('public/last.css');
  assert.match(app, /id="wrRestart" data-act="restart"[^`]*`\n\s*\+ `<button type="button" class="wr-btn" data-act="settings"/);
  assert.match(app, /if \(b\.dataset\.act === 'restart'\) return \$\('#restartBtn'\)\?\.disabled \? undefined : restartHarness\(\);/);
  assert.match(app, /for \(const b of \['#restartBtn', '#railRestart', '#wrRestart'\]/);
  assert.match(last, /#restartBtn\.stale, #railRestart\.stale, #wrRestart\.stale \{/);
  assert.match(ws, /\.ws-rail #wrRestart\.spinning svg \{ animation: ohSpin/);
  assert.equal((app.match(/id="wrRestart"/g) || []).length, 1);
});
