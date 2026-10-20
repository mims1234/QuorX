#!/usr/bin/env node
// QuorX as an MCP server (stdio), so Claude Code, OpenDesign or any MCP client can hand work to QuorX.
// It talks to the QuorX you have running (QUORX_URL, default http://localhost:<AGENT_PORT or 5188>) over its own
// HTTP API, so every reply it starts is an ordinary chat in your sidebar, with your budgets and checks.
// Approvals and the agent's questions stay yours: a client can see that a reply waits for you, never answer for you.
//   claude mcp add quorx -- node <path to QuorX>/server/mcp.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPort = (() => { try { return fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^\s*AGENT_PORT\s*=\s*(\d+)/m)?.[1]; } catch { return null; } })();
const BASE = (process.env.QUORX_URL || `http://localhost:${process.env.AGENT_PORT || envPort || 5188}`).replace(/\/+$/, '');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0'; } })();

async function api(p, opts = {}) {
  let r;
  try { r = await fetch(BASE + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: opts.signal || AbortSignal.timeout(30000) }); }
  catch (e) { throw new Error(`QuorX is not answering at ${BASE} (${e.cause?.code || e.message}). Start it, or set QUORX_URL.`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error) throw new Error(`QuorX answered ${r.status} for ${p}`);
  return j;
}
const id36 = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
async function project(ref) {
  const list = await api('/api/projects');
  const p = list.find((x) => x.id === ref) || list.find((x) => x.name.toLowerCase() === String(ref || '').toLowerCase());
  if (!p) throw new Error(`no project "${ref}". Projects: ${list.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}`);
  if (p.missing || p.needsFolder) throw new Error(`project "${p.name}" has no folder to work in; reselect it in QuorX first`);
  return p;
}

// What a reply has done so far, in a few lines: its status, what it is waiting for, the last steps, and its answer.
function summarize(runId, log, chatId) {
  const ev = log.events || [];
  const done = ev.find((e) => e.t === 'done'), err = ev.findLast((e) => e.t === 'error');
  const asked = ev.filter((e) => e.t === 'question'), answered = new Set(ev.filter((e) => e.t === 'answer').map((e) => e.id));
  const appr = ev.filter((e) => e.t === 'approval'), apprDone = new Set(ev.filter((e) => e.t === 'approval_done').map((e) => e.id));
  const waitQ = asked.find((q) => !answered.has(q.id) && !q.auto), waitA = appr.find((a) => !apprDone.has(a.id));
  const status = done ? 'done' : err ? (err.stopped ? 'stopped' : 'failed') : log.status === 'running' ? (waitQ || waitA ? 'waiting for the user' : 'working') : log.status || 'unknown';
  const tools = ev.filter((e) => e.t === 'tool' && !e.by).map((e) => `${e.name}${e.args?.path ? ` ${e.args.path}` : e.args?.target ? ` ${e.args.target}` : ''}`);
  const review = ev.findLast((e) => e.t === 'review'), verify = ev.findLast((e) => e.t === 'verify');
  const lines = [`Reply ${runId} in chat ${chatId || '?'}: ${status}.`];
  if (waitQ) lines.push(`Waiting for the user to answer in QuorX: "${clip(waitQ.question, 200)}". Answers come only from the user; check again later.`);
  if (waitA) lines.push(`Waiting for the user's approval in QuorX: ${clip(waitA.what || waitA.tool, 200)}. Only the user can approve; check again later.`);
  if (tools.length) lines.push(`Steps so far (${tools.length}): ${tools.slice(-10).join(' · ')}`);
  if (verify) lines.push(`Checks: ${verify.ok ? 'passed' : `${verify.problems?.length || 0} problem(s)`}${verify.lint ? `, design lint ${verify.lint.fix} to fix / ${verify.lint.consider} to consider` : ''}`);
  if (review) lines.push(`Reviewer: ${review.pass ? 'passed' : 'not passed'} (${Object.entries(review.scores || {}).map(([k, v]) => `${k} ${v}/5`).join(', ')})`);
  if (done) lines.push(`Cost: $${(done.stats?.cost || 0).toFixed(4)}${done.stats?.changed?.length ? ` · files changed: ${done.stats.changed.slice(0, 20).join(', ')}` : ''}`, '', 'Answer:', String(done.reply || '').trim() || '(no text)');
  if (err && !done) lines.push(`Ended: ${clip(err.msg, 300)}`);
  return { status, text: lines.join('\n'), done, err };
}
// When a reply has ended, its answer is saved into its chat, so the sidebar and the chat show it like any other.
async function saveAnswer(chatId, runId, s) {
  const chat = await api(`/api/chats/${chatId}`).catch(() => null);
  if (!chat?.agent?.messages) return;
  const answer = { content: s.done ? String(s.done.reply || '') : `⚠ ${s.err?.msg || 'The reply ended without an answer.'}`, live: false, runActive: false, ...(s.done?.stats ? { stats: s.done.stats } : {}), ...(s.done ? {} : { error: true }) };
  const m = chat.agent.messages.find((x) => x.role === 'assistant' && x.runId === runId);
  if (m?.content) return; // the page has already shown and saved it
  // A page on another QuorX may have marked it interrupted while it ran; the log knows better.
  if (m) { delete m.error; delete m.resumable; Object.assign(m, answer); } else chat.agent.messages.push({ role: 'assistant', at: Date.now(), runId, ...answer });
  await api(`/api/chats/${chatId}`, { method: 'PUT', body: JSON.stringify(chat) }).catch(() => {});
}
const runChat = new Map(); // runId → chatId, for replies this process started

const TOOLS = [
  { name: 'list_projects', description: 'List the QuorX projects (each is a folder on this computer) with their spend and budget.', inputSchema: { type: 'object', properties: {} },
    run: async () => (await api('/api/projects')).map((p) => `${p.name} (id ${p.id})${p.missing ? ' · folder missing' : ''} · ${p.dir || ''} · spent $${(p.spent || 0).toFixed(3)}${p.budget != null ? ` of $${p.budget}` : ''}`).join('\n') || 'No projects yet.' },
  { name: 'list_files', description: "List a project's files (without QuorX's own .quorx folder).", inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string', description: 'Project id or name' } } },
    run: async ({ project: ref }) => { const p = await project(ref); const f = await api(`/api/files?project=${encodeURIComponent(p.id)}`); const list = (Array.isArray(f) ? f : f.files || []).filter((x) => !String(x.path).startsWith('.quorx')); return list.length ? `${list.slice(0, 400).map((x) => `${x.path} (${x.size} bytes)`).join('\n')}${list.length > 400 ? `\n… ${list.length - 400} more` : ''}` : 'The folder is empty.'; } },
  { name: 'read_file', description: 'Read a text file of a project, up to 100k characters at a time (continue with offset).', inputSchema: { type: 'object', required: ['project', 'path'], properties: { project: { type: 'string' }, path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } } },
    run: async ({ project: ref, path: rel, offset = 0 }) => { const p = await project(ref); const r = await api(`/api/files/read?project=${encodeURIComponent(p.id)}&path=${encodeURIComponent(rel)}&offset=${Number(offset) || 0}`); if (r.error) throw new Error(r.error); return `${r.text}${r.more ? `\n\n[… ${r.total - r.offset - r.text.length} more characters: call again with offset ${r.offset + r.text.length}]` : ''}`; } },
  { name: 'start_reply', description: "Ask QuorX's agent to do something in a project: it works in the project folder with QuorX's tools, checks and reviewer, as a chat the user can open in QuorX. Returns at once with the reply's id; follow it with get_reply. In Strict mode (the default) paid tools and the agent's questions wait for the user in QuorX.", inputSchema: { type: 'object', required: ['project', 'message'], properties: {
    project: { type: 'string', description: 'Project id or name' }, message: { type: 'string', description: 'What to do, as you would tell the agent' },
    chat: { type: 'string', description: 'Continue this chat (its id) instead of starting a new one' }, model: { type: 'string', description: 'OpenRouter model id (default: the QuorX default model)' },
    approval: { type: 'string', enum: ['strict', 'yolo'], description: 'strict (default): ask the user before paid tools · yolo: no asking; the deciders check paid calls' } } },
    run: async ({ project: ref, message, chat: chatRef, model, approval = 'strict' }) => {
      const p = await project(ref);
      const cfg = await api('/api/config').catch(() => ({}));
      let chat = chatRef ? await api(`/api/chats/${chatRef}`).catch(() => null) : null;
      if (chatRef && !chat?.agent) throw new Error(`no chat ${chatRef}`);
      if (chat && chat.projectId !== p.id) throw new Error(`chat ${chatRef} belongs to another project`);
      const setup = { model: model || chat?.agent?.setup?.model || cfg.defaults?.chatModel || 'deepseek/deepseek-v4.1-flash-1017' };
      chat ||= { id: id36('cm'), title: clip(String(message).replace(/\s+/g, ' '), 60), projectId: p.id, created: Date.now(), approval: approval === 'yolo' ? 'yolo' : 'strict', agent: { setup, allowed: [], messages: [], artifacts: {} }, from: 'mcp' };
      const history = chat.agent.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error).slice(-20).map((m) => ({ role: m.role, at: m.at, content: String(m.content || '') }));
      const runId = id36('r');
      chat.agent.messages.push({ role: 'user', content: String(message), at: Date.now(), from: 'mcp' });
      chat.agent.messages.push({ role: 'assistant', content: '', at: Date.now(), runId, live: true, runActive: true, trace: [], approvals: {}, questions: {}, arts: [] });
      const saved = await api(`/api/chats/${chat.id}`, { method: 'PUT', body: JSON.stringify(chat) });
      if (saved?.error) throw new Error(saved.error);
      // The reply belongs to QuorX once it starts: read its stream only until it has begun, then let it work.
      const ac = new AbortController();
      const body = { runId, chatId: chat.id, projectId: p.id, chatTitle: chat.title, setup, settings: { approval: chat.approval, mediaEnabled: false }, allowed: [], history, summary: '', text: String(message), artifacts: {}, context: '', images: [], docs: [] };
      const r = await fetch(`${BASE}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal }).catch((e) => { throw new Error(`QuorX is not answering at ${BASE} (${e.cause?.code || e.message})`); });
      try { const rd = r.body.getReader(); const end = Date.now() + 15000; let got = ''; while (Date.now() < end && !/"t":"start"/.test(got)) { const { value, done } = await rd.read(); if (done) break; got += Buffer.from(value).toString('utf8'); } } catch { /* the reply goes on regardless */ }
      ac.abort();
      // The chat keeps a live placeholder for the reply, so opening it in QuorX shows the reply working (and its
      // approval cards); get_reply fills in the answer when the page hasn't already.
      runChat.set(runId, chat.id);
      return `Started reply ${runId} in project ${p.name}, chat ${chat.id} ("${chat.title}"), model ${setup.model}, ${chat.approval}. The user can watch it in QuorX at ${BASE}. Call get_reply with run "${runId}" and chat "${chat.id}" to follow it.`;
    } },
  { name: 'get_reply', description: 'How a reply started with start_reply is doing: working, waiting for the user, done (with its answer, cost, checks and review) or failed.', inputSchema: { type: 'object', required: ['run'], properties: { run: { type: 'string' }, chat: { type: 'string', description: 'The chat id start_reply gave (lets QuorX save the answer into the chat)' }, wait: { type: 'integer', minimum: 0, maximum: 120, description: 'Seconds to wait for it to finish before answering (default 20)' } } },
    run: async ({ run, chat, wait = 20 }) => {
      const chatId = chat || runChat.get(run);
      const end = Date.now() + Math.max(0, Math.min(120, Number(wait) || 0)) * 1000;
      let s;
      for (;;) {
        const log = await api(`/api/runs/${encodeURIComponent(run)}/log`);
        if (log.error) throw new Error(log.error);
        if (log.status === 'unknown') throw new Error(`no reply ${run}`);
        s = summarize(run, log, chatId);
        if (['done', 'failed', 'stopped', 'waiting for the user', 'interrupted'].includes(s.status) || Date.now() >= end) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      if ((s.done || s.err) && chatId) await saveAnswer(chatId, run, s);
      return s.text;
    } },
  { name: 'stop_reply', description: 'Stop a reply that is working.', inputSchema: { type: 'object', required: ['run'], properties: { run: { type: 'string' } } },
    run: async ({ run }) => ((await api(`/api/runs/${encodeURIComponent(run)}/stop`, { method: 'POST', body: '{}' })).ok ? `Stopped ${run}.` : `${run} was not running.`) },
];

// ---------- JSON-RPC over stdio, one message per line ----------
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
async function handle(m) {
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'quorx', version: VERSION }, instructions: 'QuorX is a local agent harness. Use start_reply to have its agent build or change things in a project folder, then get_reply to follow it. Approvals and the agent\'s questions are answered by the user in QuorX, not through these tools.' } });
  if (m.method === 'ping') return send({ id: m.id, result: {} });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
  if (m.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === m.params?.name);
    if (!tool) return send({ id: m.id, error: { code: -32602, message: `unknown tool ${m.params?.name}` } });
    try { return send({ id: m.id, result: { content: [{ type: 'text', text: String(await tool.run(m.params.arguments || {})) }] } }); }
    catch (e) { return send({ id: m.id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } }); }
  }
  if (m.id !== undefined && m.method) return send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    handle(m).catch((e) => send({ id: m.id ?? null, error: { code: -32603, message: e.message } }));
  }
});
process.stdin.on('end', () => process.exit(0));
