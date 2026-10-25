// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Everything running in a project, in one list, for the pane's Running tab: dev servers, commands (yours and the
// agent's, including the ones that moved to the background), the agent's own terminals, and your terminal tabs.
// Each row can be stopped from there. The agent keeps working while things run; this is where you see them and
// end what you don't want.
import { serverOverview, serverLog, stopServerWait, listServers } from './workspace.js';
import { runningJobs, stopJob } from './terminal.js';
import { listBackground } from './bgjobs.js';
import { listTerms, termTail, termStop } from './agentterm.js';
import { ptyList, ptyClose } from './pty.js';

const tail = (text, n = 4) => String(text || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n);

/**
 * { items: [{ id, kind, label, source, chatId, started, status, url?, bg?, tail }], elsewhere: [{ projectId, count }] }
 * kind: 'server' · 'background' (a command that went on running in the background) · 'command' · 'agent-term' · 'your-term'.
 */
export function runningIn(projectId) {
  const items = [];
  for (const s of serverOverview(projectId).filter((x) => x.status !== 'stopped')) {
    items.push({ id: `srv:${s.key}`, kind: 'server', label: s.name, detail: [s.command, ...(s.args || [])].filter(Boolean).join(' '), source: null, chatId: null,
      started: s.started, status: s.status, url: s.url || null, tail: tail(serverLog(s.key)) });
  }
  const bgs = listBackground(projectId);
  for (const j of runningJobs(projectId)) {
    const b = bgs.find((x) => (j.bg && x.id === j.bg) || (x.termJob && x.termJob === j.job));
    items.push({ id: `job:${j.job}`, kind: b ? 'background' : 'command', label: j.label, source: j.source, chatId: j.chatId || b?.chatId || null,
      started: b?.started || j.at, status: 'running', bg: b?.id || null, log: b?.log || null, tab: j.tab || null, tail: j.tail });
  }
  for (const t of listTerms(projectId).filter((x) => x.running)) {
    items.push({ id: `aterm:${t.id}`, kind: 'agent-term', label: t.label, source: 'agent', chatId: t.chatId, started: t.started, status: 'running', tail: termTail(t.id) });
  }
  for (const p of ptyList(projectId)) items.push({ id: `pty:${p.tab}`, kind: 'your-term', label: p.shell, tab: p.tab, source: 'you', chatId: null, started: p.started, status: 'open', tail: [] });
  // Other projects: just how much runs there, so nothing is forgotten.
  const counts = new Map();
  for (const j of runningJobs()) if (j.projectId !== projectId) counts.set(j.projectId, (counts.get(j.projectId) || 0) + 1);
  for (const t of listTerms().filter((x) => x.running && x.projectId !== projectId)) counts.set(t.projectId, (counts.get(t.projectId) || 0) + 1);
  for (const s of listServers().filter((x) => x.status !== 'stopped' && x.projectId !== projectId)) counts.set(s.projectId, (counts.get(s.projectId) || 0) + 1);
  return { items, elsewhere: [...counts].map(([pid, count]) => ({ projectId: pid, count })) };
}

/** Stops one row. Your terminal tabs close; everything else ends with all it started. */
export async function stopRunning(projectId, id) {
  const [kind, ...rest] = String(id || '').split(':'), key = rest.join(':');
  if (kind === 'srv') return (await stopServerWait(key, 'you')) || { already: true };
  if (kind === 'job') return (await stopJob(key)) || { already: true };
  if (kind === 'aterm') return termStop(key);
  if (kind === 'pty') return { closed: ptyClose(projectId, key) };
  throw new Error('unknown item');
}

/** Stops everything the agent or a server runs in the project (your own terminal tabs stay open). */
export async function stopAllIn(projectId) {
  const { items } = runningIn(projectId);
  const todo = items.filter((x) => x.kind !== 'your-term');
  const results = await Promise.all(todo.map((x) => stopRunning(projectId, x.id).catch((e) => ({ error: e.message }))));
  return { stopped: todo.length, left: results.reduce((n, r) => n + (r?.left || 0), 0) };
}
