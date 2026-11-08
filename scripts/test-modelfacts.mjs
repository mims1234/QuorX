// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Requests built to fit the model and its providers (server/modelfacts.js, applied in server/openrouter.js): reasoning
// a model can't turn off, efforts it doesn't list, tool_choice values some providers refuse. No network: OpenRouter's
// model list, endpoint list and chat endpoint are stubbed.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningFacts, nearestEffort, fitReasoning, summariseEndpoints, fitToolChoice, keepWithinChoice, endpointsOf, forgetModelFacts, ENDPOINT_TTL } from '../server/modelfacts.js';
import { chat, primeCatalogue } from '../server/openrouter.js';

test('reasoning facts come from the model list entry', () => {
  assert.deepEqual(reasoningFacts({ reasoning: { mandatory: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'high' } }), { mandatory: true, efforts: ['max', 'high', 'low'] });
  assert.deepEqual(reasoningFacts({ reasoning: { mandatory: false, supports_max_tokens: true } }), { mandatory: false, efforts: null, maxTokens: true });
  assert.equal(reasoningFacts({}), null);
});

test('an effort a model does not list becomes the nearest one it does (lower wins a tie)', () => {
  assert.equal(nearestEffort('medium', ['max', 'high', 'low']), 'low');
  assert.equal(nearestEffort('medium', ['xhigh', 'high']), 'high');
  assert.equal(nearestEffort('low', ['high', 'medium']), 'medium');
  assert.equal(nearestEffort('high', null), 'high');
  assert.equal(nearestEffort('high', ['high']), 'high');
});

test('reasoning "off" is never sent to a model that cannot turn it off', () => {
  const off = { model: 'm', reasoning: { enabled: false } };
  assert.deepEqual(fitReasoning(off, { mandatory: true, efforts: ['high', 'minimal', 'low'] }).reasoning, { effort: 'minimal', exclude: true });
  assert.deepEqual(fitReasoning(off, { mandatory: true, efforts: null }).reasoning, { effort: 'low', exclude: true });
  assert.equal(fitReasoning(off, { mandatory: false, efforts: ['high', 'low'] }), off, 'an optional model keeps "off"');
  assert.equal(fitReasoning(off, null), off);
  const med = { model: 'm', reasoning: { effort: 'medium', exclude: false } };
  assert.deepEqual(fitReasoning(med, { mandatory: true, efforts: ['max', 'high', 'low'] }).reasoning, { effort: 'low', exclude: false });
  assert.equal(fitReasoning(med, { mandatory: false, efforts: ['high', 'medium', 'low'] }), med);
  const budget = { model: 'm', reasoning: { max_tokens: 3000 } };
  assert.equal(fitReasoning(budget, { mandatory: true, efforts: ['high'] }), budget, 'a token budget is left to OpenRouter to convert');
});

const EPS = [
  { tag: 'relace/fp4', provider_name: 'Relace', context_length: 1048576, max_completion_tokens: 943718, supported_parameters: ['tools', 'tool_choice'], supports_tool_choice: { none: false, auto: true, required: true, function: true } },
  { tag: 'deepseek', provider_name: 'DeepSeek', context_length: 1048576, max_completion_tokens: 393216, supported_parameters: ['tools', 'tool_choice'], supports_tool_choice: { none: true, auto: true, required: true, function: true } },
  { tag: 'tinyhost/fp8', provider_name: 'TinyHost', context_length: 131072, max_completion_tokens: 32768, supported_parameters: ['tools'], supports_tool_choice: { none: true, auto: true, required: false, function: false } },
  { tag: 'textonly', provider_name: 'TextOnly', context_length: 8192, supported_parameters: ['temperature'] },
];

test('endpoints sum up to what every allowed provider takes', () => {
  assert.deepEqual(summariseEndpoints(EPS), { providers: 3, context: 131072, maxOut: 32768, toolChoice: { none: false, required: false, function: false } });
  assert.deepEqual(summariseEndpoints(EPS, { ignore: ['tinyhost', 'Relace'] }), { providers: 1, context: 1048576, maxOut: 393216, toolChoice: { none: true, required: true, function: true } });
  assert.equal(summariseEndpoints(EPS, { ignore: ['relace', 'deepseek', 'tinyhost'] }), null, 'endpoints without tools never count');
  assert.equal(summariseEndpoints([{ tag: 'x' }]).toolChoice.none, true, 'an endpoint that says nothing counts as taking it');
});

test('a tool_choice some allowed provider refuses goes out as auto, and the answer stays within what was asked', () => {
  const sum = summariseEndpoints(EPS);
  assert.deepEqual(fitToolChoice('none', sum), { tool_choice: 'auto', was: 'none' });
  assert.deepEqual(fitToolChoice('auto', sum), { tool_choice: 'auto' });
  const forced = { type: 'function', function: { name: 'submit' } };
  assert.deepEqual(fitToolChoice(forced, sum), { tool_choice: 'auto', was: 'function' });
  assert.deepEqual(fitToolChoice(forced, summariseEndpoints(EPS, { ignore: ['tinyhost'] })), { tool_choice: forced });
  assert.deepEqual(fitToolChoice('required', null, new Set(['required'])), { tool_choice: 'auto', was: 'required' }, 'a refusal learned at run time counts too');
  const calls = [{ function: { name: 'submit' } }, { function: { name: 'read_file' } }];
  assert.deepEqual(keepWithinChoice(calls, 'none', 'none'), []);
  assert.deepEqual(keepWithinChoice(calls, forced, 'function').map((c) => c.function.name), ['submit']);
  assert.equal(keepWithinChoice(calls, 'auto', undefined), calls);
});

test('endpoint lists are fetched once a day and a slow fetch never holds a call up', async () => {
  forgetModelFacts();
  let n = 0;
  const fetcher = async () => { n++; return EPS; };
  assert.equal(await endpointsOf('a/b', fetcher), EPS);
  assert.equal(await endpointsOf('a/b', fetcher), EPS);
  assert.equal(n, 1);
  assert.equal(await endpointsOf('a/b', fetcher, { now: Date.now() + ENDPOINT_TTL + 1 }), EPS);
  assert.equal(n, 2);
  const t0 = Date.now();
  assert.equal(await endpointsOf('slow/one', () => new Promise(() => {}), { waitMs: 50 }), null);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await endpointsOf('bad/one', async () => { throw new Error('down'); }), null);
});

test('through the OpenRouter client: off becomes the lightest level, a refused tool_choice becomes auto and its calls are dropped', async () => {
  forgetModelFacts();
  primeCatalogue('chat', [{ id: 'x/thinker', think: { mandatory: true, efforts: ['high', 'low'] }, details: '/api/v1/models/x/thinker-2026/endpoints' }]);
  const sent = [], asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    asked.push(u);
    if (u.endsWith('/api/v1/models/x/thinker-2026/endpoints')) return new Response(JSON.stringify({ data: { endpoints: EPS } }), { status: 200 });
    if (u.endsWith('/api/v1/chat/completions')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }], usage: {} }), { status: 200 });
    }
    return real(url, init);
  };
  try {
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
    const r = await chat({ model: 'x/thinker', messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: 'none', reasoning: { enabled: false } });
    assert.deepEqual(sent[0].reasoning, { effort: 'low', exclude: true });
    assert.equal(sent[0].tool_choice, 'auto');
    assert.deepEqual(r.message.tool_calls, [], 'calls dropped, as "none" asked');
    assert.ok(asked.some((u) => u.includes('/x/thinker-2026/endpoints')), 'the model list\'s endpoint link is used');
    // With the refusing provider blocked, "none" goes out as asked.
    await chat({ model: 'x/thinker', messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: 'none', provider: { ignore: ['relace', 'tinyhost'] } });
    assert.equal(sent[1].tool_choice, 'none');
    assert.equal(asked.filter((u) => u.includes('/endpoints')).length, 1, 'one endpoint fetch for both calls');
  } finally { globalThis.fetch = real; primeCatalogue('chat', []); forgetModelFacts(); }
});

test('through the OpenRouter client: a tool_choice refusal is learned and the call goes again as auto', async () => {
  forgetModelFacts();
  primeCatalogue('chat', [{ id: 'y/plain' }]);
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/endpoints')) return new Response('{}', { status: 404 });
    if (u.endsWith('/api/v1/chat/completions')) {
      const b = JSON.parse(init.body);
      sent.push(b);
      if (b.tool_choice === 'required') return new Response(JSON.stringify({ error: { message: 'Provider does not support tool_choice "required"' } }), { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 });
    }
    return real(url, init);
  };
  try {
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
    await chat({ model: 'y/plain', messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: 'required' });
    await chat({ model: 'y/plain', messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: 'required' });
    assert.deepEqual(sent.map((b) => b.tool_choice), ['required', 'auto', 'auto'], 'refused once, then remembered');
  } finally { globalThis.fetch = real; primeCatalogue('chat', []); forgetModelFacts(); }
});
