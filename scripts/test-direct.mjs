// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The model makers' own APIs (server/directapi.js) against a fake server on this computer: model lists and prices,
// streaming and tool calls in each provider's format, what a call costs, routing OpenRouter's ids, deciders, and the
// Spending view's totals by provider. No network, no keys, no money.
import { tempDir } from './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// ---------- the fake providers ----------
const MD = {
  openai: { models: {
    'gpt-test': { id: 'gpt-test', name: 'GPT Test', tool_call: true, reasoning: true, temperature: false, reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }], modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 400000, output: 128000 }, cost: { input: 1.25, output: 10, cache_read: 0.125 } },
    'gpt-absurd': { id: 'gpt-absurd', name: 'GPT Absurd', tool_call: true, modalities: { input: ['text'], output: ['text'] }, cost: { input: 5e9, output: 10 } },
    'gpt-image-9': { id: 'gpt-image-9', tool_call: false, modalities: { input: ['text'], output: ['image'] }, cost: { input: 5, output: 40 } },
  } },
  anthropic: { models: { 'claude-test-5': { id: 'claude-test-5', name: 'Claude Test 5', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }], modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 200000, output: 64000 }, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
  google: { models: { 'gemini-test-flash': { id: 'gemini-test-flash', name: 'Gemini Test Flash', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }], modalities: { input: ['text', 'image'], output: ['text'] }, cost: { input: 0.3, output: 2.5, cache_read: 0.03 } } } },
  moonshotai: { models: { 'kimi-test': { id: 'kimi-test', name: 'Kimi Test', tool_call: true, reasoning: true, interleaved: { field: 'reasoning_content' }, modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.6, output: 2.5, cache_read: 0.15 } } } },
};
const seen = []; // every request the fake got: { method, url, headers, body }
const sse = (res, frames, { named = false } = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const f of frames) res.write(`${named ? `event: ${f.type}\n` : ''}data: ${JSON.stringify(f)}\n\n`);
  if (!named) res.write('data: [DONE]\n\n');
  res.end();
};
const toolFrames = (usage, extra = {}) => [
  { id: 'gen1', model: 'x', choices: [{ delta: { content: 'Writing the file.' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt",' }, ...extra }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] }, finish_reason: 'tool_calls' }] },
  ...(usage ? [{ choices: [], usage }] : []),
];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const auth = req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '';
    const json = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/models.dev') return json(200, MD);
    if (/bad-key/.test(auth)) {
      if (req.url.startsWith('/anthropic')) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (req.url.startsWith('/gemini')) return json(400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]);
      return json(401, { error: { message: 'Incorrect API key provided: bad-key…', type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
    // OpenAI
    if (req.url === '/openai/v1/models') return json(200, { object: 'list', data: [{ id: 'gpt-test', created: 1760000000 }, { id: 'gpt-absurd' }, { id: 'gpt-image-9' }, { id: 'text-embedding-3-small' }, { id: 'gpt-test-pro' }, { id: 'gpt-unpriced' }] });
    if (req.url === '/openai/v1/chat/completions') return sse(res, toolFrames({ prompt_tokens: 10000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 8000 } }));
    // Anthropic
    if (req.url.startsWith('/anthropic/v1/models')) return json(200, { data: [{ id: 'claude-test-5', display_name: 'Claude Test 5', created_at: '2026-09-01T00:00:00Z' }], has_more: false });
    if (req.url === '/anthropic/v1/messages') return sse(res, [
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-test-5', usage: { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan: write it.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'On it.' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt","content":"hi"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 500 } },
      { type: 'message_stop' },
    ], { named: true });
    // Gemini: its own list, and the OpenAI-compatible endpoint (a thought signature on the call)
    if (req.url.startsWith('/gemini/v1beta/models')) return json(200, { models: [{ name: 'models/gemini-test-flash', displayName: 'Gemini Test Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }] });
    if (req.url === '/gemini/v1beta/openai/chat/completions') return sse(res, toolFrames({ prompt_tokens: 2000, completion_tokens: 200 }, { extra_content: { google: { thought_signature: 'gsig-1' } } }));
    // Moonshot: usage inside the choice, cached tokens at its top
    if (req.url === '/moon/v1/models') return json(200, { data: [{ id: 'kimi-test' }] });
    if (req.url === '/moon/v1/chat/completions') return sse(res, [
      { id: 'k1', choices: [{ delta: { reasoning_content: 'Think first.' } }] },
      ...toolFrames(null).slice(0, 2),
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] }, finish_reason: 'tool_calls', usage: { prompt_tokens: 4000, completion_tokens: 400, cached_tokens: 3000 } }] },
    ]);
    json(404, { error: { message: `no route ${req.url}` } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.env.QX_MODELS_DEV = `${BASE}/models.dev`;
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MOONSHOT_API_KEY', 'META_MODEL_API_KEY', 'LLAMA_API_KEY']) delete process.env[k];
test.after(() => server.close());

const D = await import('../server/directapi.js');
const S = await import('../server/sources.js');
const { costSummary } = await import('../server/store.js');
const { ensemble } = await import('../server/decisions.js');
const BASES = { 'openai-api': `${BASE}/openai/v1`, 'anthropic-api': `${BASE}/anthropic/v1`, 'gemini-api': `${BASE}/gemini/v1beta/openai`, 'moonshot-api': `${BASE}/moon/v1` };
const sig = () => new AbortController().signal;
const write = (msg) => [{ role: 'user', content: 'Write a.txt' }, ...(msg ? [msg] : [])];
const TOOLS = [{ type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } }];

test('prices are guarded: absurd or missing figures are unknown, never billions', () => {
  assert.deepEqual(D.saneCost({ input: 1.25, output: 10, cache_read: 0.125 }), { input: 1.25, output: 10, cache_read: 0.125 });
  assert.equal(D.saneCost({ input: 5e9, output: 10 }), null, 'an absurd input price makes the whole price unknown');
  assert.equal(D.saneCost({ input: -1, output: 10 }), null);
  assert.equal(D.saneCost({ input: '1', output: null }), null);
  assert.equal(D.saneCost(null), null);
  assert.deepEqual(D.saneCost({ input: 1, output: 2, cache_read: 1e12, cache_write: 'x' }), { input: 1, output: 2 }, 'a bad cache price is dropped, the rest kept');
  assert.equal(D.saneCost({ input: 1, output: 2, tiers: [{ input: 2, output: 4, tier: { size: 200000 } }, { input: 1e9, output: 4, tier: { size: 1 } }] }).tiers.length, 1);
  // What a call costs, from tokens: the guard holds per call too.
  const info = { plan: 'paid', cost: { input: 1, output: 2 } };
  assert.deepEqual(S.priced(info, { prompt_tokens: 1e6, completion_tokens: 1e6 }), { cost: 3, estimated_cost: true });
  assert.deepEqual(S.priced({ plan: 'paid', cost: { input: 900, output: 900 } }, { prompt_tokens: 1e6, completion_tokens: 0 }), { cost: 0, estimated_cost: true, cost_unknown: true }, 'over $50 for one call is a bad record');
  assert.deepEqual(S.priced({ plan: 'paid', priceUnknown: true, cost: {} }, { prompt_tokens: 1000 }), { cost: 0, estimated_cost: true, cost_unknown: true });
  assert.deepEqual(S.priced(info, { cost: 1e9 }), { cost: 0, cost_unknown: true }, 'a reported figure that is absurd is unknown too');
  assert.deepEqual(S.priced(info, { cost: -2 }), { cost: 0, cost_unknown: true });
  assert.deepEqual(S.priced(info, { cost: 0.0123 }), { cost: 0.0123 });
});

test('each provider lists the models a key can use, with models.dev’s prices; non-chat ones are left out', async () => {
  const oa = await D.directModels('openai-api', { key: 'sk-test-key-0123456789', base: BASES['openai-api'] });
  assert.deepEqual(oa.map((m) => m.id), ['openai-api/gpt-test', 'openai-api/gpt-absurd', 'openai-api/gpt-unpriced'], 'pictures, embeddings and Responses-only models are left out');
  const g = oa[0];
  assert.deepEqual([g.source, g.realId, g.maker, g.kind, g.plan, g.price, g.cost.cache_read, g.temp, g.efforts.length, g.created], ['openai-api', 'gpt-test', 'openai', 'chat', 'paid', [1.25, 10], 0.125, false, 4, 1760000000]);
  assert.deepEqual([oa[1].price, oa[1].priceUnknown], [[0, 0], true], 'an absurd price shows as unknown');
  assert.deepEqual([oa[2].priceUnknown, oa[2].name], [true, 'Gpt Unpriced'], 'a model models.dev doesn’t know still shows, price unknown');
  const listReq = seen.findLast((r) => r.url === '/openai/v1/models');
  assert.equal(listReq.headers.authorization, 'Bearer sk-test-key-0123456789');

  const an = await D.directModels('anthropic-api', { key: 'sk-ant-test-0123456789', base: BASES['anthropic-api'] });
  assert.deepEqual(an.map((m) => [m.id, m.wire, m.price]), [['anthropic-api/claude-test-5', 'messages', [3, 15]]]);
  const ar = seen.findLast((r) => r.url.startsWith('/anthropic/v1/models'));
  assert.deepEqual([ar.headers['x-api-key'], ar.headers['anthropic-version'], ar.headers.authorization], ['sk-ant-test-0123456789', '2023-06-01', undefined]);

  const gm = await D.directModels('gemini-api', { key: 'AIza-test-0123456789', base: BASES['gemini-api'] });
  assert.deepEqual(gm.map((m) => [m.id, m.ctx]), [['gemini-api/gemini-test-flash', 1048576]], 'Gemini’s own list: only models that generate content');
  const gr = seen.findLast((r) => r.url.startsWith('/gemini/v1beta/models'));
  assert.equal(gr.headers['x-goog-api-key'], 'AIza-test-0123456789', 'the key goes in a header, never the address');
  assert.ok(!gr.url.includes('AIza'), 'the key is never in the URL');

  await assert.rejects(D.directModels('openai-api', { key: '', base: BASES['openai-api'] }), /key first/);
  const bad = await D.directModels('openai-api', { key: 'bad-key-0123456789abc', base: BASES['openai-api'] }).catch((e) => e);
  assert.equal(S.failureKind(bad), 'auth');
  const badG = await D.directModels('gemini-api', { key: 'bad-key-0123456789abc', base: BASES['gemini-api'] }).catch((e) => e);
  assert.equal(S.failureKind(badG), 'auth', 'Google’s “API key not valid” (a 400) is a refused key');
});

test('OpenAI streams text and tool calls; the body is OpenAI’s, and the call is priced with its cached tokens', async () => {
  const [info] = await D.directModels('openai-api', { key: 'sk-test-key-0123456789', base: BASES['openai-api'] });
  let text = '';
  const r = await D.directStream('openai-api', { model: info.id, max_tokens: 900, temperature: 0.3, reasoning: { effort: 'high' }, tools: TOOLS, messages: write() }, sig(), (t) => { text += t; }, null, { info, key: 'sk-test-key-0123456789', base: BASES['openai-api'] });
  const req = seen.findLast((x) => x.url === '/openai/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-test-key-0123456789');
  assert.deepEqual([req.body.model, req.body.max_completion_tokens, req.body.max_tokens, req.body.temperature, req.body.reasoning_effort, req.body.stream, req.body.stream_options], ['gpt-test', 900, undefined, undefined, 'high', true, { include_usage: true }], 'max_completion_tokens, no temperature for a reasoning model, its effort');
  assert.equal(text, 'Writing the file.');
  assert.deepEqual(r.toolCalls, [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } }]);
  assert.equal(r.provider, 'OpenAI');
  const cost = S.priced(info, r.usage);
  assert.ok(Math.abs(cost.cost - (2000 * 1.25 + 8000 * 0.125 + 1000 * 10) / 1e6) < 1e-12, `cached tokens at the cache price (${cost.cost})`);
});

test('Anthropic runs on its Messages API: tool calls, signed thinking passed back, cache reads priced', async () => {
  const [info] = await D.directModels('anthropic-api', { key: 'sk-ant-test-0123456789', base: BASES['anthropic-api'] });
  const thought = [];
  const r = await D.directStream('anthropic-api', { model: info.id, max_tokens: 4000, reasoning: { effort: 'medium' }, tools: TOOLS, messages: [{ role: 'system', content: 'Be brief.' }, ...write()] }, sig(), null, (t) => thought.push(t), { info, key: 'sk-ant-test-0123456789', base: BASES['anthropic-api'] });
  const req = seen.findLast((x) => x.url === '/anthropic/v1/messages');
  assert.deepEqual([req.headers['x-api-key'], req.headers['anthropic-version']], ['sk-ant-test-0123456789', '2023-06-01']);
  assert.deepEqual([req.body.model, req.body.system[0].text, req.body.tools[0].name, req.body.output_config, req.body.thinking.type], ['claude-test-5', 'Be brief.', 'write_file', { effort: 'medium' }, 'adaptive']);
  assert.deepEqual(r.toolCalls, [{ id: 'toolu_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } }]);
  assert.equal(r.text, 'On it.');
  assert.deepEqual(thought, ['Plan: write it.']);
  assert.deepEqual(r.passBack, { cc_thinking: [{ type: 'thinking', thinking: 'Plan: write it.', signature: 'sig-abc' }] }, 'the signed thinking goes back on the next step');
  assert.deepEqual([r.usage.prompt_tokens, r.usage.prompt_tokens_details.cached_tokens, r.usage.completion_tokens], [10000, 9000, 500]);
  const c = S.priced(info, r.usage).cost;
  assert.ok(Math.abs(c - (1000 * 3 + 9000 * 0.3 + 500 * 15) / 1e6) < 1e-12, `cache reads at their price (${c})`);
  // The next step sends the thinking back in front of the call.
  await D.directStream('anthropic-api', { model: info.id, tools: TOOLS, messages: [...write(), { role: 'assistant', content: 'On it.', tool_calls: r.toolCalls, qx_pass: r.passBack }, { role: 'tool', tool_call_id: 'toolu_1', content: 'written' }] }, sig(), null, null, { info, key: 'sk-ant-test-0123456789', base: BASES['anthropic-api'] });
  const next = seen.findLast((x) => x.url === '/anthropic/v1/messages').body.messages;
  assert.deepEqual(next[1].content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  assert.deepEqual([next[2].content[0].type, next[2].content[0].tool_use_id], ['tool_result', 'toolu_1']);
});

test('Gemini’s thought signatures go back on their tool calls; Kimi’s reasoning goes back and its usage is read from the choice', async () => {
  const [gi] = await D.directModels('gemini-api', { key: 'AIza-test-0123456789', base: BASES['gemini-api'] });
  const r = await D.directStream('gemini-api', { model: gi.id, max_tokens: 500, seed: 1, parallel_tool_calls: true, tools: TOOLS, messages: write() }, sig(), null, null, { info: gi, key: 'AIza-test-0123456789', base: BASES['gemini-api'] });
  let req = seen.findLast((x) => x.url === '/gemini/v1beta/openai/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer AIza-test-0123456789');
  assert.deepEqual([req.body.seed, req.body.parallel_tool_calls, req.body.max_tokens], [undefined, undefined, 500]);
  assert.deepEqual(r.toolCalls, [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } }], 'the call itself stays clean');
  assert.deepEqual(r.passBack, { gemini_sigs: { call_1: 'gsig-1' } });
  await D.directStream('gemini-api', { model: gi.id, tools: TOOLS, messages: [...write(), { role: 'assistant', content: '', tool_calls: r.toolCalls, qx_pass: r.passBack }, { role: 'tool', tool_call_id: 'call_1', content: 'ok' }] }, sig(), null, null, { info: gi, key: 'AIza-test-0123456789', base: BASES['gemini-api'] });
  req = seen.findLast((x) => x.url === '/gemini/v1beta/openai/chat/completions');
  assert.deepEqual(req.body.messages[1].tool_calls[0].extra_content, { google: { thought_signature: 'gsig-1' } });
  assert.equal(req.body.messages[1].qx_pass, undefined);

  const [ki] = await D.directModels('moonshot-api', { key: 'sk-moon-test-0123456789', base: BASES['moonshot-api'] });
  const k = await D.directStream('moonshot-api', { model: ki.id, temperature: 1.6, tools: TOOLS, messages: write() }, sig(), null, null, { info: ki, key: 'sk-moon-test-0123456789', base: BASES['moonshot-api'] });
  assert.equal(seen.findLast((x) => x.url === '/moon/v1/chat/completions').body.temperature, 1, 'Moonshot takes 0–1');
  assert.deepEqual(k.passBack, { reasoning_content: 'Think first.' });
  assert.deepEqual([k.usage.prompt_tokens, k.usage.prompt_tokens_details.cached_tokens], [4000, 3000]);
  assert.ok(Math.abs(S.priced(ki, k.usage).cost - (1000 * 0.6 + 3000 * 0.15 + 400 * 2.5) / 1e6) < 1e-12);
});

test('in Settings: a key, its own address, on and off, and OpenRouter’s ids routed to the maker’s API', async () => {
  fs.mkdirSync(path.dirname(S.SOURCE_FILE), { recursive: true });
  fs.writeFileSync(S.SOURCE_FILE, '{}');
  try {
    for (const id of ['openai-api', 'anthropic-api', 'gemini-api', 'moonshot-api', 'meta-api']) assert.ok(S.SOURCE_IDS.includes(id), id);
    assert.match(S.sourceOffWhy('openai-api'), /no key/);
    assert.throws(() => S.setSourceKey('openai-api', 'sk-or-v1-0123456789abcdef'), /OpenRouter key/);
    assert.throws(() => S.setSourceKey('openai-api', 'sk-ant-api03-0123456789abcdef'), /Anthropic key/);
    assert.throws(() => S.setSourceOptions('openai-api', { base: 'ftp://example.com' }), /https/);
    assert.throws(() => S.setSourceOptions('openai-api', { base: 'http://example.com/v1' }), /https/, 'plain http only to this computer');
    assert.throws(() => S.setSourceOptions('opencode-go', { base: BASE }), /no options/);
    S.setSourceOptions('openai-api', { base: `${BASES['openai-api']}/` });
    assert.equal(S.baseFor('openai-api'), BASES['openai-api'], 'its own address, without the trailing slash');
    S.setSourceKey('openai-api', 'sk-test-key-0123456789');
    assert.equal(S.baseFor('openai-api'), BASES['openai-api'], 'saving a key keeps the address');
    assert.equal(S.sourceOn('openai-api'), true);
    const st = (await S.sourceStatus({ versions: false })).find((x) => x.id === 'openai-api');
    assert.deepEqual([st.needsKey, st.direct, st.billing, st.key.masked, st.base, st.defaultBase, st.route], [true, true, 'paid', 'sk-tes••••••••6789', BASES['openai-api'], 'https://api.openai.com/v1', 'openrouter']);
    assert.ok(!JSON.stringify(st).includes('sk-test-key-0123456789'), 'the page never gets the key');
    const t = await S.testSource('openai-api');
    assert.deepEqual([t.ok, t.models, t.priced, t.cost], [true, 3, 1, 0], 'the check lists the models (free) and says how many have a price');

    // The models join the pickers, and a call through sources.js is priced from the catalogue.
    const list = await S.sourceModels({ refresh: true });
    assert.ok(list.some((m) => m.id === 'openai-api/gpt-test'));
    const r = await S.sourceStream({ model: 'openai-api/gpt-test', tools: TOOLS, messages: write() }, sig(), null, null);
    assert.deepEqual([r.source, r.usage.estimated_cost, r.toolCalls.length], ['openai-api', true, 1]);
    assert.ok(r.usage.cost > 0 && r.usage.cost < 1);
    assert.equal(S.providerOfModel('openai-api/gpt-test'), 'OpenAI');
    assert.equal(S.providerOfModel('openai/gpt-test'), 'OpenRouter');

    // OpenRouter's id of the same model: stays on OpenRouter until the user routes it.
    assert.equal(await S.routeModel('openai/gpt-test'), 'openai/gpt-test');
    S.setSourceOptions('openai-api', { route: 'direct' });
    assert.equal(S.routeOf('openai-api'), 'direct');
    assert.equal(await S.routeModel('openai/gpt-test'), 'openai-api/gpt-test');
    assert.equal(await S.routeModel('openai/gpt-nothere'), 'openai/gpt-nothere', 'a model the key can’t use stays on OpenRouter');
    assert.equal(await S.routeModel('openai/gpt-test:free'), 'openai/gpt-test:free');
    assert.equal(await S.routeModel('anthropic/claude-test-5'), 'anthropic/claude-test-5', 'only the makers routed');
    assert.equal(S.sameOnDirect('anthropic/claude-sonnet-4.5', 'anthropic-api', [{ id: 'anthropic-api/claude-sonnet-4-5-20250929', realId: 'claude-sonnet-4-5-20250929', source: 'anthropic-api', kind: 'chat' }, { id: 'anthropic-api/claude-sonnet-4-5', realId: 'claude-sonnet-4-5', source: 'anthropic-api', kind: 'chat' }]), 'anthropic-api/claude-sonnet-4-5', 'dots and dashes match; the alias over a dated snapshot');
    // A whole answer (summaries, briefs) for the routed id goes direct, and back to OpenRouter if that fails.
    const orChat = async (b) => ({ message: { role: 'assistant', content: `openrouter ${b.model}` }, usage: {}, ms: 1 });
    const viaKey = await S.chatAny({ model: 'openai/gpt-test', messages: write() }, sig(), { orChat });
    assert.deepEqual([viaKey.model, viaKey.message.content], ['openai-api/gpt-test', 'Writing the file.']);
    S.forgetSourceHealth();
    const failing = await S.chatAny({ model: 'openai/gpt-test', messages: write() }, sig(), { orChat, stream: async () => { throw Object.assign(new Error('down'), { status: 503 }); }, checkOn: true });
    assert.deepEqual([failing.model, failing.fellBack], ['openai/gpt-test', true], 'the call the user asked for still gets answered on OpenRouter');
    S.forgetSourceHealth();

    // A refused key sets the whole provider aside (one key for all its models), not just the model.
    S.noteSourceResult('openai-api', 'openai-api/gpt-test', Object.assign(new Error('Incorrect API key'), { status: 401 }));
    assert.match(S.sourceSkip('openai-api', 'openai-api/gpt-absurd'), /refused its key/);
    S.forgetSourceHealth();

    S.setSourceOn('openai-api', false);
    assert.equal(await S.routeModel('openai/gpt-test'), 'openai/gpt-test', 'switched off: OpenRouter again');
    S.removeSourceKey('openai-api');
    assert.equal(S.keyFor('openai-api'), null);
  } finally { fs.writeFileSync(S.SOURCE_FILE, '{}'); S.forgetSourceHealth(); }
});

test('any of their chat models can be a decider: typed questions in plain words, probabilities out', async () => {
  const qs = { q1: { type: 'noul', instructions: 'Is the file written?' }, q2: { type: 'choice', instructions: 'Which?', criteria: { a: 'first', b: 'second' } }, q3: { type: 'score', instructions: 'How good?', criteria: ['bad', 'ok', 'great'] } };
  assert.deepEqual(D.readDecisions('```json\n{"answers":{"q1":{"yes":0.9,"no":0.1},"q2":{"a":3,"b":1},"q3":{"0":0,"1":0,"2":0},"zz":{"yes":1}}}\n```', qs), {
    q1: { probabilities: { yes: 0.9, no: 0.1 } }, q2: { probabilities: { a: 0.75, b: 0.25 } },
  }, 'probabilities add up to 1; a question with none, or one not asked, is left out');
  assert.deepEqual(D.readDecisions('not json', qs), {});
  const chat = { id: 'openai-api/gpt-test', realId: 'gpt-test', source: 'openai-api', kind: 'chat', name: 'GPT Test', in: ['text', 'image'], price: [1.25, 10] };
  const [dec] = D.directDeciders([chat]);
  assert.deepEqual([dec.id, dec.kind, dec.chatDecider, dec.chatId, D.deciderReal(dec.id)], ['openai-api/decider/gpt-test', 'decision', true, 'openai-api/gpt-test', 'gpt-test']);
  let asked = null;
  const r = await D.directDecisions(dec, ['Context: x', { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }], { q1: qs.q1 }, sig(), { stream: async (b) => { asked = b; return { text: '{"answers":{"q1":{"yes":0.2,"no":0.8}}}', usage: { prompt_tokens: 100, completion_tokens: 20 }, ms: 5, provider: 'OpenAI' }; } });
  assert.deepEqual(r.answers, { q1: { probabilities: { yes: 0.2, no: 0.8 } } });
  assert.equal(asked.model, 'openai-api/gpt-test');
  assert.ok(asked.messages[1].content.some((p) => p.type === 'image_url'), 'a model that sees pictures gets them');
  await assert.rejects(D.directDecisions(dec, {}, { q1: qs.q1 }, sig(), { stream: async () => ({ text: 'I think yes.', usage: {} }) }), /no answers/);
  // Through the decider ensemble, as the agent asks.
  fs.writeFileSync(S.SOURCE_FILE, '{}');
  try {
    S.setSourceOptions('openai-api', { base: BASES['openai-api'] });
    S.setSourceKey('openai-api', 'sk-test-key-0123456789');
    await S.sourceModels({ refresh: true });
    assert.ok((await S.sourceDecisionModels()).some((m) => m.id === 'openai-api/decider/gpt-test'), 'its models are offered as deciders');
    // The fake answers in tool calls, not JSON: the vote fails and says so, rather than being made up.
    const votes = [];
    const e = await ensemble({ voters: ['openai-api/decider/gpt-test'], state: { user_message_verbatim: 'x' }, questions: [{ id: 'q1', type: 'noul', ask: 'Is it?' }], onVote: (v) => votes.push(v) });
    assert.equal(e.results.q1.verdict, 'failed');
    assert.match(votes[0].error, /no answers/);
  } finally { fs.writeFileSync(S.SOURCE_FILE, '{}'); S.forgetSourceHealth(); }
});

test('the Spending view totals what each provider was paid; absurd figures count as nothing', async () => {
  const { saveProject } = await import('../server/store.js');
  const { saveChat } = await import('../server/store.js');
  const dir = tempDir('qx-direct-proj-');
  saveProject({ id: 'direct', path: dir });
  const now = Date.now();
  const reply = (byModel, cost) => ({ role: 'assistant', content: 'ok', at: now, stats: { cost, byModel } });
  saveChat(`c${now}`, { projectId: 'direct', title: 'Spend', agent: { setup: { model: 'openai-api/gpt-test' }, messages: [{ role: 'user', content: 'hi', at: now },
    reply({ 'openai-api/gpt-test': { cost: 0.5, calls: 2 }, 'anthropic-api/claude-test-5': { cost: 0.25, calls: 1 }, 'openai/gpt-test': { cost: 0.1, calls: 1 }, 'openai-api/decider/gpt-test': { cost: 0.05, calls: 1 } }, 0.9),
    reply({ 'gemini-api/gemini-test-flash': { cost: 1e12, calls: 1 } }, 0)] } });
  const s = costSummary({ providerOf: S.providerOfModel });
  const by = s.total.byProvider;
  assert.ok(Math.abs(by.OpenAI - 0.55) < 1e-9, `OpenAI ${by.OpenAI}: its chat model and its decider`);
  assert.ok(Math.abs(by.Anthropic - 0.25) < 1e-9);
  assert.ok(Math.abs(by.OpenRouter - 0.1) < 1e-9);
  assert.equal(by['Google Gemini'], undefined, 'a billion-dollar figure is a bad record, not spending');
  assert.equal(costSummary().total.byProvider, undefined, 'only when asked');
  // ⚙ Settings → Providers: each provider's today, month, all time, calls, models and last 14 days.
  const { providerUsage } = await import('../server/store.js');
  const u = providerUsage({ providerOf: S.providerOfModel, now });
  assert.ok(Math.abs(u.OpenAI.all - 0.55) < 1e-9 && Math.abs(u.OpenAI.today - 0.55) < 1e-9 && Math.abs(u.OpenAI.month - 0.55) < 1e-9);
  assert.equal(u.OpenAI.calls, 3, 'calls are counted per model');
  assert.deepEqual(Object.keys(u.OpenAI.models).sort(), ['openai-api/decider/gpt-test', 'openai-api/gpt-test']);
  assert.equal(u.OpenAI.days.length, 14);
  assert.ok(Math.abs(u.OpenAI.days[13] - 0.55) < 1e-9, 'today is the last day');
  assert.equal(u['Google Gemini'], undefined, 'an absurd figure counts as nothing');
});
