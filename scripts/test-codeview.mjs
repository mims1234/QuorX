// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The code viewer's Formatted view (public/code.js): it may only move whitespace. Each sample is formatted and read
// back: JS and CSS compared with all whitespace taken out, HTML token by token (tags, attributes as written, text
// with its whitespace runs made one space, and the insides of pre, textarea, script and style).
import test from 'node:test';
import assert from 'node:assert/strict';
import { beautify } from '../public/code.js';

const squash = (s) => s.replace(/\s+/g, '');

// A tokenizer of its own (not the one in code.js), so the check doesn't lean on what it checks.
function readBack(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<(pre|textarea|script|style|title)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*>|<\/?[A-Za-z][\w:-]*(?:"[^"]*"|'[^']*'|[^'">])*>|<![^>]*>/gi;
  let last = 0, m, text = '';
  const textOut = () => { const t = text.replace(/[ \t\n\r\f]+/g, ' ').trim(); if (t) out.push(['text', t]); text = ''; };
  const tag = (t) => {
    const name = /^<\/?([\w:-]+)/.exec(t)[1].toLowerCase();
    const attrs = [...t.slice(name.length + 1).matchAll(/([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)].map((a) => `${a[1]}=${a[2] ?? ''}`);
    return [t.startsWith('</') ? 'close' : 'open', name, ...attrs];
  };
  while ((m = re.exec(html))) {
    text += html.slice(last, m.index);
    // Text either side of a tag reads the same with or without the line break the formatter puts there.
    textOut();
    if (m[0].startsWith('<!--') || m[0].startsWith('<!')) out.push(['other', m[0]]);
    else if (m[1]) {
      const name = m[1].toLowerCase(), code = name === 'script' || name === 'style';
      out.push(tag(`<${m[1]}${m[2]}>`), ['body', code ? squash(m[3]) : m[3]], ['close', name]);
    } else out.push(tag(m[0]));
    last = m.index + m[0].length;
  }
  text += html.slice(last); textOut();
  return out;
}
const sameHtml = (src) => {
  const f = beautify(src, 'html');
  assert.deepEqual(readBack(f), readBack(src), `formatted:\n${f}`);
  return f;
};
const sameJs = (src, lang = 'js') => {
  const f = beautify(src, lang);
  assert.equal(squash(f), squash(src), `formatted:\n${f}`);
  return f;
};
// Each case: the source, text the formatted output must hold as written (strings) or match (regexes), and what it must not.
const holds = (what, f, has = [], hasNot = []) => {
  for (const h of has) assert.ok(typeof h === 'string' ? f.includes(h) : h.test(f), `${what}: ${h} in\n${f}`);
  for (const h of hasNot) assert.doesNotMatch(f, h, what);
};

test('code view: HTML moves only whitespace: entities, pre and textarea, inline script and style, nothing added, a minified page', () => {
  for (const c of [
    { what: 'entities in text and attributes stay as written',
      src: '<div class="a"><p>Use &lt;script&gt; &amp; &quot;quotes&quot; &copy;</p><a href="/x?a=1&amp;b=2" title="say &quot;hi&quot;">link</a><span data-x=\'it"s\'>q</span></div>',
      has: [/&lt;script&gt; &amp; &quot;quotes&quot; &copy;/, /href="\/x\?a=1&amp;b=2"/, /title="say &quot;hi&quot;"/, /data-x='it"s'/], hasNot: [/<script>/] },
    { what: 'pre, textarea and a no-break space keep their whitespace',
      src: '<section><pre>  line one\n    indented   &lt;b&gt;\n\n  end</pre><textarea name="t">  a\n  b  </textarea><p>a  b   c</p></section>',
      has: ['<pre>  line one\n    indented   &lt;b&gt;\n\n  end</pre>', '<textarea name="t">  a\n  b  </textarea>', 'a  b c'] },
    { what: 'nothing is added (no implied tags, no closing tags the source left out)',
      src: '<ul><li>one<li>two</ul><p>para<div>block</div><table><tr><td>x</table><img src=a.png alt="a > b"><br/>',
      has: ['alt="a > b"'], hasNot: [/<\/li>|<tbody>|<html>|<body>/] },
    { what: 'inline script and style are laid out safely, other scripts left alone',
      src: '<html><head><style>a{color:red}b::after{content:"};{"}</style><script>const r=/<\\/b>;/;if(r.test(s)){f(`${1}`)}</script><script type="application/json">{"a":  [1,  2]}</script></head><body><p>hi</p></body></html>',
      has: ['content:"};{"', '/<\\/b>;/', '<script type="application/json">{"a":  [1,  2]}</script>'] },
    { what: 'a minified page lays out over lines to the same tokens',
      src: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T &amp; U</title></head><body><!-- note --><div id="app" class="a  b"><h1>Hello <b>world</b>!</h1><button onclick="go(&quot;x&quot;)">Go</button></div><script>document.querySelector("#app").onclick=()=>{let n=0;for(let i=0;i<3;i++){n+=i}console.log(`n=${n}`)}</script></body></html>',
      has: [/^<!doctype html>\n/, '<title>T &amp; U</title>', 'onclick="go(&quot;x&quot;)"', /(\n[^\n]*){8}/] },
  ]) holds(c.what, sameHtml(c.src), c.has, c.hasNot);
});

test('code view: JS and CSS move only whitespace: regex literals, template literals and strings, lines without semicolons', () => {
  const long = 'x'.repeat(240);
  for (const c of [
    { what: 'regex literals with // and ; are kept whole',
      src: 'const re=/https?:\\/\\/[^;]+;/g;const n=a/b/c;function f(s){return /\\/\\/;x/.test(s)?s.replace(/;{2}/,";"):s}if(!/[/;]/.test(u)){go()}const k=[/a;b/,/c\\/\\/d/];x=y?/;/:z',
      has: ['/https?:\\/\\/[^;]+;/g', '/\\/\\/;x/', '/;{2}/', '/[/;]/', '/a;b/', '/c\\/\\/d/', '/;/', 'a/b/c;'] },
    { what: 'template literals with ${} and strings stay as written',
      src: 'const t=`a {b}; ${x?`in ${y}{`:"}"} // not a comment\n    keep   this ;`;const s="a;{b}//c";let o={k:`${{a:1}.a}`};',
      has: ['`a {b}; ${x?`in ${y}{`:"}"} // not a comment\n    keep   this ;`', '"a;{b}//c"', '`${{a:1}.a}`'] },
    { what: 'code without semicolons keeps its line breaks',
      src: `const a = 1\nconst b = a\n(function(){})()\nlet s = "${long}"\n`, has: [/^const a = 1$/m, /^const b = a$/m] },
    { what: 'CSS with strings and data URLs', lang: 'css', src: 'a{color:red}b::after{content:"};{"}@media (x){c{d:url(data:a;b,c)}}' },
  ]) holds(c.what, sameJs(c.src, c.lang), c.has);
});

