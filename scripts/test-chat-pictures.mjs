// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A picture the user attached stays usable for the whole chat: saved in the project when it is sent, listed for the
// model in every later turn (after a compaction too), and usable by path as a reference for imagine and the rest.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { reply, run, toolResults } from './agent-harness.mjs';
import { primeCatalogue } from '../server/openrouter.js';

const JPG = (s) => `data:image/jpeg;base64,${Buffer.from(s).toString('base64')}`;
const picPath = (u) => `.quorx/uploads/pictures/${crypto.createHash('sha1').update(u).digest('hex').slice(0, 12)}.jpg`;
const IMG_REF = { id: 'test/img-ref', name: 'Ref', kind: 'image', in: ['text', 'image'], out: ['image'], price: [0, 0], perImage: 0.02, params: { input_references: { type: 'range', min: 0, max: 4 } } };
const settings = { mediaEnabled: true, yoloCheck: false, tools: { browser: { on: false }, video: { on: false }, music: { on: false }, speech: { on: false }, image: { on: true, pick: 'fixed', models: ['test/img-ref'], resolution: '1K' } } };
const fakeImage = (sent) => async (b) => { sent.push(b); return { images: [JPG('made')], usage: { cost: 0.02 }, ms: 5 }; };
const systemText = (body) => body.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

test('a picture attached to a message is saved in the project, and the model is told its path', async () => {
  primeCatalogue('images', [IMG_REF]);
  const photo = JPG('the-girl');
  const { bodies, dir } = await run((body, i) => [reply('Got it.')][i], { settings, images: [photo] });
  const rel = picPath(photo);
  assert.equal(fs.readFileSync(path.join(dir, rel)).toString(), 'the-girl', 'saved under .quorx/uploads/pictures');
  assert.match(systemText(bodies[0]), new RegExp(`attached:1 = ${rel.replace(/\./g, '\\.')}`));
});

test('in a later turn the earlier picture is listed and works as a reference by its path; one only in an old message is saved then', async () => {
  primeCatalogue('images', [IMG_REF]);
  const photo = JPG('the-girl'), old = JPG('old-chat-photo');
  const sent = [];
  const rel = picPath(photo), oldRel = picPath(old);
  // The earlier turn saved the photo; this turn sends no picture. An older message's picture (from before pictures
  // were saved) comes as data once, with the path the page worked out for it.
  const { bodies } = await run((body, i) => [
    reply('', [['imagine', { prompt: 'the girl from the photo, as a watercolour', why: 'asked', references: [rel, oldRel] }]]),
    reply('Done.'),
  ][i], { settings, text: 'now make her a watercolour', prep: (d) => { fs.mkdirSync(path.join(d, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), Buffer.from('the-girl')); },
    shared: [{ path: rel, at: 1, said: 'use the girl from this photo' }, { path: oldRel, at: 0, said: 'an older one', data: old }], generateImage: fakeImage(sent) });
  const sys = systemText(bodies[0]);
  assert.match(sys, /Pictures the user attached earlier in this chat/);
  assert.ok(sys.includes(rel) && sys.includes(oldRel), sys);
  assert.equal(sent.length, 1, toolResults(bodies[1]).at(-1));
  assert.deepEqual(sent[0].input_references.map((r) => r.image_url.url), [JPG('the-girl'), old]);
});

test("attached:1 in a turn with no picture says where the chat's earlier pictures are", async () => {
  primeCatalogue('images', [IMG_REF]);
  const photo = JPG('the-girl'), rel = picPath(photo);
  const { bodies } = await run((body, i) => [reply('', [['imagine', { prompt: 'x', why: 'y', references: ['attached:1'] }]]), reply('Done.')][i],
    { settings, prep: (d) => { fs.mkdirSync(path.join(d, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), 'the-girl'); }, shared: [{ path: rel, at: 1 }] });
  assert.match(toolResults(bodies[1]).at(-1), new RegExp(`no picture is attached to this message.*${rel.replace(/\./g, '\\.')}`));
});
