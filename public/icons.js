// Swaps the UI's emoji for the harness's own icons as the page renders, so app.js keeps writing plain emoji and
// every place they appear gets the same icon family. Chat text, thinking, code and form fields keep real emoji:
// only the harness's own chrome changes.
// - Things (files, money, media, keys…) are the coloured icons in public/icons/*.svg (manifest.js).
// - Actions and chrome (close, reload, copy, pane, menu…) are line icons in public/icons/line/*.svg, painted in the
//   button's own colour through a CSS mask, so they follow hover, disabled and the theme.
// - Colour-coded marks (🟢🟡🔴 ratings, 📘📕📙📗 document kinds) stay emoji: their colour is the meaning.
// Every icon-only button also gets a spoken name: its title, else the icon's name.
import { SLUG } from './icons/manifest.js';

const LINE = new Map(Object.entries({
  '✕': 'close', '↻': 'reload', '⟳': 'restart', '▶': 'play', '◧': 'pane', '↶': 'undo', '↩': 'rewind', '↗': 'external',
  '⬇': 'download', '⬆': 'upload', '◐': 'theme', '☰': 'menu', '✎': 'rename', '⧉': 'copy', '⑂': 'remix', '⇉': 'parallel',
  '🏠': 'home', '🖥': 'server', '🤖': 'agent', '🧪': 'test', '👤': 'user', '⏱': 'timer', '⏳': 'hourglass', 'ℹ': 'info',
  '📦': 'package', '🗺': 'map', '🧹': 'clean', '📚': 'books', '🔤': 'font', '✉': 'mail', '🤝': 'agree',
}));
// Spoken names for line icons whose file name isn't the word a person would use.
const SAY = { close: 'Close', reload: 'Reload', restart: 'Restart', play: 'Play', pane: 'Toggle the side pane', undo: 'Undo', rewind: 'Rewind',
  external: 'Open in a new tab', download: 'Download', upload: 'Update', theme: 'Theme', menu: 'Menu', rename: 'Rename', copy: 'Copy',
  remix: 'Remix', home: 'Home', server: 'Servers', agent: 'Agent', user: 'You', info: 'Info' };
const word = (slug) => SAY[slug] || slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

const SKIP = 'script,style,textarea,input,select,option,code,pre,title,[contenteditable],.msg .body,.think-body,.utext,.no-ico';
// Some symbols come with or without the emoji variation selector (U+FE0F); both forms match.
const keys = [...SLUG.keys(), ...[...LINE.keys()].flatMap((k) => [k + '️', k])];
const alts = [...new Set(keys)].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const ANY = new RegExp(alts, 'u');
const ALL = new RegExp(alts, 'gu');
const CONTROL = 'button,a[href],[role="button"],[role="tab"],[role="menuitem"]';

function iconFor(m) {
  const line = LINE.get(m.replace(/️/g, ''));
  if (line) {
    const s = document.createElement('span');
    s.className = 'ico ico-line';
    s.style.setProperty('--ico', `url("icons/line/${line}.svg")`);
    s.setAttribute('aria-hidden', 'true');
    s.dataset.name = word(line);
    return s;
  }
  const slug = SLUG.get(m);
  const img = document.createElement('img');
  img.className = 'ico';
  img.src = `icons/${slug}.svg`;
  img.alt = '';
  img.dataset.name = word(slug);
  img.draggable = false;
  return img;
}

// A control whose only content is icons gets an aria-label (its title, else the icons' names).
// Icons beside text stay silent, so a screen reader says "Delete", not "trash Delete".
function nameControl(el) {
  if (!el || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return;
  if (el.textContent.replace(/\s+/g, '').length) {
    // Visible text may still be a lone symbol we don't draw (×, ＋): then the title is the better name.
    if (el.title && !/[\p{L}\p{N}]/u.test(el.textContent)) el.setAttribute('aria-label', el.title);
    return;
  }
  const names = [...el.querySelectorAll('.ico[data-name]')].map((i) => i.dataset.name);
  const label = el.title || names.join(', ');
  if (label) el.setAttribute('aria-label', label);
}

function swap(node) {
  const t = node.nodeValue;
  if (!t || !ANY.test(t)) return;
  const p = node.parentElement;
  if (!p || p.closest(SKIP)) return;
  const frag = document.createDocumentFragment();
  // Beside words an icon is decoration; on its own (outside a named control) it says its name.
  const alone = !/[\p{L}\p{N}]/u.test(t.replace(ALL, ''));
  let last = 0;
  for (const m of t.matchAll(ALL)) {
    if (m.index > last) frag.append(t.slice(last, m.index));
    const ico = iconFor(m[0]);
    if (alone) { if (ico.tagName === 'IMG') ico.alt = ico.dataset.name; else { ico.removeAttribute('aria-hidden'); ico.setAttribute('role', 'img'); ico.setAttribute('aria-label', ico.dataset.name); } }
    frag.append(ico);
    last = m.index + m[0].length;
  }
  if (last < t.length) frag.append(t.slice(last));
  node.replaceWith(frag);
  nameControl(p.closest(CONTROL));
}

function walk(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found = [];
  while (w.nextNode()) if (ANY.test(w.currentNode.nodeValue)) found.push(w.currentNode);
  found.forEach(swap);
  // Icon-only controls that use inline SVG (app.js ICO / CMP_ICO) need names too.
  for (const el of (root.matches?.(CONTROL) ? [root] : [])) nameControl(el);
  for (const el of root.querySelectorAll?.(CONTROL) || []) if (el.querySelector('svg, .ico') && !el.hasAttribute('aria-label')) nameControl(el);
}

// Mutation callbacks run before the next paint, so the emoji never flash.
new MutationObserver((list) => {
  for (const r of list) {
    if (r.type === 'characterData') swap(r.target);
    else for (const n of r.addedNodes) n.nodeType === 3 ? swap(n) : n.nodeType === 1 && walk(n);
  }
}).observe(document.body, { childList: true, subtree: true, characterData: true });
walk(document.body);
