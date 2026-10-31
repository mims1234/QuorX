// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Design systems: a DESIGN.md (the look in words: colours with roles, type, spacing, components) and a tokens.css
// (the same values as CSS custom properties). Starters live in design-systems/<id>/. A project uses one by having
// DESIGN.md, and usually tokens.css, in its folder root: every chat in it reads DESIGN.md, the design lint checks
// colours against tokens.css, and the reviewer scores brand fit against it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, HOME } from './openrouter.js';
import { safePath, trashFile } from './workspace.js';

const DIR = path.join(ROOT, 'design-systems');
const FILES = ['DESIGN.md', 'tokens.css'];
const validId = (id) => /^[a-z0-9-]{1,40}$/.test(String(id || ''));

function frontMatter(md) {
  const m = String(md).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^(\w+):\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].trim(); }
  return { meta, body: m ? md.slice(m[0].length) : md };
}

const hex6 = (h) => { const x = h.toLowerCase().replace('#', ''); return `#${x.length === 3 || x.length === 4 ? x.slice(0, 3).split('').map((c) => c + c).join('') : x.slice(0, 6)}`; };
/** The colours a tokens file defines, as lowercase #rrggbb. Only custom-property definitions count. */
export function tokenColors(css) {
  const out = new Set();
  for (const m of String(css || '').matchAll(/--[\w-]+\s*:\s*([^;}]*)/g)) for (const h of m[1].match(/#[0-9a-f]{3,8}\b/gi) || []) out.add(hex6(h));
  return out;
}
/** First value of each custom property in the first :root block (the light, or only, theme). */
function rootTokens(css) {
  const first = String(css || '').match(/:root\s*\{([^}]*)\}/)?.[1] || '';
  return Object.fromEntries([...first.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const family = (stack) => String(stack || '').split(',')[0].replace(/["']/g, '').trim();

// ---------- specs: a design system as plain values (colours, fonts, sizes), from which DESIGN.md and tokens.css are made ----------
// The hand-written starters (design-systems/<id>/) are read back into a spec so they can be duplicated and edited; the
// catalogue (design-systems/catalog.json) and the user's own systems (data/design-systems/<id>.json) are specs.
export const COLOR_KEYS = ['bg', 'surface', 'surface-2', 'fg', 'muted', 'line', 'accent', 'accent-ink', 'accent-2', 'ok', 'warn', 'bad', 'focus'];
export const FAMILIES = ['minimal', 'corporate', 'editorial', 'playful', 'brutalist', 'glass', 'neon', 'retro', 'material', 'swiss', 'organic', 'luxury', 'pastel', 'terminal', 'data', 'accessible'];
// Fonts the editor offers: the fallback stack after each, and the Google Fonts weights to load (null: a system font).
export const FONTS = {
  'Inter': ['system-ui, "Segoe UI", sans-serif', 'wght@400;500;600;700'],
  'Source Sans 3': ['"Segoe UI", system-ui, sans-serif', 'wght@400;600;700'],
  'IBM Plex Sans': ['"Segoe UI", system-ui, sans-serif', 'wght@400;500;600'],
  'IBM Plex Sans Condensed': ['"Arial Narrow", system-ui, sans-serif', 'wght@600;700'],
  'Public Sans': ['"Helvetica Neue", Arial, sans-serif', 'wght@400;500;600;700'],
  'Work Sans': ['"Segoe UI", system-ui, sans-serif', 'wght@400;500;600;700'],
  'DM Sans': ['"Segoe UI", system-ui, sans-serif', 'wght@400;500;700'],
  'Manrope': ['"Segoe UI", system-ui, sans-serif', 'wght@400;600;800'],
  'Nunito Sans': ['"Segoe UI", system-ui, sans-serif', 'wght@400;600;700'],
  'Nunito': ['"Trebuchet MS", system-ui, sans-serif', 'wght@400;700;800'],
  'Barlow': ['"Segoe UI", system-ui, sans-serif', 'wght@400;500;600'],
  'Barlow Semi Condensed': ['"Arial Narrow", system-ui, sans-serif', 'wght@600;700'],
  'Roboto': ['"Segoe UI", Arial, sans-serif', 'wght@400;500;700'],
  'Roboto Flex': ['"Segoe UI", Arial, sans-serif', 'wght@400;500;700'],
  'Archivo': ['"Helvetica Neue", Arial, sans-serif', 'wght@500;700;900'],
  'Archivo Black': ['"Arial Black", Arial, sans-serif', 'wght@400'],
  'Space Grotesk': ['"Segoe UI", system-ui, sans-serif', 'wght@400;500;700'],
  'Bricolage Grotesque': ['"Arial Black", system-ui, sans-serif', 'wght@500;700;800'],
  'Syne': ['"Arial Black", system-ui, sans-serif', 'wght@600;700;800'],
  'Baloo 2': ['"Trebuchet MS", system-ui, sans-serif', 'wght@600;700;800'],
  'Fredoka': ['"Trebuchet MS", system-ui, sans-serif', 'wght@400;500;600;700'],
  'Lexend': ['"Segoe UI", system-ui, sans-serif', 'wght@400;500;700'],
  'Atkinson Hyperlegible': ['Verdana, "Segoe UI", sans-serif', 'wght@400;700'],
  'Outfit': ['"Segoe UI", system-ui, sans-serif', 'wght@400;500;700'],
  'Unbounded': ['"Arial Black", system-ui, sans-serif', 'wght@500;700'],
  'Press Start 2P': ['"Courier New", monospace', 'wght@400'],
  'VT323': ['"Courier New", monospace', 'wght@400'],
  'Fraunces': ['Georgia, "Times New Roman", serif', 'wght@500;700'],
  'Playfair Display': ['Georgia, "Times New Roman", serif', 'wght@500;700'],
  'Cormorant Garamond': ['Garamond, Georgia, serif', 'wght@500;600;700'],
  'Libre Baskerville': ['Baskerville, Georgia, serif', 'wght@400;700'],
  'Lora': ['Georgia, serif', 'wght@400;600;700'],
  'Newsreader': ['Georgia, serif', 'wght@400;600;700'],
  'Source Serif 4': ['Georgia, serif', 'wght@400;600;700'],
  'DM Serif Display': ['Georgia, serif', 'wght@400'],
  'Caveat': ['"Segoe Print", cursive', 'wght@500;700'],
  'Patrick Hand': ['"Segoe Print", cursive', 'wght@400'],
  'JetBrains Mono': ['ui-monospace, Consolas, monospace', 'wght@400;500;700'],
  'IBM Plex Mono': ['ui-monospace, Consolas, monospace', 'wght@400;500'],
  'Space Mono': ['ui-monospace, Consolas, monospace', 'wght@400;700'],
  'Georgia': ['"Times New Roman", serif', null],
  'Segoe UI': ['system-ui, sans-serif', null],
  'system-ui': ['"Segoe UI", sans-serif', null],
  'ui-monospace': ['"Cascadia Code", Consolas, monospace', null],
};
const SHADOWS = {
  none: ['none', 'none'],
  soft: ['0 1px 2px rgba(0, 0, 0, 0.06), 0 6px 18px rgba(0, 0, 0, 0.06)', '0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.25)'],
  strong: ['0 2px 4px rgba(0, 0, 0, 0.08), 0 16px 40px rgba(0, 0, 0, 0.14)', '0 2px 4px rgba(0, 0, 0, 0.4), 0 16px 40px rgba(0, 0, 0, 0.45)'],
  hard: ['4px 4px 0 #000000', '4px 4px 0 #000000'],
};

const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ''));
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
/** WCAG contrast ratio of two #rrggbb colours. */
export const contrast = (a, b) => { if (!isHex(a) || !isHex(b)) return 0; const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** The readability checks the editor shows (and the starters must pass): text, muted text and text on the accent. */
export function contrastChecks(colors) {
  if (!colors) return [];
  const c = colors;
  return [
    { id: 'fg', label: 'Text on the background', ratio: contrast(c.fg, c.bg), need: 7 },
    { id: 'muted', label: 'Muted text on the background', ratio: Math.min(contrast(c.muted, c.bg), contrast(c.muted, c.surface)), need: 4.5 },
    { id: 'accent', label: 'Text on the accent', ratio: contrast(c['accent-ink'], c.accent), need: 4.5 },
  ].map((x) => ({ ...x, ratio: Math.round(x.ratio * 100) / 100, ok: x.ratio >= x.need }));
}

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const clip = (s, n) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);
const fontName = (f, d) => { const n = clip(f, 60).replace(/["';{}<>]/g, ''); return n || d; };
function cleanColors(c, base) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  for (const k of COLOR_KEYS) out[k] = isHex(c[k]) ? c[k].toLowerCase() : (base?.[k] || '#808080');
  return out;
}
/** A spec from anywhere (the catalogue, the editor, a file) made safe and complete. */
export function cleanSpec(s = {}) {
  const dark = ['no', 'yes', 'only'].includes(s.dark) ? s.dark : 'no';
  const base = cleanColors(s.colors?.base, null) || cleanColors({}, null);
  const shadow = Object.hasOwn(SHADOWS, s.shadow) ? s.shadow : 'soft';
  return {
    name: clip(s.name, 60) || 'Untitled design system',
    description: clip(s.description, 300),
    family: FAMILIES.includes(s.family) ? s.family : 'minimal',
    dark,
    colors: { base, dark: dark === 'yes' ? (cleanColors(s.colors?.dark, base) || base) : null },
    fonts: { display: fontName(s.fonts?.display, 'Inter'), body: fontName(s.fonts?.body, 'Inter'), mono: fontName(s.fonts?.mono, 'JetBrains Mono') },
    type: { base: num(s.type?.base, 12, 22, 16), ratio: num(s.type?.ratio, 1.067, 1.618, 1.25), displayWeight: num(s.type?.displayWeight, 300, 900, 700), case: s.type?.case === 'upper' ? 'upper' : 'normal' },
    radius: num(s.radius, 0, 40, 10), radiusSm: num(s.radiusSm, 0, 24, 6),
    space: num(s.space, 2, 12, 8), maxWidth: num(s.maxWidth, 640, 1600, 1120),
    shadow, border: num(s.border, 0, 4, 1),
    look: clip(s.look, 900), dos: (Array.isArray(s.dos) ? s.dos : []).slice(0, 6).map((x) => clip(x, 200)).filter(Boolean), donts: (Array.isArray(s.donts) ? s.donts : []).slice(0, 6).map((x) => clip(x, 200)).filter(Boolean),
  };
}

const stack = (f) => `"${f}", ${(FONTS[f] || ['system-ui, sans-serif'])[0]}`;
const rem = (px) => `${Math.round((px / 16) * 1000) / 1000}rem`;
const scale = (s) => { const b = s.type.base, r = s.type.ratio; return { sm: b * 0.875, base: b, lg: b * r, xl: b * r ** 2, '2xl': b * r ** 3, '3xl': b * r ** 4 }; };
const spaces = (s) => [0.5, 1, 2, 3, 5, 9].map((m) => Math.round(s.space * m));

/** tokens.css for a spec: the colours, fonts, type scale, spacing, shape and shadow as custom properties. */
export function specTokens(s0) {
  const s = cleanSpec(s0);
  const g = [...new Set([s.fonts.display, s.fonts.body, s.fonts.mono])].filter((f) => FONTS[f]?.[1]).map((f) => `family=${f.replace(/ /g, '+')}:${FONTS[f][1]}`);
  const colors = (c) => COLOR_KEYS.map((k) => `    --${k}: ${c[k]};`).join('\n');
  const sc = scale(s), sp = spaces(s);
  const [shL, shD] = SHADOWS[s.shadow];
  return `/* ${s.name} tokens. Link this file first (<link rel="stylesheet" href="tokens.css">) and use var() everywhere. */
${g.length ? `@import url("https://fonts.googleapis.com/css2?${g.join('&')}&display=swap");\n` : ''}
:root {
  /* colour */
${colors(s.colors.base).replace(/^ {2}/gm, '')}
  /* type */
  --font-display: ${stack(s.fonts.display)};
  --font-body: ${stack(s.fonts.body)};
  --font-mono: ${stack(s.fonts.mono)};
${Object.entries(sc).map(([k, v]) => `  --text-${k}: ${rem(v)};`).join('\n')}
  --leading: ${s.type.base >= 17 ? 1.55 : 1.6};
  --display-weight: ${s.type.displayWeight};
  /* space and shape */
${sp.map((v, i) => `  --space-${i + 1}: ${v}px;`).join('\n')}
  --radius: ${s.radius}px;
  --radius-sm: ${s.radiusSm}px;
  --border: ${s.border}px;
  --shadow: ${s.dark === 'only' ? shD : shL};
  --max: ${s.maxWidth}px;
}
${s.colors.dark ? `
@media (prefers-color-scheme: dark) {
  :root {
${colors(s.colors.dark)}
    --shadow: ${shD};
  }
}
` : ''}`;
}

const SHADOW_WORDS = { none: 'No shadows: depth comes from borders and surface colour.', soft: 'One soft shadow (`--shadow`) for raised cards and menus only.', strong: 'A strong, lifted shadow (`--shadow`) for cards and dialogs.', hard: 'A hard offset shadow (`--shadow`, no blur) on buttons and cards: a printed, stamped look.' };
/** DESIGN.md for a spec: the same look in words, which every chat in the project reads. */
export function specMarkdown(s0, id) {
  const s = cleanSpec(s0);
  const b = s.colors.base, d = s.colors.dark;
  const role = { bg: 'Page background', surface: 'Cards, panels, inputs', 'surface-2': 'Bands, hover, table stripes', fg: 'Body text and headings', muted: 'Secondary text, captions', line: 'Borders and dividers', accent: 'The main action, plus at most one highlight per screen', 'accent-ink': 'Text on the accent', 'accent-2': 'Links and secondary emphasis', ok: 'Success, always with a word or icon', warn: 'Warnings, always with a word or icon', bad: 'Errors, always with a word or icon', focus: 'Focus ring' };
  const sc = scale(s), sp = spaces(s);
  return `---
name: ${s.name}
description: ${s.description}
dark: ${s.dark}
family: ${s.family}${id ? `\nid: ${id}` : ''}
---

# ${s.name}

## Look
${s.look || s.description || 'A clear, consistent look built from the tokens below.'}

## Colours
All colours live in \`tokens.css\` as custom properties. Use \`var()\`; never write hex values into rules.

| Token | ${s.dark === 'only' ? 'Value' : d ? 'Light | Dark' : 'Value'} | Use |
|---|---|${d ? '---|' : ''}---|
${COLOR_KEYS.map((k) => `| \`--${k}\` | ${b[k]}${d ? ` | ${d[k]}` : ''} | ${role[k]} |`).join('\n')}
${s.dark === 'only' ? '\nThis look is dark only: keep it dark whatever the visitor\'s setting.\n' : d ? '\nThe dark values switch on with `prefers-color-scheme: dark`; tokens.css does it, so pages need nothing extra.\n' : '\nLight only.\n'}
## Type
- Display: ${s.fonts.display} at ${s.type.displayWeight} for h1-h2 (\`--font-display\`, weight \`--display-weight\`)${s.type.case === 'upper' ? ', set in capitals with 0.04em letter-spacing' : ''}, \`text-wrap: balance\`.
- Body: ${s.fonts.body} (\`--font-body\`), ${s.type.base}px at line-height 1.6, lines about 65 characters.
- Mono: ${s.fonts.mono} (\`--font-mono\`) for code, numbers in tables and small labels.
- Scale (ratio ${s.type.ratio}): ${Object.entries(sc).map(([k, v]) => `\`--text-${k}\` ${Math.round(v)}`).join(' · ')}.

## Spacing and shape
- Spacing steps: ${sp.join(', ')} px (\`--space-1\` to \`--space-6\`). Sections are separated by \`--space-6\`.
- Radius ${s.radius}px for cards and buttons (\`--radius\`), ${s.radiusSm}px for inputs and tags (\`--radius-sm\`). Borders are ${s.border}px (\`--border\`).
- ${SHADOW_WORDS[s.shadow]}
- Content width up to ${s.maxWidth}px (\`--max\`), 16px side gutter on phones.

## Components
- **Primary button:** \`--accent\` fill, \`--accent-ink\` text, 600 weight, radius \`--radius\`. One per section.
- **Secondary button:** transparent with a \`--border\` \`--line\` border, text in \`--fg\`.
- **Links:** \`--accent-2\`, underlined on hover.
- **Cards:** \`--surface\`, \`--border\` \`--line\` border, radius \`--radius\`, padding \`--space-4\`.
- **Inputs:** \`--surface\`, \`--border\` \`--line\` border, radius \`--radius-sm\`, a visible 2px \`--focus\` ring on \`:focus-visible\`.
- **Tags:** \`--surface-2\` fill, \`--muted\` text, radius \`--radius-sm\`, \`--text-sm\`.

## Do and don't
${[...s.dos.map((x) => `- Do ${x.replace(/^do\s+/i, '')}`), ...s.donts.map((x) => `- Don't ${x.replace(/^don'?t\s+/i, '')}`)].join('\n') || '- Do keep the accent rare: if three things use it, nothing stands out.\n- Don\'t write colours, fonts or sizes by hand: use the tokens.'}
`;
}

/** A hand-written starter's tokens.css read back into a spec, so it can be duplicated into the editor. */
function specFromFiles(md, css) {
  const { meta } = frontMatter(md);
  const blocks = String(css || '').split('@media');
  const t = rootTokens(css), dk = blocks[1] ? Object.fromEntries([...blocks[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])) : null;
  const pick = (o) => Object.fromEntries(COLOR_KEYS.map((k) => [k, isHex(o?.[k]) ? o[k] : undefined]));
  const px = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  const sh = String(t.shadow || '');
  return cleanSpec({
    name: meta.name, description: meta.description, family: meta.family, dark: meta.dark,
    colors: { base: pick(t), dark: dk ? { ...pick(t), ...Object.fromEntries(Object.entries(pick(dk)).filter(([, v]) => v)) } : null },
    fonts: { display: family(t['font-display']), body: family(t['font-body']), mono: family(t['font-mono']) || 'JetBrains Mono' },
    type: { base: 16, ratio: t['text-lg'] ? Math.round(px(t['text-lg'], 1.25) * 1000) / 1000 : 1.25 },
    radius: px(t.radius, 10), radiusSm: px(t['radius-sm'], 6), space: px(t['space-2'], 8), maxWidth: px(t.max, 1120),
    shadow: !sh || sh === 'none' ? 'none' : /\b0\s*(?:,|$|\))/.test(sh) && /\dpx \dpx 0 /.test(sh) ? 'hard' : 'soft',
    look: (md.match(/## Look\s*\n([\s\S]*?)\n## /)?.[1] || '').trim(),
  });
}

// ---------- where systems come from: hand-written starters, the catalogue, and the user's own ----------
const CUSTOM_DIR = () => path.join(HOME, 'data', 'design-systems');
const customFile = (id) => path.join(CUSTOM_DIR(), `${id}.json`);
const isCustom = (id) => /^custom-[a-z0-9-]{1,32}$/.test(String(id || ''));
let catalogCache = null;
function catalog() {
  if (catalogCache) return catalogCache;
  try { catalogCache = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8')).systems.filter((s) => validId(s.id)); } catch { catalogCache = []; }
  return catalogCache;
}
function readCustom(id) {
  if (!isCustom(id)) return null;
  try { const j = JSON.parse(fs.readFileSync(customFile(id), 'utf8')); return { ...cleanSpec(j.spec), createdAt: j.createdAt, updatedAt: j.updatedAt, from: j.from || null }; } catch { return null; }
}
function customIds() {
  try { return fs.readdirSync(CUSTOM_DIR()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter(isCustom); } catch { return []; }
}

/** A system's spec (any source), or null. */
export function designSpec(id) {
  if (isCustom(id)) return readCustom(id);
  if (!validId(id)) return null;
  const c = catalog().find((s) => s.id === id);
  if (c) return cleanSpec(c);
  if (!fs.existsSync(path.join(DIR, id, 'DESIGN.md'))) return null;
  const read = (f) => (fs.existsSync(path.join(DIR, id, f)) ? fs.readFileSync(path.join(DIR, id, f), 'utf8') : '');
  return specFromFiles(read('DESIGN.md'), read('tokens.css'));
}

const summary = (id, s, source, extra = {}) => ({
  id, source, name: s.name, description: s.description, family: s.family, dark: s.dark,
  swatches: ['bg', 'surface', 'fg', 'accent', 'accent-2'].map((k) => ({ token: k, value: s.colors.base[k] })),
  fonts: { display: s.fonts.display, body: s.fonts.body, mono: s.fonts.mono }, spec: s, checks: contrastChecks(s.colors.base), ...extra,
});
/** Every system a picker can show: the starters and catalogue (source "builtin") and the user's own ("custom"). */
export function listDesignSystems() {
  const out = [];
  if (fs.existsSync(DIR)) {
    for (const e of fs.readdirSync(DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || !validId(e.name) || !fs.existsSync(path.join(DIR, e.name, 'DESIGN.md'))) continue;
      out.push(summary(e.name, designSpec(e.name), 'builtin'));
    }
  }
  for (const c of catalog()) if (!out.some((x) => x.id === c.id)) out.push(summary(c.id, cleanSpec(c), 'builtin'));
  for (const id of customIds()) { const s = readCustom(id); if (s) out.push(summary(id, s, 'custom', { updatedAt: s.updatedAt, from: s.from })); }
  return out.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'custom' ? -1 : 1));
}

export function readDesignSystem(id) {
  if (!isCustom(id) && validId(id) && fs.existsSync(path.join(DIR, id, 'DESIGN.md'))) {
    const read = (f) => (fs.existsSync(path.join(DIR, id, f)) ? fs.readFileSync(path.join(DIR, id, f), 'utf8') : '');
    // The id goes into the front matter, so the project settings can tell which system a project uses.
    const md = read('DESIGN.md').replace(/^(---\s*\r?\n[\s\S]*?)(\r?\n---)/, (m, a, b) => (/^id:/m.test(a) ? m : `${a}\nid: ${id}${b}`));
    return { id, md, tokens: read('tokens.css'), spec: designSpec(id) };
  }
  const s = designSpec(id);
  return s ? { id, md: specMarkdown(s, id), tokens: specTokens(s), spec: s } : null;
}

/** Saves one of the user's own systems (a new id when none is given). Returns its summary. */
export function saveCustomSystem({ id, spec, from } = {}) {
  if (id != null && !isCustom(id)) throw new Error('only your own design systems can be changed: duplicate a built-in one first');
  const clean = cleanSpec(spec);
  const now = Date.now();
  const prev = id ? readCustom(id) : null;
  if (id && !prev) throw new Error('no such design system');
  if (!id) {
    const slug = clean.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'system';
    id = `custom-${slug}-${crypto.randomBytes(3).toString('hex')}`;
  }
  if (!prev && customIds().length >= 200) throw new Error('at most 200 design systems of your own');
  fs.mkdirSync(CUSTOM_DIR(), { recursive: true });
  fs.writeFileSync(customFile(id), JSON.stringify({ version: 1, spec: clean, from: prev?.from ?? (from && (validId(from) || isCustom(from)) ? from : null), createdAt: prev?.createdAt || now, updatedAt: now }, null, 2));
  return summary(id, clean, 'custom', { updatedAt: now });
}
export function deleteCustomSystem(id) {
  if (!isCustom(id)) throw new Error('built-in design systems can\'t be deleted');
  if (!fs.existsSync(customFile(id))) throw new Error('no such design system');
  fs.rmSync(customFile(id));
  return { deleted: id };
}

/** A project's own design system (its DESIGN.md and tokens.css), or null when it has none. */
export function projectDesign(root) {
  if (!root) return null;
  const read = (f) => { try { const p = safePath(root, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };
  const md = read('DESIGN.md'), tokens = read('tokens.css');
  if (!md.trim() && !tokens.trim()) return null;
  const { meta } = frontMatter(md);
  return { md, tokens, id: meta.id || null, name: meta.name || (md.match(/^#\s+(.+)$/m)?.[1] || '').trim() || 'Project design system', colors: tokenColors(tokens) };
}

/**
 * Copies a starter into a project's root. Existing DESIGN.md / tokens.css are kept unless `overwrite`, in which
 * case the old ones go to the project's .quorx/trash first, so nothing is lost.
 */
export function applyDesignSystem(root, id, { overwrite = false } = {}) {
  const sys = readDesignSystem(id);
  if (!sys) throw new Error(`no design system "${id}"`);
  const present = FILES.filter((f) => fs.existsSync(safePath(root, f)));
  if (present.length && !overwrite) return { applied: false, exists: present };
  const trashed = present.map((f) => trashFile(root, f));
  fs.writeFileSync(safePath(root, 'DESIGN.md'), sys.md);
  if (sys.tokens) fs.writeFileSync(safePath(root, 'tokens.css'), sys.tokens);
  return { applied: true, written: sys.tokens ? FILES : ['DESIGN.md'], trashed };
}

/** Saves an edited DESIGN.md (the old one goes to the trash), or removes the project's design files when md is null. */
export function saveProjectDesign(root, md) {
  const trashed = [];
  const p = safePath(root, 'DESIGN.md');
  if (fs.existsSync(p)) trashed.push(trashFile(root, 'DESIGN.md'));
  if (md == null) {
    if (fs.existsSync(safePath(root, 'tokens.css'))) trashed.push(trashFile(root, 'tokens.css'));
    return { removed: true, trashed };
  }
  fs.writeFileSync(p, String(md));
  return { saved: true, trashed };
}
