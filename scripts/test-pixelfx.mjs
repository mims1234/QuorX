// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Pixel art effects for games (server/pixelfx.js, skills/canvas-game): the shipped index, search, the request gate,
// adding effects with their hashes checked, the layer, and the agent's pixel_fx tool. No network: files come from a
// small index of our own, served by a fake download or kept in the throwaway data folder's cache.
import { tempDir } from './test-home.mjs';
import { reply, run, toolResults } from './agent-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { index, useIndex, closure, findEffects, asksForPixelFx, isPixelFxPath, prepareEffects, addedNote, pixelGuide, CACHE_DIR, MAX_EFFECTS, BUILD_DIR } from '../server/pixelfx.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A small index of our own, so files can be served with hashes that match.
const CODE = {
  'core/index.js': 'export * from "./fx.js";\nexport const PAL = { ice: ["#000", "#fff"] };\n',
  'core/fx.js': 'export function createFrame() {}\nexport function clearFrame() {}\nexport function createFx() {}\nexport function createAct() {}\nexport function composite() {}\n',
  'fx/ice/_lib.js': 'import { PAL } from "../../core/index.js";\nexport const shard = PAL.ice;\n',
  'fx/ice/frost-nova.js': 'import { PAL } from "../../core/index.js";\nimport { shard } from "./_lib.js";\nexport const meta = { name: "Frost nova" };\nexport function draw() { return [PAL, shard]; }\n',
  'fx/ice/ice-spikes.js': 'import { shard } from "./_lib.js";\nexport const meta = { name: "Ice spikes" };\nexport function draw() { return shard; }\n',
};
const IMPORTS = { 'core/index.js': ['core/fx.js'], 'core/fx.js': [], 'fx/ice/_lib.js': ['core/index.js'], 'fx/ice/frost-nova.js': ['core/index.js', 'fx/ice/_lib.js'], 'fx/ice/ice-spikes.js': ['fx/ice/_lib.js'] };
const COMMIT = 'a'.repeat(40);
const FILES = Object.fromEntries(Object.entries(CODE).map(([rel, text]) => [rel, { sha256: sha(text), bytes: Buffer.byteLength(text), imports: IMPORTS[rel] }]));
const OURS = {
  commit: COMMIT,
  files: { ...FILES, 'fx/ice/broken.js': { sha256: sha('x'), bytes: 1, imports: ['fx/ice/missing.js'] }, '../../etc/passwd.js': FILES['core/fx.js'] },
  effects: [
    { id: 'ice/frost-nova', name: 'Frost nova', category: 'ice', about: 'a ring of ice', tags: ['nova'], duration: 3.4, loop: false, size: [288, 192], act: true },
    { id: 'ice/ice-spikes', name: 'Ice spikes', category: 'ice', about: '', tags: [], duration: 3, loop: false, size: [100, 80] },
    { id: 'ice/broken', name: 'Broken', category: 'ice', tags: [] },
  ],
};
const RAW = (rel) => `https://raw.githubusercontent.com/patch-gg/pixelfx/${COMMIT}/src/${rel}`;
/** A fake download: serves CODE (or `serve`), and counts what was asked. */
function server(serve = CODE) {
  const asked = [];
  const get = async (url, { maxBytes }) => {
    asked.push(url);
    const rel = Object.keys(serve).find((r) => RAW(r) === url);
    if (!rel) throw new Error('GitHub answered 404');
    const bytes = Buffer.from(serve[rel]);
    if (bytes.length > maxBytes) throw new Error('the file is larger than expected');
    return bytes;
  };
  return { get, asked };
}
/** A game folder: has / readText over it, and write for the files prepareEffects returns. */
function game() {
  const dir = tempDir('quorx-fx-');
  const abs = (rel) => path.join(dir, ...rel.split('/'));
  return {
    dir,
    has: (rel) => fs.existsSync(abs(rel)),
    readText: (rel) => fs.readFileSync(abs(rel), 'utf8'),
    write(files) { for (const f of files) { fs.mkdirSync(path.dirname(abs(f.path)), { recursive: true }); fs.writeFileSync(abs(f.path), f.text); } },
  };
}

test('the shipped index names one commit, holds the whole library, and every effect comes with all it imports', () => {
  useIndex(null);
  const shipped = index();
  assert.match(shipped.commit, /^[0-9a-f]{40}$/);
  assert.ok(shipped.effects.length >= 240, `${shipped.effects.length} effects`);
  for (const e of shipped.effects) {
    const files = closure(shipped.files, `fx/${e.id}.js`);
    assert.ok(files?.includes('core/index.js'), `${e.id} should come with everything it imports`);
  }
  // Transitions build their meta with screenMeta(...): they are in the index too, as whole-screen one-shots.
  const wipes = shipped.effects.filter((e) => e.id.startsWith('transitions/'));
  assert.ok(wipes.length > 0 && wipes.every((e) => !e.loop && e.size?.[0] === 320 && e.size?.[1] === 180 && e.tags.includes('transition')));
  // Weather is drawn for one 320 x 180 screen, from the bottom centre.
  const rain = shipped.effects.find((e) => e.id === 'weather/rain');
  assert.deepEqual([rain.size, rain.origin], [[320, 180], [160, 170]]);
});

test('search finds an effect by its name, a category word finds that category first, and the plainest name wins a tie', () => {
  useIndex(null);
  assert.equal(findEffects('frost nova')[0]?.id, 'ice/frost-nova');
  assert.match(findEffects('fire')[0]?.id, /^fire\//, 'not "flying skull" or another effect that only mentions fire');
  assert.equal(findEffects('rain')[0]?.id, 'weather/rain', 'Rain before Rain splash');
  assert.equal(findEffects('explosion')[0]?.id, 'explosions/small-explosion', 'the effect named Explosion first');
  assert.match(findEffects('frost nova')[0].label, /Frost nova · ice · 3\.4s one-shot, 288x192 px · acted/);
  assert.deepEqual(findEffects('zzzz qqqq'), []);
});

test('pixel effects are offered only when a request asks for them, not for a pixel art look', () => {
  for (const ask of ['a platformer with pixel effects', 'a landing page with pixel-art explosions', 'a shooter, add some VFX', 'use pixelfx for the spells', 'pixel art particles on every hit', 'pixel fx please'])
    assert.ok(asksForPixelFx(ask), `"${ask}" asks for pixel effects`);
  for (const ask of ['a pixel art platformer', 'make a snake game', 'a bakery website', 'pixel perfect layout', ''])
    assert.ok(!asksForPixelFx(ask), `"${ask}" does not`);
  assert.ok(isPixelFxPath('js/pixelfx/core/index.js') && isPixelFxPath('game\\js\\pixelfx\\layer.js') && isPixelFxPath('./js/pixelfx'));
  assert.ok(!isPixelFxPath('js/main.js') && !isPixelFxPath('js/pixelfx-notes.md'));
});

test('adding an effect writes it with its imports, the layer, the licence and a credit; files are checked against their hashes and kept', async () => {
  useIndex(OURS);
  try {
    assert.equal(index().effects.length, 2, 'an effect whose imports are missing is left out');
    assert.ok(!index().files.has('../../etc/passwd.js'), 'a file of the wrong shape is left out');
    const g = game(), s = server();
    const r = await prepareEffects(['ice/frost-nova'], { has: g.has, readText: g.readText, get: s.get });
    assert.deepEqual(r.problems, []);
    g.write(r.files);
    for (const rel of ['core/index.js', 'core/fx.js', 'fx/ice/_lib.js', 'fx/ice/frost-nova.js', 'layer.js', 'license.txt']) assert.ok(g.has(`${BUILD_DIR}/${rel}`), `${rel} should come with the effect`);
    // Saved byte for byte as pixelfx has them, with their own names: nothing to rewrite.
    assert.equal(g.readText('js/pixelfx/fx/ice/frost-nova.js'), CODE['fx/ice/frost-nova.js']);
    assert.match(g.readText('js/pixelfx/license.txt'), /MIT License[\s\S]*Copyright \(c\) 2026 Patch[\s\S]*Hugo Duprez[\s\S]*Hollow Crown/);
    assert.match(g.readText('credits.txt'), /pixelfx by Patch, MIT License/);
    assert.match(addedNote(r), /Added 1 effect[\s\S]*js\/pixelfx\/fx\/ice\/frost-nova\.js \(Frost nova, 3\.4s, then ends, acted\)[\s\S]*Never read, copy or edit/);

    // A second effect brings only what the game lacks, and the credit is not written twice.
    const before = s.asked.length;
    const r2 = await prepareEffects(['ice/ice-spikes'], { has: g.has, readText: g.readText, get: s.get });
    assert.deepEqual(r2.files.map((f) => f.path), ['js/pixelfx/fx/ice/ice-spikes.js']);
    assert.equal(s.asked.length, before + 1);

    // Kept on disk: another game gets the same effect without a download.
    const fresh = server();
    const r3 = await prepareEffects(['ice/frost-nova'], { get: fresh.get });
    assert.equal(fresh.asked.length, 0, 'files already downloaded and checked come from disk');
    assert.ok(r3.added.length === 1);
    // ...and a kept file that was changed on disk is not trusted.
    fs.writeFileSync(path.join(CACHE_DIR(), COMMIT, 'core', 'fx.js'), 'export const evil = 1;\n');
    await prepareEffects(['ice/frost-nova'], { get: fresh.get });
    assert.deepEqual(fresh.asked, [RAW('core/fx.js')]);

    // A file that does not match its hash is refused, and nothing of that effect is written.
    fs.rmSync(path.join(CACHE_DIR(), COMMIT), { recursive: true, force: true });
    const evil = server({ ...CODE, 'fx/ice/ice-spikes.js': CODE['fx/ice/ice-spikes.js'].replace('Ice', 'Evil') });
    const g2 = game();
    const bad = await prepareEffects(['ice/ice-spikes', 'ice/frost-nova'], { has: g2.has, get: evil.get });
    assert.deepEqual(bad.added.map((a) => a.id), ['ice/frost-nova']);
    assert.match(bad.problems.join(), /ice\/ice-spikes: fx\/ice\/ice-spikes\.js from GitHub did not match/);
    assert.ok(!bad.files.some((f) => f.path.endsWith('ice-spikes.js')));
    // An id from nowhere, and a game in a folder of its own.
    const odd = await prepareEffects(['../../etc/passwd', 'pixelfx:ice/frost-nova'], { folder: 'games/frost/', get: server().get });
    assert.match(odd.problems.join(), /not an effect id/);
    assert.ok(odd.files.some((f) => f.path === 'games/frost/js/pixelfx/fx/ice/frost-nova.js') && odd.files.some((f) => f.path === 'games/frost/credits.txt'));
  } finally { useIndex(null); }
});

test('a game gets at most 24 effects', async () => {
  const many = { ...OURS, effects: [...OURS.effects] };
  const files = { ...OURS.files };
  for (let i = 0; i < MAX_EFFECTS + 1; i++) {
    const text = `import { shard } from "./_lib.js";\nexport const meta = { name: "Shard ${i}" };\n`;
    CODE[`fx/ice/shard-${i}.js`] = text;
    files[`fx/ice/shard-${i}.js`] = { sha256: sha(text), bytes: Buffer.byteLength(text), imports: ['fx/ice/_lib.js'] };
    many.effects.push({ id: `ice/shard-${i}`, name: `Shard ${i}`, category: 'ice', tags: [], duration: 1 });
  }
  useIndex({ ...many, files });
  try {
    const g = game();
    const r = await prepareEffects(many.effects.map((e) => e.id), { has: g.has, readText: g.readText, get: server().get });
    assert.equal(r.added.length, MAX_EFFECTS);
    assert.match(r.problems.join(), /already has 24 effects/);
    g.write(r.files);
    // An effect the game already has can be added again (the file is written afresh), even at the limit.
    const again = await prepareEffects(['ice/frost-nova'], { has: g.has, readText: g.readText, get: server().get });
    assert.deepEqual([again.added.length, again.problems.length], [1, 0]);
  } finally { useIndex(null); }
});

test('the layer offers what the guide uses, drops empty options and covers any view with weather', () => {
  const layer = fs.readFileSync(path.join(ROOT, 'skills', 'canvas-game', 'pixelfx', 'layer.js'), 'utf8');
  for (const name of ['play', 'act', 'cover', 'update', 'render', 'overlay', 'resize', 'clear', 'count', 'frozen', 'shake', 'moveTo', 'face', 'stop', 'done', 'camera'])
    assert.match(layer, new RegExp(`\\b${name}\\b`), `the layer should offer ${name}`);
  // A game passing palette: undefined (or a PAL name that does not exist) once broke every explosion: the effect's own is kept.
  const src = /const given = ([\s\S]*?\)\)\);)/.exec(layer);
  assert.ok(src, 'the layer should clean the options it is given');
  const given = new Function(`return ${src[1].replace(/;$/, '')}`)();
  assert.deepEqual(given({ x: 1, palette: undefined, seed: null, flip: false, light: 0 }), { x: 1, flip: false, light: 0 });
  assert.deepEqual(given({ palette: [] }), {});
  assert.deepEqual(given({ palette: 'ice' }), {});
  assert.deepEqual(given({ palette: ['#000', '#fff'] }), { palette: ['#000', '#fff'] });
  assert.match(layer, /scale === 'cover'/);
  assert.match(layer, /Math\.max\(width \/ SCREEN_W, height \/ SCREEN_H\)/, "scale: 'cover' fits a 320 x 180 screen over the whole view");
  assert.doesNotMatch(layer, /ALMA/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'skills', 'canvas-game', 'pixelfx', 'license.txt'), 'utf8'), /ALMA/);
});

test('the canvas-game skill covers the adaptive view, phones, full screen and credits; pixel effects only in its add-on', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'canvas-game', 'SKILL.md'), 'utf8');
  for (const re of [/short side at 540/, /Scale\.RESIZE/, /scale\.refresh\(\)/, /Math\.min\(innerWidth, innerHeight\) \/ 540/, /at least 56px/, /safe-area-inset/, /requestFullscreen/, /no plain link to `credits\.txt`/]) assert.match(skill, re);
  assert.doesNotMatch(skill, /pixelfx|pixel_fx/i, 'a game that did not ask for effects is not told about them');
  const guide = pixelGuide();
  for (const re of [/pixel_fx/, /createFxLayer/, /fx\.cover|sky\.cover/, /scale: 'cover'/, /fx\.resize/, /Never read, copy, search or edit/, /type="module"/]) assert.match(guide, re);
  assert.doesNotMatch(guide, /^---/, 'the front matter is left out');
});

test('the agent offers pixel_fx only when asked, adds the guide to the skill, and never reads or searches the effect files', async () => {
  useIndex(OURS);
  try {
    // A pixel art look alone: no tool, no guide, no list of the skill's own files.
    const plain = await run(async (body, i) => (i === 0 ? reply('', [['use_skill', { name: 'canvas-game' }]]) : reply('ok')), { text: 'make a pixel art platformer' });
    assert.ok(!plain.bodies[0].tools.some((t) => t.function.name === 'pixel_fx'));
    const skillText = toolResults(plain.bodies[1]).join('\n');
    assert.match(skillText, /# Skill: canvas-game/);
    assert.doesNotMatch(skillText, /Pixel art effects|pixel_fx|Extra files/);

    // Asked for: the tool, the guide, find and add; the files are written and pixelfx's are off limits.
    const kept = path.join(CACHE_DIR(), COMMIT);
    for (const [rel, text] of Object.entries(CODE)) { fs.mkdirSync(path.dirname(path.join(kept, rel)), { recursive: true }); fs.writeFileSync(path.join(kept, rel), text); }
    const steps = [
      [['use_skill', { name: 'canvas-game' }]],
      [['pixel_fx', { action: 'find', query: 'frost nova, spikes' }]],
      [['pixel_fx', { action: 'add', ids: ['ice/frost-nova'] }]],
      [['read_file', { path: 'js/pixelfx/core/index.js' }], ['edit_file', { path: 'js/pixelfx/layer.js', find: 'export', replace: 'x' }], ['search_files', { query: 'PAL' }]],
    ];
    const asked = await run(async (body, i) => (i < steps.length ? reply('', steps[i]) : reply('done')), { text: 'a platformer with pixel effects' });
    assert.ok(asked.bodies[0].tools.some((t) => t.function.name === 'pixel_fx'));
    const results = toolResults(asked.bodies.at(-1));
    assert.match(results[0], /## Pixel art effects \(pixelfx\)/);
    assert.doesNotMatch(results[0], /Extra files/);
    assert.match(results[1], /"frost nova": \n- ice\/frost-nova: Frost nova/);
    assert.match(results[2], /Added 1 effect/);
    assert.ok(fs.existsSync(path.join(asked.dir, 'js', 'pixelfx', 'fx', 'ice', 'frost-nova.js')) && fs.existsSync(path.join(asked.dir, 'js', 'pixelfx', 'layer.js')));
    assert.match(fs.readFileSync(path.join(asked.dir, 'credits.txt'), 'utf8'), /pixelfx by Patch/);
    assert.match(results[3], /^Refused: the files under js\/pixelfx/);
    assert.match(results[4], /^Refused: the files under js\/pixelfx/);
    assert.ok(!/js[\\/]pixelfx/.test(results[5]), `search should not show effect files (got: ${results[5]})`);
    assert.ok(fs.readFileSync(path.join(asked.dir, 'js', 'pixelfx', 'layer.js'), 'utf8').includes('export function createFxLayer'), 'the layer was not edited');
  } finally { useIndex(null); }
});
