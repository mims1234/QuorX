// Starts a scheduled chat on the server (no page needed), the way the page starts one: a new chat in the
// schedule's project with its prompt, model, mode and settings. Strict approvals and questions wait for you like in
// any chat; you get a notification when it waits and when it ends. When it ends, its reply is saved into the chat,
// so the chat is complete even if no page was open. A page that opens it while it runs follows it live as usual.
import crypto from 'node:crypto';
import { noteRun } from './schedules.js';

const rid = (p, t) => `${p}${t.toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const WAIT_EVENTS = (e) => (e.t === 'approval' && e.mode === 'strict') || (e.t === 'question' && !e.auto) || e.t === 'budget_ask';

/**
 * deps: { now, listProjects, budgetState, saveChat, getChat, startRun, follow, runAgent, notify(kind, info) }
 * Returns { chatId, runId, status } for the scheduler, or { status: 'skipped', note } when it can't run now.
 */
export function startScheduledChat(s, { missed = false, due = null } = {}, deps) {
  const project = deps.listProjects().find((p) => p.id === s.projectId);
  if (!project) throw new Error('its project no longer exists');
  if (project.missing || project.needsFolder) throw new Error('its project folder is missing');
  const b = deps.budgetState(s.projectId);
  if (b.budget != null && b.left <= 0) {
    deps.notify?.('budget', { schedule: s, text: `${project.name} has reached its budget, so “${s.name}” did not run.` });
    return { status: 'skipped', note: 'the project has reached its budget' };
  }
  const at = deps.now(), chatId = rid('c', at), runId = rid('r', at);
  const title = `⏰ ${s.name}`;
  const setup = { model: s.model, reasoning: s.reasoning || 'off' };
  const approval = s.approval === 'yolo' ? 'yolo' : 'strict'; // YOLO only when chosen for this schedule
  const user = { role: 'user', content: s.prompt, at, scheduled: { id: s.id, name: s.name, missed, due } };
  const bot = { role: 'assistant', content: '', at, trace: [], approvals: {}, questions: {}, arts: [], runId, runActive: true };
  deps.saveChat(chatId, { id: chatId, title, projectId: s.projectId, created: at, approval, tools: s.tools || {}, scheduled: { id: s.id, name: s.name },
    agent: { setup, messages: [user, bot], artifacts: {}, allowed: [], cmdRules: [] } });
  const body = { runId, chatId, projectId: s.projectId, chatTitle: title, setup, settings: { ...(s.settings || {}), approval, chromeAccess: s.settings?.chromeAccess ?? !!s.tools?.chrome }, allowed: [], cmdRules: [],
    history: [], summary: '', reading: '', text: s.prompt, artifacts: {}, context: '', images: [], docs: [] };
  deps.startRun({ runId, chatId }, (emit, signal) => deps.runAgent(body, emit, signal));
  const told = new Set();
  deps.follow(runId, 0, (e) => {
    if (e === null) {
      const ended = finishChat(chatId, runId, deps);
      const status = ended.error ? (ended.stopped ? 'stopped' : 'failed') : 'done';
      noteRun(s.id, runId, { status, ended: deps.now(), cost: ended.cost, ...(ended.error ? { note: ended.error } : {}) });
      deps.notify?.(status === 'done' ? 'done' : 'error', { schedule: s, chatId, text: ended.error || ended.reply, cost: ended.cost });
      return;
    }
    if (WAIT_EVENTS(e) && !told.has(e.id ?? e.t)) {
      told.add(e.id ?? e.t);
      noteRun(s.id, runId, { status: 'waiting' });
      deps.notify?.(e.t === 'budget_ask' ? 'budget' : e.t === 'question' ? 'answer' : 'approval', { schedule: s, chatId, text: e.what || e.question || e.tool || '' });
    }
    if (e.t === 'approval_done' || e.t === 'answer' || e.t === 'budget_done') noteRun(s.id, runId, { status: 'running' });
  });
  return { chatId, runId, status: 'running' };
}

/**
 * Writes a finished run into its chat, as the page would have: the reply, its steps, cards and cost. Skipped when a
 * page already saved the finished reply (the message is no longer marked running).
 */
export function finishChat(chatId, runId, deps) {
  const events = deps.events(runId);
  const done = events.find((e) => e.t === 'done'), err = [...events].reverse().find((e) => e.t === 'error');
  const out = { reply: done?.reply || '', error: done ? '' : err?.msg || 'The reply ended without an answer.', stopped: !!err?.stopped, cost: done?.stats?.cost ?? err?.stats?.cost ?? 0 };
  const doc = deps.getChat(chatId), m = doc?.agent?.messages?.find((x) => x.runId === runId);
  if (!m || !m.runActive) return out;
  const trace = [], approvals = {}, questions = {}, arts = [];
  let text = '';
  for (const e of events) {
    if (e.t === 'token') { text += e.text; continue; }
    if (e.t === 'think' || e.t === 'spend' || e.t === 'start') continue;
    if (e.t === 'approval') approvals[e.id] = { card: e };
    if (e.t === 'approval_done' && approvals[e.id]) approvals[e.id].outcome = e;
    if (e.t === 'question') questions[e.id] = { card: e };
    if (e.t === 'answer' && questions[e.id]) questions[e.id].answer = e;
    if (e.t === 'artifact' && e.artifact?.id) {
      const x = e.artifact;
      doc.agent.artifacts = { ...(doc.agent.artifacts || {}), [x.id]: { id: x.id, kind: x.kind, title: x.title, html: x.html, md: x.md, url: x.url, cost: x.cost, ms: x.ms, model: x.model, updated: Date.now() } };
      if (!arts.some((y) => y.id === x.id)) arts.push({ id: x.id, kind: x.kind, title: x.title });
      continue;
    }
    if (e.t === 'compacted') { doc.agent.summary = e.summary; doc.agent.summaryAt = e.cutoffAt; }
    trace.push(e);
  }
  for (const x of Object.values(approvals)) if (!x.outcome && x.card.mode === 'strict') x.outcome = { approve: false, by: 'the reply ending' };
  for (const q of Object.values(questions)) if (!q.answer) q.answer = { label: '(not answered: the reply ended)' };
  Object.assign(m, { content: done ? done.reply : text.trim(), trace, approvals, questions, arts, runActive: false, live: false, doneAt: deps.now() });
  if (done) Object.assign(m, { note: done.historyNote, stats: done.stats });
  else { m.error = out.error; if (err?.stats) m.stats = { ...err.stats, partial: true }; }
  deps.saveChat(chatId, doc);
  return out;
}
