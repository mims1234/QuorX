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

test('code view: entities in text and attributes stay as written', () => {
  const src = '<div class="a"><p>Use &lt;script&gt; &amp; &quot;quotes&quot; &copy;</p><a href="/x?a=1&amp;b=2" title="say &quot;hi&quot;">link</a><span data-x=\'it"s\'>q</span></div>';
  const f = sameHtml(src);
  assert.match(f, /&lt;script&gt; &amp; &quot;quotes&quot; &copy;/);
  assert.match(f, /href="\/x\?a=1&amp;b=2"/);
  assert.match(f, /title="say &quot;hi&quot;"/);
  assert.match(f, /data-x='it"s'/);
  assert.doesNotMatch(f, /<script>/);
});

test('code view: pre, textarea and a no-break space keep their whitespace', () => {
  const src = '<section><pre>  line one\n    indented   &lt;b&gt;\n\n  end</pre><textarea name="t">  a\n  b  </textarea><p>a  b   c</p></section>';
  const f = sameHtml(src);
  assert.ok(f.includes('<pre>  line one\n    indented   &lt;b&gt;\n\n  end</pre>'));
  assert.ok(f.includes('<textarea name="t">  a\n  b  </textarea>'));
  assert.ok(f.includes('a  b c'));
});

test('code view: nothing is added (no implied tags, no closing tags the source left out)', () => {
  const src = '<ul><li>one<li>two</ul><p>para<div>block</div><table><tr><td>x</table><img src=a.png alt="a > b"><br/>';
  const f = sameHtml(src);
  assert.doesNotMatch(f, /<\/li>|<tbody>|<html>|<body>/);
  assert.ok(f.includes('alt="a > b"'));
});

test('code view: regex literals with // and ; are kept whole', () => {
  const src = 'const re=/https?:\\/\\/[^;]+;/g;const n=a/b/c;function f(s){return /\\/\\/;x/.test(s)?s.replace(/;{2}/,";"):s}if(!/[/;]/.test(u)){go()}const k=[/a;b/,/c\\/\\/d/];x=y?/;/:z';
  const f = sameJs(src);
  for (const r of ['/https?:\\/\\/[^;]+;/g', '/\\/\\/;x/', '/;{2}/', '/[/;]/', '/a;b/', '/c\\/\\/d/', '/;/']) assert.ok(f.includes(r), `${r} in\n${f}`);
  assert.ok(f.includes('a/b/c;'));
});

test('code view: template literals with ${} and strings stay as written', () => {
  const src = 'const t=`a {b}; ${x?`in ${y}{`:"}"} // not a comment\n    keep   this ;`;const s="a;{b}//c";let o={k:`${{a:1}.a}`};';
  const f = sameJs(src);
  assert.ok(f.includes('`a {b}; ${x?`in ${y}{`:"}"} // not a comment\n    keep   this ;`'));
  assert.ok(f.includes('"a;{b}//c"'));
  assert.ok(f.includes('`${{a:1}.a}`'));
});

test('code view: code without semicolons keeps its line breaks', () => {
  const long = 'x'.repeat(240);
  const src = `const a = 1\nconst b = a\n(function(){})()\nlet s = "${long}"\n`;
  const f = sameJs(src);
  assert.ok(f.split('\n').includes('const a = 1'));
  assert.ok(f.split('\n').includes('const b = a'));
});

test('code view: inline script and style are laid out safely, other scripts left alone', () => {
  const src = '<html><head><style>a{color:red}b::after{content:"};{"}</style><script>const r=/<\\/b>;/;if(r.test(s)){f(`${1}`)}</script><script type="application/json">{"a":  [1,  2]}</script></head><body><p>hi</p></body></html>';
  const f = sameHtml(src);
  assert.ok(f.includes('content:"};{"'));
  assert.ok(f.includes('/<\\/b>;/'));
  assert.ok(f.includes('<script type="application/json">{"a":  [1,  2]}</script>'));
  sameJs('a{color:red}b::after{content:"};{"}@media (x){c{d:url(data:a;b,c)}}', 'css');
});

test('code view: a minified page lays out to the same tokens', () => {
  const src = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T &amp; U</title></head><body><!-- note --><div id="app" class="a  b"><h1>Hello <b>world</b>!</h1><button onclick="go(&quot;x&quot;)">Go</button></div><script>document.querySelector("#app").onclick=()=>{let n=0;for(let i=0;i<3;i++){n+=i}console.log(`n=${n}`)}</script></body></html>';
  const f = sameHtml(src);
  assert.match(f, /^<!doctype html>\n/);
  assert.ok(f.includes('<title>T &amp; U</title>'));
  assert.ok(f.includes('onclick="go(&quot;x&quot;)"'));
  assert.ok(f.split('\n').length > 8, 'it is laid out over lines');
});
