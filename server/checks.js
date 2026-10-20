// Checks on what the agent writes. ALMA can only parse files; this harness can run real tools, so a
// JS file is checked by Node itself (node --check, which handles both ES modules and CommonJS) and a
// Python file by Python. HTML gets its inline scripts parsed and its local links resolved.
// Nothing here runs the agent's code: --check and ast.parse only read it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';

const run = (cmd, args, ms = 10000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stderr || stdout || '') }));
});

// node --check prints "file:line", the line, a caret, a blank line, then "SyntaxError: …".
function nodeError(out, label) {
  const lines = out.split(/\r?\n/);
  const at = lines[0].match(/:(\d+)$/)?.[1];
  const msg = lines.find((l) => /^\w*Error:/.test(l)) || lines.find((l) => l.trim()) || 'syntax error';
  const code = lines[1]?.trim();
  return `${label}${at ? `:${at}` : ''}: ${msg.trim()}${code ? `\n    ${code.slice(0, 160)}` : ''}`;
}
async function checkJs(file, label) {
  const r = await run(process.execPath, ['--check', file]);
  return r.code === 0 ? [] : [nodeError(r.out, label)];
}

let python; // the first Python that answers, found once
async function findPython() {
  if (python !== undefined) return python;
  for (const exe of process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']) {
    const r = await run(exe, ['--version'], 4000);
    if (r.code === 0 && /Python 3/.test(r.out)) return (python = exe);
  }
  return (python = null);
}
async function checkPython(file, label) {
  const exe = await findPython();
  if (!exe) return [];
  const r = await run(exe, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read(), sys.argv[1])', file]);
  if (r.code === 0) return [];
  const line = r.out.match(/line (\d+)/)?.[1];
  const msg = r.out.trim().split(/\r?\n/).filter((l) => /Error/.test(l)).at(-1) || 'syntax error';
  return [`${label}${line ? `:${line}` : ''}: ${msg.trim()}`];
}

function checkCss(text, label) {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let depth = 0, line = 1;
  for (const ch of plain) {
    if (ch === '\n') line++;
    if (ch === '{') depth++;
    if (ch === '}' && --depth < 0) return [`${label}:${line}: an extra "}" closes a block that was never opened`];
  }
  return depth ? [`${label}: ${depth} "{" never closed (the file may be cut off)`] : [];
}

const LOCAL = (u) => u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{|\$)/i.test(u);
/** Problems in one HTML document: a cut-off ending, inline scripts that don't parse, missing local files. */
export async function checkHtml(html, { label = 'page', dir = null } = {}) {
  const out = [];
  if (/<html[\s>]/i.test(html) && !/<\/html>\s*$/i.test(html.trim())) out.push(`${label}: does not end with </html>; it may be cut off`);
  let n = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1], code = m[2];
    n++;
    if (/\bsrc\s*=/i.test(attrs) || !code.trim()) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] || '').toLowerCase();
    const where = `${label} (inline script ${n}, line ${html.slice(0, m.index).split('\n').length})`;
    if (type === 'importmap') { try { JSON.parse(code); } catch (e) { out.push(`${where}: the import map is not valid JSON: ${e.message}`); } continue; }
    if (type === 'module') {
      const tmp = path.join(os.tmpdir(), `quorx-check-${process.pid}-${Date.now()}-${n}.mjs`);
      try { fs.writeFileSync(tmp, code); out.push(...await checkJs(tmp, where)); }
      finally { fs.rmSync(tmp, { force: true }); }
      continue;
    }
    if (type && !/javascript|ecmascript|^text\/jsx?$/.test(type)) continue; // shaders, templates, babel…
    try { new vm.Script(code, { filename: where }); } catch (e) { out.push(`${where}: ${e.name}: ${e.message}`); }
  }
  if (dir) {
    const seen = new Set();
    for (const m of html.matchAll(/<(?:script|img|audio|video|source|link|iframe)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      const ref = m[1].split(/[?#]/)[0];
      if (!LOCAL(ref) || seen.has(ref)) continue;
      seen.add(ref);
      if (/^<link/i.test(m[0]) && !/rel\s*=\s*["']?(stylesheet|icon|manifest|modulepreload|preload)/i.test(m[0])) continue;
      let file; try { file = path.resolve(dir, decodeURIComponent(ref.replace(/^\//, ''))); } catch { continue; }
      if (!fs.existsSync(file)) out.push(`${label}: links to ${ref}, which does not exist`);
    }
  }
  return out;
}

/** Problems in one project file right after it was written (an empty list when it looks fine). */
export async function checkFile(root, rel) {
  const file = path.resolve(root, rel);
  if (!fs.existsSync(file) || fs.statSync(file).size > 2e6) return [];
  const ext = path.extname(file).toLowerCase();
  const label = String(rel).replaceAll('\\', '/');
  try {
    if (['.js', '.mjs', '.cjs'].includes(ext)) return await checkJs(file, label);
    if (ext === '.py') return await checkPython(file, label);
    const text = fs.readFileSync(file, 'utf8');
    if (ext === '.json') { try { JSON.parse(text); return []; } catch (e) { return [`${label}: not valid JSON: ${e.message}`]; } }
    if (ext === '.css') return checkCss(text, label);
    if (ext === '.html' || ext === '.htm') return await checkHtml(text, { label, dir: path.dirname(file) });
  } catch (e) { return [`${label}: could not be checked (${e.message})`]; }
  return [];
}

export const CHECKED = /\.(m?js|cjs|py|json|css|html?)$/i;

// ---------- design lint: patterns that make a page look machine-made ----------
// Advice, not errors: nothing here fails a check or sends a build back. "fix" rules are the clearest tells,
// "consider" ones are softer or about accessibility. Adapted from OpenDesign's lint-artifact and craft/anti-ai-slop.md
// (Apache-2.0), which adapted refero_skill (MIT). Each hit: { id, level: 'fix' | 'consider', msg }.
const INDIGO = ['#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#8b5cf6', '#7c3aed', '#a855f7'];
const TW_INDIGO = /\b(?:bg|text|border|from|via|to|ring|fill|stroke)-(?:indigo|violet|purple)-(?:500|600|700)\b/;
const NAMED = { purple: 270, violet: 270, indigo: 255, blue: 220, navy: 240, cyan: 185, aqua: 185, teal: 180, magenta: 300, fuchsia: 300, pink: 330, hotpink: 330, deeppink: 328, royalblue: 225, dodgerblue: 210, blueviolet: 271, mediumpurple: 260, slateblue: 248, darkviolet: 282, orchid: 302 };
const PLACEHOLDER_IMG = /(?:unsplash\.com|placehold\.co|placeholder\.com|placekitten\.com|picsum\.photos|dummyimage\.com|loremflickr\.com)/i;

// Hue (0-360) and saturation/lightness (0-1) of one CSS colour, or null when it isn't one we read.
function hsl(c) {
  c = c.trim().toLowerCase();
  if (NAMED[c] != null) return { h: NAMED[c], s: 0.8, l: 0.5 };
  let r, g, b;
  const hex = c.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const x = hex[1].length < 6 ? hex[1].slice(0, 3).split('').map((d) => d + d).join('') : hex[1].slice(0, 6);
    [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
  } else if (/^rgba?\(/.test(c)) {
    const n = c.match(/[\d.]+%?/g)?.slice(0, 3).map((v) => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / 255));
    if (!n || n.length < 3) return null;
    [r, g, b] = n;
  } else if (/^hsla?\(/.test(c)) {
    const n = c.match(/[\d.]+/g);
    return n && n.length >= 3 ? { h: +n[0] % 360, s: +n[1] / 100, l: +n[2] / 100 } : null;
  } else return null;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b[a-z]+\b/gi;
// A gradient whose stops all sit between cyan and pink, saturated, and actually change hue: the stock "AI" hero.
function trustGradient(css) {
  for (const m of css.matchAll(/linear-gradient\(((?:[^()]|\([^()]*\))*)\)/gi)) {
    const stops = (m[1].match(COLOR) || []).map(hsl).filter((x) => x && x.s >= 0.35 && x.l > 0.2 && x.l < 0.85);
    if (stops.length < 2 || !stops.every((x) => x.h >= 180 && x.h <= 335)) continue;
    const hs = stops.map((x) => x.h);
    if (Math.max(...hs) - Math.min(...hs) >= 25) return m[0].slice(0, 90);
  }
  return null;
}
// Emoji, minus the marks that are fine in UI text: © ® ™, arrows, geometric shapes (▶ ■), check marks and crosses.
const EMOJI = /\p{Extended_Pictographic}/gu;
const OK_MARK = /[©®™←-⇿■-◿✓-✗]/u;
const emojiIn = (s) => (s.match(EMOJI) || []).filter((ch) => !OK_MARK.test(ch));
const visibleText = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const INVENTED = [
  /\b\d+(?:\.\d+)?\s?[x×]\s+(?:faster|more|better|cheaper|quicker|productive|growth|roi)\b/i,
  /\b99\.9+\s?%\s*(?:uptime|availability|satisfaction|accuracy)/i,
  /\b\d{2,3}\s?%\s+(?:faster|more productive|increase|boost|growth|less time|of (?:users|customers|teams))/i,
  /\b(?:\d+(?:\.\d+)?[km]\+|\d{1,3}(?:,\d{3})+\+)\s+(?:happy\s+)?(?:users|customers|teams|developers|companies|downloads)\b/i,
];
const FILLER = /lorem ipsum|dolor sit amet|\bfeature (?:one|two|three|1|2|3)\b|placeholder text|sample content|your (?:tagline|company name|text) here|insert (?:text|content) here/i;

const hex6 = (h) => { const x = h.toLowerCase().replace('#', ''); return `#${x.length === 3 || x.length === 4 ? x.slice(0, 3).split('').map((c) => c + c).join('') : x.slice(0, 6)}`; };

/** Design lint for CSS (a .css file, or the styles of a page). `tokens`: the project's palette (a Set of #rrggbb), if it has one. */
export function lintCss(css, { tokens = null } = {}) {
  const out = [];
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const indigo = INDIGO.filter((h) => plain.toLowerCase().includes(h));
  if (indigo.length) out.push({ id: 'default-indigo', level: 'fix', msg: `uses Tailwind's default indigo/violet (${indigo.join(', ')}), the best-known sign of AI-made design. Pick an accent that fits the subject (or the project's design system).` });
  const grad = trustGradient(plain);
  if (grad) out.push({ id: 'trust-gradient', level: 'fix', msg: `a purple/blue/cyan gradient (${grad}…) is the stock AI hero background. A flat surface with deliberate type usually reads better.` });
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const d = m[2];
    const radius = d.match(/border-radius\s*:\s*([^;]+)/i)?.[1];
    if (/border-left(?:-width)?\s*:\s*[^;]*\b[2-8]px/i.test(d) && radius && !/^\s*0(?:px|%)?\s*$/.test(radius)) {
      out.push({ id: 'left-accent-card', level: 'fix', msg: `"${m[1].trim().slice(0, 50)}" is a rounded card with a coloured left border, the stock AI dashboard tile. Drop the radius or the border.` });
      break;
    }
  }
  // Colours written straight into rules instead of tokens (custom-property definitions are the tokens, so they don't count).
  const raw = new Set((plain.replace(/--[\w-]+\s*:[^;}]*/g, '').match(/#[0-9a-f]{3,8}\b/gi) || []).map((x) => x.toLowerCase()));
  if (raw.size > 12) out.push({ id: 'raw-hex', level: 'consider', msg: `${raw.size} different hex colours are used directly. Put the palette in :root tokens (--bg, --fg, --accent…) and use var().` });
  // With a project design system: colours that are not in its tokens.css (custom properties a page defines itself count too).
  if (tokens?.size) {
    const own = new Set([...(plain.match(/--[\w-]+\s*:[^;}]*/g) || []).flatMap((d) => d.match(/#[0-9a-f]{3,8}\b/gi) || [])].map(hex6));
    const off = [...new Set([...plain.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => hex6(m[0])))].filter((h) => !tokens.has(h) && !own.has(h));
    if (off.length) out.push({ id: 'off-palette', level: 'consider', msg: `${off.length} colour${off.length > 1 ? 's are' : ' is'} not in the project's tokens.css (${off.slice(0, 5).join(', ')}${off.length > 5 ? '…' : ''}). Use its var(--…) tokens instead, or add the colour to tokens.css and DESIGN.md if the design really needs it.` });
  }
  if (/outline\s*:\s*(?:none|0)\b/i.test(plain) && !/:focus(?:-visible|-within)?[^{]*\{[^}]*(?:outline|box-shadow|border)/i.test(plain)) out.push({ id: 'focus-removed', level: 'consider', msg: 'removes the focus outline with no :focus-visible style in its place, so keyboard users can\'t see where they are.' });
  if (PLACEHOLDER_IMG.test(plain)) out.push({ id: 'placeholder-images', level: 'consider', msg: 'loads pictures from a placeholder image site; they break offline and look generic. Use a CSS or SVG placeholder, or make a picture if the user wants one.' });
  return out;
}

/** Design lint for one HTML page: its styles, its markup and its visible text. */
export function lintHtml(html, opts = {}) {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
    + '\n' + [...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => `x{${m[1]}}`).join('\n');
  const out = lintCss(css, opts);
  const has = (id) => out.some((x) => x.id === id);
  if (!has('default-indigo') && TW_INDIGO.test(html)) out.unshift({ id: 'default-indigo', level: 'fix', msg: `uses Tailwind's default indigo/violet classes (${html.match(TW_INDIGO)[0]}), the best-known sign of AI-made design. Pick an accent that fits the subject.` });
  if (!has('trust-gradient')) {
    const tw = html.match(/\bfrom-(purple|violet|indigo|blue|fuchsia|pink|cyan|sky)-\d{3}\b[^"']*?\bto-(purple|violet|indigo|blue|fuchsia|pink|cyan|sky)-\d{3}\b/);
    if (tw && tw[1] !== tw[2]) out.push({ id: 'trust-gradient', level: 'fix', msg: `a ${tw[1]}-to-${tw[2]} gradient is the stock AI hero background. A flat surface with deliberate type usually reads better.` });
  }
  if (!has('left-accent-card') && /class\s*=\s*["'][^"']*\bborder-l-[2-8]\b[^"']*\brounded|class\s*=\s*["'][^"']*\brounded[^"']*\bborder-l-[2-8]\b/.test(html)) out.push({ id: 'left-accent-card', level: 'fix', msg: 'rounded cards with a coloured left border (border-l-4 + rounded) are the stock AI dashboard tile. Drop the radius or the border.' });
  // Emoji standing in for icons: inside headings, buttons, list items and anything classed as an icon.
  const spots = [];
  for (const m of html.matchAll(/<(h[1-6]|button|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) spots.push(...emojiIn(m[2].replace(/<[^>]+>/g, '')));
  for (const m of html.matchAll(/class\s*=\s*["'][^"']*icon[^"']*["'][^>]*>([^<]{0,12})</gi)) spots.push(...emojiIn(m[1]));
  if (spots.length) out.push({ id: 'emoji-icons', level: 'consider', msg: `emoji used as icons in headings, buttons or lists (${[...new Set(spots)].slice(0, 5).join(' ')}). Simple line SVG icons in currentColor look more deliberate, unless the user wants emoji.` });
  const text = visibleText(html);
  const claim = INVENTED.map((re) => text.match(re)?.[0]).find(Boolean);
  if (claim) out.push({ id: 'invented-metric', level: 'fix', msg: `"${claim}" reads like an invented number. Use a real figure the user gave you, or mark it clearly as an example.` });
  const filler = text.match(FILLER)?.[0];
  if (filler) out.push({ id: 'filler-copy', level: 'fix', msg: `filler copy ("${filler}"). Write real words for this subject; an empty section is a layout problem, not a text one.` });
  if (!has('placeholder-images') && /<img\b[^>]*\bsrc\s*=\s*["'][^"']*/i.test(html) && [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi)].some((m) => PLACEHOLDER_IMG.test(m[1]))) out.push({ id: 'placeholder-images', level: 'consider', msg: 'loads pictures from a placeholder image site; they break offline and look generic. Use a CSS or SVG placeholder, or make a picture if the user wants one.' });
  const noAlt = (html.match(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi) || []).length;
  if (noAlt) out.push({ id: 'img-alt', level: 'consider', msg: `${noAlt} <img> without alt text (use alt="" for decoration).` });
  if (/<head[\s>]/i.test(html) && !/<meta[^>]+name\s*=\s*["']?viewport/i.test(html)) out.push({ id: 'no-viewport', level: 'consider', msg: 'has no <meta name="viewport">, so phones show it zoomed out.' });
  return out;
}

export const LINTED = /\.(html?|css)$/i;
/** The colours a project's tokens.css defines (its design system), or null when it has none. */
export function projectPalette(root) {
  try {
    const p = path.join(root, 'tokens.css');
    if (!fs.existsSync(p)) return null;
    const set = new Set((fs.readFileSync(p, 'utf8').match(/--[\w-]+\s*:[^;}]*/g) || []).flatMap((d) => d.match(/#[0-9a-f]{3,8}\b/gi) || []).map(hex6));
    return set.size ? set : null;
  } catch { return null; }
}
/** Design lint for one project file (HTML or CSS); an empty list for anything else or anything unreadable. */
export function lintFile(root, rel) {
  const file = path.resolve(root, rel);
  if (!LINTED.test(file)) return [];
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size > 2e6) return [];
    const text = fs.readFileSync(file, 'utf8');
    // tokens.css itself is the palette; everything else is checked against it.
    const tokens = path.relative(root, file).replaceAll('\\', '/') === 'tokens.css' ? null : projectPalette(root);
    return /\.css$/i.test(file) ? lintCss(text, { tokens }) : lintHtml(text, { tokens });
  } catch { return []; }
}
