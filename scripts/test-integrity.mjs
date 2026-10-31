// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Things that must never quietly break: attached documents reaching the list, the project list surviving a save cut
// off halfway, and one missing or locked file ending one response instead of the whole server.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { HOME } from '../server/openrouter.js';
import { saveProject, listProjects, readProjectsFile, setProjectAlias, setProjectFlags, forgetProject } from '../server/store.js';
import { saveUpload, listDocs, getDoc, okEntry } from '../server/docs.js';
import { sendFile } from '../server/blobs.js';

const PROJECTS = path.join(HOME, 'data', 'projects.json');
const later = () => new Promise((r) => setTimeout(r, 20)); // a new mtime, so the cached list is read again

test('documents: each upload is listed, and a second one keeps the first', () => {
  const root = tempDir('qx-docs-');
  saveProject({ id: 'pdocs', path: root });
  const a = saveUpload('pdocs', 'report.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
  const b = saveUpload('pdocs', 'résumé [final] v2.docx', Buffer.from('PK'), '');
  assert.deepEqual(listDocs('pdocs').map((x) => x.id), [a.id, b.id]);
  assert.equal(getDoc('pdocs', 'report.pdf')?.id, a.id);
  assert.ok(fs.existsSync(path.join(root, '.quorx', 'uploads', a.file)));
});

test('documents: an entry naming anything but a plain file in uploads/ is dropped', () => {
  const ok = { id: 'dabc123', file: 'dabc123-notes.txt' };
  assert.equal(okEntry(ok), true);
  for (const file of ['../x.txt', 'dabc123-../../x', 'dabc123-a/b.txt', 'dabc123-a\\b.txt', 'C:x.txt', 'dabc123-x.txt:stream', 'other-x.txt'])
    assert.equal(okEntry({ ...ok, file }), false, file);
  for (const id of ['', 'a/b', 'x'.repeat(65)]) assert.equal(okEntry({ ...ok, id }), false, id);
  assert.equal(okEntry(null), false);
});

test('projects: a list cut off halfway falls back to the last good copy, and the next save repairs it', async () => {
  const one = tempDir('qx-proj-a-'), two = tempDir('qx-proj-b-');
  saveProject({ id: 'pone', path: one });
  saveProject({ id: 'ptwo', path: two });
  assert.ok(fs.existsSync(PROJECTS + '.bak'), 'the save before keeps a copy');
  assert.equal(fs.existsSync(PROJECTS + '.tmp'), false, 'no temp file left over');
  await later();
  const whole = fs.readFileSync(PROJECTS, 'utf8');
  fs.writeFileSync(PROJECTS, whole.slice(0, Math.floor(whole.length / 2))); // what a crash mid-write used to leave
  const ids = listProjects().map((p) => p.id);
  assert.ok(ids.includes('pone'), 'projects come back from the last good copy');
  saveProject({ id: 'pone', path: one });
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(PROJECTS, 'utf8'))), 'the next save writes a whole list again');
  assert.ok(readProjectsFile().some((p) => p.id === 'pone'));
});

test('projects: a rename keeps the folder and its name, survives other saves, and an empty name goes back', async () => {
  const dir = tempDir('qx-proj-r-'), folder = path.basename(dir);
  saveProject({ id: 'pren', path: dir });
  const get = () => listProjects().find((p) => p.id === 'pren');
  assert.deepEqual(setProjectAlias('pren', '  My   app '), { id: 'pren', name: 'My app', folderName: folder });
  await later();
  assert.equal(get().name, 'My app');
  assert.equal(get().folderName, folder);
  assert.equal(get().dir, path.resolve(dir), 'the folder is not touched');
  setProjectFlags('pren', { pinned: true }); setProjectFlags('pren', { pinned: false });
  await later();
  assert.equal(get().name, 'My app', 'other saves keep the name');
  assert.equal(readProjectsFile().find((p) => p.id === 'pren').name, folder, 'the file keeps the folder\'s name apart');
  setProjectAlias('pren', '');
  await later();
  assert.equal(get().name, folder);
  assert.throws(() => setProjectAlias('scratch', 'x'), /built-in/);
  assert.throws(() => setProjectAlias('nope-none', 'x'), /no such project/);
  forgetProject('pren');
});

test('projects: with no readable copy at all it refuses, and nothing saves over the list', async () => {
  const dir = tempDir('qx-proj-c-');
  await later();
  fs.writeFileSync(PROJECTS, '[{"id":"pone", "na');
  fs.writeFileSync(PROJECTS + '.bak', '{');
  assert.throws(() => listProjects(), /can't read its project list/);
  assert.throws(() => saveProject({ id: 'pthree', path: dir }), /can't read its project list/);
  assert.equal(fs.readFileSync(PROJECTS, 'utf8'), '[{"id":"pone", "na', 'the damaged file is left for repair, not replaced');
  fs.writeFileSync(PROJECTS, '[]'); fs.rmSync(PROJECTS + '.bak');
});

// A server that sends one file the way the app does; `closed` settles when the file it opened is closed again.
async function serving(file) {
  let closed;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const src = sendFile(file, res);
    closed = new Promise((r) => src.once('close', r));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, closed: () => closed, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('files: one that is gone by the time it opens ends that response, not the server', async () => {
  const s = await serving(path.join(tempDir('qx-send-'), 'replaced.mp4'));
  try {
    await assert.rejects(fetch(s.url).then((r) => r.arrayBuffer()));
    const again = await fetch(s.url).catch((e) => e);
    assert.ok(again, 'the server still answers');
  } finally { await s.close(); }
});

test('files: a download cut off midway closes the file', async () => {
  const file = path.join(tempDir('qx-send-'), 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024, 1));
  const s = await serving(file);
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(s.url, (res) => { res.once('data', () => { req.destroy(); resolve(); }); });
      req.on('error', () => {});
      setTimeout(() => reject(new Error('no data')), 5000);
    });
    const shut = await Promise.race([s.closed().then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    assert.ok(shut, 'the file is closed once the download is cut off');
  } finally { await s.close(); }
});
