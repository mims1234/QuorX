// Tests for the harness's own protections: who may connect, file paths, commands, and media kept as blobs.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostAllowed, crossSiteApi, gate, isLoopback } from '../server/access.js';
import { safePath, checkCommand } from '../server/workspace.js';
import { externalize, blobData } from '../server/blobs.js';

const req = ({ host = 'localhost:5188', ip = '127.0.0.1', site, cookie } = {}) => ({ headers: { host, ...(site ? { 'sec-fetch-site': site } : {}), ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: ip } });
const res = () => { const r = { code: 0, headers: {}, body: '' }; r.writeHead = (c, h = {}) => { r.code = c; Object.assign(r.headers, h); return r; }; r.end = (b = '') => { r.body += b; return r; }; return r; };

test('the Host must name this computer: names a web page could rebind are refused', () => {
  for (const h of ['localhost:5188', '127.0.0.1:5188', '[::1]:5188', '192.168.1.20:5188', `${os.hostname()}:5188`]) assert.ok(hostAllowed(req({ host: h })), h);
  for (const h of ['evil.example:5188', 'localhost.:5188', 'app.localhost:5188', '']) assert.ok(!hostAllowed(req({ host: h })), h || '(none)');
});

test('/api refuses other sites and other origins on this computer; pages and same-origin calls pass', () => {
  assert.ok(crossSiteApi(req({ site: 'cross-site' }), '/api/term/run'));
  assert.ok(crossSiteApi(req({ site: 'same-site' }), '/api/checkpoints'), 'an agent dev server on another localhost port');
  assert.ok(!crossSiteApi(req({ site: 'same-origin' }), '/api/chats'));
  assert.ok(!crossSiteApi(req({}), '/api/chats'), 'no header: Node clients and old browsers');
  assert.ok(!crossSiteApi(req({ site: 'cross-site' }), '/ws/p1/index.html'), 'project files stay loadable by sandboxed pages');
});

test('other devices must pair; this computer never has to', () => {
  const url = (p) => new URL(p, 'http://x');
  assert.equal(gate(req({ ip: '::ffff:127.0.0.1' }), res(), url('/api/chats')), false);
  assert.ok(isLoopback(req({ ip: '::1' })));
  const r1 = res();
  assert.equal(gate(req({ ip: '192.168.1.50' }), r1, url('/api/chats')), true);
  assert.equal(r1.code, 401);
  const r2 = res();
  assert.equal(gate(req({ ip: '192.168.1.51' }), r2, url('/?pair=wrong')), true);
  assert.equal(r2.code, 401);
  const token = JSON.parse(fs.readFileSync(path.join(process.env.OH_HOME, 'data', 'access.json'), 'utf8')).token;
  const r3 = res();
  assert.equal(gate(req({ ip: '192.168.1.52' }), r3, url(`/?pair=${token}`)), true);
  assert.equal(r3.code, 302);
  assert.match(r3.headers['Set-Cookie'], /HttpOnly/);
  assert.equal(gate(req({ ip: '192.168.1.52', cookie: `x=1; oh_pair=${token}` }), res(), url('/api/chats')), false, 'paired');
});

test('file paths stay inside the project: links, streams and device names too', () => {
  const root = tempDir('oh-sec-');
  const outside = tempDir('oh-out-');
  try {
    assert.equal(safePath(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
    assert.equal(safePath(root, path.join(root, 'c.txt')), path.join(root, 'c.txt'), 'an absolute path inside the project');
    assert.throws(() => safePath(root, '../x.txt'), /outside/);
    if (process.platform === 'win32') {
      assert.throws(() => safePath(root, 'notes.txt::$DATA'), /not allowed/);
      assert.throws(() => safePath(root, 'sub/nul'), /not allowed/);
    }
    let linked = true;
    try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); } catch { linked = false; }
    if (linked) assert.throws(() => safePath(root, 'link/secret.txt'), /through a link/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('{PORT} is allowed in server arguments; shell characters are not', () => {
  assert.equal(checkCommand('python', ['-m', 'http.server', '{PORT}']), 'python');
  assert.throws(() => checkCommand('node', ['x.js', '&&', 'calc']), /not allowed/);
  assert.throws(() => checkCommand('cmd', ['/c', 'dir']), /not allowed/);
});

test('big data URLs become blobs, the original is untouched, and a blob reads back', () => {
  const png = `data:image/png;base64,${Buffer.alloc(40000, 7).toString('base64')}`;
  const ev = { t: 'screenshot', image: png, nested: [{ after: png }], small: 'data:image/png;base64,AAAA' };
  const out = externalize(ev);
  assert.match(out.image, /^\/blob\/[0-9a-f]{64}\.png$/);
  assert.equal(out.nested[0].after, out.image, 'the same picture is stored once');
  assert.equal(out.small, ev.small, 'small ones stay inline');
  assert.equal(ev.image, png, 'the original object is not changed');
  assert.equal(blobData(out.image), png);
  const plain = { t: 'note', msg: 'hi' };
  assert.equal(externalize(plain), plain, 'nothing to change: the same object back');
});

test('a chat saves only what changed; a stale patch is refused and a whole save still works', async () => {
  const { saveChat, patchChat, getChat, listChats } = await import('../server/store.js');
  const { artifactContent } = await import('../server/artifacts.js');
  const msg = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}`, at: 1000 + i });
  const chat = { title: 'Patch me', projectId: 'scratch', created: 5, tools: { web: true },
    agent: { setup: { model: 'm1' }, messages: [0, 1, 2].map(msg), artifacts: { a1: { kind: 'md', title: 'Notes', md: 'one', updated: 1 } } } };
  // A whole save, as an older page sends it: no rev in, a rev out.
  const first = saveChat('patch-chat', chat);
  assert.ok(first.rev);
  // A running reply: the last message grows, one artifact changes, another is added; title and setup unchanged.
  const png = `data:image/png;base64,${Buffer.alloc(40000, 9).toString('base64')}`;
  const second = patchChat('patch-chat', { base: first.rev, count: 4, messages: { 2: { ...msg(2), content: 'message 2, edited' }, 3: { ...msg(3), image: png } },
    artifacts: { a1: { kind: 'md', title: 'Notes', md: 'two', updated: 2 }, a2: { kind: 'html', title: 'Page', html: '<p>hi</p>', updated: 2 } } });
  assert.ok(second.rev && second.rev !== first.rev);
  let doc = getChat('patch-chat');
  assert.deepEqual(doc.agent.messages.map((m) => m.content), ['message 0', 'message 1', 'message 2, edited', 'message 3']);
  assert.match(doc.agent.messages[3].image, /^\/blob\//, 'pictures in a patch go to the blob store too');
  assert.equal(doc.title, 'Patch me'); assert.equal(doc.agent.setup.model, 'm1'); assert.equal(doc.created, 5);
  assert.equal(artifactContent('patch-chat', 'a1').text, 'two');
  assert.equal(listChats().find((c) => c.id === 'patch-chat').artifacts, 2, 'the sidebar summary sees the patched file');
  // A patch built on an older rev (another tab saved in between) is refused; nothing changes.
  assert.equal(patchChat('patch-chat', { base: first.rev, count: 1, messages: {} }).stale, true);
  assert.equal(getChat('patch-chat').agent.messages.length, 4);
  // A patch that would leave a gap in the messages is refused too, so the page saves whole.
  assert.equal(patchChat('patch-chat', { base: second.rev, count: 6, messages: { 5: msg(5) } }).stale, true);
  // Fewer messages (a rewind), an artifact removed, and a new title and model (the head).
  const third = patchChat('patch-chat', { base: second.rev, count: 2, messages: {}, artifacts: { a2: null },
    head: { title: 'Renamed', projectId: 'scratch', created: 5, tools: {}, agent: { setup: { model: 'm2' } } } });
  doc = getChat('patch-chat');
  assert.equal(doc.rev, third.rev); assert.equal(doc.agent.messages.length, 2); assert.deepEqual(Object.keys(doc.agent.artifacts), ['a1']);
  assert.equal(doc.title, 'Renamed'); assert.equal(doc.agent.setup.model, 'm2');
  // An older page's whole save after all that still wins, and the next patch from the newer page is then stale.
  const fourth = saveChat('patch-chat', { ...chat, title: 'Old page' });
  assert.equal(getChat('patch-chat').title, 'Old page');
  assert.equal(patchChat('patch-chat', { base: third.rev, count: 3, messages: {} }).stale, true);
  assert.ok(patchChat('patch-chat', { base: fourth.rev, count: 3, messages: {} }).rev);
  assert.throws(() => patchChat('patch-chat', { count: 1 }), /base/);
});
