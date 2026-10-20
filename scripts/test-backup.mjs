// Export my QuorX / Import, through the API with the app key: two throwaway QuorX homes stand in for two computers.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-or-v1-backuptestkey0123456789';
const BLOB = `${'ab'.repeat(32)}.png`;

// A QuorX on its own home and a free port; resolves to { call, home, stop }. No job host: these servers run no commands,
// and one would share the computer's command jobs with the tests that check stopping them.
async function quorx(home) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, OH_HOME: home, AGENT_PORT: '0', AGENT_HOST: '127.0.0.1', OPENROUTER_API_KEY: '', OPENROUTER_API_KEY_BOT: '', QX_NO_JOBHOST: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`QuorX did not start:\n${out}`)), 30000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(/QuorX → http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`QuorX exited (${c}):\n${out}`)); });
  });
  const appKey = fs.readFileSync(path.join(home, 'data', 'app-key'), 'utf8').trim();
  const call = async (p, body, key = appKey) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(key ? { 'x-quorx-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined })
      .catch((e) => { throw new Error(`${p}: ${e.cause?.code || e.message} (exit ${child.exitCode}); QuorX said:
${out.slice(-1500)}`); });
    return { status: r.status, body: await r.json() };
  };
  return { call, home, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

// Computer A: two projects (one whose folder won't exist on B), a chat with a picture, rules, a schedule, logs, a key.
function homeA() {
  const home = tempDir('qx-backup-a-'), data = path.join(home, 'data');
  const keep = tempDir('qx-proj-keep-'), gone = tempDir('qx-proj-gone-');
  fs.mkdirSync(path.join(data, 'chats'), { recursive: true });
  fs.mkdirSync(path.join(data, 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify([
    { id: 'keep-app', name: path.basename(keep), path: keep, created: 1, color: '#c0392b', budget: 5 },
    { id: 'moved-app', name: path.basename(gone), path: gone, created: 2 },
  ]));
  fs.writeFileSync(path.join(data, 'chats', 'chat-one.json'), JSON.stringify({ id: 'chat-one', title: 'Round trip', projectId: 'keep-app', agent: { setup: {}, messages: [{ role: 'user', content: 'hello', images: [`blob:${BLOB}`] }] } }));
  fs.writeFileSync(path.join(data, 'blobs', BLOB), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(data, 'permissions.json'), JSON.stringify({ version: 1, rules: [{ effect: 'allow', match: 'npm test', by: 'user', note: '', at: 1 }] }));
  fs.writeFileSync(path.join(data, 'schedules.json'), JSON.stringify([{ id: 'nightly', prompt: 'check the build', cron: '0 3 * * *' }]));
  fs.writeFileSync(path.join(data, 'keys.json'), JSON.stringify({ active: 'k1', keys: [{ id: 'k1', label: 'Mine', key: KEY, added: 1 }] }));
  fs.writeFileSync(path.join(home, 'logs', 'audit.jsonl'), '{"t":"run"}\n');
  fs.writeFileSync(path.join(home, 'logs', 'bench-build-x.jsonl'), '{"bench":1}\n');
  return { home, keep, gone };
}
const entries = (file) => { const buf = fs.readFileSync(file), names = []; for (let i = 0; i + 46 < buf.length; i++) if (buf.readUInt32LE(i) === 0x02014b50) { const n = buf.readUInt16LE(i + 28); names.push(buf.toString('utf8', i + 46, i + 46 + n)); } return names; };

test('backup calls need the app key', async () => {
  const qx = await quorx(tempDir('qx-backup-key-'));
  try {
    const r = await qx.call('/api/backup/export', { dir: tempDir('qx-out-') }, '');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'APP_KEY');
  } finally { await qx.stop(); }
});

test('export leaves the API keys out unless both boxes are ticked, and logs out unless asked', async () => {
  const a = homeA(), qx = await quorx(a.home);
  try {
    const out = tempDir('qx-out-');
    const plain = (await qx.call('/api/backup/export', { dir: out, settings: { settings: { theme: 'dark' } } })).body;
    assert.ok(!plain.error, plain.error);
    assert.equal(plain.counts.keys, 0);
    const names = entries(plain.file);
    assert.ok(!names.includes('keys.json'), 'no keys by default');
    assert.ok(!names.some((n) => n.startsWith('logs/')), 'no logs by default');
    assert.ok(!fs.readFileSync(plain.file).includes(Buffer.from(KEY)), 'the key text is nowhere in the file');
    assert.ok(!names.some((n) => /app-key|access\.json|key-usage/.test(n)), 'never the app key or pairing');
    const half = (await qx.call('/api/backup/export', { dir: out, keys: true })).body;
    assert.ok(!entries(half.file).includes('keys.json'), 'one box is not enough');
    const full = (await qx.call('/api/backup/export', { dir: out, keys: true, keysWarned: true, logs: true })).body;
    assert.equal(full.counts.keys, 1);
    const fullNames = entries(full.file);
    assert.ok(fullNames.includes('keys.json') && fullNames.includes('logs/audit.jsonl'));
    assert.ok(!fullNames.includes('logs/bench-build-x.jsonl'), 'benchmark logs are not the user\'s own');
    assert.notEqual(path.basename(plain.file), path.basename(full.file), 'a second backup the same day gets its own name');
  } finally { await qx.stop(); }
});

test('round trip: import on another computer asks before overwriting and re-points a missing folder', async () => {
  const a = homeA(), qa = await quorx(a.home);
  let file;
  try {
    // A project rule, kept by the project's folder.
    assert.ok((await qa.call('/api/permissions', { scope: 'project', projectId: 'keep-app', rules: [{ effect: 'deny', match: 'git push *' }] })).body.ok);
    file = (await qa.call('/api/backup/export', { dir: tempDir('qx-out-'), settings: { settings: { theme: 'dark', approval: 'strict' } }, logs: true })).body.file;
  } finally { await qa.stop(); }
  fs.rmSync(a.gone, { recursive: true, force: true }); // that project's folder isn't on computer B

  const bHome = tempDir('qx-backup-b-');
  fs.mkdirSync(path.join(bHome, 'data', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(bHome, 'data', 'chats', 'chat-one.json'), JSON.stringify({ id: 'chat-one', title: 'Already here', agent: { messages: [] } }));
  const qb = await quorx(bHome);
  try {
    const found = (await qb.call('/api/backup/find', { dir: path.dirname(file) })).body.backups;
    assert.equal(found[0].file, file);
    const look = (await qb.call('/api/backup/inspect', { file })).body;
    assert.equal(look.chats, 1);
    assert.equal(look.chatClashes, 1, 'the clash is reported before anything is written');
    assert.equal(look.keys, 0);
    assert.deepEqual(look.projects.map((p) => [p.id, p.found]).sort(), [['keep-app', true], ['moved-app', false]]);

    // Without overwrite the chat that is here stays as it is.
    const moved = tempDir('qx-proj-new-');
    const r1 = (await qb.call('/api/backup/import', { file, folders: { 'moved-app': moved } })).body;
    assert.ok(!r1.error, r1.error);
    assert.equal(r1.chats, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(bHome, 'data', 'chats', 'chat-one.json'), 'utf8')).title, 'Already here');
    assert.equal(r1.settings.settings.approval, 'strict', 'settings come back for the page');
    const projects = (await qb.call('/api/projects')).body;
    const keep = projects.find((p) => p.id === 'keep-app'), mv = projects.find((p) => p.id === 'moved-app');
    assert.equal(keep.color, '#c0392b');
    assert.equal(keep.budget, 5);
    assert.equal(path.resolve(mv.path), path.resolve(moved), 're-pointed');
    assert.ok(!mv.missing);
    const rules = (await qb.call('/api/permissions?project=keep-app')).body;
    assert.ok(rules.project.some((r) => r.match === 'git push *' && r.effect === 'deny'), 'the project rule follows its project');
    assert.ok(rules.everywhere.some((r) => r.match === 'npm test'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bHome, 'data', 'schedules.json'), 'utf8')).map((s) => s.id), ['nightly']);
    assert.ok(fs.existsSync(path.join(bHome, 'data', 'blobs', BLOB)), 'the chat\'s picture came along');
    assert.ok(fs.readdirSync(path.join(bHome, 'logs')).some((d) => d.startsWith('imported-')));
    assert.ok(!fs.existsSync(path.join(bHome, 'data', 'keys.json')), 'no keys were in it, none appear');

    // With overwrite the backup's chat replaces it; importing again adds no duplicate rules.
    const r2 = (await qb.call('/api/backup/import', { file, overwrite: true, folders: { 'moved-app': moved } })).body;
    assert.equal(r2.chats, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(bHome, 'data', 'chats', 'chat-one.json'), 'utf8')).title, 'Round trip');
    const again = (await qb.call('/api/permissions?project=keep-app')).body;
    assert.equal(again.everywhere.filter((r) => r.match === 'npm test').length, 1);

    // A folder that doesn't exist is refused before anything changes.
    const bad = (await qb.call('/api/backup/import', { file, folders: { 'moved-app': path.join(moved, 'nope') } })).body;
    assert.match(bad.error, /no folder/);
  } finally { await qb.stop(); }
});

test('a backup restores into a fresh QuorX home without losing projects or chats', async () => {
  const a = homeA(), qa = await quorx(a.home);
  let file, before;
  try {
    before = { projects: (await qa.call('/api/projects')).body.filter((p) => p.id !== 'scratch'), chats: (await qa.call('/api/chats')).body };
    file = (await qa.call('/api/backup/export', { dir: tempDir('qx-out-') })).body.file;
  } finally { await qa.stop(); }
  const qb = await quorx(tempDir('qx-backup-fresh-'));
  try {
    const r = (await qb.call('/api/backup/import', { file })).body;
    assert.ok(!r.error, r.error);
    const projects = (await qb.call('/api/projects')).body, chats = (await qb.call('/api/chats')).body;
    for (const p of before.projects) {
      const got = projects.find((x) => x.id === p.id);
      assert.ok(got, `project ${p.id} restored`);
      assert.equal(path.resolve(got.path), path.resolve(p.path));
      assert.equal(got.color, p.color);
    }
    assert.deepEqual(chats.map((c) => c.id).sort(), before.chats.map((c) => c.id).sort(), 'every chat restored');
    const one = (await qb.call('/api/chats/chat-one')).body;
    assert.equal(one.title, 'Round trip');
    assert.equal(one.projectId, 'keep-app');
  } finally { await qb.stop(); }
});

test('keys come back only when the backup has them and the import asks for them', async () => {
  const a = homeA(), qa = await quorx(a.home);
  let file;
  try { file = (await qa.call('/api/backup/export', { dir: tempDir('qx-out-'), keys: true, keysWarned: true })).body.file; } finally { await qa.stop(); }
  const qb = await quorx(tempDir('qx-backup-b-'));
  try {
    assert.equal((await qb.call('/api/backup/inspect', { file })).body.keys, 1);
    await qb.call('/api/backup/import', { file });
    assert.equal((await qb.call('/api/keys')).body.length, 0, 'not without asking');
    const r = (await qb.call('/api/backup/import', { file, keys: true })).body;
    assert.equal(r.keys, 1);
    assert.equal((await qb.call('/api/keys')).body[0].masked.endsWith(KEY.slice(-4)), true);
  } finally { await qb.stop(); }
});

test('import refuses a file that is not a QuorX backup', async () => {
  const qx = await quorx(tempDir('qx-backup-c-'));
  try {
    const f = path.join(tempDir('qx-out-'), 'quorx-backup-fake.zip');
    fs.writeFileSync(f, 'not a zip');
    assert.match((await qx.call('/api/backup/inspect', { file: f })).body.error, /not a QuorX backup/);
  } finally { await qx.stop(); }
});
