// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Generates the harness's own icon set (public/icons/*.svg) with an OpenRouter image model,
// one icon per emoji the UI uses. Run: node scripts/make-icons.mjs [slug ...] [--model id] [--force] [--clean]
// The key comes from .env (OPENROUTER_API_KEY or OPENROUTER_API_KEY_BOT). Existing icons are kept unless --force.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from '../public/icons/manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'icons');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
const KEY = process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY_BOT;
if (!KEY) throw new Error('No OpenRouter key in .env');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const MODEL = opt('--model', 'recraft/recraft-v4.1-vector');
const force = args.includes('--force') && args.splice(args.indexOf('--force'), 1);
const only = new Set(args);

// One visual language for the whole set: flat, rounded, slate outlines. Plain UI icons use the
// harness's cyan; icons whose meaning lives in colour (money, status, media…) bring their own `colors`.
const STYLE = 'Single app UI icon, flat vector, centered on a plain transparent background, no frame, no tile, no text, no letters. '
  + 'Bold simple silhouette that reads at 16 pixels; rounded corners; thick even outlines in deep slate #1b2a26; '
  + 'clean flat colour fills with a subtle lighter highlight on one side. Friendly, modern, consistent icon family.';
const BRAND = (tint) => `Colours: fills in teal-cyan #1fc8db${tint ? ` with ${tint} as the secondary tone` : ''}; at most three colours.`;

// Model SVGs come as a 2048² canvas, sometimes with a white backdrop and a C2PA metadata blob.
// Keep only the drawing, cropped square to its own bounds, so it fills a 16px slot.
function clean(svg) {
  let s = svg.replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
    .replace(/<path[^>]*d="M 0 0 L (\d+) 0 L \1 \1 L 0 \1 L 0 0 z"\/>/g, '')
    .replace(/ transform="translate\(0,0\)"/g, '');
  const nums = [...s.matchAll(/ d="([^"]+)"/g)].flatMap((m) => m[1].match(/-?\d+(\.\d+)?/g).map(Number));
  if (nums.length < 2) return s;
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const side = Math.max(x1 - x0, y1 - y0) * 1.04, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const vb = [cx - side / 2, cy - side / 2, side, side].map((n) => Math.round(n)).join(' ');
  return s.replace(/<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">`);
}
if (args.includes('--clean')) {
  for (const f of fs.readdirSync(OUT).filter((n) => n.endsWith('.svg'))) fs.writeFileSync(path.join(OUT, f), clean(fs.readFileSync(path.join(OUT, f), 'utf8')));
  console.log('cleaned'); process.exit(0);
}

const items = ICONS.filter((i) => !only.size || only.has(i.slug));
let spent = 0;
async function make(it) {
  const file = path.join(OUT, `${it.slug}.svg`);
  if (fs.existsSync(file) && !force) { console.log(`skip ${it.slug} (exists)`); return; }
  const prompt = `${STYLE} Subject: ${it.draw} ${it.colors ? `Colours: ${it.colors}.` : BRAND(it.tint)}`;
  const t = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'QuorX icons' },
    body: JSON.stringify({ model: MODEL, prompt, aspect_ratio: '1:1', output_format: 'svg' }),
  });
  const j = await r.json().catch(() => ({}));
  const d = j.data?.[0];
  if (!r.ok || !d?.b64_json) { console.log(`FAIL ${it.slug}: ${j.error?.message || r.status}`); return; }
  fs.writeFileSync(file, clean(Buffer.from(d.b64_json, 'base64').toString('utf8')));
  spent += j.usage?.cost || 0;
  console.log(`ok ${it.slug} ${d.media_type || ''} ${Date.now() - t}ms $${(j.usage?.cost || 0).toFixed(4)}`);
}
// four at a time: each call takes ~10 s
const queue = [...items];
await Promise.all([1, 2, 3, 4].map(async () => { while (queue.length) await make(queue.shift()); }));
console.log(`done · ${items.length} icons · $${spent.toFixed(4)}`);
