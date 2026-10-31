// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A stand-in for `claude -p --output-format stream-json` (test-sources.mjs): it writes down how it was started and what
// it was sent, then answers the way FAKE_CLAUDE_MODE says. It never calls a model.
import fs from 'node:fs';

const args = process.argv.slice(2), mode = process.env.FAKE_CLAUDE_MODE || 'normal';
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const say = (j) => process.stdout.write(`${JSON.stringify(j)}\n`);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const system = fs.readFileSync(arg('--system-prompt-file'), 'utf8');
  if (process.env.FAKE_CLAUDE_LOG) fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, system, input: JSON.parse(input.trim()), cwd: process.cwd(), openrouter: !!process.env.OPENROUTER_API_KEY }));
  if (mode === 'signedout') { process.stderr.write('Not logged in · Please run /login\n'); process.exit(1); }
  const key = /<quorx_call key="([0-9a-f]+)">/.exec(system)?.[1] || '';
  say({ type: 'system', subtype: 'init', session_id: 's1', model: arg('--model'), tools: mode === 'tools' ? ['Bash', 'Read'] : [], mcp_servers: [] });
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'limit') { say({ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`, total_cost_usd: 0 }); return; }
  const delta = (d) => say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: d } });
  delta({ type: 'thinking_delta', thinking: 'Plan it.' });
  delta({ type: 'text_delta', text: `Writing it.
<quorx_call key="${key}">{"name":"write_file",` });
  delta({ type: 'text_delta', text: '"arguments":{"path":"a.js"}}</quorx_call>' });
  const content = [{ type: 'text', text: `Writing it.
<quorx_call key="${key}">{"name":"write_file","arguments":{"path":"a.js"}}</quorx_call>` }];
  if (mode === 'tooluse') content.push({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } });
  say({ type: 'assistant', message: { role: 'assistant', content, stop_reason: 'end_turn' } });
  say({ type: 'result', subtype: 'success', is_error: false, result: content[0].text, total_cost_usd: 0.0123, usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } });
});
