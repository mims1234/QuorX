// A small code viewer with no dependencies: syntax colours for the languages agents usually write,
// line numbers, and a formatter that lays out minified or messy HTML, CSS, JS and JSON.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const EXT = { html: 'html', htm: 'html', svg: 'html', xml: 'html', vue: 'html', css: 'css', scss: 'css', less: 'css',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'json', py: 'py', md: 'md', sh: 'sh', bash: 'sh', ps1: 'sh', bat: 'sh', txt: 'text', log: 'text' };
export const langOf = (name) => EXT[String(name).split('.').pop().toLowerCase()] || (/^\s*</.test(name) ? 'html' : 'text');
export const LANG_NAME = { html: 'HTML', css: 'CSS', js: 'JavaScript', json: 'JSON', py: 'Python', md: 'Markdown', sh: 'Shell', text: 'Text' };

// ---------- highlighting: one regex of named alternatives per language ----------
const JS_KW = 'await|async|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|interface|type|enum|implements|public|private|protected|readonly|as';
const RULES = {
  js: [
    ['com', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ['str', /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/],
    ['kw', new RegExp(`\\b(?:${JS_KW})\\b`)],
    ['lit', /\b(?:true|false|null|undefined|NaN|Infinity)\b/],
    ['num', /\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/i],
    ['fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/],
    ['prop', /(?<=\.)[A-Za-z_$][\w$]*/],
  ],
  json: [
    ['prop', /"(?:\\.|[^"\\])*"(?=\s*:)/],
    ['str', /"(?:\\.|[^"\\])*"/],
    ['lit', /\b(?:true|false|null)\b/],
    ['num', /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i],
  ],
  css: [
    ['com', /\/\*[\s\S]*?\*\//],
    ['str', /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/],
    ['kw', /@[\w-]+/],
    ['prop', /[\w-]+(?=\s*:[^;{}]*[;}])/],
    ['num', /#[\da-f]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|dvh|s|ms|deg|fr|ch)?\b/i],
    ['fn', /[\w-]+(?=\()/],
    ['sel', /[.#]?[A-Za-z][\w-]*(?=[^{};]*\{)|::?[\w-]+/],
  ],
  py: [
    ['com', /#[^\n]*/],
    ['str', /(?:[rbfu]{0,2})(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/i],
    ['kw', /\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|self)\b/],
    ['lit', /\b(?:True|False|None)\b/],
    ['num', /\b\d+(?:\.\d+)?\b/],
    ['fn', /@[\w.]+|\b[A-Za-z_]\w*(?=\s*\()/],
  ],
  sh: [
    ['com', /#[^\n]*/],
    ['str', /'[^']*'|"(?:\\.|[^"\\])*"/],
    ['kw', /\b(?:if|then|else|fi|for|do|done|while|case|esac|function|in|echo|export|cd|set)\b/],
    ['prop', /\$\{?[\w@#?*]+\}?/],
    ['num', /\b\d+\b/],
  ],
  md: [
    ['kw', /^#{1,6} [^\n]*/m],
    ['com', /^>[^\n]*/m],
    ['str', /`[^`\n]+`/],
    ['fn', /\[[^\]\n]+\]\([^)\n]+\)/],
    ['prop', /\*\*[^*\n]+\*\*|^\s*(?:[-*+]|\d+\.) /m],
  ],
};
function tokens(code, lang) {
  const rules = RULES[lang];
  if (!rules) return esc(code);
  const re = new RegExp(rules.map(([, r]) => `(${r.source})`).join('|'), 'g' + (rules.some(([, r]) => r.flags.includes('i')) ? 'i' : '') + (rules.some(([, r]) => r.flags.includes('m')) ? 'm' : ''));
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const i = m.slice(1).findIndex((x) => x !== undefined);
    out += esc(code.slice(last, m.index)) + `<span class="tk-${rules[i][0]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}
// HTML: tags and attributes, with <script> and <style> bodies coloured as JS and CSS.
function markup(code) {
  const re = /<!--[\s\S]*?-->|<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<\/?[A-Za-z][^>]*>|<!DOCTYPE[^>]*>/gi;
  let out = '', last = 0, m;
  // Attributes first (on the plain escaped tag), then the tag name, so neither pass sees the other's spans.
  const tag = (t) => esc(t).replace(/([\w:@.-]+)(=)(&quot;[\s\S]*?&quot;|'[^']*'|[^\s&>]+)/g, '\u0001$1\u0002$2\u0003$3\u0004')
    .replace(/^(&lt;\/?)([\w-]+)/, '$1<span class="tk-kw">$2</span>')
    .replace(/\u0001/g, '<span class="tk-prop">').replace(/\u0002/g, '</span>').replace(/\u0003/g, '<span class="tk-str">').replace(/\u0004/g, '</span>');
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[0].startsWith('<!--')) out += `<span class="tk-com">${esc(m[0])}</span>`;
    else if (m[1]) {
      const open = m[0].slice(0, m[0].indexOf('>') + 1), close = m[0].slice(m[0].lastIndexOf('</'));
      out += tag(open) + tokens(m[3], m[1].toLowerCase() === 'script' ? 'js' : 'css') + tag(close);
    } else out += tag(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}
export function highlight(code, lang) { return lang === 'html' ? markup(code) : tokens(code, lang); }

// ---------- formatting ----------
// Walks the code once, tracking strings, comments and template literals, so braces and
// semicolons inside them are never touched.
function layoutBraces(code, { css = false } = {}) {
  const minified = code.split('\n').some((l) => l.length > 220);
  let out = '', depth = 0, i = 0, paren = 0, line = '';
  const push = () => { const t = line.trim(); if (t) out += '  '.repeat(Math.max(0, depth)) + t + '\n'; else if (!minified && out && !out.endsWith('\n\n')) out += '\n'; line = ''; };
  while (i < code.length) {
    const c = code[i], two = code.slice(i, i + 2);
    if (two === '//' && !css) { const e = code.indexOf('\n', i); const end = e < 0 ? code.length : e; line += code.slice(i, end); i = end; continue; }
    if (two === '/*') { const e = code.indexOf('*/', i + 2); const end = e < 0 ? code.length : e + 2; line += code.slice(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) { if (code[j] === '\\') j++; else if (c !== '`' && code[j] === '\n') break; j++; }
      line += code.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '\n') { if (!minified) push(); else line += ' '; i++; continue; }
    if (c === '(' || c === '[') paren++;
    if (c === ')' || c === ']') paren = Math.max(0, paren - 1);
    if (c === '{') { line += ' {'; push(); depth++; i++; continue; }
    if (c === '}') { push(); depth--; line = '}'; i++; if (/^\s*[;,)]/.test(code.slice(i))) continue; if (!/^\s*(else|catch|finally|while)\b/.test(code.slice(i))) push(); else line += ' '; continue; }
    if (c === ';' && paren === 0) { line += ';'; push(); i++; continue; }
    line += c; i++;
  }
  push();
  return out.replace(/ {2,}\{/g, ' {').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INLINE = new Set(['a', 'b', 'i', 'em', 'strong', 'span', 'small', 'code', 'kbd', 'abbr', 'sup', 'sub', 'label', 'button', 'br']);
function formatHtml(code) {
  const doc = new DOMParser().parseFromString(code, 'text/html');
  const hasDoctype = /^\s*<!doctype/i.test(code), wholeDoc = /<html[\s>]/i.test(code);
  const attrs = (el) => [...el.attributes].map((a) => (a.value === '' ? ` ${a.name}` : ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`)).join('');
  const lines = [];
  const walk = (node, d) => {
    const pad = '  '.repeat(d);
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t) lines.push(pad + t); continue; }
      if (n.nodeType === 8) { lines.push(`${pad}<!--${n.textContent}-->`); continue; }
      if (n.nodeType !== 1) continue;
      const name = n.tagName.toLowerCase(), open = `<${name}${attrs(n)}>`;
      if (VOID.has(name)) { lines.push(pad + open); continue; }
      if (name === 'script' || name === 'style') {
        const body = n.textContent.trim();
        if (!body) { lines.push(`${pad}${open}</${name}>`); continue; }
        lines.push(pad + open);
        for (const l of layoutBraces(body, { css: name === 'style' }).trimEnd().split('\n')) lines.push(l ? pad + '  ' + l : '');
        lines.push(`${pad}</${name}>`); continue;
      }
      if (name === 'pre' || name === 'textarea') { lines.push(pad + n.outerHTML); continue; }
      const kids = [...n.childNodes].filter((k) => !(k.nodeType === 3 && !k.textContent.trim()));
      const simple = kids.every((k) => k.nodeType === 3 || (k.nodeType === 1 && INLINE.has(k.tagName.toLowerCase()) && k.children.length === 0));
      if (simple && n.innerHTML.replace(/\s+/g, ' ').trim().length < 100) { lines.push(`${pad}${open}${n.innerHTML.replace(/\s+/g, ' ').trim()}</${name}>`); continue; }
      lines.push(pad + open); walk(n, d + 1); lines.push(`${pad}</${name}>`);
    }
  };
  if (wholeDoc) { lines.push(`<html${attrs(doc.documentElement)}>`); for (const part of [doc.head, doc.body]) { lines.push(`  <${part.tagName.toLowerCase()}${attrs(part)}>`); walk(part, 2); lines.push(`  </${part.tagName.toLowerCase()}>`); } lines.push('</html>'); }
  else { walk(doc.head, 0); walk(doc.body, 0); }
  return (hasDoctype ? '<!doctype html>\n' : '') + lines.join('\n') + '\n';
}
export function beautify(code, lang) {
  try {
    if (lang === 'json') return JSON.stringify(JSON.parse(code), null, 2) + '\n';
    if (lang === 'html') return formatHtml(code);
    if (lang === 'css') return layoutBraces(code, { css: true });
    if (lang === 'js') return layoutBraces(code);
  } catch { /* fall back to the original */ }
  return code;
}
export const canFormat = (lang) => ['json', 'html', 'css', 'js'].includes(lang);

// ---------- the viewer ----------
// Returns the markup for a code view: a bar (language, Formatted/Original, Copy) and numbered lines.
export function codeViewHTML(code, lang, { formatted = true, name = '' } = {}) {
  const big = code.length > 400000;
  const text = formatted && canFormat(lang) && !big ? beautify(code, lang) : code;
  const html = big ? esc(text) : highlight(text, lang);
  const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return `<div class="code-view">
    <div class="cv-bar"><span class="cv-lang">${esc(LANG_NAME[lang] || lang)}</span>${name ? `<span class="cv-name">${esc(name)}</span>` : ''}<span class="cv-lines">${n} lines</span>
      ${canFormat(lang) && !big ? `<div class="seg cv-mode"><button type="button" data-fmt="1" class="${formatted ? 'on' : ''}">✨ Formatted</button><button type="button" data-fmt="0" class="${formatted ? '' : 'on'}">Original</button></div>` : ''}
      <button type="button" class="cv-copy" title="Copy">⧉ Copy</button></div>
    <div class="cv-scroll"><pre class="cv-gutter" aria-hidden="true">${Array.from({ length: n }, (_, i) => i + 1).join('\n')}</pre><pre class="cv-code"><code>${html}</code></pre></div>
  </div>`;
}
// Renders into an element and wires the toggle and copy buttons.
export function mountCode(el, code, lang, opts = {}) {
  const draw = (formatted) => {
    el.innerHTML = codeViewHTML(code, lang, { ...opts, formatted });
    for (const b of el.querySelectorAll('.cv-mode button')) b.onclick = () => draw(b.dataset.fmt === '1');
    const copy = el.querySelector('.cv-copy');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(el.querySelector('.cv-code').textContent); copy.textContent = '✓ Copied'; setTimeout(() => (copy.textContent = '⧉ Copy'), 1200); } catch { copy.textContent = 'Copy failed'; } };
  };
  draw(opts.formatted !== false);
}
