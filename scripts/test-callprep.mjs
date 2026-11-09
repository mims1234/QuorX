// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Tool calls seen while they stream, from every kind of source: OpenAI-style streams (OpenRouter, OpenCode Go, the
// direct APIs, Command Code), Anthropic-style streams, Ollama (whole calls) and models that write their calls as text
// (OpenCode and Claude Code on this PC, Grok). Each must reach the page as preparing rows. No network.
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, reply } from './agent-harness.mjs';
import { textFilter, callWatcher } from '../server/textcalls.js';
import { readMessagesStream } from '../server/commandcode.js';
import { readOllamaStream } from '../server/ollamalocal.js';
import { prepAbout } from '../server/loop.js';

const feed = (watch, text, size = 7) => { for (let i = 0; i < text.length; i += size) watch(text.slice(i, i + size)); };

test('text-written calls: QuorX blocks report the tool, growing arguments and the path, even when it comes last', () => {
  const seen = [];
  const watch = callWatcher((k, c) => seen.push({ k, name: c.function.name, chars: c.chars, about: prepAbout(c.function.arguments) }));
  feed(watch, '<quorx_call key="ab12">{"name": "write_file", "arguments": {"content": "' + 'w'.repeat(200) + '", "path": "notes/tide.md"}}</quorx_call>');
  assert.ok(seen.length > 10, 'reported as it streams');
  assert.ok(seen.every((s) => s.k === 0 && s.name === 'write_file'));
  assert.ok(seen.at(-1).chars > seen[0].chars, 'the size grows');
  assert.equal(seen.find((s) => s.about)?.about, 'notes/tide.md');
  assert.equal(seen.filter((s) => s.about).length < seen.length, true, 'no path until it arrives whole');
});

test('text-written calls: several blocks get their own index, <tool_call> and <invoke> formats included', () => {
  const seen = new Map();
  const watch = callWatcher((k, c) => seen.set(k, { name: c.function.name, about: prepAbout(c.function.arguments), chars: c.chars }));
  feed(watch, '<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>\n<invoke name="shell"><parameter name="command">npm test</parameter></invoke>\n<invoke name="write_file"><parameter name="path">b.md</parameter><parameter name="content">' + 'z'.repeat(80), 5);
  assert.deepEqual([...seen.keys()], [0, 1, 2]);
  assert.deepEqual(seen.get(0), { name: 'read_file', about: 'a.txt', chars: seen.get(0).chars });
  assert.equal(seen.get(1).name, 'shell');
  assert.equal(seen.get(1).about, 'npm test');
  assert.equal(seen.get(2).about, 'b.md', 'a finished parameter is read while the next one is still streaming');
  assert.ok(seen.get(2).chars > 80);
});

test('the text filter still shows only what comes before a call, and hears the call too', () => {
  let shown = '';
  const calls = [];
  const show = textFilter((t) => { shown += t; }, (k, c) => calls.push(c.function.name));
  feed(show, 'I will write it now. <quorx_call key="k">{"name": "write_file", "arguments": {"path": "x"}}</quorx_call>', 4);
  assert.equal(shown, 'I will write it now. ');
  assert.ok(calls.length && calls.every((n) => n === 'write_file'));
  // Without a text listener the calls are still heard (a step whose text isn't shown).
  const only = [];
  feed(textFilter(null, (k, c) => only.push(c.function.name)), '<quorx_call>{"name": "shell", "arguments": {}}</quorx_call>');
  assert.ok(only.includes('shell'));
  assert.equal(callWatcher(null), null);
});

test('Anthropic-style streams report each tool call as its input streams in', async () => {
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const sse = [
    ev({ type: 'message_start', message: { id: 'm1', model: 'claude', usage: { input_tokens: 5 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Writing.' } }),
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'write_file', input: {} } }),
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path": "a.md", ' } }),
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"content": "hi"}' } }),
    ev({ type: 'content_block_stop', index: 1 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
    ev({ type: 'message_stop' }),
  ].join('');
  const seen = [];
  const r = await readMessagesStream(new Response(sse), { model: 'claude' }, Date.now(), null, null, (k, c) => seen.push([k, c.function.name, c.function.arguments]));
  assert.deepEqual(seen.map((s) => s[1]), ['write_file', 'write_file', 'write_file']);
  assert.equal(seen[0][0], 1, 'indexed like the stream\'s blocks');
  assert.equal(seen.at(-1)[2], '{"path": "a.md", "content": "hi"}');
  assert.equal(r.toolCalls[0].function.name, 'write_file');
});

test('Ollama reports each tool call as it lands (Ollama sends calls whole)', async () => {
  const lines = [{ message: { role: 'assistant', content: '' } }, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] } }, { done: true, done_reason: 'stop', message: { content: '' } }]
    .map((o) => JSON.stringify(o)).join('\n') + '\n';
  const seen = [];
  const r = await readOllamaStream({ body: [new TextEncoder().encode(lines)] }, { model: 'q' }, Date.now(), null, null, (k, c) => seen.push([k, c.function.name, c.function.arguments]));
  assert.deepEqual(seen, [[0, 'read_file', '{"path":"a.txt"}']]);
  assert.equal(r.toolCalls.length, 1);
});

test('a chat on an app source sends preparing events from what the source hears', async () => {
  const goInfo = { id: 'opencode-local/opencode-go/glm-5.3', realId: 'opencode-go/glm-5.3', providerID: 'opencode-go', modelID: 'glm-5.3', source: 'opencode-local', kind: 'chat', format: 'opencode-local', plan: 'plan', price: [0, 0], tools: true, maxOut: 4000 };
  let n = 0;
  const sourceStream = async (body, sig, onText, onThink, opts) => {
    n++;
    if (n > 1) return { ...reply('Done.'), provider: 'OpenCode on this PC', source: 'opencode-local', usage: { cost: 0 } };
    assert.equal(typeof opts?.onCall, 'function', 'the source is given the listener');
    for (let i = 1; i <= 3; i++) { opts.onCall(0, { function: { name: 'write_file', arguments: `{"content":"${'x'.repeat(i * 500)}` } }); await new Promise((r) => setTimeout(r, 300)); }
    return { ...reply('', [['write_file', { path: 'tide.md', content: 'x' }]]), provider: 'OpenCode on this PC', source: 'opencode-local', usage: { cost: 0 } };
  };
  const events = [];
  await run(() => { throw new Error('OpenRouter must not be called'); }, { setup: { model: goInfo.id }, catalogue: [{ id: 'test/model', maxOut: 4000 }, goInfo], sourceStream, onEvent: (e) => events.push(e) });
  const preps = events.filter((e) => e.t === 'call_prep');
  assert.ok(preps.length >= 2, `preparing events sent (${preps.length})`);
  assert.ok(preps.every((e) => e.name === 'write_file' && e.step === preps[0].step));
  assert.ok(preps.at(-1).chars > preps[0].chars);
});
