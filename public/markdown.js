// Markdown for chat messages, with no dependencies (KaTeX loads from a CDN only when a message has math).
// Supports: headings, paragraphs (single newlines kept), bold/italic/strike, inline code, links,
// autolinks, images, block quotes, ordered/unordered/task lists (nested by indentation), tables
// with alignment, horizontal rules, fenced code with syntax colours and a Copy button, and math:
// $…$ / \(…\) inline, $$…$$ / \[…\] blocks.
import { highlight, langOf, LANG_NAME } from './code.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LANG_ALIAS = { js: 'js', javascript: 'js', ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js', mjs: 'js', node: 'js', json: 'json', html: 'html', xml: 'html', svg: 'html', vue: 'html', css: 'css', scss: 'css', py: 'py', python: 'py', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', powershell: 'sh', ps1: 'sh', cmd: 'sh', md: 'md', markdown: 'md' };
const safeUrl = (u, img = false) => (/^(https?:|mailto:)/i.test(u) || (img && /^data:image\//i.test(u)) ? u : '');

// ---------- inline ----------
// Code spans and math are cut out first (as placeholders) so their contents are never formatted.
function inline(src, keep) {
  let s = String(src);
  const hold = (html) => { keep.push(html); return `\u0000${keep.length - 1}\u0000`; };
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(`<code class="md-ic">${esc(code.trim())}</code>`));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => hold(`<span class="md-math" data-tex="${esc(tex)}">${esc(tex)}</span>`));
  // $…$ only when it looks like math: no space just inside, and no digit right after the closing $ (so "$5 and $10" stays text)
  s = s.replace(/(^|[^\\$\w])\$(?![\s\d$])([^$\n]+?)(?<!\s)\$(?![\d$])/g, (_, pre, tex) => pre + hold(`<span class="md-math" data-tex="${esc(tex)}">${esc(tex)}</span>`));
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => { const u = safeUrl(url.replace(/&amp;/g, '&'), true); return u ? `<img class="md-img" src="${esc(u)}" alt="${alt}" loading="lazy">` : m; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => { const u = safeUrl(url.replace(/&amp;/g, '&')); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${text}</a>` : m; });
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>').replace(/==([^=\n]+?)==/g, '<mark>$1</mark>');
  return s;
}
const restore = (html, keep) => html.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);

// ---------- blocks ----------
function codeBlock(code, info) {
  const name = String(info || '').trim().split(/\s+/)[0].toLowerCase();
  const lang = LANG_ALIAS[name] || (name ? langOf(`x.${name}`) : 'text');
  const label = name || 'text';
  return `<div class="md-code"><div class="md-code-bar"><span class="md-code-lang">${esc(LANG_NAME[lang] && lang !== 'text' ? LANG_NAME[lang] : label)}</span><button type="button" class="md-copy" data-copy="code">Copy</button></div><pre><code>${highlight(code.replace(/\n$/, ''), lang)}</code></pre></div>`;
}
function table(rows, keep) {
  const cells = (r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const head = cells(rows[0]), align = cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
  const td = (tag, c, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(c, keep)}</${tag}>`;
  return `<div class="md-table"><table><thead><tr>${head.map((c, i) => td('th', c, i)).join('')}</tr></thead><tbody>${rows.slice(2).map((r) => `<tr>${cells(r).map((c, i) => td('td', c, i)).join('')}</tr>`).join('')}</tbody></table></div>`;
}
// Lists nest by indentation; "- [ ]" / "- [x]" become task items.
function list(lines, keep) {
  const items = [];
  for (const l of lines) {
    const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
    else if (items.length) items[items.length - 1].text += '\n' + l.trim();
  }
  const build = (from, indent) => {
    let html = '', i = from;
    const ordered = items[from].ordered, start = items[from].start;
    html += ordered ? `<ol${start > 1 ? ` start="${start}"` : ''}>` : '<ul>';
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) { const [sub, next] = build(i, items[i].indent); html = html.replace(/<\/li>$/, '') + sub + '</li>'; i = next; continue; }
      let t = items[i].text, task = '';
      const tm = t.match(/^\[([ xX])\]\s+(.*)$/s);
      if (tm) { task = `<span class="md-task ${tm[1] !== ' ' ? 'done' : ''}" aria-hidden="true">${tm[1] !== ' ' ? '✓' : ''}</span>`; t = tm[2]; }
      html += `<li${task ? ' class="md-task-item"' : ''}>${task}${inline(t, keep).replace(/\n/g, '<br>')}</li>`;
      i++;
    }
    return [html + (ordered ? '</ol>' : '</ul>'), i];
  };
  let out = '', i = 0;
  while (i < items.length) { const [h, n] = build(i, items[i].indent); out += h; i = n; }
  return out;
}

export function renderMarkdown(src) {
  const keep = [];
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = l.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(codeBlock(body.join('\n'), fence[2])); continue;
    }
    const mathOpen = l.trim().match(/^(\$\$|\\\[)(.*)$/);
    if (mathOpen) {
      const close = mathOpen[1] === '$$' ? '$$' : '\\]';
      let rest = mathOpen[2], body = [];
      if (rest.trim().endsWith(close) && rest.trim().length > close.length - 1) { body.push(rest.trim().slice(0, -close.length)); i++; }
      else { if (rest.trim()) body.push(rest); i++; while (i < lines.length && !lines[i].trim().endsWith(close)) body.push(lines[i++]); if (i < lines.length) { body.push(lines[i].trim().slice(0, -close.length)); i++; } }
      const tex = body.join('\n').trim();
      out.push(`<div class="md-math-block"><div class="md-math" data-tex="${esc(tex)}" data-display="1">${esc(tex)}</div></div>`); continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { out.push(`<h${h[1].length} class="md-h">${inline(h[2], keep)}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr class="md-hr">'); i++; continue; }
    if (/^\s*>/.test(l)) {
      const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote class="md-quote">${renderMarkdown(q.join('\n'))}</blockquote>`); continue;
    }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = []; while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++]);
      out.push(table(rows, keep)); continue;
    }
    if (isList(l)) {
      const block = []; while (i < lines.length && (isList(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i])))) block.push(lines[i++]);
      out.push(list(block, keep)); continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(`{3,}|~{3,}|#{1,6}\s|>|\$\$|\\\[)/.test(lines[i]) && !isList(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++]);
    if (!para.length) { out.push(`<p>${inline(l, keep)}</p>`); i++; continue; }
    out.push(`<p>${para.map((p) => inline(p, keep)).join('<br>')}</p>`);
  }
  return restore(out.join(''), keep);
}

// ---------- after the HTML is on the page: math and copy buttons ----------
let katex = null, loading = null;
function loadKatex() {
  if (katex) return Promise.resolve(katex);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
    s.onload = () => { katex = window.katex; resolve(katex); };
    s.onerror = () => resolve(null); // offline: the TeX source stays visible, styled as math
    document.head.appendChild(s);
  });
  return loading;
}
export async function enhance(root) {
  for (const b of root.querySelectorAll('.md-copy:not([data-wired])')) {
    b.dataset.wired = '1';
    b.onclick = async () => {
      const code = b.closest('.md-code')?.querySelector('code')?.textContent || '';
      try { await navigator.clipboard.writeText(code); b.textContent = 'Copied ✓'; } catch { b.textContent = 'Copy failed'; }
      setTimeout(() => (b.textContent = 'Copy'), 1400);
    };
  }
  const maths = [...root.querySelectorAll('.md-math:not([data-done])')];
  if (!maths.length) return;
  const k = await loadKatex();
  for (const el of maths) {
    el.dataset.done = '1';
    if (!k) { el.classList.add('raw'); continue; }
    try { k.render(el.dataset.tex, el, { displayMode: el.dataset.display === '1', throwOnError: false, output: 'html' }); }
    catch { el.classList.add('raw'); }
  }
}
