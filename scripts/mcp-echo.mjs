#!/usr/bin/env node
// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A tiny MCP server (stdio) for the tests of QuorX's MCP client (server/mcpclient.js): echo (read-only) and
// add_note (changes things), plus a line on stdout that isn't JSON, as some servers print.
import readline from 'node:readline';

const notes = [];
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
process.stdout.write('mcp-echo starting (a log line, not JSON)\n');
// ECHO_PIDFILE: writes its process id there and keeps running after its input closes, as some servers do.
if (process.env.ECHO_PIDFILE) { (await import('node:fs')).writeFileSync(process.env.ECHO_PIDFILE, String(process.pid)); setInterval(() => {}, 1e3); }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return; // notifications
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mcp-echo', version: '1.0.0' }, instructions: 'A test server.' } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'echo', description: 'Says the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    { name: 'add_note', description: 'Keeps a note.', inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } },
  ] } });
  if (m.method === 'tools/call') {
    const { name, arguments: a = {} } = m.params || {};
    if (name === 'echo') return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo: ${a.text}${process.env.ECHO_SUFFIX || ''}` }] } });
    if (name === 'add_note') { notes.push(a.note); return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `kept ${notes.length} note(s)` }] } }); }
    return out({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: `no tool ${name}` }] } });
  }
  out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
});
