// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The pixel effect index the canvas-game skill ships with (skills/canvas-game/pixelfx/index.json).
//
//   node scripts/pixelfx-index.mjs <pixelfx checkout> [commit]           print what the index would hold
//   node scripts/pixelfx-index.mjs <pixelfx checkout> [commit] --write   rewrite the index
//
// pixelfx (https://github.com/patch-gg/pixelfx, MIT) is a library of pixel art effects written as code: one ES module
// per effect, all drawing through a small core. This reads a checkout at one commit (HEAD when none is named) with
// git show, so every file is byte for byte what GitHub serves for that commit, and writes every file with its hash,
// size and imports, and every effect with the words it is found by. Nothing in the checkout is run: each effect's meta
// is read from its source with acorn. A developer runs this and commits the result; games download the files they
// need from that commit (server/pixelfx.js) and check each against its hash.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';
import { INDEX_FILE, REPO } from '../server/pixelfx.js';

const git = (dir, args, opts = {}) => execFileSync('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });

/** A literal from the source (numbers, strings, arrays, plain objects), or undefined for anything computed. */
function literal(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis.map((q) => q.value.cooked).join('');
  if (node.type === 'ArrayExpression') { const items = node.elements.map(literal); return items.includes(undefined) ? undefined : items; }
  if (node.type === 'ObjectExpression') {
    const out = {};
    for (const p of node.properties) {
      if (p.type !== 'Property' || p.computed) continue;
      out[p.key.type === 'Identifier' ? p.key.name : p.key.value] = literal(p.value);
    }
    return out;
  }
  return undefined;
}

/** What one module imports (as paths under src/), and its exported meta and act, from the source alone. */
function readModule(rel, text) {
  const tree = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const imports = [];
  let meta = null, act = false;
  for (const node of tree.body) {
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) && node.source) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(rel), node.source.value));
      if (!imports.includes(to)) imports.push(to);
    }
    if (node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'VariableDeclaration') continue;
    for (const d of node.declaration.declarations) {
      // The transitions build theirs with screenMeta({ ... }) from their _lib.js: a whole 320 x 180 screen, one-shot.
      if (d.id.name === 'meta' && d.init?.type === 'CallExpression' && d.init.callee.name === 'screenMeta') {
        const own = literal(d.init.arguments[0]) || {};
        meta = { ...own, tags: ['transition', 'screen', ...(own.tags || []), 'one-shot'], size: [320, 180], origin: [0, 0], loop: false, options: { color: '#0b0a10', ...own.options } };
      } else if (d.id.name === 'meta') meta = literal(d.init);
      if (d.id.name === 'act') act = true;
    }
  }
  return { imports, meta, act };
}

/** The category names, in gallery order, from src/fx/categories.js. */
function readCategories(text) {
  const tree = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  for (const node of tree.body) {
    const d = node.declaration?.declarations?.find((x) => x.id.name === 'categories');
    if (d) return literal(d.init) || [];
  }
  return [];
}

const round = (v) => Math.round(Number(v) * 100) / 100;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dir = args[0];
if (!dir || !fs.existsSync(path.join(dir, '.git'))) {
  console.error('Usage: node scripts/pixelfx-index.mjs <pixelfx checkout> [commit] [--write]');
  process.exit(1);
}
const commit = git(dir, ['rev-parse', args[1] || 'HEAD'], { encoding: 'utf8' }).trim();
const read = (file) => git(dir, ['show', `${commit}:${file}`]);
const listed = git(dir, ['ls-tree', '-r', '--name-only', commit, 'src'], { encoding: 'utf8' }).split('\n').filter(Boolean);
// The core, every effect and each category's helpers; the two lists of everything (fx/index.js, fx/categories.js) are left out.
const wanted = listed.filter((f) => /^src\/(core\/[a-z0-9-]+|fx\/[a-z0-9-]+\/_?[a-z0-9-]+)\.js$/.test(f)).map((f) => f.slice('src/'.length));
const categories = readCategories(read('src/fx/categories.js').toString('utf8'));

const files = {}, effects = [];
for (const rel of wanted) {
  const bytes = read(`src/${rel}`);
  const mod = readModule(rel, bytes.toString('utf8'));
  files[rel] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, imports: mod.imports };
  const name = path.posix.basename(rel, '.js');
  if (!rel.startsWith('fx/') || name.startsWith('_')) continue;
  const meta = mod.meta || {};
  if (!meta.name) { console.warn(`skipped ${rel}: no meta it can read`); continue; }
  const category = rel.split('/')[1];
  effects.push({
    id: rel.slice('fx/'.length, -'.js'.length),
    name: String(meta.name),
    category: categories.find((c) => c.id === category)?.name || category,
    about: String(meta.desc || '').replace(/\s+/g, ' ').trim(),
    tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
    duration: round(meta.duration ?? 1),
    loop: !!meta.loop,
    size: Array.isArray(meta.size) ? meta.size : null,
    origin: Array.isArray(meta.origin) ? meta.origin : null,
    actor: !!meta.actor,
    act: mod.act,
    options: Object.keys(meta.options || {}).filter((k) => k !== 'seed'),
  });
}
// Every import must be in the index, or a game would get a file that cannot load.
for (const [rel, f] of Object.entries(files)) for (const to of f.imports) if (!files[to]) throw new Error(`${rel} imports ${to}, which is not indexed`);

const total = Object.values(files).reduce((s, f) => s + f.bytes, 0);
console.log(`${REPO} at ${commit}: ${effects.length} effects, ${Object.keys(files).length} files, ${(total / 1024).toFixed(0)} KB`);
for (const e of effects.slice(0, 5)) console.log(`    ${e.id}: ${e.name} (${e.loop ? 'loop' : `${e.duration}s`}) ${e.tags.join(' ')}`);
if (!effects.length) process.exit(1);
if (process.argv.includes('--write')) {
  fs.writeFileSync(INDEX_FILE, `${JSON.stringify({ licence: 'MIT', repo: REPO, commit, effects, files }, null, 1)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), INDEX_FILE)}`);
}
