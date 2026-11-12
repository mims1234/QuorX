// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A scripted stand-in for an ACP CLI (`agy acp`, `codex-acp`, `gemini --acp`, …) used by scripts/test-sources.mjs.
// Speaks JSON-RPC 2.0 over stdio and logs every request it saw to FAKE_ACP_LOG; never calls a model or the network.
import fs from 'node:fs';

const args = process.argv.slice(2), mode = process.env.FAKE_ACP_MODE || 'normal', logFile = process.env.FAKE_ACP_LOG;
const record = { args, cwd: process.cwd(), openrouter: !!process.env.OPENROUTER_API_KEY, droidNoUpdate: process.env.DROID_DISABLE_AUTO_UPDATE || null, requests: [], permOutcomes: [] };
const flush = () => { if (logFile) { try { fs.writeFileSync(logFile, JSON.stringify(record)); } catch { /* ignore */ } } };
const say = (j) => process.stdout.write(`${JSON.stringify(j)}\n`);

const CONFIG = [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'yolo', options: [{ value: 'ask', name: 'Ask' }, { value: 'yolo', name: 'YOLO' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-3-flash', options: [
    { group: 'featured', name: 'Featured', options: [
      { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon', description: 'Frontier multimodal', _meta: { totalContextTokens: 1000000 } },
      { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { value: 'old-preview', name: 'Old Preview [Deprecated]' },
    ] },
  ] },
  { id: 'thinking', name: 'Thinking level', category: 'thought_level', type: 'select', currentValue: 'Medium', options: ['Low', 'Medium', 'High', 'Extra', 'Max'].map((v) => ({ value: v, name: v })) },
];

let authed = mode !== 'signedout' && mode !== 'envkey', pendingPromptId = null;
let buf = '';
process.stdin.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.id != null && !j.method) { record.permOutcomes.push(j.result?.outcome || j.error || null); flush(); continue; }
    record.requests.push({ method: j.method, params: j.params });
    flush();

    if (j.method === 'initialize') {
      say({ jsonrpc: '2.0', id: j.id, result: {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { close: {}, systemPrompt: { mode: { override: {} } } },
          promptCapabilities: { image: true },
        },
        agentInfo: { name: 'fake-acp', version: '1.5.1' },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'gemini-api-key', name: 'Gemini API key' }, { id: 'terminal-login', type: 'terminal', args: ['--login'] }],
      } });
    } else if (j.method === 'authenticate') {
      if (j.params?.methodId === 'gemini-api-key' && process.env.GEMINI_API_KEY) { authed = true; say({ jsonrpc: '2.0', id: j.id, result: {} }); }
      else say({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'Authentication required' } });
    } else if (j.method === 'session/new') {
      if (!authed) { say({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'Authentication required' } }); continue; }
      say({ jsonrpc: '2.0', id: j.id, result: { sessionId: 'sess_qx_1', configOptions: structuredClone(CONFIG) } });
    } else if (j.method === 'session/set_config_option') {
      for (const c of CONFIG) if (c.id === j.params?.configId) c.currentValue = j.params.value;
      say({ jsonrpc: '2.0', id: j.id, result: { configOptions: structuredClone(CONFIG) } });
    } else if (j.method === 'session/close') {
      say({ jsonrpc: '2.0', id: j.id, result: {} });
    } else if (j.method === 'session/cancel') {
      if (pendingPromptId != null) { say({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } }); pendingPromptId = null; }
      setImmediate(() => process.exit(0));
    } else if (j.method === 'session/prompt') {
      pendingPromptId = j.id;
      const sid = j.params?.sessionId || 'sess_qx_1';
      const sysText = JSON.stringify(record.requests);
      const promptText = (j.params?.prompt || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const key = /<quorx_call key="([0-9a-f]+)">/.exec(`${sysText}\n${promptText}`)?.[1] || '';

      if (mode === 'hang') { setInterval(() => {}, 1000); continue; }
      if (mode === 'perm_always' || (mode === 'perm_retry' && !promptText.includes('[QuorX] Your last answer tried'))) {
        say({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: {
          sessionId: sid, title: 'Run shell command?',
          subject: { type: 'tool_call', toolCall: { toolCallId: 'tc_1', name: 'run_command', title: 'run_command', rawInput: { cmd: 'rm -rf /' } } },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
        } });
        continue;
      }

      const chunk = (sessionUpdate, text) => say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate, content: { type: 'text', text } } } });
      if (mode === 'websearch') { // Cursor's way: a line of text, then its own web search as a tool call (QuorX cancels it)
        chunk('agent_message_chunk', 'Checking today’s market headlines.');
        say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc_ws', title: 'Web search: stock market news today Dow S&P Nasdaq', kind: 'fetch', status: 'pending', rawInput: {} } } });
        continue;
      }
      chunk('agent_thought_chunk', 'Plan via ACP.');
      chunk('agent_message_chunk', `Building now.\n<quorx_call key="${key}">{"name":"write_file",`);
      chunk('agent_message_chunk', `"arguments":{"path":"app.js"}}</quorx_call>`);
      if (mode !== 'nousage') {
        say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 700, size: 1000000, ...(mode === 'usdcost' ? { cost: { amount: 0.015, currency: 'USD' } } : {}) } } });
      }
      say({ jsonrpc: '2.0', id: j.id, result: {
        stopReason: 'end_turn',
        ...(mode === 'nousage' ? {} : { usage: { inputTokens: 500, outputTokens: 45, cachedReadTokens: 200, thoughtTokens: 15 } }),
      } });
    }
  }
});
