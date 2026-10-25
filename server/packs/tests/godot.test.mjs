// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Godot pack self-test. The error parser and the log folder are tested anywhere; with Godot 4 installed (or QX_GODOT
// set to its editor), QuorX finds it, the check catches a script error in a changed file (also one that needs the
// project's class list), a scene runs headless, and the debugger stops at a breakpoint in a running game.
import { project, tool, skipUnless } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';
import { debugStart, debugBreak, debugMove, debugEval, debugStop } from '../../debugger.js';
import { parseGodot, godotVersion, godotLogDir, godotExe } from '../godot.js';
import { packsIn } from '../index.js';

const PROJECT = 'config_version=5\n\n[application]\n\nconfig/name="QX Pack"\nrun/main_scene="res://main.tscn"\n';
const SCENE = '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n';

test('godot: the error parser reads script errors with their file and line', () => {
  const out = [
    '\x1b[1mGodot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org\x1b[0m', '',
    'SCRIPT ERROR: Parse Error: Identifier "undefined_thing" not declared in the current scope.',
    '   at: GDScript::reload (res://main.gd:6)',
    'ERROR: Failed to load script "res://main.gd" with error "Parse error".',
    '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
    'SCRIPT ERROR: Invalid call. Nonexistent function \'jump\' in base \'Nil\'.',
    '          at: _process (res://actors/player.gd:31)',
    'SCRIPT ERROR: Parse Error: Identifier "undefined_thing" not declared in the current scope.',
    '   at: GDScript::reload (res://main.gd:6)',
  ].join('\r\n');
  assert.deepEqual(parseGodot(out), [
    'main.gd:6: Parse Error: Identifier "undefined_thing" not declared in the current scope.',
    'actors/player.gd:31: Invalid call. Nonexistent function \'jump\' in base \'Nil\'.',
  ]);
  assert.deepEqual(parseGodot('Godot Engine v4.7.2\n'), []);
});

test('godot: versions are read, and the log folder follows project.godot', () => {
  assert.equal(godotVersion('4.7.2.stable.official.ed1daf0bf\n'), '4.7.2');
  assert.equal(godotVersion('4.3.stable.official.77dcf97d8'), '4.3');
  assert.equal(godotVersion('no'), null);
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', XDG_DATA_HOME: '/home/me/.local/share' };
  const dir = godotLogDir(PROJECT, env);
  assert.match(dir, /QX Pack[\\/]logs$/);
  assert.match(dir, /app_userdata/);
  const own = godotLogDir(`${PROJECT}config/use_custom_user_dir=true\nconfig/custom_user_dir_name="qxgame"\n`, env);
  assert.match(own, /qxgame[\\/]logs$/);
  assert.doesNotMatch(own, /app_userdata/);
});

test('godot: a folder with project.godot is a Godot project', () => {
  const dir = project('godot-marker', { 'project.godot': PROJECT });
  assert.ok(packsIn(dir).some((p) => p.id === 'godot'));
});

test('godot: QuorX finds Godot 4 and it parses a script here', async (t) => {
  const skip = await skipUnless('godot'); if (skip) return t.skip(skip);
  const g = await tool('godot');
  assert.match(g.version, /^4\.\d+/);
  assert.ok(g.works, g.problem);
});

test('godot: the check catches a script error in a changed file, and not in one that is fine', async (t) => {
  const skip = await skipUnless('godot', { works: true }); if (skip) return t.skip(skip);
  const dir = project('godot-check', {
    'project.godot': PROJECT, 'main.tscn': SCENE,
    'main.gd': 'extends Node\n\nfunc _ready():\n\tprint(score)\n',
    'enemy.gd': 'class_name Enemy\nextends Node\n\nvar hp := 3\n',
    'spawner.gd': 'extends Node\n\nfunc spawn() -> int:\n\tvar e := Enemy.new()\n\treturn e.hp\n',
  });
  const r = await languageChecks(dir, ['main.gd', 'enemy.gd', 'spawner.gd'], { have: ['godot'] });
  assert.equal(r.ran[0]?.lang, 'godot');
  assert.ok(r.problems.some((p) => /main\.gd:4: .*score/.test(p)), `problems: ${r.problems.join(' | ')}`);
  // spawner.gd uses Enemy, another script's class_name: fine once the project is imported, which the check does.
  assert.ok(!r.problems.some((p) => /spawner\.gd/.test(p)), `problems: ${r.problems.join(' | ')}`);
});

test('godot: a scene runs headless and prints', async (t) => {
  const skip = await skipUnless('godot', { works: true }); if (skip) return t.skip(skip);
  const dir = project('godot-run', { 'project.godot': PROJECT, 'main.tscn': SCENE, 'main.gd': 'extends Node\n\nfunc _ready():\n\tprint("ready ", 2 + 3)\n\tget_tree().quit()\n' });
  assert.match(execFileSync(godotExe(), ['--headless', '--path', dir], { encoding: 'utf8', timeout: 120000 }), /ready 5/);
});

test('godot: the debugger stops at a breakpoint in the running game and reads a variable', async (t) => {
  const skip = await skipUnless('godot', { works: true }); if (skip) return t.skip(skip);
  const dir = project('godot-dbg', {
    'project.godot': PROJECT, 'main.tscn': SCENE,
    'main.gd': 'extends Node\n\nfunc _ready():\n\tvar lives := 3\n\tlives -= 1\n\tprint("lives ", lives)\n\tget_tree().quit()\n',
  });
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'main.gd' });
  try {
    assert.match(await debugBreak(s.id, 'main.gd', 6), /breakpoint at main\.gd:6/);
    const st = await debugMove(s.id, 'continue', 60000);
    assert.equal(st.state, 'paused', 'stopped at the breakpoint');
    assert.equal(path.basename(st.frames[0].file), 'main.gd');
    assert.equal(st.frames[0].line, 6);
    assert.ok(st.locals.some((l) => /^lives = 2$/.test(l)), `locals: ${st.locals.join(', ')}`);
    assert.match(await debugEval(s.id, 'lives * 10'), /20/);
  } finally { await debugStop(s.id).catch(() => {}); }
});

test('godot: the notes name this project\'s log folder', async () => {
  const { packNotes } = await import('../index.js');
  const dir = project('godot-notes', { 'project.godot': PROJECT });
  assert.match(packNotes(dir, []), /QX Pack[\\/]logs/);
});
