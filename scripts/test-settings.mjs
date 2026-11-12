// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The Settings tab (public/settings-map.js and app.js "the Settings tab"): its scopes and regrouped pages, old page
// names that still land on the right page, a row's default for the dot and ↺, search words, the read-only settings
// file, and checks on the page's own code that every row Settings had is still there and nothing opens it as a dialog.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as SM from '../public/settings-map.js';

// (Read with plain LF line ends, as the repository keeps them, whatever the checkout did.)
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const region = (start) => { const i = app.indexOf(start); assert.ok(i >= 0, `${start} is in app.js`); return app.slice(i, app.indexOf('\n}\n', i)); };
const panels = region('function settingsPanels(S) {');
const desktop = region('async function drawDesktopSettings() {');

test('settings map: scopes, groups and pages are unique, and the desktop-only page shows only in the desktop app', () => {
  assert.deepEqual(SM.SCOPES.map(([k]) => k), ['app', 'project', 'chat']);
  assert.ok(SM.isScope('project') && !SM.isScope('dialog'));
  const all = SM.pagesFor(true).map((p) => p.id);
  assert.equal(new Set(all).size, all.length, 'no page twice');
  assert.deepEqual(SM.navFor(true).map(([g]) => g), ['General', 'Models', 'Agent', 'Safety', 'Workspace', 'Keyboard', 'Data']);
  // The regrouped pages from the IDE shell design, Window & layout among them.
  for (const id of ['setup', 'appearance', 'privacy', 'window', 'providers', 'limits', 'newchats', 'loop', 'deciders', 'tools', 'video', 'memory', 'safety', 'perms', 'letthrough', 'budget', 'projects', 'servers', 'terminal', 'browser', 'docs', 'design', 'shortcuts', 'storage', 'backup', 'updates', 'about']) assert.ok(all.includes(id), id);
  assert.ok(!SM.pagesFor(false).some((p) => p.id === 'updates'), 'Updates comes from the desktop app');
  assert.equal(SM.pagesFor(false).length, all.length - 1);
});

test('settings map: old page names open the page that holds those rows now', () => {
  assert.equal(SM.resolvePage('keys'), 'providers');
  assert.equal(SM.resolvePage('sources'), 'providers');
  assert.equal(SM.resolvePage('data'), 'backup');
  assert.equal(SM.resolvePage('code'), 'browser'); // the Chrome extension's old link
  assert.equal(SM.resolvePage('mcp'), 'mcp');
  assert.equal(SM.resolvePage('updates', false), 'about');
  assert.equal(SM.resolvePage('updates', true), 'updates');
  assert.equal(SM.resolvePage('nonsense'), 'setup');
  assert.equal(SM.resolveProjectPage('hooks'), 'hooks');
  assert.equal(SM.resolveProjectPage('space'), 'overview');
  assert.equal(SM.resolveProjectPage(undefined), 'overview');
});

test('settings map: a row knows its default, and a value only counts as changed when it really differs', () => {
  const defaults = { maxSteps: 500, safety: { shell: 'powershell', tripwire: true }, gate: { act: 0.8 }, voters: ['a', 'b'] };
  const ui = { density: 'comfortable', idleHide: 0, showBalance: false };
  assert.equal(SM.rowDefault('maxSteps', defaults, ui), 500);
  assert.equal(SM.rowDefault('safety.shell', defaults, ui), 'powershell');
  assert.equal(SM.rowDefault('ui.density', defaults, ui), 'comfortable');
  assert.equal(SM.rowDefault('ui.idleHide', defaults, ui), 0);
  assert.equal(SM.rowDefault('voters', defaults, ui), undefined, 'a list has no single default');
  assert.equal(SM.rowDefault('nope.deep', defaults, ui), undefined);
  assert.equal(SM.rowDefault('', defaults, ui), undefined);
  assert.equal(SM.isModified(498, 500), true);
  assert.equal(SM.isModified('500', 500), false, 'a number box gives text');
  assert.equal(SM.isModified('0', 0), false, 'a segmented control gives text');
  assert.equal(SM.isModified('compact', 'comfortable'), true);
  assert.equal(SM.isModified(undefined, 500), false, 'unset is the default');
  assert.equal(SM.isModified(true, false), true);
  assert.equal(SM.isModified(false, false), false);
  assert.equal(SM.isModified(5, undefined), false, 'no default: no dot');
});

test('settings map: search needs every word; the settings file leaves out keys and tokens but keeps token counts', () => {
  const w = SM.searchWords('  Keep  AWAKE ');
  assert.deepEqual(w, ['keep', 'awake']);
  assert.equal(SM.rowMatches('Keep the PC awake while QuorX works', w), true);
  assert.equal(SM.rowMatches('Keep going while the plan is open', w), false);
  assert.equal(SM.rowMatches('anything', []), true);
  const text = SM.settingsFile({ maxSteps: 400, inlineDocTokens: 15000, apiKey: 'sk-x', nested: { githubToken: 'g', secret: 's', list: [{ password: 'p', ok: 1 }] }, ui: { density: 'compact' } }, 'dark');
  const j = JSON.parse(text);
  assert.equal(j.theme, 'dark');
  assert.equal(j.maxSteps, 400);
  assert.equal(j.inlineDocTokens, 15000);
  assert.equal(j.apiKey, undefined);
  assert.deepEqual(j.nested, { list: [{ ok: 1 }] });
  assert.equal(JSON.parse(SM.settingsFile(null)).theme, 'system');
  assert.ok(SM.isSecretKey('token') && SM.isSecretKey('OPENROUTER_API_KEY') && !SM.isSecretKey('maxOutput'));
});

test('settings tab: every App page has its panel, and every row Settings had is still drawn', () => {
  for (const { id } of SM.pagesFor(true)) assert.ok(new RegExp(`\\n    (?:\\.\\.\\.\\(DESK \\? \\{ )?${id}: [[(]`).test(panels), `panel for ${id}`);
  // Rows that moved to new pages, by what they save (same storage as before).
  const moved = { window: ['ui.notify', 'ui.sidebarStart', 'ui.paneMode', 'ui.idleHide'], limits: ['sourceFallback', 'limitSwitchSecs', 'limitWaitHours'], terminal: ['safety.shell', 'safety.timeout', 'safety.memoryMB'], browser: ['browseReadOnly', 'chromeCheck', 'chromeYoloActs', 'chromeNetwork', 'chromeCloseTabs', 'chromeSitesNever', 'chromeSitesAlways', 'chromeSitesRead'], budget: ['ui.usageBtn', 'chatBudget', 'budgetGrace'] };
  for (const [page, binds] of Object.entries(moved)) {
    const at = panels.indexOf(`\n    ${page}: [`);
    const end = panels.indexOf('\n    ]],', at);
    const body = page === 'terminal' ? panels.slice(panels.indexOf('const shellCard'), panels.indexOf('return {')) : panels.slice(at, end);
    for (const b of binds) assert.ok(body.includes(`'${b}'`) || body.includes(`data-bind="${b}"`), `${b} on ${page}`);
  }
  // Each one is drawn once: two controls for one value would disagree.
  for (const b of ['ui.notify', 'safety.shell', 'chromeCheck', 'ui.usageBtn', 'sourceFallback', 'requireParams']) assert.equal(panels.split(`'${b}'`).length - 1, 1, `${b} drawn once`);
  // The rows Settings had (169 with the desktop app's) plus four links between the pages that were one.
  const rows = (s) => (s.match(/st(?:Row|Tile|Cap)\(/g) || []).length;
  assert.ok(rows(panels) + rows(desktop) >= 173, `rows: ${rows(panels) + rows(desktop)}`);
  // The desktop app's rows land on Window & layout, Updates and Backup.
  for (const id of ['stDesktop', 'stDeskUpd', 'stDeskData']) assert.ok(panels.includes(`id="${id}"`) && desktop.includes(`#${id}`) || id === 'stDesktop', id);
});

test('settings tab: Settings and the project settings are a tab, never a dialog', () => {
  assert.match(html, /<div id="settings" class="st-tab"/);
  assert.doesNotMatch(html, /<dialog id="settings"/);
  assert.doesNotMatch(html, /id="projDlg"|id="projSubDlg"/, 'the project settings window is the Project scope now');
  assert.doesNotMatch(app, /\$\('#settings'\)\??\.(open|showModal|close)\b/);
  assert.doesNotMatch(app, /#projDlg|#projSubDlg|openProjectSub\(/);
  assert.match(app, /function openProjectSettings\(p0, focusOn\) \{\n  if \(!p0\) return;\n  openSettings\(null, \{ scope: 'project'/);
  // It opens as a file-like tab (it moves, splits and pops out with the workspace), and the settings file beside it.
  assert.match(app, /const ST_F = \{ id: 'qx-settings', kind: 'settings'/);
  assert.match(app, /const ST_FILE_F = \{ id: 'qx-settings-file', kind: 'settingsfile'/);
  assert.match(app, /if \(stInPane\(body, bar\)\) return;/);
  // A pop-out window's Save reaches the main window.
  assert.match(app, /savePrefs\(\); if \(POP\) stSaveFromPop\(\);/);
  assert.match(app, /addEventListener\('storage', \(e\) => \{\n  if \(e\.key !== STORE/);
  // The shared list filter on Settings › Projects.
  assert.match(app, /listFilter\(\$\('\.pp-filter', box\), \{ key: 'projects'/);
});
