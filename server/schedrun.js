// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Starts a scheduled run on the server (no page needed), the way the page starts a reply: in the schedule's chat
// (made on its first run), with its prompt, model, mode and settings. Strict approvals and questions wait for you
// like in any chat; you hear about a run as the schedule's notify rule says (a run waiting for you always tells you).
// When it ends, its reply is saved into the chat, so the chat is complete even if no page was open. A page that
// opens it while it runs follows it live as usual.
import crypto from 'node:crypto';
import { noteRun, endRun, loadSchedules, PAUSE_AFTER_FAILS } from './schedules.js';

export const CLOSE_TABS_MS = 30e3; // after a run that went well, its Chrome tabs close this much later
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
  const at = deps.now(), runId = rid('r', at);
  const setup = { model: s.model, reasoning: s.reasoning || 'off' };
  const approval = s.approval === 'yolo' ? 'yolo' : 'strict'; // YOLO only when chosen for this schedule
  const user = { role: 'user', content: s.prompt, at, scheduled: { id: s.id, name: s.name, missed, due } };
  const bot = { role: 'assistant', content: '', at, trace: [], approvals: {}, questions: {}, arts: [], runId, runActive: true };
  // Each run is posted in the schedule's chat (the one it was made from, or its first run's), so there is one chat to
  // look at, and you can ask its agent there what the runs saw or to change the schedule. The run itself starts
  // fresh: only the prompt, never the chat's history, so it can't drift on an earlier run's mistakes and costs the
  // same every time. A new chat every run when the schedule asks for that, or when its chat was deleted or moved.
  const prevId = s.newChat ? null : s.chatId || s.lastRun?.chatId;
  const prev = prevId && deps.getChat(prevId);
  const doc = prev && prev.projectId === s.projectId ? prev : null;
  const chatId = doc ? prevId : rid('c', at), title = doc?.title || `⏰ ${s.name}`;
  if (doc) {
    // A chat the schedule made follows its mode and tools; a chat of yours it was made from keeps its own (the run
    // still uses the schedule's).
    if (doc.scheduled?.id === s.id) Object.assign(doc, { approval, tools: s.tools || doc.tools || {} });
    doc.agent = { ...doc.agent, setup, messages: [...(doc.agent?.messages || []), user, bot] };
    deps.saveChat(chatId, doc);
  } else deps.saveChat(chatId, { id: chatId, title, projectId: s.projectId, created: at, approval, tools: s.tools || {}, scheduled: { id: s.id, name: s.name },
    agent: { setup, messages: [user, bot], artifacts: {}, allowed: [], cmdRules: [] } });
  const a = doc?.agent || {};
  const body = { runId, chatId, projectId: s.projectId, chatTitle: title, setup, settings: { ...(s.settings || {}), approval, chromeAccess: s.settings?.chromeAccess ?? !!s.tools?.chrome, schedCardWaitSecs: s.cardWaitSecs || 15 }, allowed: a.allowed || [], cmdRules: a.cmdRules || [],
    ...(a.apps ? { apps: a.apps } : {}), history: [], summary: '', reading: '', text: s.prompt, artifacts: a.artifacts || {}, context: '', images: [], docs: [], scheduledBy: s.id, scheduleTrusted: s.trusted === true };
  deps.startRun({ runId, chatId }, (emit, signal) => deps.runAgent(body, emit, signal));
  // A page that has this chat open learns of the new run (its copy of the chat doesn't have it), and follows it live.
  deps.notify?.('start', { schedule: s, chatId });
  const told = new Set();
  deps.follow(runId, 0, (e) => {
    if (e === null) {
      const ended = finishChat(chatId, runId, deps);
      const status = ended.error ? (ended.stopped ? 'stopped' : 'failed') : 'done';
      const r = endRun(s.id, runId, { status, cost: ended.cost, reply: ended.reply, error: ended.error, ms: deps.now() - at, now: deps.now() });
      // A run that went well: the Chrome tabs it opened (and their tab group) close 30 s later, so Chrome isn't left
      // holding them until the next run. A failed run keeps them, for you to see what it saw. Tabs you gave stay.
      if (status === 'done' && s.closeTabs !== false && deps.closeChromeTabs) setTimeout(() => {
        // (Not when a newer run of it has started meanwhile: that one uses the tabs.)
        const now = loadSchedules().find((x) => x.id === s.id);
        if (now?.lastRun?.runId && now.lastRun.runId !== runId) return;
        deps.closeChromeTabs(chatId)?.catch?.(() => {});
      }, CLOSE_TABS_MS).unref?.();
      if (r?.paused) deps.notify?.('error', { schedule: s, chatId, text: `“${s.name}” failed ${PAUSE_AFTER_FAILS} times in a row, so it is paused. Resume it in Schedules once it is fixed. Last error: ${ended.error}`, cost: ended.cost });
      else if (r ? r.notify : true) deps.notify?.(status === 'done' ? 'done' : 'error', { schedule: s, chatId, text: ended.error && ended.reply ? `${ended.error} ${ended.reply}` : ended.error || ended.reply, cost: ended.cost, changed: r?.changed });
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
  // A run cut off before it finished (out of steps, or ended by the loop guard for going in circles) failed at its
  // job, even with a reply: it counts towards the pause after failures, and its chat says why.
  // A model that stopped answering part-way failed too (the work so far is kept, but the job wasn't done).
  const cut = done?.stats?.stop === 'model_error' ? `The model stopped answering: ${done.stats.modelError || 'see the chat'}` : done?.stats?.stop === 'steps' ? (done.stats.loopEnd ? 'It went in circles (the same failing call again), so it was stopped.' : `It ran out of steps (${done.stats.steps}).`) : '';
  const out = { reply: done?.reply || '', error: done ? cut : err?.msg || 'The reply ended without an answer.', stopped: !!err?.stopped, cost: done?.stats?.cost ?? err?.stats?.cost ?? 0 };
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
