// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A stand-in for `grok` (test-sources.mjs). As `grok agent stdio` it answers the ACP handshake QuorX lists models with;
// in one-shot mode (`--prompt-file`) it writes down how it was started and what it was sent, then streams the way
// FAKE_GROK_MODE says. It never calls a model.
import fs from 'node:fs';

const args = process.argv.slice(2), mode = process.env.FAKE_GROK_MODE || 'normal', log = process.env.FAKE_GROK_LOG;
const say = (j) => process.stdout.write(`${JSON.stringify(j)}\n`);
const efforts = [{ value: 'high', id: 'high' }, { value: 'low', id: 'low' }];

if (args.includes('agent')) {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.method === 'initialize') say({ jsonrpc: '2.0', id: j.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }],
        _meta: { modelState: { currentModelId: 'grok-4.6', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000, supportsReasoningEffort: true, reasoningEfforts: efforts } }, { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { totalContextTokens: 256000, supportsReasoningEffort: true, reasoningEfforts: efforts } }] } } } });
      else if (j.method === 'authenticate') say(mode === 'signedout' ? { jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'Authentication required' } } : { jsonrpc: '2.0', id: j.id, result: {} });
    }
  });
} else {
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const prompt = fs.readFileSync(arg('--prompt-file'), 'utf8');
  if (log) fs.writeFileSync(log, JSON.stringify({ args, prompt, cwd: process.cwd(), openrouter: !!process.env.OPENROUTER_API_KEY }));
  if (mode === 'signedout') { process.stderr.write('You are not authenticated. Run grok login.\n'); process.exit(1); }
  const key = /<quorx_call key="([0-9a-f]+)">/.exec(prompt)?.[1] || '';
  say({ type: 'system', subtype: 'init', session_id: 's1', model: arg('-m'), permissionMode: arg('--permission-mode'), tools: mode === 'tools' ? ['read_file', 'run_terminal_cmd'] : mode === 'mcp' ? ['cloudflare-docs__search'] : [], mcp_servers: [] });
  if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'loop') { // a call block it never finishes, the same lines over and over
    say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `<quorx_call key="${key}">{"name":"write_file","arguments":{"path":"a.html","content":"` } } });
    setInterval(() => say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<li class=\\"game\\">Game</li>'.repeat(40) } } }), 5);
  } else if (mode === 'runaway') { // a call, then the conversation's next turns written by the model itself, without end
    say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Opening it.\n<quorx_call key="${key}">{"name":"read_file","arguments":{"path":"a.js"}}</quorx_call>\n\n` } } });
    setInterval(() => say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `<tool_result key="${key}" name="read_file">\nmade up\n</tool_result>\n\n` } } }), 20);
  }
  else {
    const delta = (d) => say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: d } });
    if (mode === 'inline') { // its call mid-sentence, as grok-4.7-build-fast sometimes writes it
      const inline = `Opening it now. <quorx_call key="${key}">{"name":"read_file","arguments":{"path":"a.js"}}</quorx_call>`;
      delta({ type: 'text_delta', text: inline });
      say({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: inline }], stop_reason: 'end_turn' } });
      say({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 20 } });
      process.exit(0);
    }
    delta({ type: 'thinking_delta', thinking: 'Plan it.' });
    delta({ type: 'text_delta', text: `Writing it.\n<quorx_call key="${key}">{"name":"write_file",` });
    delta({ type: 'text_delta', text: `"arguments":{"path":"a.js"}}</quorx_call>${mode === 'eos' ? '<|eos|>' : ''}` });
    const content = [{ type: 'text', text: `Writing it.\n<quorx_call key="${key}">{"name":"write_file","arguments":{"path":"a.js"}}</quorx_call>` }];
    if (mode === 'tooluse') content.push({ type: 'tool_use', id: 't1', name: 'list_dir', input: {} });
    say({ type: 'assistant', message: { role: 'assistant', content, stop_reason: 'end_turn' } });
    say({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } });
  }
}
