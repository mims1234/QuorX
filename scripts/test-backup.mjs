// Export my QuorX / Import, through the API with the app key: two throwaway QuorX homes stand in for two computers.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { zipBuffer, writeZip, fileSink, readZip, fileSource } from '../server/zip.js';
import { mergeSettings } from '../public/backup.js';

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
  const call = async (p, body, key = appKey, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(key ? { 'x-quorx-key': key } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined })
      .catch((e) => { throw new Error(`${p}: ${e.cause?.code || e.message} (exit ${child.exitCode}); QuorX said:
${out.slice(-1500)}`); });
    return { status: r.status, body: await r.json() };
  };
  // The pass the page gets after you confirm a key export (the browser marks the page's own request same-origin).
  const keyPass = async () => (await call('/api/backup/key-pass', {}, appKey, { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' })).body.pass;
  return { call, keyPass, home, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
}

// Computer A: two projects (one whose folder won't exist on B), a chat with a picture, rules, a schedule, logs, a key.
function homeA() {
  const home = tempDir('qx-backup-a-'), data = path.join(home, 'data');
  const keep = tempDir('qx-proj-keep-'), gone = tempDir('qx-proj-gone-');
  fs.mkdirSync(path.join(data, 'chats'), { recursive: true });
  fs.mkdirSync(path.join(data, 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify([
    { id: 'keep-app', name: 'Keep App', path: keep, created: 1, color: '#c0392b', budget: 5 },
    { id: 'moved-app', name: path.basename(gone), path: gone, created: 2 },
  ]));
  fs.writeFileSync(path.join(data, 'chats', 'chat-one.json'), JSON.stringify({ id: 'chat-one', title: 'Round trip', projectId: 'keep-app', agent: { setup: {}, messages: [{ role: 'user', content: 'hello', images: [`blob:${BLOB}`] }] } }));
  fs.writeFileSync(path.join(data, 'blobs', BLOB), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(data, 'permissions.json'), JSON.stringify({ version: 1, rules: [{ effect: 'allow', match: 'npm test', by: 'user', note: '', at: 1 }] }));
  fs.writeFileSync(path.join(data, 'schedules.json'), JSON.stringify({ version: 1, schedules: [{ id: 'nightly', prompt: 'check the build', when: { kind: 'daily', at: '03:00' }, approval: 'yolo', paused: false, nextAt: Date.now() + 60e3 }] }));
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
    const both = (await qx.call('/api/backup/export', { dir: out, keys: true, keysWarned: true })).body;
    assert.ok(!entries(both.file).includes('keys.json'), 'both boxes without the confirmation pass are not enough');
    assert.equal((await qx.call('/api/backup/key-pass', {})).status, 403, 'only the page itself gets a pass');
    const pass = await qx.keyPass();
    const full = (await qx.call('/api/backup/export', { dir: out, keys: true, keysWarned: true, logs: true, keyPass: pass })).body;
    const again = (await qx.call('/api/backup/export', { dir: out, keys: true, keysWarned: true, keyPass: pass })).body;
    assert.ok(!entries(again.file).includes('keys.json'), 'a pass works once');
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
    assert.equal(keep.name, 'Keep App', 'the project keeps its own name');
    assert.equal(path.resolve(mv.path), path.resolve(moved), 're-pointed');
    assert.ok(!mv.missing);
    const rules = (await qb.call('/api/permissions?project=keep-app')).body;
    assert.ok(rules.project.some((r) => r.match === 'git push *' && r.effect === 'deny'), 'the project rule follows its project');
    assert.ok(rules.everywhere.some((r) => r.match === 'npm test'));
    const sched = JSON.parse(fs.readFileSync(path.join(bHome, 'data', 'schedules.json'), 'utf8')).schedules;
    assert.deepEqual(sched.map((s) => [s.id, s.paused, s.nextAt]), [['nightly', true, null]], 'an imported schedule arrives paused');
    assert.equal(r1.paused, 1);
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

test('your own skills and memory go in the backup and come back, keeping what is here unless asked to replace it', async () => {
  const a = tempDir('qx-backup-sk-a-'), da = path.join(a, 'data');
  fs.mkdirSync(path.join(da, 'skills', 'release-notes', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(da, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: From the git log\n---\n1. Read the log');
  fs.writeFileSync(path.join(da, 'skills', 'release-notes', 'refs', 'style.md'), 'Short lines.');
  fs.mkdirSync(path.join(da, 'skills', 'no-skill-md'), { recursive: true });
  fs.writeFileSync(path.join(da, 'skills', 'no-skill-md', 'notes.txt'), 'not a skill');
  fs.writeFileSync(path.join(da, 'memory.json'), JSON.stringify({ version: 1, on: true, items: [{ id: 'm1', text: 'I use pnpm', by: 'you', at: 1 }, { id: 'm2', text: 'Prefer dark themes', by: 'you', at: 2 }] }));
  const qa = await quorx(a);
  let file;
  try {
    const r = (await qa.call('/api/backup/export', { dir: tempDir('qx-out-') })).body;
    assert.ok(!r.error, r.error);
    assert.equal(r.counts.skills, 1, 'only folders with a SKILL.md');
    assert.equal(r.counts.memory, 2);
    const names = entries(r.file);
    assert.ok(names.includes('skills/release-notes/SKILL.md') && names.includes('skills/release-notes/refs/style.md'), 'every file in the skill');
    assert.ok(names.includes('memory.json'));
    assert.ok(!names.some((n) => n.includes('no-skill-md')));
    file = r.file;
  } finally { await qa.stop(); }

  // Computer B has its own skill of the same name and one memory item, one of them the same as the backup's.
  const b = tempDir('qx-backup-sk-b-'), db = path.join(b, 'data');
  fs.mkdirSync(path.join(db, 'skills', 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(db, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Mine\n---\nMine');
  fs.writeFileSync(path.join(db, 'memory.json'), JSON.stringify({ version: 1, on: true, items: [{ id: 'x1', text: 'i use pnpm', by: 'you', at: 1 }, { id: 'x2', text: 'Answer in English', by: 'you', at: 2 }] }));
  const qb = await quorx(b);
  try {
    const look = (await qb.call('/api/backup/inspect', { file })).body;
    assert.equal(look.skills, 1); assert.equal(look.skillClashes, 1); assert.equal(look.memory, 2);
    const keep = (await qb.call('/api/backup/import', { file })).body;
    assert.ok(!keep.error, keep.error);
    assert.equal(keep.skills, 0, 'a skill that is here is kept');
    assert.match(fs.readFileSync(path.join(db, 'skills', 'release-notes', 'SKILL.md'), 'utf8'), /Mine/);
    assert.equal(keep.memory, 1, 'the duplicate memory item stays out');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(db, 'memory.json'), 'utf8')).items.map((x) => x.text), ['i use pnpm', 'Answer in English', 'Prefer dark themes']);
    const replace = (await qb.call('/api/backup/import', { file, overwrite: true })).body;
    assert.equal(replace.skills, 1);
    assert.match(fs.readFileSync(path.join(db, 'skills', 'release-notes', 'SKILL.md'), 'utf8'), /From the git log/);
    assert.equal(fs.readFileSync(path.join(db, 'skills', 'release-notes', 'refs', 'style.md'), 'utf8'), 'Short lines.');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(db, 'memory.json'), 'utf8')).items.map((x) => x.text), ['I use pnpm', 'Prefer dark themes'], 'with Replace, the backup\'s memory');
    const skills = (await qb.call('/api/skills?project=scratch')).body.filter((k) => k.source === 'mine').map((k) => k.name);
    assert.deepEqual(skills, ['release-notes'], 'the agent sees the restored skill');
  } finally { await qb.stop(); }
});

// A backup with one broken part: nothing at all is written.
test('a damaged backup is refused before anything is written', async () => {
  const home = tempDir('qx-backup-dmg-'), qx = await quorx(home);
  try {
    const before = fs.readFileSync(path.join(home, 'data', 'projects.json'), 'utf8');
    const make = (extra) => {
      const f = path.join(tempDir('qx-out-'), 'quorx-backup-bad.zip');
      const j = (o) => Buffer.from(JSON.stringify(o));
      fs.writeFileSync(f, zipBuffer([{ name: 'manifest.json', data: j({ format: 'quorx-backup', version: 1 }) }, { name: 'projects.json', data: j([{ id: 'new-app', name: 'New', path: home }]) },
        { name: 'chats/c-good.json', data: j({ id: 'c-good', title: 'fine' }) }, ...extra]));
      return f;
    };
    for (const [why, extra] of [['a log named "."', [{ name: 'logs/.', data: Buffer.from('x') }]], ['a chat whose id differs from its name', [{ name: 'chats/c-two.json', data: Buffer.from('{"id":"other"}') }]], ['a chat that is not JSON', [{ name: 'chats/c-three.json', data: Buffer.from('{') }]],
      ['a skill file that climbs out of its folder', [{ name: 'skills/evil/../../keys.json', data: Buffer.from('{}') }]], ['memory that is not a list', [{ name: 'memory.json', data: Buffer.from('{"items":5}') }]]]) {
      const r = (await qx.call('/api/backup/import', { file: make(extra) })).body;
      assert.match(r.error || '', /damaged.*nothing was imported/, why);
      assert.equal(fs.readFileSync(path.join(home, 'data', 'projects.json'), 'utf8'), before, `${why}: the project list is untouched`);
      assert.ok(!fs.existsSync(path.join(home, 'data', 'chats', 'c-good.json')), `${why}: no chat was written`);
    }
  } finally { await qx.stop(); }
});

test('imported settings keep the safety settings of this computer', () => {
  const theirs = { settings: { theme: 'light', approval: 'yolo', yoloAuto: { commands: true }, voters: ['x/y'], fontSize: 16 }, templates: ['t'] };
  const mine = { settings: { approval: 'strict', voters: ['a/b'] } };
  const out = mergeSettings(theirs, mine);
  assert.equal(out.settings.approval, 'strict');
  assert.deepEqual(out.settings.voters, ['a/b']);
  assert.ok(!('yoloAuto' in out.settings), 'a safety setting this computer never set goes back to its default');
  assert.equal(out.settings.theme, 'light');
  assert.equal(out.settings.fontSize, 16);
  assert.deepEqual(out.templates, ['t']);
  assert.equal(mergeSettings(theirs, null).settings.approval, undefined, 'with nothing saved here, the defaults apply');
});

test('keys come back only when the backup has them and the import asks for them', async () => {
  const a = homeA(), qa = await quorx(a.home);
  let file;
  try { file = (await qa.call('/api/backup/export', { dir: tempDir('qx-out-'), keys: true, keysWarned: true, keyPass: await qa.keyPass() })).body.file; } finally { await qa.stop(); }
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

// ---------- the ZIP itself: streamed, ZIP64 past the 32-bit limits, and the backups made before ----------
// The writer and reader backups had before they were streamed, kept here as they were: the backups they made must
// still import, and a new backup that needs no ZIP64 must be exactly what they made and read.
const DOS = (d) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
function oldZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = e.data, packed = zlib.deflateRawSync(raw), stored = packed.length >= raw.length;
    const body = stored ? raw : packed, crc = zlib.crc32(raw) >>> 0, { time, date } = DOS(e.mtime || new Date());
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(name.length, 26);
    locals.push(head, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += head.length + name.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
function oldUnzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  const out = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0 && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
    out.set(buf.toString('utf8', p + 46, p + 46 + nlen), method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
// A sink that keeps only what was written, where it was written: an archive "past 4 GB" without 4 GB anywhere.
function sparse() {
  const parts = [];
  return {
    write: async (b, p) => { parts.push([p, Buffer.from(b)]); },
    source: (size) => ({ size, read: (pos, len) => {
      const out = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
      for (const [p, b] of parts) { const s = Math.max(p, pos), e = Math.min(p + b.length, pos + out.length); if (s < e) b.copy(out, s - pos, s - p, e - p); }
      return out;
    } }),
  };
}
const readAll = (z) => Object.fromEntries([...z].map(([n, e]) => [n, e.read()]));
const zipFile = async (file, entries, opts) => { const fh = await fs.promises.open(file, 'w'); try { return await writeZip(fileSink(fh), entries, opts); } finally { await fh.close(); } };
const openZip = (file) => { const fd = fs.openSync(file, 'r'); try { return readAll(readZip(fileSource(fd))); } finally { fs.closeSync(fd); } };
// Big enough to go through in pieces (over 8 MB): one that deflates, one already compressed.
const BIG = tempDir('qx-zip-big-');
const bigText = path.join(BIG, 'big.txt'), bigVideo = path.join(BIG, 'big.mp4');
fs.writeFileSync(bigText, crypto.randomBytes(4.5e6).toString('hex'));
fs.writeFileSync(bigVideo, crypto.randomBytes(8.5e6));

test('a backup that needs no ZIP64 is byte for byte what the old writer made, and the old reader reads it', async () => {
  const mtime = new Date(2026, 9, 21, 12, 30, 4), j = (o) => Buffer.from(JSON.stringify(o, null, 2));
  const small = path.join(tempDir('qx-zip-'), 'notes.md');
  fs.writeFileSync(small, '# Notes\n' + 'a line that repeats\n'.repeat(500));
  const items = [
    { name: 'manifest.json', data: j({ format: 'quorx-backup', version: 1 }), mtime }, { name: 'chats/c1.json', data: j({ id: 'c1', title: 'hi', messages: ['x'.repeat(3000)] }), mtime },
    { name: `blobs/${BLOB}`, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mtime }, { name: 'blobs/empty.txt', data: Buffer.alloc(0), mtime },
    { name: 'skills/s/notes.md', file: small, mtime }, { name: 'logs/big.txt', file: bigText, mtime },
  ];
  const file = path.join(tempDir('qx-zip-'), 'new.zip'), bytes = await zipFile(file, items);
  const made = fs.readFileSync(file), old = oldZip(items.map((e) => ({ ...e, data: e.data || fs.readFileSync(e.file) })));
  assert.equal(bytes, made.length);
  assert.ok(made.equals(old), 'the same bytes as before, deflated in pieces or not');
  assert.equal(made.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), -1, 'no ZIP64 record');
  const back = oldUnzip(made);
  assert.ok(back.get('logs/big.txt').equals(fs.readFileSync(bigText)));
  assert.equal(back.get('skills/s/notes.md').toString(), fs.readFileSync(small, 'utf8'));
  assert.deepEqual(Object.keys(openZip(file)), items.map((e) => e.name), 'and the new reader too');
});

test('pictures and videos are stored as they are, everything else deflated; both read back the same', async () => {
  const file = path.join(tempDir('qx-zip-'), 'mixed.zip');
  await zipFile(file, [{ name: 'blobs/a.mp4', file: bigVideo }, { name: 'blobs/b.txt', file: bigText }, { name: 'blobs/c.png', data: Buffer.from('x'.repeat(5000)) }]);
  const fd = fs.openSync(file, 'r');
  try {
    const z = readZip(fileSource(fd));
    assert.equal(z.get('blobs/a.mp4').method, 0);
    assert.equal(z.get('blobs/c.png').method, 0, 'stored by its kind, even when it would deflate');
    assert.equal(z.get('blobs/b.txt').method, 8);
    assert.ok(z.get('blobs/b.txt').csize < z.get('blobs/b.txt').size);
    assert.ok(z.get('blobs/a.mp4').read().equals(fs.readFileSync(bigVideo)));
    assert.ok(z.get('blobs/b.txt').read().equals(fs.readFileSync(bigText)));
  } finally { fs.closeSync(fd); }
  // A file that doesn't get smaller is stored instead, and the archive ends where it should.
  const noise = path.join(BIG, 'noise.bin'), f2 = path.join(tempDir('qx-zip-'), 'noise.zip');
  fs.copyFileSync(bigVideo, noise);
  const end = await zipFile(f2, [{ name: 'blobs/n.bin', file: noise }, { name: 'z.json', data: Buffer.from('{}') }]);
  assert.equal(fs.statSync(f2).size, end, 'nothing left past the end');
  const back = openZip(f2);
  assert.ok(back['blobs/n.bin'].equals(fs.readFileSync(noise)));
  assert.equal(back['z.json'].toString(), '{}');
});

test('past 4 GB the offsets go in ZIP64 records, and the reader finds them', async () => {
  const at = 2 ** 32 + 12345, sink = sparse(), j = Buffer.from('{"id":"c1"}');
  const end = await writeZip(sink, [{ name: 'manifest.json', data: Buffer.from('{"format":"quorx-backup"}') }, { name: 'chats/c1.json', data: j }, { name: `blobs/${BLOB}`, data: Buffer.from([1, 2, 3]) }], { at });
  const src = sink.source(end), last = src.read(end - 22, 22);
  assert.equal(last.readUInt32LE(0), 0x06054b50);
  assert.equal(last.readUInt32LE(16), 0xffffffff, 'the end record points at the ZIP64 one');
  assert.equal(src.read(end - 42, 4).readUInt32LE(0), 0x07064b50, 'the locator is just before it');
  const z = readZip(src);
  assert.deepEqual([...z.keys()], ['manifest.json', 'chats/c1.json', `blobs/${BLOB}`]);
  assert.ok(z.get('chats/c1.json').read().equals(j));
  assert.deepEqual([...z.get(`blobs/${BLOB}`).read()], [1, 2, 3]);
});

test('sizes and entry counts past the limits get ZIP64 too (limits lowered, so nothing big is written)', async () => {
  const file = path.join(tempDir('qx-zip-'), 'z64.zip'), names = Array.from({ length: 6 }, (_, i) => `logs/l${i}.txt`);
  const end = await zipFile(file, [{ name: 'big.txt', file: bigText }, { name: 'big.mp4', file: bigVideo }, ...names.map((n) => ({ name: n, data: Buffer.from(n.repeat(100)) }))], { limits: { u32: 1000, u16: 4 } });
  const buf = fs.readFileSync(file);
  assert.equal(buf.length, end);
  assert.equal(buf.readUInt16LE(end - 22 + 10), 0xffff, 'the count is in the ZIP64 record');
  const back = openZip(file);
  assert.ok(back['big.txt'].equals(fs.readFileSync(bigText)) && back['big.mp4'].equals(fs.readFileSync(bigVideo)));
  for (const n of names) assert.equal(back[n].toString(), n.repeat(100));
});

test('a big export keeps the event loop free: a timer keeps ticking while it writes', async () => {
  const dir = tempDir('qx-zip-loop-'), entries = [];
  for (let i = 0; i < 4; i++) entries.push({ name: `blobs/t${i}.txt`, file: bigText }, { name: `blobs/v${i}.mp4`, file: bigVideo });
  let last = Date.now(), worst = 0, ticks = 0;
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; ticks++; }, 5);
  const t0 = Date.now();
  try { await zipFile(path.join(dir, 'loop.zip'), entries); } finally { clearInterval(timer); }
  const took = Date.now() - t0;
  assert.ok(ticks >= Math.min(10, took / 50), `the timer ticked ${ticks} times in ${took} ms`);
  assert.ok(worst < 250, `the longest wait between ticks was ${worst} ms over ${took} ms`);
});

test('a backup made before streaming still imports, and a new one brings back the same chats, projects and files', async () => {
  const home = tempDir('qx-backup-old-'), keep = tempDir('qx-proj-old-'), j = (o) => Buffer.from(JSON.stringify(o, null, 2));
  const pic = crypto.randomBytes(3000), chat = { id: 'old-chat', title: 'From before', projectId: 'old-app', agent: { messages: [{ role: 'user', content: 'hi', images: [`blob:${BLOB}`] }] } };
  const old = path.join(tempDir('qx-out-'), 'quorx-backup-2026-01-01.zip');
  fs.writeFileSync(old, oldZip([{ name: 'manifest.json', data: j({ format: 'quorx-backup', version: 1, counts: {} }) }, { name: 'projects.json', data: j([{ id: 'old-app', name: 'Old App', path: keep, created: 1 }]) },
    { name: 'chats/old-chat.json', data: j(chat) }, { name: `blobs/${BLOB}`, data: pic }, { name: 'memory.json', data: j({ on: true, items: [{ text: 'Old memory' }] }) }]));
  const qx = await quorx(home);
  let file;
  try {
    const r = (await qx.call('/api/backup/import', { file: old })).body;
    assert.ok(!r.error, r.error);
    assert.deepEqual([r.projects, r.chats, r.files, r.memory], [1, 1, 1, 1]);
    assert.equal((await qx.call('/api/chats/old-chat')).body.title, 'From before');
    assert.ok(fs.readFileSync(path.join(home, 'data', 'blobs', BLOB)).equals(pic));
    // A big file of its own next to it, then a new backup of all of it.
    fs.copyFileSync(bigText, path.join(home, 'data', 'blobs', `${'cd'.repeat(32)}.txt`));
    fs.copyFileSync(bigVideo, path.join(home, 'data', 'blobs', `${'ef'.repeat(32)}.mp4`));
    const out = (await qx.call('/api/backup/export', { dir: tempDir('qx-out-') })).body;
    assert.ok(!out.error, out.error);
    assert.equal(out.bytes, fs.statSync(out.file).size);
    assert.equal(out.counts.files, 3);
    assert.deepEqual(fs.readdirSync(path.dirname(out.file)), [path.basename(out.file)], 'no temp file left beside it');
    file = out.file;
  } finally { await qx.stop(); }
  const fresh = tempDir('qx-backup-new-'), qb = await quorx(fresh);
  try {
    const r = (await qb.call('/api/backup/import', { file })).body;
    assert.ok(!r.error, r.error);
    assert.equal(r.files, 3);
    for (const n of fs.readdirSync(path.join(home, 'data', 'blobs'))) assert.ok(fs.readFileSync(path.join(fresh, 'data', 'blobs', n)).equals(fs.readFileSync(path.join(home, 'data', 'blobs', n))), `${n} came back whole`);
    assert.deepEqual((await qb.call('/api/chats/old-chat')).body.agent, chat.agent);
    const p = (await qb.call('/api/projects')).body.find((x) => x.id === 'old-app');
    assert.equal(p.name, 'Old App');
    assert.equal(path.resolve(p.path), path.resolve(keep));
  } finally { await qb.stop(); }
});
