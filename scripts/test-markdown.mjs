// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Chat Markdown (public/markdown.js): a streaming reply drawn in pieces (the finished blocks once, then only the text
// after them) is exactly the whole reply drawn at once, at every token.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown as md, stableCut } from '../public/markdown.js';
import { sentencePieces, pickVoice } from '../public/speak.js';

const REPLIES = [
  'Here is the plan.\n\n1. First item\n2. Second item\n\n3. Third after a blank line\n\n- a\n  - nested b\n    - deeper c\n- d\n\nSome **bold**, *italic*, `code` and a [link](https://example.com).',
  '```js\nfunction f(x) {\n  return x * 2;\n\n\n  // blank lines inside the fence\n}\n```\n\nAfter the code.\n\n```\nunclosed fence at the end\n\nstill inside',
  'Inline math $a^2 + b^2 = c^2$ and \\(x\\).\n\n$$\n\\int_0^1 x\\,dx\n\n= \\frac12\n$$\n\nText after math.\n\n\\[\nE = mc^2\n\\]\n\n$$x$$\n\nCosts $5 and $10.',
  '| Name | Price |\n|:-----|------:|\n| a | $1 |\n| b | $2 |\n\nAfter the table.\nfoo | bar\n|---|---|\n\n> quote line\n> more\n\n> second quote\n\n---\n\n# Heading\n\n## Sub ##\n\n  # indented hash',
  '- [ ] todo\n- [x] done\n\n  continuation, indented\n\n10. ten\n11. eleven\n\n~~~py\nprint("hi")\n\n~~~\n\n***\n\nend',
  'Para one\nline two\n\n\n\nAfter many blanks   \n   \n\t\nwhitespace-only lines above\n\n````md\n```js\ninner\n```\n````\n\nok',
  'A list, then a fence\n- item\n  ```\n  code in the list\n\n```\nreal fence\n\n```\n\n- after',
];
// Replies made of random lines, for the cases nobody thought of.
const LINES = ['Text line.', 'More *text*', '', '', '```js', '```', '~~~', '$$', '\\[', '\\]', '$$x$$', '- item', '  - sub', '1. one', '2) two', '| a | b |', '|---|---|', '| 1 | 2 |', '> q', '# H', '***', '  indented', 'a $m$ b'];
let seed = 11;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let k = 0; k < 150; k++) REPLIES.push(Array.from({ length: 5 + rnd(30) }, () => LINES[rnd(LINES.length)]).join('\n'));

// What the reply's body shows after each token: the finished blocks drawn once, then the rest.
function stream(text, each) {
  let content = '', head = '', headHtml = '';
  for (let pos = 0; pos < text.length;) {
    const n = 1 + rnd(8);
    content += text.slice(pos, pos + n); pos += n;
    const cut = stableCut(content, head.length);
    assert.ok(cut >= head.length, 'the finished part only grows');
    if (cut > head.length) { headHtml += md(content.slice(head.length, cut)); head = content.slice(0, cut); }
    each(content, headHtml + md(content.slice(cut)), cut);
  }
}

test('markdown: a reply drawn in pieces while it streams is the whole reply drawn at once, at every token', () => {
  let frames = 0;
  for (const text of REPLIES) stream(text, (content, shown) => { frames++; assert.equal(shown, md(content)); });
  assert.ok(frames > 5000);
});

test('markdown: local paths are marked for File Explorer links; commands, web links and network paths are not', () => {
  const paths = (s) => [...md(s).matchAll(/data-path="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(paths('Made `site/index.html`, `package.json` and `assets/`'), ['site/index.html', 'package.json', 'assets/']);
  assert.deepEqual(paths('Saved to D:\\Work\\quorx\\index.html.'), ['D:\\Work\\quorx\\index.html'], 'a bare full path, without the full stop');
  assert.deepEqual(paths('In **C:\\x_y\\z.txt**'), ['C:\\x_y\\z.txt']);
  assert.deepEqual(paths('`C:/Users/x/a b/c.txt` and `file:///D:/a/b.html`'), ['C:/Users/x/a b/c.txt', 'file:///D:/a/b.html']);
  assert.deepEqual(paths('See [the page](site/index.html) or [web](https://example.com/a.html)'), ['site/index.html']);
  assert.deepEqual(paths('Run `npm run dev`, `npm -v`, `\\\\server\\share\\x.txt`, `https://a.com/x.js`, `./` or `v1.2`'), []);
  assert.doesNotMatch(md('[x](javascript:alert(1))'), /data-path|<a /, 'a script link stays text');
  assert.match(md('`a"b.txt`'), /<code class="md-ic">a&quot;b.txt<\/code>/, 'a quote is never a path');
});

test('markdown: the finished part never ends inside a code fence or a math block', () => {
  const text = 'Intro.\n\n```js\na\n\nb\n```\n\n$$\nx\n\ny\n$$\n\nEnd.\n';
  const cuts = new Set();
  stream(text, (content, _, cut) => cuts.add(content.slice(0, cut)));
  for (const head of cuts) {
    assert.equal((head.match(/^```/gm) || []).length % 2, 0, `cut inside the fence: ${JSON.stringify(head)}`);
    assert.equal((head.match(/^\$\$/gm) || []).length % 2, 0, `cut inside the math: ${JSON.stringify(head)}`);
  }
  assert.equal(stableCut('a\n\n```\nopen\n\nstill open\n'), 3, 'an open fence stays in the tail');
  assert.equal(stableCut('a\n\n'), 3, 'a blank line with a line after it');
  assert.equal(stableCut('a\n'), 0, 'the last line is still being written');
  assert.equal(stableCut('a\r\n\r\nb'), 0, 'text with \\r is drawn whole');
});

// 🔊 Read aloud (public/speak.js): the sentences read and lit one at a time, and the voice that reads them.
test('read aloud: a reply splits into the sentences it reads, with offsets for the highlight; a local voice in the language reads them', () => {
  const text = 'The game now saves your high score.  It shows under the score! Reload to see it? Version 2.1 works.';
  const parts = sentencePieces(text, 'en');
  assert.deepEqual(parts.map((x) => x.text), ['The game now saves your high score.', 'It shows under the score!', 'Reload to see it?', 'Version 2.1 works.']);
  for (const x of parts) assert.equal(text.slice(x.from, x.to), x.text, 'the offsets cover the sentence, without the spaces around it');
  assert.deepEqual(sentencePieces('— • ', 'en'), [], 'nothing with no letter or digit is read');
  assert.deepEqual(sentencePieces('', 'en'), []);
  assert.deepEqual(sentencePieces('No full stop at the end', 'xx-not-a-lang').map((x) => x.text), ['No full stop at the end'], 'an odd language still splits');
  const v = (name, lang, local = true, def = false) => ({ name, lang, localService: local, default: def });
  const voices = [v('Online US', 'en-US', false, true), v('David', 'en-US', true, false), v('Zira', 'en-US', true, false), v('Hazel', 'en-GB'), v('Hortense', 'fr-FR')];
  assert.equal(pickVoice(voices, 'en-US').name, 'David', 'a voice on this computer before one that sends the text away');
  assert.equal(pickVoice([v('David', 'en-US'), v('Zira', 'en-US', true, true)], 'en-US').name, 'Zira', 'the system default first');
  assert.equal(pickVoice(voices, 'en-IN').name, 'David', 'the same language family');
  assert.equal(pickVoice(voices, 'fr_FR').name, 'Hortense');
  assert.equal(pickVoice([v('Online', 'en-US', false, true)], 'de-DE').name, 'Online', 'nothing local: the default');
  assert.equal(pickVoice([], 'en-US'), null, 'no voices yet: the browser picks');
});
