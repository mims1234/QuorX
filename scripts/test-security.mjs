// Tests for the harness's own protections: who may connect, file paths, commands, and media kept as blobs.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostAllowed, crossSiteApi, gate, isLoopback, appGate, appKey } from '../server/access.js';
import { privateAddress } from '../server/safefetch.js';
import { decide, agentWriteBlocked } from '../server/cmdpolicy.js';
import { safePath, checkCommand, searchFiles } from '../server/workspace.js';
import { externalize, blobData } from '../server/blobs.js';

const req = ({ host = 'localhost:5188', ip = '127.0.0.1', site, cookie, headers = {} } = {}) => ({ headers: { host, ...(site ? { 'sec-fetch-site': site } : {}), ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: ip } });
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

test('only this computer may use QuorX: other devices are refused, with no way to pair', () => {
  const url = (p) => new URL(p, 'http://x');
  assert.equal(gate(req({ ip: '::ffff:127.0.0.1' }), res(), url('/api/chats')), false);
  assert.ok(isLoopback(req({ ip: '::1' })));
  for (const p of ['/api/chats', '/', '/?pair=anything']) {
    const r = res();
    assert.equal(gate(req({ ip: '192.168.1.50' }), r, url(p)), true, p);
    assert.equal(r.code, 403, p);
    assert.ok(!r.headers['Set-Cookie'], 'nothing signs another device in');
  }
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

test('a whole command line in command says how to split it, not that the program is not allowed', () => {
  assert.throws(() => checkCommand('node hub/server.mjs', []), /use command "node" with args \["hub\/server\.mjs"\]/);
  assert.throws(() => checkCommand('npm run dev', ['--', '--port', '{PORT}']), /use command "npm" with args \["run","dev","--","--port","\{PORT\}"\]/);
  assert.throws(() => checkCommand('cmd /c dir', []), /"cmd \/c dir" is not allowed/);
});

test('the static site server answers this computer on its port', async () => {
  const src = fs.readFileSync(new URL('../server/serve-static.mjs', import.meta.url), 'utf8');
  const strip = new Function(`return ${src.match(/\.replace\((\/[^/]+\/), ''\)/)[1]}`)();
  assert.equal('localhost:5300'.replace(strip, ''), 'localhost');
  assert.equal('[::1]:8080'.replace(strip, ''), '[::1]');
});

test('a finished reply keeps its result: from the server when it ends, and over a save that lacks it', async () => {
  const { saveChat, patchChat, getChat, settleReply } = await import('../server/store.js');
  const user = { role: 'user', content: 'go', at: 1 };
  const running = { role: 'assistant', content: '', at: 2, runId: 'run-settle-1', trace: [{ t: 'llm_start', step: 0 }], live: false, runActive: true };
  const first = saveChat('settle-chat', { title: 'Settle', projectId: 'scratch', created: 1, agent: { setup: {}, messages: [user, running], artifacts: {} } });
  const stats = { cost: 0.01, steps: 3 };
  assert.equal(settleReply('settle-chat', 'run-settle-1', { t: 'done', reply: 'All done.', historyNote: '[note]', stats }), true);
  let m = getChat('settle-chat').agent.messages[1];
  assert.equal(m.content, 'All done.'); assert.deepEqual(m.stats, stats); assert.equal(m.runActive, false);
  assert.equal(m.trace.length, 1, 'the steps the page saved stay');
  // Already settled (or saved by the page): left alone.
  assert.equal(settleReply('settle-chat', 'run-settle-1', { t: 'done', reply: 'other', stats }), false);
  // A page with an old copy of that reply (no text, no totals) saves whole, then patches: the result stays.
  saveChat('settle-chat', { title: 'Settle', projectId: 'scratch', created: 1, agent: { setup: {}, messages: [user, { ...running, runActive: false, trace: [1, 2] }], artifacts: {} } });
  m = getChat('settle-chat').agent.messages[1];
  assert.equal(m.content, 'All done.'); assert.equal(m.stats.cost, 0.01); assert.deepEqual(m.trace, [1, 2], 'the newer steps are kept');
  const rev = getChat('settle-chat').rev;
  patchChat('settle-chat', { base: rev, count: 2, messages: { 1: { ...running, content: '', error: 'Lost the connection' } } });
  m = getChat('settle-chat').agent.messages[1];
  assert.equal(m.content, 'All done.'); assert.equal(m.error, undefined);
  // A page that has the text keeps its own; a different run in the same place is not touched.
  saveChat('settle-chat', { title: 'Settle', projectId: 'scratch', created: 1, agent: { setup: {}, messages: [user, { ...running, content: 'Edited', stats: { cost: 0.02 } }, { ...running, runId: 'run-settle-2' }], artifacts: {} } });
  const ms = getChat('settle-chat').agent.messages;
  assert.equal(ms[1].content, 'Edited'); assert.equal(ms[2].content, ''); assert.equal(ms[2].stats, undefined);
  // A failed run records its error once.
  assert.equal(settleReply('settle-chat', 'run-settle-2', { t: 'error', msg: 'boom' }), true);
  assert.equal(getChat('settle-chat').agent.messages[2].error, 'boom');
  assert.ok(first.rev);
});

test('a run cut off by a restart is interrupted at once, not "elsewhere" for 90 seconds', async () => {
  const { runStatus } = await import('../server/runs.js');
  const dir = path.join(process.env.OH_HOME, 'data', 'runs');
  const log = (id, pid) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ t: 'run', runId: id, chatId: 'c', ...(pid ? { pid } : {}), at: 0 })}\n${JSON.stringify({ t: 'llm_start', step: 0 })}\n`);
  log('cut-dead', 2 ** 22 + 12345); // no such process
  fs.writeFileSync(path.join(dir, 'cut-dead.ckpt.json'), '{}');
  assert.deepEqual([runStatus('cut-dead').status, runStatus('cut-dead').resumable], ['interrupted', true]);
  log('cut-self', process.pid); // this process wrote it and has no such run: it restarted with the same pid
  assert.equal(runStatus('cut-self').status, 'interrupted');
  log('cut-other', process.ppid); // a live QuorX that isn't this one
  assert.equal(runStatus('cut-other').status, 'elsewhere');
  log('cut-old'); // an older log without a pid: the 90-second rule
  assert.equal(runStatus('cut-old').status, 'elsewhere');
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

test('/api on this computer needs the app key; the app link sets it', () => {
  const u = (p) => new URL(p, 'http://x');
  const r1 = res();
  assert.equal(appGate(req({ ip: '127.0.0.1' }), r1, u('/api/chats')), true);
  assert.equal(r1.code, 401, 'a program on this computer without the key');
  assert.equal(appGate(req({ ip: '127.0.0.1' }), res(), u('/api/config')), false, 'the version check stays open');
  assert.equal(appGate(req({ ip: '127.0.0.1', headers: { cookie: `qx_app=${appKey}` } }), res(), u('/api/chats')), false);
  assert.equal(appGate(req({ ip: '127.0.0.1', headers: { 'x-quorx-key': appKey } }), res(), u('/api/chats')), false);
  const r2 = res();
  assert.equal(appGate(req({ ip: '127.0.0.1' }), r2, u(`/?k=${appKey}`)), true);
  assert.equal(r2.code, 302);
  const r3 = res();
  assert.equal(appGate(req({ ip: '127.0.0.1' }), r3, u('/?k=wrong')), true);
  assert.equal(r3.code, 401);
});

test('fetch_url refuses private, loopback and link-local addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.ok(privateAddress(ip), ip);
  for (const ip of ['93.184.215.14', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!privateAddress(ip), ip);
});

test('read commands: keys never, outside the project asks; QuorX itself never', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-sec-'));
  const v = async (line) => (await decide(line, { shell: 'bash', root, mode: 'strict', rules: [] })).verdict;
  const fwd = (p) => p.split(path.sep).join('/');
  assert.equal(await v(`cat ${fwd(path.join(os.homedir(), '.ssh', 'id_ed25519'))}`), 'deny');
  assert.equal(await v(`cat ${fwd(path.join(process.env.OH_HOME, 'data', 'app-key'))}`), 'deny');
  assert.equal(await v(`cat ${fwd(path.join(os.tmpdir(), 'elsewhere.txt'))}`), 'ask');
  assert.equal(await v('cat README.md'), 'allow');
  assert.equal(await v('curl http://127.0.0.1:5188/api/config'), 'deny');
});

test('the write guard judges where a path lands, not how it is spelled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-sec-'));
  for (const p of ['.quorx/permissions.json', path.join(root, '.quorx', 'x.json'), 'src/../.quorx/x.json', path.join(root, '.claude', 'settings.json')]) {
    const real = path.relative(root, safePath(root, p));
    assert.ok(agentWriteBlocked(real), p);
  }
});

test('search_files does not follow links out of the project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-sec-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-out-'));
  fs.writeFileSync(path.join(out, 'secret.txt'), 'needle-outside');
  fs.writeFileSync(path.join(root, 'a.txt'), 'needle-inside');
  try { fs.symlinkSync(path.join(out, 'secret.txt'), path.join(root, 'link.txt')); } catch { return t.skip('this account cannot make links'); }
  const hits = searchFiles(root, 'needle');
  assert.deepEqual(hits.map((h) => h.path), ['a.txt']);
});

// ---------- the data folder lock-down (server/keys.js) keeps every file readable by its owner ----------
test('data folder: 0.2.5 locked files are repaired at start, and the lock-down keeps them readable', { skip: process.platform !== 'win32' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const home = tempDir('qx-lock-');
  fs.mkdirSync(path.join(home, 'data', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(home, 'data', 'app-key'), 'k'.repeat(43));
  fs.writeFileSync(path.join(home, 'data', 'chats', 'c1.json'), '{}');
  // What 0.2.5 did: strip inheritance from every file and leave it with no access at all.
  spawnSync('icacls', [path.join(home, 'data'), '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(OI)(CI)F`, '/T', '/Q'], { windowsHide: true });
  assert.throws(() => fs.readFileSync(path.join(home, 'data', 'chats', 'c1.json')), /EPERM|EACCES/, 'the 0.2.5 damage is reproduced');
  // The fixed lockDown, run as QuorX runs it, with this folder as its home.
  const keys = new URL('../server/keys.js', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const { lockDown } = await import(${JSON.stringify(keys)}); lockDown();`], { env: { ...process.env, OH_HOME: home }, windowsHide: true, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(home, 'data', 'app-key'), 'utf8'), 'k'.repeat(43));
  assert.equal(fs.readFileSync(path.join(home, 'data', 'chats', 'c1.json'), 'utf8'), '{}');
  // Still private: the folder grants only this account and SYSTEM, and the files inherit just that.
  const acl = spawnSync('icacls', [path.join(home, 'data', 'chats', 'c1.json')], { encoding: 'utf8', windowsHide: true }).stdout;
  assert.match(acl, new RegExp(`${process.env.USERNAME}:\\(I\\)\\(F\\)`, 'i'));
  assert.doesNotMatch(acl, /Users:|Everyone:|Authenticated Users:/i);
  fs.rmSync(home, { recursive: true, force: true });
});

test('two QuorX on one computer keep their own cookies: each name carries the port', () => {
  const at = (port, cookie) => ({ headers: { host: `localhost:${port}`, ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: '127.0.0.1', localPort: port } });
  const u = (p) => new URL(p, 'http://x');
  const r = res();
  assert.equal(appGate(at(5233), r, u(`/?k=${appKey}`)), true);
  assert.match(r.headers['Set-Cookie'], /^qx_app_5233=/, 'the app link sets this port\'s cookie');
  // Another QuorX on 5262 (its own data folder, so its own key) set its cookie for the same host.
  const both = `qx_app_5262=someone-elses-key-0123456789abcdefghijkl; qx_app_5233=${appKey}`;
  assert.equal(appGate(at(5233, both), res(), u('/api/chats')), false, 'this one stays signed in');
  const r2 = res();
  assert.equal(appGate(at(5262, `qx_app_5233=${appKey}`), r2, u('/api/chats')), true, "this key doesn't open the other port");
  assert.equal(r2.code, 401);
  assert.equal(appGate(at(5233, `qx_app=${appKey}`), res(), u('/api/chats')), false, 'the old cookie name still works for now');
  assert.equal(appGate(at(5233, `qx_app=${appKey}; qx_app_5233=wrong`), res(), u('/api/chats')), true, "this port's cookie wins over the old one");
});

// A main port above 64535 has no port 1000 above it for the pages address: QuorX must start anyway (it used to crash
// with ERR_SOCKET_BAD_PORT, as when Windows hands a test a high free port).
test('QuorX starts on a main port near the top of the range', async () => {
  const { spawn } = await import('node:child_process');
  const home = tempDir('qx-highport-');
  const child = spawn(process.execPath, [path.resolve('server.js')], { env: { ...process.env, OH_HOME: home, AGENT_PORT: '65000', AGENT_HOST: '127.0.0.1', QX_NO_JOBHOST: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 30000);
      child.stdout.on('data', (d) => { out += d; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.stderr.on('data', (d) => { out += d; });
      child.once('exit', (c) => { clearTimeout(t); reject(new Error(`QuorX exited (${c}):\n${out}`)); });
    });
    assert.ok(port > 64535, `started on ${port}`);
    await new Promise((r) => setTimeout(r, 1500)); // the pages address is set up just after
    assert.equal(child.exitCode, null, `QuorX is still running:\n${out}`);
    const cfg = await fetch(`http://127.0.0.1:${port}/api/config`).then((r) => r.json());
    assert.ok(cfg.pagePort > 0 && cfg.pagePort <= 65535, `pages on ${cfg.pagePort}`);
  } finally { child.kill(); }
});

// After "Sign in with OpenRouter" the desktop app's tab is the user's own browser, which can't open QuorX's pages.
test('sign-in finish: in the desktop app the tab says to go back to the QuorX window, with no link into QuorX', async () => {
  const { callbackPage } = await import('../server/oauth.js');
  const desk = callbackPage({ ok: true, desktop: true });
  assert.match(desk, /Close this tab and go back to the QuorX window/);
  assert.doesNotMatch(desk, /href=/, 'no link the browser could not open');
  assert.doesNotMatch(callbackPage({ ok: false, message: 'OpenRouter said no.', desktop: true }), /href=/);
  assert.match(callbackPage({ ok: true }), /href="\/"/, 'a browser QuorX already opened keeps its way back');
});
