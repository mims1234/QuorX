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
// Formatting only ever changes whitespace between tokens: strings, template literals (with their ${} parts),
// regex literals, comments, and in HTML the text, entities and attribute values, are kept exactly as written.

// The end (exclusive) of the string, template or regex literal that starts at i, or -1 when it isn't one.
function scanQuoted(code, i) {
  const q = code[i];
  let j = i + 1;
  while (j < code.length && code[j] !== q) { if (code[j] === '\\') j++; else if (code[j] === '\n') return j; j++; }
  return Math.min(j + 1, code.length);
}
function scanTemplate(code, i) {
  let j = i + 1;
  while (j < code.length) {
    const c = code[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && code[j + 1] === '{') { j = scanExpr(code, j + 2); continue; }
    j++;
  }
  return code.length;
}
// Inside ${ … }: up to its closing brace, past nested braces, strings, templates and comments.
function scanExpr(code, j) {
  let depth = 1;
  while (j < code.length) {
    const c = code[j], two = code.slice(j, j + 2);
    if (two === '//') { const e = code.indexOf('\n', j); j = e < 0 ? code.length : e; continue; }
    if (two === '/*') { const e = code.indexOf('*/', j + 2); j = e < 0 ? code.length : e + 2; continue; }
    if (c === '"' || c === "'") { j = scanQuoted(code, j); continue; }
    if (c === '`') { j = scanTemplate(code, j); continue; }
    if (c === '{') depth++;
    if (c === '}' && !--depth) return j + 1;
    j++;
  }
  return code.length;
}
function scanRegex(code, i) {
  let j = i + 1, cls = false;
  while (j < code.length) {
    const c = code[j];
    if (c === '\n') return -1;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break;
    j++;
  }
  if (j >= code.length) return -1;
  j++;
  while (j < code.length && /[a-z]/i.test(code[j])) j++;
  return j;
}
// A / starts a regex (not a division) after an operator, an opening bracket, a keyword like return, or nothing.
const REGEX_AFTER_WORD = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
const regexCanStart = (last, line) => {
  if (!last) return true;
  if (/[\w$]/.test(last)) { const w = line.match(/([\w$]+)\s*$/); return !!w && REGEX_AFTER_WORD.test(w[1]); }
  return /[(,=:[!&|?{};+\-*%<>~^]/.test(last);
};
// Walks the code once, lining up braces and semicolons; everything listed above is skipped over whole.
// base: an indent put before every line it lays out (a <script> inside HTML); never inside a multi-line literal.
function layoutBraces(code, { css = false, base = '' } = {}) {
  const minified = code.split('\n').some((l) => l.length > 220);
  let out = '', depth = 0, i = 0, paren = 0, line = '', last = '';
  const push = () => { const t = line.trim(); if (t) out += base + '  '.repeat(Math.max(0, depth)) + t + '\n'; else if (!minified && out && !out.endsWith('\n\n')) out += '\n'; line = ''; };
  const take = (end) => { line += code.slice(i, end); i = end; };
  while (i < code.length) {
    const c = code[i], two = code.slice(i, i + 2);
    if (two === '//' && !css) { const e = code.indexOf('\n', i); take(e < 0 ? code.length : e); continue; }
    if (two === '/*') { const e = code.indexOf('*/', i + 2); take(e < 0 ? code.length : e + 2); continue; }
    if (c === '"' || c === "'") { take(scanQuoted(code, i)); last = c; continue; }
    if (c === '`' && !css) { take(scanTemplate(code, i)); last = c; continue; }
    if (c === '/' && !css && regexCanStart(last, line)) { const e = scanRegex(code, i); if (e > 0) { take(e); last = 'r'; continue; } }
    // A line break in the source stays one (some code leans on it: no semicolons).
    if (c === '\n') { push(); i++; continue; }
    if (c === '(' || c === '[') paren++;
    if (c === ')' || c === ']') paren = Math.max(0, paren - 1);
    if (!/\s/.test(c)) last = c;
    if (c === '{') { line = line.replace(/\s+$/, '') + ' {'; push(); depth++; i++; continue; }
    if (c === '}') { push(); depth--; line = '}'; i++; if (/^\s*[;,)]/.test(code.slice(i, i + 200))) continue; if (!/^\s*(else|catch|finally|while)\b/.test(code.slice(i, i + 200))) push(); else line += ' '; continue; }
    if (c === ';' && paren === 0) { line += ';'; push(); i++; continue; }
    line += c; i++;
  }
  push();
  return out.trimEnd() + '\n';
}

// HTML is read by a small tokenizer, not the browser's parser: nothing is decoded (&lt;script&gt; stays as written)
// and nothing is added (no implied <html>, <tbody> or closing tags), so the formatted page is the same page.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INLINE = new Set(['a', 'b', 'i', 'em', 'strong', 'span', 'small', 'code', 'kbd', 'abbr', 'sup', 'sub', 'label', 'button', 'br']);
// Kept exactly as written inside: their whitespace matters (or, for script and style, is laid out as code).
const RAW = new Set(['script', 'style', 'pre', 'textarea', 'title']);
// An open tag that closes the one before it when the source leaves the closing tag out.
const AUTO_CLOSE = { li: ['li'], option: ['option'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], p: ['p'] };
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const WS = /[ \t\n\r\f]+/g; // HTML's whitespace (not a no-break space)
/** The source as tokens: text, comment, doctype, open (name, attrs as written, selfClose), close, and for RAW
 * elements one token with its body. Exported for the tests. */
export function htmlTokens(code) {
  const out = [];
  let i = 0, text = '';
  const flush = () => { if (text) out.push({ t: 'text', raw: text }); text = ''; };
  while (i < code.length) {
    if (code[i] !== '<') { const n = code.indexOf('<', i); const end = n < 0 ? code.length : n; text += code.slice(i, end); i = end; continue; }
    if (code.startsWith('<!--', i)) { const e = code.indexOf('-->', i + 4); const end = e < 0 ? code.length : e + 3; flush(); out.push({ t: 'comment', raw: code.slice(i, end) }); i = end; continue; }
    if (code.startsWith('<![CDATA[', i)) { const e = code.indexOf(']]>', i + 9); const end = e < 0 ? code.length : e + 3; flush(); out.push({ t: 'comment', raw: code.slice(i, end) }); i = end; continue; }
    if (/^<[!?]/.test(code.slice(i, i + 2))) { const e = code.indexOf('>', i); const end = e < 0 ? code.length : e + 1; flush(); out.push({ t: 'doctype', raw: code.slice(i, end) }); i = end; continue; }
    const close = /^<\/([A-Za-z][\w:-]*)[^>]*>/.exec(code.slice(i, i + 300));
    if (close) { flush(); out.push({ t: 'close', name: close[1].toLowerCase(), raw: close[0] }); i += close[0].length; continue; }
    const open = /^<([A-Za-z][\w:-]*)/.exec(code.slice(i, i + 300));
    if (!open) { text += '<'; i++; continue; }
    // Attributes one at a time, so a > inside a quoted value doesn't end the tag.
    let j = i + open[0].length, selfClose = false;
    const attrs = [];
    for (;;) {
      while (j < code.length && /\s/.test(code[j])) j++;
      if (j >= code.length) break;
      if (code[j] === '>') { j++; break; }
      if (code.startsWith('/>', j)) { selfClose = true; j += 2; break; }
      const nm = /^[^\s"'>/=]+|^[/"'=]/.exec(code.slice(j, j + 300));
      let a = nm[0]; j += a.length;
      const eq = /^\s*=\s*/.exec(code.slice(j, j + 100));
      if (eq && nm[0] !== '/') {
        j += eq[0].length;
        let v;
        if (code[j] === '"' || code[j] === "'") { const e = code.indexOf(code[j], j + 1); v = code.slice(j, e < 0 ? code.length : e + 1); }
        else v = /^[^\s>]*/.exec(code.slice(j))[0];
        a += '=' + v; j += v.length;
      }
      if (a !== '/') attrs.push(a);
    }
    flush();
    const name = open[1].toLowerCase(), tag = { t: 'open', name, attrs, selfClose, raw: code.slice(i, j) };
    i = j;
    if (RAW.has(name) && !selfClose) {
      const m = new RegExp(`</${name}\\s*>`, 'i').exec(code.slice(i));
      const end = m ? i + m.index : code.length;
      out.push({ ...tag, t: 'raw', body: code.slice(i, end), close: m ? m[0] : '' });
      i = m ? end + m[0].length : end;
      continue;
    }
    out.push(tag);
  }
  flush();
  return out;
}
// Tokens into a tree. A closing tag the source leaves out is never written in (closed stays false).
function htmlTree(tokens) {
  const root = { kids: [] }, stack = [root];
  const top = () => stack[stack.length - 1];
  for (const k of tokens) {
    if (k.t === 'open' || k.t === 'raw') {
      const shut = AUTO_CLOSE[k.name] || [];
      while (stack.length > 1 && (shut.includes(top().name) || (top().name === 'p' && CLOSES_P.has(k.name)))) stack.pop();
      const el = { ...k, kids: [], closed: false };
      top().kids.push(el);
      if (k.t === 'open' && !k.selfClose && !VOID.has(k.name)) stack.push(el);
      continue;
    }
    if (k.t === 'close') {
      const at = stack.findLastIndex((x, n) => n > 0 && x.name === k.name);
      if (at < 0) { top().kids.push({ t: 'text', raw: k.raw, stray: true }); continue; }
      stack[at].closed = true; stack[at].closeRaw = k.raw;
      stack.length = at;
      continue;
    }
    top().kids.push(k);
  }
  return root;
}
const isScript = (el) => {
  const ty = /^type\s*=\s*["']?([^"'\s>]*)/i.exec(el.attrs.find((a) => /^type\s*=/i.test(a)) || '')?.[1]?.toLowerCase();
  return !ty || /^(?:module|text\/javascript|application\/javascript|text\/ecmascript)$/.test(ty);
};
function formatHtml(code) {
  const lines = [];
  const openTag = (el) => `<${el.raw.slice(1, 1 + el.name.length)}${el.attrs.map((a) => ' ' + a).join('')}${el.selfClose ? ' />' : '>'}`;
  const closeTag = (el) => (el.closed ? el.closeRaw : '');
  // A short run of text and plain inline tags, on one line (whitespace between words becomes one space).
  const inline = (n) => n.t === 'text' ? n.raw.replace(WS, ' ') : n.t === 'comment' ? n.raw : `${openTag(n)}${n.kids.map(inline).join('')}${closeTag(n)}`;
  const walk = (node, d) => {
    const pad = '  '.repeat(d);
    for (const n of node.kids) {
      if (n.t === 'text') { const t = n.raw.replace(WS, ' ').trim(); if (t) lines.push(pad + t); continue; }
      if (n.t === 'comment' || n.t === 'doctype') { lines.push(pad + n.raw); continue; }
      const open = openTag(n);
      if (n.t === 'raw') {
        if ((n.name === 'script' && isScript(n)) || n.name === 'style') {
          const body = n.body.trim();
          if (!body) { lines.push(`${pad}${open}${n.close}`); continue; }
          lines.push(pad + open);
          lines.push(layoutBraces(body, { css: n.name === 'style', base: pad + '  ' }).trimEnd());
          lines.push(pad + n.close); continue;
        }
        // pre, textarea, title, and scripts that hold data or templates: exactly as written.
        lines.push(pad + open + n.body + n.close); continue;
      }
      if (VOID.has(n.name) || n.selfClose) { lines.push(pad + open); continue; }
      const kids = n.kids.filter((k) => !(k.t === 'text' && !k.raw.replace(WS, '')));
      const simple = kids.every((k) => k.t === 'text' || (k.t === 'open' && INLINE.has(k.name) && k.kids.every((x) => x.t === 'text')));
      const flat = simple && n.kids.map(inline).join('').replace(WS, ' ').trim();
      if (simple && flat.length < 100) { lines.push(`${pad}${open}${flat}${closeTag(n)}`); continue; }
      lines.push(pad + open); walk(n, d + 1); if (n.closed) lines.push(pad + closeTag(n));
    }
  };
  walk(htmlTree(htmlTokens(code)), 0);
  return lines.join('\n') + '\n';
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
      <button type="button" class="cv-copy" title="Copy the code as written">⧉ Copy</button></div>
    <div class="cv-scroll"><pre class="cv-gutter" aria-hidden="true">${Array.from({ length: n }, (_, i) => i + 1).join('\n')}</pre><pre class="cv-code"><code>${html}</code></pre></div>
  </div>`;
}
// Renders into an element and wires the toggle and copy buttons.
export function mountCode(el, code, lang, opts = {}) {
  const draw = (formatted) => {
    el.innerHTML = codeViewHTML(code, lang, { ...opts, formatted });
    for (const b of el.querySelectorAll('.cv-mode button')) b.onclick = () => draw(b.dataset.fmt === '1');
    const copy = el.querySelector('.cv-copy');
    // Always the source as it is: the formatted view is for reading.
    copy.onclick = async () => { try { await navigator.clipboard.writeText(code); copy.textContent = '✓ Copied'; setTimeout(() => (copy.textContent = '⧉ Copy'), 1200); } catch { copy.textContent = 'Copy failed'; } };
  };
  draw(opts.formatted !== false);
}
