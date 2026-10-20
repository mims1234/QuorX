// Design systems: a DESIGN.md (the look in words: colours with roles, type, spacing, components) and a tokens.css
// (the same values as CSS custom properties). Starters live in design-systems/<id>/. A project uses one by having
// DESIGN.md, and usually tokens.css, in its folder root: every chat in it reads DESIGN.md, the design lint checks
// colours against tokens.css, and the reviewer scores brand fit against it.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './openrouter.js';
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

/** The starter systems, with what a picker needs to show them: name, description, swatches and fonts. */
export function listDesignSystems() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && validId(e.name) && fs.existsSync(path.join(DIR, e.name, 'DESIGN.md'))).map((e) => {
    const md = fs.readFileSync(path.join(DIR, e.name, 'DESIGN.md'), 'utf8');
    const css = fs.existsSync(path.join(DIR, e.name, 'tokens.css')) ? fs.readFileSync(path.join(DIR, e.name, 'tokens.css'), 'utf8') : '';
    const { meta } = frontMatter(md);
    const t = rootTokens(css);
    return {
      id: e.name, name: meta.name || e.name, description: meta.description || '', dark: meta.dark || 'no',
      swatches: ['bg', 'surface', 'fg', 'accent', 'accent-2'].filter((k) => t[k]).map((k) => ({ token: k, value: t[k] })),
      fonts: { display: family(t['font-display']), body: family(t['font-body']) },
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function readDesignSystem(id) {
  if (!validId(id) || !fs.existsSync(path.join(DIR, id, 'DESIGN.md'))) return null;
  const read = (f) => (fs.existsSync(path.join(DIR, id, f)) ? fs.readFileSync(path.join(DIR, id, f), 'utf8') : '');
  return { id, md: read('DESIGN.md'), tokens: read('tokens.css') };
}

/** A project's own design system (its DESIGN.md and tokens.css), or null when it has none. */
export function projectDesign(root) {
  if (!root) return null;
  const read = (f) => { try { const p = safePath(root, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };
  const md = read('DESIGN.md'), tokens = read('tokens.css');
  if (!md.trim() && !tokens.trim()) return null;
  const { meta } = frontMatter(md);
  return { md, tokens, name: meta.name || (md.match(/^#\s+(.+)$/m)?.[1] || '').trim() || 'Project design system', colors: tokenColors(tokens) };
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
