// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A stand-in for `grok agent stdio` (test-agent.mjs): it speaks ACP over stdin/stdout, writes down how it was started
// and what it was sent, and answers the way FAKE_GROK_MODE says. It never calls a model.
import fs from 'node:fs';

const mode = process.env.FAKE_GROK_MODE || 'normal', log = process.env.FAKE_GROK_LOG;
const record = { args: process.argv.slice(2), cwd: process.cwd(), openrouter: !!process.env.OPENROUTER_API_KEY, calls: [] };
const save = () => { if (log) fs.writeFileSync(log, JSON.stringify(record)); };
const say = (j) => process.stdout.write(`${JSON.stringify(j)}\n`);
const update = (sessionId, u) => say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const efforts = [{ value: 'high', id: 'high' }, { value: 'low', id: 'low' }];
let buf = '', promptId = null;
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!j.method && j.id === 'perm1') { record.permissionAnswer = j.result; save(); continue; }
    if (!j.method) continue;
    record.calls.push({ method: j.method, params: j.params }); save();
    const ok = (result) => say({ jsonrpc: '2.0', id: j.id, result });
    if (j.method === 'initialize') ok({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: mode !== 'nopics' } }, authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }],
      _meta: { modelState: { currentModelId: 'grok-4.6', availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 256000, supportsReasoningEffort: true, reasoningEfforts: efforts } }, { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { totalContextTokens: 256000, supportsReasoningEffort: true, reasoningEfforts: efforts } }] } } });
    else if (j.method === 'authenticate') { if (mode === 'signedout') say({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'Authentication required' } }); else ok({}); }
    else if (j.method === 'session/new') ok({ sessionId: 's1', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'grok-4.6', options: [{ value: 'grok-4.7' }, { value: 'grok-4.6' }] }, { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'high', options: efforts }] });
    else if (j.method === 'session/set_config_option') ok({ configOptions: [] });
    else if (j.method === 'session/cancel') { record.cancelled = true; save(); if (promptId != null) say({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } }); }
    else if (j.method === 'session/prompt') {
      promptId = j.id;
      const sys = record.calls.find((c) => c.method === 'session/new').params._meta.systemPromptOverride;
      const key = /<tool_call key="([0-9a-f]+)">/.exec(sys)?.[1] || '';
      if (mode === 'hang') continue;
      if (mode === 'perm') { say({ jsonrpc: '2.0', id: 'perm1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't1', title: 'Run ls', kind: 'execute' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } }); continue; }
      if (mode === 'toolcall') { update('s1', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read_file', kind: 'read' }); continue; }
      update('s1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Plan it.' } });
      update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Writing it. <tool_call key="${key}">{"name":"write_file",` } });
      update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '"arguments":{"path":"a.js"}}</tool_call>' } });
      ok({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 300, outputTokens: 40, reasoningTokens: 10, cachedReadTokens: 100, cacheCreationTokens: 0, costUsdTicks: 123000000 } } });
    } else say({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'no such method' } });
  }
});
