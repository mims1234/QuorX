// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// ToAPIs against a fake server on this computer: its chat models as a source (owners, chat-only, OpenRouter's price),
// and its picture, video and Suno music jobs (submit, poll, upload, download, cost) through the media catalogue the
// tools use. No network, no keys, no money.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const seen = []; // { method, url, auth, type, body }
let polls = {};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks), type = req.headers['content-type'] || '';
    const body = /json/.test(type) && raw.length ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', type, body, size: raw.length });
    const json = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const file = (mime) => { res.writeHead(200, { 'Content-Type': mime }); res.end(PNG); };
    if (req.url === '/models.dev') return json(200, { toapis: { id: 'toapis', models: {} } });
    if (/bad-key/.test(req.headers.authorization || '')) return json(401, { error: { code: 401, message: 'Authentication failed, please check your API key', type: 'authentication_error' } });
    // Its lists: text by default, others by ?type=
    if (req.url === '/v1/models') return json(200, { success: true, object: 'list', data: [
      { id: 'claude-opus-5-5-official', object: 'model', owned_by: 'anthropic', supported_endpoint_types: ['chat_completions', 'responses'] },
      { id: 'glm-5.3', object: 'model', owned_by: 'zai', supported_endpoint_types: ['chat_completions'] },
      { id: 'gpt-image-2', object: 'model', owned_by: 'openai', supported_endpoint_types: ['image-generation'] },
    ] });
    if (req.url === '/v1/models?type=image') return json(200, { success: true, data: [{ id: 'gpt-image-2', owned_by: 'openai' }, { id: 'grok-image', owned_by: 'xai' }] });
    if (req.url === '/v1/models?type=video') return json(200, { success: true, data: [{ id: 'seedance-2', owned_by: 'bytedance' }, { id: 'seedance-2-ext' }, { id: 'grok-video-1.5' }] });
    if (req.url === '/v1/models?type=audio') return json(200, { success: true, data: [{ id: 'suno', owned_by: 'suno' }] });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: 'Hi from ToAPIs.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    // Pictures: a task, in progress once, then done with a settled bill
    if (req.method === 'POST' && req.url === '/v1/images/generations') return json(200, { id: 'img_1', object: 'generation.task', status: 'queued' });
    if (req.url === '/v1/images/generations/img_1') {
      polls.img = (polls.img || 0) + 1;
      return json(200, polls.img < 2 ? { id: 'img_1', status: 'in_progress', progress: 50, billing: { status: 'pending' } }
        : { id: 'img_1', status: 'completed', result: { type: 'image', data: [{ url: `${BASE}/files/pic.png` }] }, billing: { status: 'settled', credits: '4', cost_usd: '0.04' } });
    }
    // Uploads (multipart) and videos
    if (req.method === 'POST' && req.url === '/v1/uploads/images') return json(200, { success: true, data: { id: 'up1', url: `${BASE}/files/start.png`, mime_type: 'image/png', size: 30 } });
    if (req.method === 'POST' && req.url === '/v1/videos/generations') return json(200, { id: 'vid_1', object: 'generation.task', status: 'queued' });
    if (req.url === '/v1/videos/generations/vid_1') return json(200, { id: 'vid_1', status: 'completed', result: { type: 'video', data: [{ url: `${BASE}/files/gone.mp4`, fallback_url: `${BASE}/files/clip.mp4` }] }, billing: { status: 'settled', cost_usd: '0.6' } });
    if (req.method === 'POST' && req.url === '/v1/videos/generations/fail') return json(200, {});
    // Suno
    if (req.method === 'POST' && req.url === '/v1/music/generations/generation') return json(200, { task_id: 'tsk_aud_1', status: 'submitted' });
    if (req.url === '/v1/music/tasks/tsk_aud_1') return json(200, { id: 'tsk_aud_1', status: 'completed', cost: 0.05, result: { music: [{ audio_url: `${BASE}/files/song.mp3`, title: 'Rain', tags: 'lo-fi jazz', duration: 120 }, { audio_url: `${BASE}/files/song2.mp3` }] } });
    if (req.url === '/files/pic.png' || req.url === '/files/start.png') return file('image/png');
    if (req.url === '/files/clip.mp4') return file('video/mp4');
    if (req.url === '/files/song.mp3') return file('audio/mpeg');
    json(404, { error: { message: `no route ${req.url}` } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.env.QX_MODELS_DEV = `${BASE}/models.dev`;
process.env.QX_TOAPIS_POLL_MS = '20';
delete process.env.TOAPIS_API_KEY;
test.after(() => server.close());

const D = await import('../server/directapi.js');
const S = await import('../server/sources.js');
const T = await import('../server/toapis.js');
const M = await import('../server/mediacat.js');
const OR = await import('../server/openrouter.js');
const KEY = 'sk-toapis-test-0123456789', opts = { key: KEY, base: `${BASE}/v1` };
const sig = () => new AbortController().signal;

test('ToAPIs is a provider in Settings, with its key, address and models.dev id', () => {
  const def = S.SOURCES['toapis-api'];
  assert.equal(def.name, 'ToAPIs');
  assert.equal(def.base, 'https://toapis.com/v1');
  assert.equal(def.env, 'TOAPIS_API_KEY');
  assert.equal(def.billing, 'paid');
  assert.equal(def.routable, false, 'its models never take the place of OpenRouter’s');
});

test('its chat models: only chat ones, each maker from its owner, priced at the same model on OpenRouter', async () => {
  const list = await D.directModels('toapis-api', opts);
  assert.deepEqual(list.map((m) => [m.id, m.maker, m.wire]), [['toapis-api/claude-opus-5-5-official', 'anthropic', 'chat'], ['toapis-api/glm-5.3', 'z-ai', 'chat']], 'the picture model is left out');
  assert.ok(list.every((m) => m.priceUnknown), 'no price of its own');
  const or = [{ id: 'anthropic/claude-opus-5.5', kind: 'chat', price: [5, 25], created: 1 }, { id: 'z-ai/glm-5.3', kind: 'chat', price: [1.4, 4.4], created: 1 }];
  const priced = S.withRefPrices(list, or);
  assert.deepEqual(priced.map((m) => [m.priceRef, m.price]), [['anthropic/claude-opus-5.5', [5, 25]], ['z-ai/glm-5.3', [1.4, 4.4]]], '-official is the same model');
  const out = await D.directStream('toapis-api', { model: list[1].id, messages: [{ role: 'user', content: 'hi' }] }, sig(), null, null, { info: list[1], key: KEY, base: `${BASE}/v1` });
  assert.equal(out.text, 'Hi from ToAPIs.');
  const req = seen.findLast((x) => x.url === '/v1/chat/completions');
  assert.equal(req.body.model, 'glm-5.3');
  assert.equal(req.auth, `Bearer ${KEY}`);
  assert.equal(S.failureKind(await D.directModels('toapis-api', { ...opts, key: 'bad-key-0123456789' }).catch((e) => e)), 'auth');
});

test('its picture, video and music lists, in the media catalogues’ shape', async () => {
  const img = await T.toapisImageModels(opts), vid = await T.toapisVideoModels(opts), mus = await T.toapisMusicModels(opts);
  assert.deepEqual(img.map((m) => [m.id, m.kind, m.out[0]]), [['toapis-api/gpt-image-2', 'image', 'image'], ['toapis-api/grok-image', 'image', 'image']]);
  assert.deepEqual(vid.map((m) => [m.id, m.frames.join()]), [['toapis-api/seedance-2', 'first_frame'], ['toapis-api/seedance-2-ext', ''], ['toapis-api/grok-video-1.5', 'first_frame']]);
  assert.deepEqual(mus.map((m) => [m.id, m.perUse]), [['toapis-api/suno', 0.05]]);
  assert.ok([...img, ...vid].every((m) => m.priceUnknown && m.source === 'toapis-api'));
});

test('a picture: shape as size (aspect_ratio for Grok), polled to done, downloaded, billed at what ToAPIs charged', async () => {
  const r = await T.toapisImage({ model: 'toapis-api/gpt-image-2', prompt: 'a panda', aspect_ratio: '16:9', resolution: '1K' }, sig(), opts);
  assert.deepEqual(seen.findLast((x) => x.url === '/v1/images/generations' && x.method === 'POST').body, { model: 'gpt-image-2', prompt: 'a panda', n: 1, size: '16:9' }, 'no resolution: each family spells it its own way');
  assert.match(r.images[0], /^data:image\/png;base64,/);
  assert.equal(r.usage.cost, 0.04);
  polls = {};
  await T.toapisImage({ model: 'toapis-api/grok-image', prompt: 'x', aspect_ratio: '1:1' }, sig(), opts);
  assert.equal(seen.findLast((x) => x.url === '/v1/images/generations' && x.method === 'POST').body.aspect_ratio, '1:1');
});

test('a video: the start picture uploaded first, each family’s own fields, the fallback link when the first fails', async () => {
  const frame = `data:image/png;base64,${PNG.toString('base64')}`;
  const statuses = [];
  const r = await T.toapisVideo({ model: 'toapis-api/seedance-2', prompt: 'waves', duration: 5, resolution: '720p', aspect_ratio: '16:9', frame_images: [{ type: 'image_url', image_url: { url: frame }, frame_type: 'first_frame' }] }, sig(), (s) => statuses.push(s), opts);
  const up = seen.findLast((x) => x.url === '/v1/uploads/images');
  assert.match(up.type, /multipart\/form-data/);
  assert.deepEqual(seen.findLast((x) => x.url === '/v1/videos/generations').body, { model: 'seedance-2', prompt: 'waves', duration: 5, aspect_ratio: '16:9', resolution: '720p', image_urls: [`${BASE}/files/start.png`] });
  assert.match(r.url, /^data:video\/mp4;base64,/);
  assert.equal(r.usage.cost, 0.6);
  assert.deepEqual(statuses, ['completed']);
  // Other families
  assert.deepEqual(T.toapisVideoBody({ model: 'toapis-api/grok-video-1.5', prompt: 'p', duration: 6, aspect_ratio: '9:16' }, 'https://x/a.png'), { model: 'grok-video-1.5', prompt: 'p', duration: 6, aspect_ratio: '9:16', image: 'https://x/a.png' });
  assert.deepEqual(T.toapisVideoBody({ model: 'toapis-api/seedance-2-ext', prompt: 'p', duration: 8, aspect_ratio: '16:9', resolution: '720p' }), { model: 'seedance-2-ext', prompt: 'p', seconds: 8, size: '16:9', resolution: '720p' });
  assert.deepEqual(T.toapisVideoBody({ model: 'toapis-api/wan3.0-video', prompt: 'p', aspect_ratio: '1:1' }, 'https://x/a.png'), { model: 'wan3.0-video', prompt: 'p', ratio: '1:1', image_with_roles: [{ url: 'https://x/a.png', role: 'first_frame' }] });
  assert.equal(T.toapisVideoBody({ model: 'toapis-api/kling-v3', prompt: 'p', resolution: '720p' }).resolution, undefined, 'Kling v3 takes a mode, not a resolution');
});

test('a song with Suno: the description in, the first of its two songs kept, at its cost', async () => {
  const r = await T.toapisMusic({ model: 'toapis-api/suno', prompt: 'lo-fi jazz for a rainy café' }, sig(), opts);
  assert.deepEqual(seen.findLast((x) => x.url === '/v1/music/generations/generation').body, { model: 'suno', gpt_description: 'lo-fi jazz for a rainy café' });
  assert.match(r.url, /^data:audio\/mpeg;base64,/);
  assert.equal(r.usage.cost, 0.05);
  assert.match(r.text, /Rain/);
});

test('the media catalogue: ToAPIs joins only when switched on with a key; each call goes where its id says', async () => {
  OR.primeCatalogue('images', [{ id: 'openai/gpt-5-image', kind: 'image', params: {} }]);
  OR.primeCatalogue('videos', [{ id: 'google/veo-3.1', kind: 'video', frames: [] }]);
  OR.primeCatalogue('music', [{ id: 'google/lyria-3', kind: 'music' }]);
  assert.deepEqual((await M.imageModels()).map((m) => m.id), ['openai/gpt-5-image'], 'off: OpenRouter’s only');
  S.setSourceOptions('toapis-api', { base: `${BASE}/v1` });
  S.setSourceKey('toapis-api', KEY);
  S.setSourceOn('toapis-api', true);
  try {
    assert.deepEqual((await M.imageModels()).map((m) => m.id), ['openai/gpt-5-image', 'toapis-api/gpt-image-2', 'toapis-api/grok-image']);
    assert.ok((await M.videoModels()).some((m) => m.id === 'toapis-api/seedance-2'));
    assert.deepEqual((await M.musicModels()).map((m) => m.id), ['google/lyria-3', 'toapis-api/suno']);
    polls = {};
    const before = seen.length;
    const r = await M.generateImage({ model: 'toapis-api/gpt-image-2', prompt: 'a fox' }, sig());
    assert.equal(r.usage.cost, 0.04);
    assert.ok(seen.slice(before).some((x) => x.url === '/v1/images/generations' && x.auth === `Bearer ${KEY}`), 'the saved key and address are used');
  } finally {
    S.setSourceOn('toapis-api', false);
    S.removeSourceKey('toapis-api');
  }
});
