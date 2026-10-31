// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Schedules, Quoriums, memory, secrets, servers, video tools and Video Mode.
// The agent loop runs with a scripted model (agent-harness.mjs): no network, no money. Each test gets a throwaway
// project in the temp folder, removed afterwards.
// test-home.mjs comes first: it points QuorX at a throwaway data folder before any server module reads it.
import { tempDir } from './test-home.mjs';
import { reply, run, toolResults, of } from './agent-harness.mjs';
import { videoBody, editCommand, ffmpegMajor } from '../server/video.js';
import { primeCatalogue } from '../server/openrouter.js';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, inPlaceEdit, deciderPicture, REVIEW_SYSTEM, FILM_KEYS, answerQuestion, answerSecret, answerApproval } from '../server/agent.js';
import { saveProject, forgetProject, setProjectBudget } from '../server/store.js';
import { ledger } from '../server/runs.js';
import { budgetState } from '../server/budget.js';
import { nextAfter, cleanWhen, cleanSchedule, describeWhen, createScheduler, saveSchedules as saveScheds, loadSchedules as loadScheds, GRACE_MS, endRun, PAUSE_AFTER_FAILS } from '../server/schedules.js';
import { startScheduledChat } from '../server/schedrun.js';
import { loadMemory, saveMemory, addMemory, checkMemory, looksSecret, memoryPrompt, memoryTokens, MEMORY_TOKENS } from '../server/memory.js';
import { listQuoriums, saveQuorium, removeQuorium, cleanQuorium, BUILT_IN, MODULES as Q_MODULES } from '../server/quoriums.js';
import { startRun, follow, getRun, readLog } from '../server/runs.js';
import { getChat, saveChat as storeChat, listProjects } from '../server/store.js';
import { setSecret, parseEnv, secretKind, scrubSecrets } from '../server/projectsecrets.js';
import { looksLikeFilm, videoModeFor, filmFacts, factsText, finishedFilms, videoRules, recommendedRoute, recommendedMusic, VIDEO_DEFAULTS } from '../server/videomode.js';
import { settleTempo, analyse, tempoOf, barsOf, fitPlan, pickWindows, cutsVsBeats } from '../server/musicmap.js';
import { checkHtml } from '../server/checks.js';

// ---------- scheduled tasks (server/schedules.js, server/schedrun.js), on a fake clock ----------

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

 // local time; 2026-10-19 is a Monday

test('schedules: the next run of a daily, weekday, one-off and repeating schedule', () => {
  const weekdays = cleanWhen({ kind: 'daily', time: '9:00', days: [1, 2, 3, 4, 5] });
  assert.equal(weekdays.time, '09:00');
  assert.equal(nextAfter(weekdays, at(2026, 10, 19, 8, 59)), at(2026, 10, 19, 9, 0));   // Monday, before 9
  assert.equal(nextAfter(weekdays, at(2026, 10, 19, 9, 0)), at(2026, 10, 20, 9, 0));    // exactly 9: the next one
  assert.equal(nextAfter(weekdays, at(2026, 10, 23, 10, 0)), at(2026, 10, 26, 9, 0));   // Friday after 9: Monday
  assert.equal(nextAfter(cleanWhen({ kind: 'daily', time: '18:30', days: [0, 1, 2, 3, 4, 5, 6] }), at(2026, 10, 24, 19)), at(2026, 10, 25, 18, 30));
  assert.equal(nextAfter({ kind: 'once', at: at(2026, 10, 21, 15) }, at(2026, 10, 21, 14)), at(2026, 10, 21, 15));
  assert.equal(nextAfter({ kind: 'once', at: at(2026, 10, 21, 15) }, at(2026, 10, 21, 15)), null);
  const every = cleanWhen({ kind: 'every', minutes: 120 });
  assert.equal(nextAfter(every, at(2026, 10, 21, 13, 10), at(2026, 10, 21, 12)), at(2026, 10, 21, 14));
  assert.throws(() => cleanWhen({ kind: 'every', minutes: 2 }), /3 minutes/);
  assert.equal(cleanWhen({ kind: 'every', minutes: 3 }).minutes, 3);
  assert.throws(() => cleanWhen({ kind: 'daily', time: '25:00' }), /time like/);
  assert.equal(describeWhen(weekdays), 'weekdays at 09:00');
  assert.equal(describeWhen(every), 'every 2 hours');
  // YOLO only when chosen for the schedule, whatever the settings say.
  const base = { prompt: 'p', projectId: 'p1', model: 'test/model', when: { kind: 'once', at: at(2026, 10, 22) } };
  assert.equal(cleanSchedule({ ...base, settings: { approval: 'yolo' } }, at(2026, 10, 21)).approval, 'strict');
  assert.equal(cleanSchedule({ ...base, approval: 'yolo' }, at(2026, 10, 21)).approval, 'yolo');
});

test('the scheduler runs what is due, runs a missed run once on wake (labelled), skips paused ones and ends one-offs', async () => {
  let now = at(2026, 10, 19, 8, 0), store = [];
  const ran = [];
  const sched = createScheduler({ now: () => now, load: () => store, save: (l) => { store = l; }, lease: false, run: async (s, info) => { ran.push({ id: s.id, ...info, at: now }); return { chatId: `c-${ran.length}`, runId: `r-${ran.length}` }; } });
  store = [
    cleanSchedule({ prompt: 'standup', projectId: 'p', model: 'test/model', name: 'Standup', when: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } }, now),
    cleanSchedule({ prompt: 'remind me', projectId: 'p', model: 'test/model', name: 'Remind', when: { kind: 'once', at: at(2026, 10, 19, 9, 30) } }, now),
    cleanSchedule({ prompt: 'paused', projectId: 'p', model: 'test/model', name: 'Off', paused: true, when: { kind: 'daily', time: '09:00', days: [] } }, now),
  ];
  assert.equal(store[2].nextAt, null);
  now = at(2026, 10, 19, 8, 59); await sched.tick();
  assert.equal(ran.length, 0);
  now = at(2026, 10, 19, 9, 0) + 20e3; await sched.tick();               // on time (20 s late is within the grace)
  assert.deepEqual(ran.map((r) => [r.id, r.missed]), [[store[0].id, false]]);
  assert.equal(store[0].lastRun.chatId, 'c-1');
  assert.equal(store[0].nextAt, at(2026, 10, 20, 9, 0));
  now = at(2026, 10, 19, 9, 31); await sched.tick();                     // the one-off
  assert.equal(ran.at(-1).id, store[1].id);
  assert.equal(store[1].nextAt, null);
  // Asleep from Monday evening to Wednesday 14:00: Tuesday's and Wednesday's runs were missed; one run, labelled.
  now = at(2026, 10, 21, 14, 0); await sched.tick();
  const woke = ran.slice(2);
  assert.equal(woke.length, 1);
  assert.equal(woke[0].missed, true);
  assert.equal(woke[0].due, at(2026, 10, 20, 9, 0));
  assert.ok(woke[0].late > GRACE_MS);
  assert.equal(store[0].lastRun.missed, true);
  assert.equal(store[0].nextAt, at(2026, 10, 22, 9, 0));
  now += 60e3; await sched.tick();                                       // nothing more until Thursday
  assert.equal(ran.length, 3);
  // A repeat whose last run is still going skips its turn instead of starting a second run beside it.
  let going = true, n = 0, list = [cleanSchedule({ prompt: 'drop', projectId: 'p', model: 'test/model', name: 'Drop', when: { kind: 'every', minutes: 3 } }, now)];
  const rep = createScheduler({ now: () => now, load: () => list, save: (l) => { list = l; }, lease: false, running: () => going, run: async () => ({ chatId: 'c', runId: `rr-${++n}` }) });
  now += 3 * 60e3; await rep.tick();
  assert.equal(n, 1);
  now += 3 * 60e3; await rep.tick();
  assert.equal(n, 1, 'still going: skipped');
  assert.equal(list[0].lastRun.skipped, 1);
  assert.ok(list[0].nextAt > now, 'the next turn is planned');
  going = false; now += 3 * 60e3; await rep.tick();
  assert.equal(n, 2, 'finished: the next turn runs');
  // A run that fails to start is recorded, and the schedule carries on.
  const bad = createScheduler({ now: () => at(2026, 10, 22, 9, 1), load: () => store, save: (l) => { store = l; }, lease: false, run: async () => { throw new Error('its project no longer exists'); } });
  await bad.tick();
  assert.equal(store[0].lastRun.status, 'failed');
  assert.match(store[0].lastRun.note, /no longer exists/);
  assert.equal(store[0].nextAt, at(2026, 10, 23, 9, 0));
});

// A scheduled chat on the scripted model: the real run store, chat store and agent loop.
function schedDeps(script, { onNotify } = {}) {
  let i = 0;
  const chatStream = async (body) => script(body, i++);
  return {
    now: Date.now, listProjects, budgetState, saveChat: storeChat, getChat, startRun, follow,
    events: (id) => getRun(id)?.events || readLog(id),
    runAgent: (body, emit, signal) => runAgent(body, emit, signal, { chatStream, catalogue: [{ id: 'test/model', maxOut: 4000 }], quiet: true }),
    notify: (kind, info) => onNotify?.(kind, info),
  };
}
const ended = (kinds = ['done', 'error']) => { let res; const p = new Promise((r) => { res = r; }); return { p, on: (k, info) => { if (kinds.includes(k)) res({ k, info }); } }; };

test('a scheduled chat runs like a normal chat and is saved complete; cut off by the step limit it counts as failed and keeps its reply', async () => {
  { // a scheduled chat runs like a normal chat and is saved complete, with no page open
    const dir = tempDir('quorx-sched-'), pid = `sp${Date.now().toString(36)}`;
    saveProject({ id: pid, name: 'sched', path: dir });
    try {
      const s = cleanSchedule({ name: 'Notes', prompt: 'write notes.txt', projectId: pid, model: 'test/model', when: { kind: 'daily', time: '09:00', days: [] }, settings: { mediaEnabled: false, tools: { browser: { on: false } } } });
      saveScheds([s]);
      const end = ended(), notes = [];
      const r = startScheduledChat(s, { missed: true, due: 123 }, schedDeps((b, k) => [reply('', [['write_file', { path: 'notes.txt', content: 'hi' }]]), reply('Wrote notes.txt.')][k], { onNotify: (k, info) => { notes.push(k); end.on(k, info); } }));
      // The scheduler records the run it started; noteRun then follows it to the end.
      const list = loadScheds(); list[0].lastRun = { at: Date.now(), runId: r.runId, chatId: r.chatId, status: 'running', missed: true }; saveScheds(list);
      assert.equal(r.status, 'running');
      const fin = await end.p;
      assert.equal(fin.k, 'done');
      assert.deepEqual(notes, ['start', 'done'], 'an open page hears the run start (silently), then that it is done');
      const doc = getChat(r.chatId);
      assert.equal(doc.title, '⏰ Notes');
      assert.equal(doc.approval, 'strict');
      assert.deepEqual(doc.agent.messages[0].scheduled, { id: s.id, name: 'Notes', missed: true, due: 123 });
      const m = doc.agent.messages[1];
      assert.equal(m.content, 'Wrote notes.txt.');
      assert.equal(m.runActive, false);
      assert.deepEqual(m.stats.changed, ['notes.txt']);
      assert.ok(m.trace.some((e) => e.t === 'tool' && e.name === 'write_file'));
      assert.ok(!m.trace.some((e) => e.t === 'token'));
      assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'hi');
      assert.equal(loadScheds()[0].lastRun.status, 'done');
    } finally { forgetProject(pid); saveScheds([]); }
  }
  { // a scheduled run cut off by the step limit counts as failed, says why, and keeps its reply
    const dir = tempDir('quorx-sched-'), pid = `so${Date.now().toString(36)}`;
    saveProject({ id: pid, name: 'sched', path: dir });
    try {
      const s = cleanSchedule({ name: 'Long', prompt: 'write files', projectId: pid, model: 'test/model', when: { kind: 'daily', time: '09:00', days: [] }, settings: { maxSteps: 4, review: 'off', verify: false, mediaEnabled: false, tools: { browser: { on: false } } } });
      saveScheds([s]);
      const end = ended();
      const r = startScheduledChat(s, {}, schedDeps((b, k) => (k < 3 ? reply('', [['write_file', { path: `f${k}.txt`, content: 'x' }]]) : reply('Wrote three of five.')), { onNotify: end.on }));
      const list = loadScheds(); list[0].lastRun = { at: Date.now(), runId: r.runId, chatId: r.chatId, status: 'running' }; saveScheds(list);
      const fin = await end.p;
      assert.equal(fin.k, 'error');
      assert.match(fin.info.text, /ran out of steps \(4\)\. Wrote three of five\./);
      const after = loadScheds()[0];
      assert.equal(after.lastRun.status, 'failed');
      assert.equal(after.fails, 1);
      const m = getChat(r.chatId).agent.messages[1];
      assert.equal(m.content, 'Wrote three of five.');
      assert.equal(m.stats.scheduled, true);
      assert.ok(!m.trace.some((e) => e.t === 'out_of_steps'), 'no card');
    } finally { forgetProject(pid); saveScheds([]); }
  }
});

test('a schedule keeps one chat (newChat starts its own), tells you as its rule says, keeps its last runs, and pauses after 3 failures', async () => {
  { // a schedule keeps one chat: every run posts there but starts fresh; newChat starts a chat of its own
    const dir = tempDir('quorx-sched-'), pid = `sr${Date.now().toString(36)}`;
    saveProject({ id: pid, name: 'sched', path: dir });
    try {
      const s = cleanSchedule({ name: 'Drop', prompt: 'type ldrop', projectId: pid, model: 'test/model', when: { kind: 'every', minutes: 3 }, settings: { mediaEnabled: false, tools: { browser: { on: false } } } });
      const seen = [];
      const once = async (sched, text) => {
        const end = ended();
        const r = startScheduledChat(sched, {}, schedDeps((b) => { seen.push(b.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${String(m.content).slice(0, 40)}`)); return reply(text); }, { onNotify: end.on }));
        await end.p;
        return r;
      };
      const r1 = await once(s, 'Typed it (1).');
      const r2 = await once({ ...s, chatId: r1.chatId }, 'Typed it (2).');
      assert.equal(r2.chatId, r1.chatId, 'the same chat');
      const msgs = getChat(r1.chatId).agent.messages;
      assert.deepEqual(msgs.map((m) => `${m.role}:${m.content}`), ['user:type ldrop', 'assistant:Typed it (1).', 'user:type ldrop', 'assistant:Typed it (2).']);
      assert.ok(!seen[1].some((x) => x.includes('Typed it (1).')), `each run starts fresh, with only its prompt: ${JSON.stringify(seen[1])}`);
      // The scheduler remembers the chat, and an edit keeps it.
      assert.equal(cleanSchedule({ prompt: 'type ldrop again' }, Date.now(), { ...s, chatId: r1.chatId }).chatId, r1.chatId);
      const r3 = await once({ ...s, chatId: r1.chatId, newChat: true }, 'Fresh.');
      assert.notEqual(r3.chatId, r1.chatId, 'newChat: a chat of its own');
      assert.equal(getChat(r3.chatId).agent.messages.length, 2);
    } finally { forgetProject(pid); saveScheds([]); }
  }
  { // a schedule tells you as its rule says, keeps its last runs, and pauses itself after 3 failures in a row
    const base = (notify) => cleanSchedule({ name: 'N', prompt: 'check', projectId: 'p', model: 'test/model', when: { kind: 'every', minutes: 5 }, notify });
    try {
      const f = base('failure'), c = base('changed'), a = base('always');
      saveScheds([f, c, a]);
      assert.equal(endRun(f.id, 'r1', { status: 'done', reply: 'all fine' }).notify, false, 'failure: a good run is quiet');
      assert.equal(endRun(f.id, 'r2', { status: 'failed', error: 'x' }).notify, true, 'failure: a failed one tells you');
      assert.equal(endRun(c.id, 'r1', { status: 'done', reply: 'In stock: no (checked 10:01)' }).notify, true, 'changed: the first result tells you');
      assert.equal(endRun(c.id, 'r2', { status: 'done', reply: 'In stock: no (checked 10:04)' }).notify, false, 'changed: the same, only a time differs');
      const r3 = endRun(c.id, 'r3', { status: 'done', reply: 'In stock: YES, 3 left' });
      assert.deepEqual([r3.notify, r3.changed], [true, true]);
      assert.equal(endRun(a.id, 'r1', { status: 'stopped' }).notify, true);
      assert.equal(loadScheds().find((s) => s.id === c.id).history.length, 3);
      // Failures in a row pause it (a stopped run is no failure, a good run resets the count).
      endRun(a.id, 'r2', { status: 'failed', error: 'e1' });
      endRun(a.id, 'r3', { status: 'done', reply: 'ok' });
      for (let i = 1; i < PAUSE_AFTER_FAILS; i++) endRun(a.id, `f${i}`, { status: 'failed', error: `e${i}` });
      assert.equal(loadScheds().find((s) => s.id === a.id).paused, false, 'not yet');
      const last = endRun(a.id, 'f9', { status: 'failed', error: 'the page did not load' });
      assert.equal(last.paused, true);
      const s = loadScheds().find((x) => x.id === a.id);
      assert.equal(s.paused, true);
      assert.equal(s.nextAt, null);
      assert.match(s.pausedWhy, /3 failed runs in a row \(last: the page did not load\)/);
      assert.equal(cleanSchedule({ paused: false }, Date.now(), s).fails, 0, 'resuming clears the count');
      assert.ok(loadScheds().find((x) => x.id === a.id).history.length <= 10, 'ten runs kept');
    } finally { saveScheds([]); }
  }
});

test('the agent manages schedules from a chat: a card first, its runs post in this chat; a scheduled run may only pause its own', async () => {
  saveScheds([]);
  const chatId = `cs${Date.now().toString(36)}`;
  try {
    let pid = null, cards = 0;
    const { bodies, done } = await run((body, i) => [
      reply('', [['schedule', { action: 'create', name: 'Lumina drop', prompt: 'Open the bot-test channel and type /ldrop', when: { kind: 'every', minutes: 15 }, notify: 'failure', why: 'you asked for it every 15 minutes' }]]),
      reply('', [['schedule', { action: 'list' }]]),
      reply('', [['schedule', { action: 'delete', id: loadScheds()[0]?.id }]]),
      reply('Set up: every 15 minutes.'),
    ][i], { chatId, settings: { approval: 'strict' }, onEvent: (e, id) => {
      if (e.t === 'start') pid = id;
      if (e.t === 'approval' && e.tool === 'schedule') { cards++; setTimeout(() => answerApproval(id, e.id, { approve: !/^Delete/.test(e.what) }), 5); }
    } });
    assert.equal(done.reply, 'Set up: every 15 minutes.');
    assert.equal(cards, 2, 'creating and deleting each asked');
    const [s] = loadScheds();
    assert.equal(s.name, 'Lumina drop');
    assert.equal(s.chatId, chatId, 'its runs post in this chat');
    assert.equal(s.projectId, pid);
    assert.equal(s.notify, 'failure');
    assert.equal(s.when.minutes, 15);
    const results = toolResults(bodies[3]);
    assert.match(results[0], /Created schedule .* "Lumina drop" \(every 15 minutes/);
    assert.match(results[1], /Lumina drop · every 15 minutes .* posts in this chat/);
    assert.match(results[2], /declined this schedule call/, 'you said no to deleting it: it stays');
    // A scheduled run: no new jobs, but it can pause its own schedule once its goal is met.
    const r2 = await run((body, i) => [reply('', [['schedule', { action: 'create', name: 'more', prompt: 'x', when: { kind: 'every', minutes: 5 } }], ['schedule', { action: 'pause' }]]), reply('Paused it: the drop is done.')][i], { chatId, scheduledBy: s.id });
    const res2 = toolResults(r2.bodies[1]);
    assert.match(res2[0], /Refused: this is a scheduled run/);
    assert.match(res2[1], /Paused "Lumina drop"/);
    assert.equal(loadScheds().length, 1);
    assert.equal(loadScheds()[0].paused, true);
  } finally { saveScheds([]); }
});

test('cards in a scheduled run: no answer counts as no, the wait is as set, and Chrome tabs close after a good run unless kept', async () => {
  { // a card in a scheduled run that no one answers counts as no, so the run ends instead of holding on to Chrome
    const t0 = Date.now();
    const { events, bodies, done } = await run((body, i) => [reply('', [['remember', { text: 'The bot channel is #bot-test' }]]), reply('Carried on without it.')][i],
      { scheduledBy: 'sdemo', settings: { approval: 'strict', schedCardWaitSecs: 1 } });
    const card = of(events, 'approval')[0];
    assert.ok(card?.wait, 'the card says how long it waits');
    assert.equal(of(events, 'approval_done')[0].by, 'timeout');
    assert.match(toolResults(bodies[1])[0], /declined this remember call.*No answer within 1 s, and this is a scheduled run/);
    assert.equal(done.reply, 'Carried on without it.');
    assert.ok(Date.now() - t0 < 20000);
    // Not a scheduled run: the same card waits for you as before (answered here).
    const { events: e2, done: d2 } = await run((body, i) => [reply('', [['remember', { text: 'x y z' }]]), reply('ok')][i], { settings: { approval: 'strict', schedCardWaitSecs: 1 },
      onEvent: (e, id) => { if (e.t === 'approval') setTimeout(() => answerApproval(id, e.id, { approve: false }), 1500); } });
    assert.equal(of(e2, 'approval_done')[0].by, 'user', 'it waited past the scheduled-run limit for your answer');
    assert.equal(d2.reply, 'ok');
  }
  { // a schedule waits as long as you set for a card (1 s to an hour, 15 s unless set) and closes its Chrome tabs after a good run unless told not to
    const base = { name: 'W', prompt: 'p', projectId: 'p', model: 'test/model', when: { kind: 'every', minutes: 5 } };
    assert.equal(cleanSchedule(base).cardWaitSecs, 15);
    assert.equal(cleanSchedule({ ...base, cardWaitSecs: 1 }).cardWaitSecs, 1);
    assert.equal(cleanSchedule({ ...base, cardWaitSecs: 0.2 }).cardWaitSecs, 15, 'nonsense falls back');
    assert.equal(cleanSchedule({ ...base, cardWaitSecs: 99999 }).cardWaitSecs, 3600);
    assert.equal(cleanSchedule(base).closeTabs, true);
    const off = cleanSchedule({ ...base, closeTabs: false });
    assert.equal(cleanSchedule({ prompt: 'q' }, Date.now(), off).closeTabs, false, 'kept over an edit');
  }
  { // after a good scheduled run its Chrome tabs close 30 s later, unless the schedule says to keep them
    const dir = tempDir('quorx-sched-'), pid = `sc${Date.now().toString(36)}`;
    saveProject({ id: pid, name: 'sched', path: dir });
    const { CLOSE_TABS_MS } = await import('../server/schedrun.js');
    assert.equal(CLOSE_TABS_MS, 30e3);
    try {
      const closed = [];
      const go = async (s, text) => {
        const end = ended(); saveScheds([s]);
        const deps = { ...schedDeps(() => (text ? reply(text) : { text: '', toolCalls: [], usage: { cost: 0 }, ms: 1, firstMs: 1, finishReason: 'error', error: 'model down' }), { onNotify: end.on }), closeChromeTabs: async (c) => { closed.push(c); } };
        const r = startScheduledChat(s, {}, deps);
        const list = loadScheds(); list[0].lastRun = { at: Date.now(), runId: r.runId, chatId: r.chatId, status: 'running' }; saveScheds(list);
        await end.p; return r;
      };
      const s = cleanSchedule({ name: 'Drop', prompt: 'type ldrop', projectId: pid, model: 'test/model', when: { kind: 'every', minutes: 5 }, settings: { mediaEnabled: false, tools: { browser: { on: false } } } });
      // The close waits 30 s: here the timer is run at once.
      const realSet = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...a) => realSet(fn, ms === CLOSE_TABS_MS ? 0 : ms, ...a);
      try {
        const r = await go(s, 'Sent.');
        await new Promise((ok) => realSet(ok, 50));
        assert.deepEqual(closed, [r.chatId]);
        await go({ ...s, closeTabs: false }, 'Sent.');
        await new Promise((ok) => realSet(ok, 50));
        assert.equal(closed.length, 1, 'closeTabs off: kept');
      } finally { globalThis.setTimeout = realSet; }
    } finally { forgetProject(pid); saveScheds([]); }
  }
});

test('a schedule can be trusted to act without asking; in Strict it waits for your approval; at its project\'s budget it does not start', async () => {
  { // a schedule can be trusted to act without asking; an edit keeps it, and the card for making one says so
    const s = cleanSchedule({ name: 'Drop', prompt: 'send /ldrop', projectId: 'p', model: 'test/model', when: { kind: 'every', minutes: 5 }, trusted: true });
    assert.equal(s.trusted, true);
    assert.equal(cleanSchedule({ prompt: 'send /ldrop now' }, Date.now(), s).trusted, true, 'kept over an edit');
    assert.equal(cleanSchedule({ trusted: false }, Date.now(), s).trusted, false);
    assert.equal(cleanSchedule({ name: 'x', prompt: 'y', projectId: 'p', model: 'test/model', when: { kind: 'every', minutes: 5 } }).trusted, false, 'off unless asked');
  }
  { // a scheduled chat in Strict waits for your approval (and says so), even if the saved settings say YOLO
    const dir = tempDir('quorx-sched-'), pid = `sq${Date.now().toString(36)}`;
    saveProject({ id: pid, name: 'sched', path: dir });
    fs.writeFileSync(path.join(dir, 'build.js'), "require('fs').writeFileSync('out.txt', 'built')");
    try {
      const s = cleanSchedule({ name: 'Build', prompt: 'build it', projectId: pid, model: 'test/model', when: { kind: 'daily', time: '09:00', days: [] }, settings: { approval: 'yolo', mediaEnabled: false, tools: { browser: { on: false } } } });
      saveScheds([s]);
      const waiting = ended(['approval']), end = ended();
      const r = startScheduledChat(s, {}, schedDeps((b, k) => [reply('', [['shell', { command: 'node build.js' }]]), reply('Built.')][k], { onNotify: (k, info) => { waiting.on(k, info); end.on(k, info); } }));
      const list = loadScheds(); list[0].lastRun = { at: Date.now(), runId: r.runId, chatId: r.chatId, status: 'running' }; saveScheds(list);
      const w = await waiting.p;
      assert.equal(w.info.chatId, r.chatId);
      assert.equal(loadScheds()[0].lastRun.status, 'waiting');
      const card = getRun(r.runId).events.find((e) => e.t === 'approval' && e.mode === 'strict');
      assert.ok(answerApproval(r.runId, card.id, { approve: true }));
      assert.equal((await end.p).k, 'done');
      assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), 'built');
      assert.equal(loadScheds()[0].lastRun.status, 'done');
    } finally { forgetProject(pid); saveScheds([]); }
  }
  { // a scheduled chat does not start when its project has reached its budget
    const dir = tempDir('quorx-sched-'), pid = `sb${Date.now().toString(36)}`;
    saveProject({ id: pid, name: 'sched', path: dir });
    setProjectBudget(pid, 0.5);
    ledger.set(`seed-${pid}`, { project: pid, cost: 0.6 });
    try {
      const notes = [];
      const s = cleanSchedule({ name: 'Costly', prompt: 'x', projectId: pid, model: 'test/model', when: { kind: 'daily', time: '09:00', days: [] } });
      const r = startScheduledChat(s, {}, schedDeps(() => { throw new Error('the model must not be called'); }, { onNotify: (k) => notes.push(k) }));
      assert.equal(r.status, 'skipped');
      assert.match(r.note, /budget/);
      assert.deepEqual(notes, ['budget']);
      assert.throws(() => startScheduledChat({ ...s, projectId: 'nope' }, {}, schedDeps(() => reply('x'))), /no longer exists/);
    } finally { forgetProject(pid); ledger.delete(`seed-${pid}`); }
  }
});

// ---------- Quoriums: saved combos of helper modules (server/quoriums.js) ----------

const resetQuoriums = () => { for (const q of listQuoriums()) removeQuorium(q.id); };

test('Quoriums: built-ins (Standard as before) can be edited and reset, yours added, changed and deleted, and a save refuses bad names and ids', () => {
  { // QuorX comes with Quoriums, and Standard is what new chats had before
    resetQuoriums();
    const list = listQuoriums();
    assert.deepEqual(list.map((q) => q.id), BUILT_IN.map((q) => q.id));
    assert.ok(list.every((q) => q.builtIn && !q.edited && Q_MODULES.every((k) => typeof q.modules[k].on === 'boolean' && q.modules[k].model === '')));
    const std = list.find((q) => q.id === 'standard');
    assert.deepEqual(Q_MODULES.filter((k) => std.modules[k].on), ['reviewer', 'freshEyes', 'deciders', 'helpers']);
    assert.deepEqual(Q_MODULES.filter((k) => list.find((q) => q.id === 'solo').modules[k].on), []);
  }
  { // a built-in Quorium can be edited and reset; yours are added, changed and deleted
    resetQuoriums();
    try {
      const solo = listQuoriums().find((q) => q.id === 'solo');
      const ed = saveQuorium({ ...solo, modules: { ...solo.modules, reviewer: { on: true, model: 'openai/gpt-6-luna' } } });
      assert.equal(ed.edited, true);
      const back = listQuoriums().find((q) => q.id === 'solo');
      assert.equal(back.modules.reviewer.on, true);
      assert.equal(back.modules.reviewer.model, 'openai/gpt-6-luna');
      assert.equal(removeQuorium('solo'), true);
      assert.equal(listQuoriums().find((q) => q.id === 'solo').modules.reviewer.on, false);
      assert.equal(removeQuorium('solo'), false, 'nothing left to reset');

      const mine = saveQuorium({ name: '  Game Builder  ', desc: 'Games', modules: { image: { on: true, model: 'opencode:big-pickle' }, nonsense: { on: true } } });
      assert.match(mine.id, /^q[a-z0-9]+$/);
      assert.equal(mine.name, 'Game Builder');
      assert.deepEqual(Object.keys(mine.modules), Q_MODULES, 'only known modules are kept');
      assert.equal(mine.modules.image.model, 'opencode:big-pickle');
      const list = listQuoriums();
      assert.equal(list.at(-1).id, mine.id);
      assert.equal(list.at(-1).builtIn, false);
      saveQuorium({ ...mine, name: 'Games' });
      assert.equal(listQuoriums().filter((q) => !q.builtIn).length, 1, 'saving again changes it, it does not add another');
      assert.equal(listQuoriums().at(-1).name, 'Games');
      assert.equal(removeQuorium(mine.id), true);
      assert.equal(listQuoriums().some((q) => q.id === mine.id), false);
    } finally { resetQuoriums(); }
  }
  { // a Quorium save refuses what is not a name or a model id
    assert.throws(() => cleanQuorium({ name: '   ' }), /name/);
    assert.throws(() => cleanQuorium({ name: 'x', modules: { reviewer: { on: true, model: 'a b; rm -rf /' } } }), /not a model id/);
    assert.throws(() => saveQuorium({ id: '../../etc', name: 'x' }), /Unknown Quorium/);
    const c = cleanQuorium({ name: 'x'.repeat(500), desc: 'line\none', modules: {} });
    assert.equal(c.name.length, 60);
    assert.equal(c.desc, 'line one');
    assert.ok(Q_MODULES.every((k) => c.modules[k].on === false && c.modules[k].model === ''));
  }
});

// ---------- memory across projects (server/memory.js) ----------

const resetMemory = () => saveMemory({ on: true, items: [] });

test('memory never keeps a secret, has a hard size limit checked on every save, and waits out a briefly held file', () => {
  { // memory never keeps anything that looks like a secret
    for (const s of ['my key is sk-or-v1-0123456789abcdef0123456789abcdef', 'token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', 'The password is hunter22', 'api key: 12345abcde', 'db at postgres://admin:s3cret@db.local/app',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', 'AKIAABCDEFGHIJKLMNOP', 'card 4111 1111 1111 1111', 'use Q2hhbmdlTWUhMTIzNDU2Nzg5MEFCQ0RFRg to sign in'])
      assert.ok(looksSecret(s), `should be refused: ${s}`);
    for (const s of ['I use pnpm, not npm', 'Prefer dark themes', 'Node 22.11.0 on Windows 11', 'Keep UI code in src/components/ui', 'Write commit messages in English, imperative mood', 'My GitHub handle is in package.json; never guess it'])
      assert.equal(looksSecret(s), '', `should be allowed: ${s}`);
    assert.match(checkMemory('The password is hunter22', { items: [] }), /never keeps secrets/);
  }
  { // memory has a hard size limit, checked again on every save
    resetMemory();
    try {
      assert.ok(addMemory('I use pnpm, not npm').item);
      assert.match(addMemory('i use PNPM, not npm').error, /already in memory/);
      assert.match(addMemory('x'.repeat(201)).error, /at most 200 characters/);
      const long = (k) => `Preference number ${k}: ${'keep things short and plain '.repeat(6)}`.slice(0, 190);
      let k = 0, last;
      while (!(last = addMemory(long(k++))).error) { /* fill it */ }
      assert.match(last.error, /memory is full/);
      const m = loadMemory();
      assert.ok(memoryTokens(m.items) <= MEMORY_TOKENS, `${memoryTokens(m.items)} tokens`);
      assert.throws(() => saveMemory({ items: [...m.items, { text: long(99) }] }), /memory is full/);
      assert.throws(() => saveMemory({ items: [{ text: 'my token: abc123xyz' }] }), (e) => /never keeps secrets/.test(e.message) && !e.message.includes('abc123xyz'));
      saveMemory({ on: false });
      assert.equal(loadMemory().on, false);
      assert.equal(loadMemory().items.length, m.items.length);
      assert.equal(memoryPrompt(loadMemory(), { propose: true }), '');
    } finally { resetMemory(); }
  }
  { // a memory save waits out a file another program holds for a moment, and gives up only if it stays held
    resetMemory();
    const real = fs.renameSync;
    const busy = (left, code = 'EPERM') => (from, to) => { if (String(to).endsWith('memory.json') && left-- > 0) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code }); return real(from, to); };
    try {
      fs.renameSync = busy(3);
      assert.ok(addMemory('I use pnpm').item, 'saved after the file was free again');
      assert.equal(loadMemory().items.length, 1);
      fs.renameSync = busy(2, 'EBUSY');
      assert.ok(addMemory('Prefer dark themes').item);
      fs.renameSync = busy(Infinity);
      assert.throws(() => addMemory('Short answers'), /EPERM/, 'a file that stays held still fails, after a short wait');
      fs.renameSync = (from, to) => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); };
      assert.throws(() => addMemory('Tabs over spaces'), /ENOSPC/, 'other errors are not retried');
    } finally { fs.renameSync = real; resetMemory(); }
  }
});

test('every chat gets the memory in a small prompt; the agent proposes a memory and it is saved only when you approve, never a secret', async () => {
  { // every chat gets the memory, and the prompt stays small; small models get the facts but no remember tool
    resetMemory();
    try {
      const sys = (b) => b.messages[0].content;
      const tools = (b) => (b.tools || []).map((t) => t.function.name);
      saveMemory({ on: false });
      const off = await run(() => reply('Hi.'), { text: 'hello' });
      assert.ok(!tools(off.bodies[0]).includes('remember'));
      // Full memory: the prompt grows by the facts and one short rule, no more.
      let k = 0;
      saveMemory({ on: true, items: [] });
      while (!addMemory(`Preference ${k++}: ${'plain words and short sentences please '.repeat(5)}`.slice(0, 180)).error) { /* fill it */ }
      const full = await run(() => reply('Hi.'), { text: 'hello' });
      const grew = sys(full.bodies[0]).length - sys(off.bodies[0]).length;
      assert.ok(grew <= MEMORY_TOKENS * 4 + 600, `the prompt grew by ${grew} characters`);
      assert.match(sys(full.bodies[0]), /\[About the user: facts and preferences they approved/);
      assert.match(sys(full.bodies[0]), /- Preference 0: plain words/);
      assert.ok(tools(full.bodies[0]).includes('remember'));
      const toolDef = full.bodies[0].tools.find((t) => t.function.name === 'remember');
      assert.ok(JSON.stringify(toolDef).length < 500);
      // An 8k-context model: the facts, but no tool and no rule about it.
      const small = await run(() => reply('Hi.'), { text: 'hello', catalogue: [{ id: 'test/model', maxOut: 2000, ctx: 8000, tools: true }] });
      assert.match(sys(small.bodies[0]), /- Preference 0/);
      assert.doesNotMatch(sys(small.bodies[0]), /propose it once with remember/);
      assert.ok(!tools(small.bodies[0]).includes('remember'));
    } finally { resetMemory(); }
  }
  { // the agent proposes a memory; it is saved only when you approve, even in YOLO, and never a secret
    resetMemory();
    try {
      const cards = [];
      const answer = (yes) => (e, id) => { if (e.t === 'approval' && e.tool === 'remember') { cards.push(e); setTimeout(() => answerApproval(id, e.id, { approve: yes }), 5); } };
      const yes = await run((b, i) => [reply('', [['remember', { text: 'Uses pnpm, not npm' }]]), reply('Noted.')][i], { text: 'I always use pnpm', onEvent: answer(true) });
      assert.equal(yes.events.find((e) => e.t === 'start').approval, 'yolo');
      assert.equal(cards[0].mode, 'strict');                           // the user's card, not the deciders'
      assert.equal(cards[0].noAlways, true);
      assert.match(toolResults(yes.bodies[1])[0], /^Saved to the user's memory/);
      assert.deepEqual(loadMemory().items.map((x) => [x.text, x.by]), [['Uses pnpm, not npm', 'agent']]);
      assert.ok(yes.events.some((e) => e.t === 'memory_saved'));
      const no = await run((b, i) => [reply('', [['remember', { text: 'Prefers tabs' }]]), reply('OK.')][i], { text: 'tabs please', onEvent: answer(false) });
      assert.match(toolResults(no.bodies[1])[0], /declined this remember call/);
      assert.equal(loadMemory().items.length, 1);
      const n0 = cards.length;
      const secret = await run((b, i) => [reply('', [['remember', { text: 'API key is sk-or-v1-abcdef0123456789abcdef0123' }]]), reply('OK.')][i], { text: 'here is my key', onEvent: answer(true) });
      assert.match(toolResults(secret.bodies[1])[0], /^Not saved: it looks like an API key/);
      assert.equal(cards.length, n0, 'no card for a secret');
      const many = await run((b, i) => [reply('', [['remember', { text: 'Likes A' }]]), reply('', [['remember', { text: 'Likes B' }]]), reply('', [['remember', { text: 'Likes C' }]]), reply('OK.')][i], { text: 'remember things', onEvent: answer(true) });
      assert.match(toolResults(many.bodies[3]).at(-1), /at most 2 memory proposals per reply/);
    } finally { resetMemory(); }
  }
});

test('cache-read and cache-write tokens from the usage go into the reply stats, per model', async () => {
  const { cacheTokens } = await import('../server/agent.js');
  assert.deepEqual(cacheTokens({ prompt_tokens: 100 }), { read: null, write: 0 }, 'not reported is not 0%');
  assert.deepEqual(cacheTokens({ prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 5 } }), { read: 80, write: 5 });
  assert.deepEqual(cacheTokens({ cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }), { read: 7, write: 3 });
  let b = 0;
  const cached = (r, u) => ({ ...r, usage: { cost: 0.0001, prompt_tokens: 1000, completion_tokens: 10, ...u } });
  const { done } = await run(() => [
    cached(reply('', [['list_files', {}]]), { prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 900 } }),
    cached(reply('', [['list_files', {}]]), { prompt_tokens_details: { cached_tokens: 900 } }),
    cached(reply('Done.'), {}),
  ][b++]);
  const m = done.stats.byModel['test/model'];
  assert.equal(m.cacheRead, 900); assert.equal(m.cacheWrite, 900);
  assert.equal(m.cachedIn, 2000, 'only calls that reported caching count toward the share');
  assert.equal(m.tokensIn, 3000);
  assert.equal(done.stats.cacheRead, 900);
});

// ---------- video: a picture as the first frame, and edit_video (no paid calls) ----------
test('make_video and edit_video commands: a start picture is the first frame only where the model takes one; stills loop, clips cut, music under the voice', () => {
  { // make_video body: a start picture goes in as the first frame, only for models that take one
    const spec = { frames: ['first_frame', 'last_frame'], aspects: ['16:9', '9:16'] };
    const ok = videoBody({ model: 'v/a', prompt: 'waves', secs: 5, res: '480p', spec, firstFrame: 'data:image/png;base64,AAA' });
    assert.deepEqual(ok.body.frame_images, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' }, frame_type: 'first_frame' }]);
    assert.equal(ok.body.aspect_ratio, '16:9');
    assert.equal(ok.body.duration, 5);
    assert.match(videoBody({ model: 'v/b', prompt: 'x', spec: { frames: [] }, firstFrame: 'data:image/png;base64,AAA' }).error, /can't start from a picture/);
    const near = videoBody({ model: 'v/c', prompt: 'x', spec: { aspects: ['16:9', '9:16'] }, aspect: '3:4' });
    assert.equal(near.body.aspect_ratio, '9:16');
    assert.match(near.note, /nearest shape, 9:16/);
    assert.equal('frame_images' in videoBody({ model: 'v/a', prompt: 'x', spec }).body, false);
  }
  { // edit_video command: stills loop, clips can be cut, music loops under the voice, the graph goes in a file
    const e = editCommand({ clips: [{ path: 'assets/a.png', seconds: 2 }, 'assets/b.mp4', { path: 'assets/c.mp4', seconds: 1.5 }], voice: 'assets/v.mp3', music: 'assets/m.mp3', musicVolume: 0.3, out: 'assets/edits/t.mp4', filterFile: '.quorx/edits/t.filter', ffmpegMajor: 9 });
    assert.equal(e.line, 'ffmpeg -hide_banner -loglevel error -y -loop 1 -framerate 30 -t 2 -i "assets/a.png" -i "assets/b.mp4" -t 1.5 -i "assets/c.mp4" -i "assets/v.mp3" -stream_loop -1 -i "assets/m.mp3" -/filter_complex ".quorx/edits/t.filter" -map "[vout]" -map "[aout]" -c:a aac -b:a 192k -shortest -c:v libx264 -preset veryfast -crf 20 -r 30 -movflags +faststart "assets/edits/t.mp4"');
    assert.match(e.filter, /\[v0\]\[v1\]\[v2\]concat=n=3:v=1:a=0\[vout\]/);
    assert.match(e.filter, /\[3:a\]apad\[vo\];\n\[4:a\]volume=0\.3\[mu\];\n\[vo\]\[mu\]amix=inputs=2:duration=first:normalize=0\[aout\]/);
    assert.match(e.filter, /scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720/);
    const old = editCommand({ clips: ['a.mp4'], out: 'o.mp4', filterFile: 'f.txt', ffmpegMajor: 6, aspect: '9:16' });
    assert.match(old.line, /-filter_complex_script "f\.txt" -map "\[vout\]" -an /);
    assert.match(old.filter, /scale=720:1280/);
    assert.match(editCommand({ clips: ['a b$x.mp4'], out: 'o.mp4', filterFile: 'f' }).error, /can't pass safely/);
    assert.match(editCommand({ clips: ['notes.txt'], out: 'o.mp4', filterFile: 'f' }).error, /not a video or a picture/);
    assert.match(editCommand({ clips: ['a.mp4'], out: 'o.mov', filterFile: 'f' }).error, /\.mp4/);
    assert.equal(ffmpegMajor('9.0.2-full_build-www.gyan.dev'), 9);
    assert.equal(ffmpegMajor('N-118000-gabc'), 0);
  }
});

const TEST_VIDEO = { id: 'test/vid-start', name: 'Test video', kind: 'video', skus: { duration_seconds_480p: 0.02, cents_per_image_input: '1' }, resolutions: ['480p'], durations: [5], aspects: ['16:9', '9:16'], frames: ['first_frame'] };
const TEST_VIDEO_TEXT = { ...TEST_VIDEO, id: 'test/vid-text', frames: [] };
const videoSettings = (model) => ({ mediaEnabled: true, yoloCheck: false, tools: { browser: { on: false }, image: { on: false }, music: { on: false }, speech: { on: false }, video: { on: true, pick: 'fixed', models: [model], resolution: '480p', seconds: 5 } } });

test('make_video starts from a project picture with a model that takes one, and a text-only model is refused before any approval or charge', async () => {
  { // make_video starts from a project picture with a model that takes one
    primeCatalogue('videos', [TEST_VIDEO, TEST_VIDEO_TEXT]);
    const sent = [];
    const { bodies, events } = await run((body, i) => [
      reply('', [['make_video', { prompt: 'the lighthouse beam sweeps across the sea', why: 'shot 1', start_image: 'assets/frame.png', aspect_ratio: '16:9' }]]),
      reply('Done.'),
    ][i], { settings: videoSettings('test/vid-start'), prep: (dir) => { fs.mkdirSync(path.join(dir, 'assets'), { recursive: true }); fs.writeFileSync(path.join(dir, 'assets', 'frame.png'), 'fake-png'); },
      generateVideo: async (b) => { sent.push(b); return { url: `data:video/mp4;base64,${Buffer.from('mp4').toString('base64')}`, usage: { cost: 0.1 }, ms: 5 }; } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].frame_images[0].frame_type, 'first_frame');
    assert.equal(sent[0].frame_images[0].image_url.url, `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`);
    assert.match(toolResults(bodies[1]).at(-1), /starting from assets\/frame\.png/);
    const card = of(events, 'approval')[0];
    assert.ok(Math.abs(card.est - 0.11) < 1e-9, `5 s at $0.02 plus 1 cent for the picture: ${card.est}`);
    assert.match(card.detail, /from the picture assets\/frame\.png/);
    const tool = bodies[0].tools.find((t) => t.function.name === 'make_video');
    assert.match(tool.function.parameters.properties.start_image.description, /test\/vid-start/);
  }
  { // make_video with a start picture and a text-only model is refused before any approval or charge
    primeCatalogue('videos', [TEST_VIDEO, TEST_VIDEO_TEXT]);
    let called = 0;
    const { bodies, events } = await run((body, i) => [
      reply('', [['make_video', { prompt: 'waves', why: 'x', start_image: 'assets/frame.png' }]]),
      reply('Done.'),
    ][i], { settings: videoSettings('test/vid-text'), generateVideo: async () => { called++; return {}; } });
    assert.match(toolResults(bodies[1]).at(-1), /^Error: test\/vid-text can't start from a picture\. None of the video models in use can/);
    assert.equal(called, 0);
    assert.equal(of(events, 'approval').length, 0);
    assert.equal('start_image' in bodies[0].tools.find((t) => t.function.name === 'make_video').function.parameters.properties, false);
  }
});

let hasFfmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); hasFfmpeg = true; } catch { /* not installed */ }
test('edit_video joins a still, a clip and a voice-over into one mp4 in the project, through the command gate', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  let runId; const cards = [];
  const { bodies, dir, events } = await run((body, i) => [
    reply('', [['edit_video', { clips: [{ path: 'assets/still.png', seconds: 1 }, { path: 'assets/clip.mp4' }], voice: 'assets/voice.mp3', out: 'assets/edits/teaser.mp4' }]]),
    reply('Done.'),
  ][i], { settings: { approval: 'strict', mediaEnabled: true, tools: { browser: { on: false }, image: { on: true }, video: { on: false }, music: { on: false }, speech: { on: false } } },
    prep: (d) => {
      const a = path.join(d, 'assets'); fs.mkdirSync(a);
      const ff = (...x) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...x], { cwd: a });
      ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-frames:v', '1', 'still.png');
      ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-t', '1', '-pix_fmt', 'yuv420p', 'clip.mp4');
      ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', 'voice.mp3');
    },
    onEvent: (e) => { if (e.t === 'start') runId = e.runId; if (e.t === 'approval') { cards.push(e); setTimeout(() => answerApproval(runId, e.id, { approve: true }), 5); } } });
  const result = toolResults(bodies[1]).at(-1);
  assert.match(result, /^Saved the finished film as assets\/edits\/teaser\.mp4 \([\d.]+ MB, 1280×720, 2 clips, voice-over\)/, result);
  assert.ok(fs.statSync(path.join(dir, 'assets', 'edits', 'teaser.mp4')).size > 1000);
  assert.ok(fs.existsSync(path.join(dir, '.quorx', 'edits', 'teaser.filter')));
  assert.equal(cards.length, 1, 'the ffmpeg line went through the command approval');
  assert.match(JSON.stringify(cards[0]), /ffmpeg/);
  assert.ok(of(events, 'file').some((e) => e.path === 'assets/edits/teaser.mp4'));
});

test('the slow start is counted: steps that only read or looked before the first write', async () => {
  let b = 0;
  const { done } = await run(() => [
    reply('', [['list_files', {}]]),
    reply('', [['search_files', { query: 'x' }], ['list_files', {}]]),
    reply('', [['write_file', { path: 'a.txt', content: 'x' }]]),
    reply('', [['read_file', { path: 'a.txt' }]]),
    reply('Done.'),
  ][b++]);
  assert.equal(done.stats.looksFirst, 2);
  assert.equal(done.stats.firstWrite, 2);
});

test('skills are listed by name, with descriptions only for the ones the request is about', async () => {
  const { skillsNote, compactPaths } = await import('../server/agent.js');
  const sk = [{ name: 'canvas-game', description: 'Build a browser game on a canvas.' }, { name: 'node-server', description: 'Run a Node.js web server or API.' }];
  const note = skillsNote(sk, 'Make a snake game');
  assert.match(note, /- canvas-game: Build a browser game/);
  assert.match(note, /Also: node-server\./);
  assert.doesNotMatch(note, /Node\.js web server/);
  assert.equal(skillsNote(sk, 'hello'), 'Available: canvas-game, node-server.');
  assert.equal(compactPaths(['index.html', 'src/a.js', 'src/b.js', 'css/x.css', 'lib/ (skipped)']), 'index.html, src/{a.js, b.js}, css/x.css, lib/ (skipped)');
});

// ---------- the project's own secrets: names for the agent, values for its commands ----------
const KEY = 'sk-test-0123456789abcdefghij', DB = 'p@ss word#42';
const withEnv = (dir) => {
  fs.writeFileSync(path.join(dir, '.env'), `# keys\nOPENAI_API_KEY=${KEY}\nDB_PASS="${DB}"\nDEBUG=true\nEMPTY=\n`);
  fs.writeFileSync(path.join(dir, 'server.pem'), '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n');
};

test('secrets: read_file and search_files show a .env as names only and key files as a note', async () => {
  { // read_file shows a .env as names only, and a key file as a one-line note
    const { bodies } = await run((body, i) => [reply('', [['read_file', { path: '.env' }], ['read_file', { path: 'server.pem' }]]), reply('Done.')][i], { prep: withEnv });
    const [env, pem] = toolResults(bodies[1]);
    assert.match(env, /# keys/);
    assert.match(env, /OPENAI_API_KEY=•••• \(set, 28 characters\)/);
    assert.match(env, /DB_PASS=•••• \(set, 12 characters\)/);
    assert.match(env, /EMPTY= \(empty\)/);
    assert.ok(!env.includes(KEY) && !env.includes('p@ss') && !/=true/.test(env), env);
    assert.match(pem, /^This file holds a secret \(a private key\)\. QuorX doesn't show its contents\./);
  }
  { // search_files never returns a secret value: names from .env, nothing from key files
    const { bodies } = await run((body, i) => [reply('', [['search_files', { query: 'sk-test' }], ['search_files', { query: 'OPENAI' }], ['search_files', { query: 'PRIVATE' }]]), reply('Done.')][i], { prep: withEnv });
    const [byValue, byName, inKey] = toolResults(bodies[1]);
    assert.match(byValue, /^No matches/, 'a hidden value never makes a hit');
    assert.match(byName, /\.env:2: OPENAI_API_KEY=•••• \(set, 28 characters\)/);
    assert.ok(!byName.includes(KEY));
    assert.match(inKey, /^No matches/);
  }
});

test('secrets: commands get the project\'s .env with its values removed from their output; request_secret and setSecret write .env safely', async () => {
  { // commands get the project's .env, and what they print of it is removed before the model sees it
    const { bodies, events, dir } = await run((body, i) => [reply('', [['shell', { command: 'node show.mjs' }]]), reply('', [['shell', { command: 'node cat.mjs' }]]), reply('Done.')][i], {
      prep: (d) => {
        withEnv(d);
        fs.writeFileSync(path.join(d, 'show.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('got.txt', `${process.env.OPENAI_API_KEY}|${process.env.DB_PASS}`);\nconsole.log('key is', process.env.OPENAI_API_KEY, 'debug', process.env.DEBUG);\n");
        fs.writeFileSync(path.join(d, 'cat.mjs'), "import fs from 'node:fs';\nconsole.log(fs.readFileSync('.env', 'utf8'));\n");
      } });
    assert.equal(fs.readFileSync(path.join(dir, 'got.txt'), 'utf8'), `${KEY}|${DB}`, 'the command had the values');
    const shown = toolResults(bodies[1])[0];
    assert.match(shown, /key is \[secret removed\] debug true/);
    assert.ok(!shown.includes(KEY));
    const printed = toolResults(bodies[2]).at(-1);
    assert.match(printed, /OPENAI_API_KEY=\[secret removed\]/);
    assert.ok(!printed.includes(KEY) && !printed.includes(DB), printed);
    assert.ok(!JSON.stringify(events).includes(KEY), 'no event carries the value');
  }
  { // request_secret writes .env and .gitignore, and the model hears only that it is set
    let runId;
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    const { bodies, events, dir } = await run((body, i) => [reply('', [['request_secret', { name: 'GITHUB_TOKEN', why: 'To publish the release.' }]]), reply('', [['request_secret', { name: 'OTHER_KEY', why: 'Maybe later.' }]]), reply('Done.')][i], {
      settings: { approval: 'strict' },
      prep: (d) => { fs.mkdirSync(path.join(d, '.git')); fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules'); fs.writeFileSync(path.join(d, '.env'), 'A=1\n'); },
      onEvent: (e) => {
        if (e.t === 'start') runId = e.runId;
        if (e.t === 'question' && e.secret) setTimeout(() => answerSecret(runId, e.id, e.secret.name === 'GITHUB_TOKEN' ? { value: `  ${secret} ` } : { skip: true }), 10);
      },
    });
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), `A=1\nGITHUB_TOKEN=${secret}\n`);
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules\n.env\n');
    assert.match(toolResults(bodies[1])[0], /^GITHUB_TOKEN is set \(in the project's \.env; \.env was added to \.gitignore\)/);
    assert.match(toolResults(bodies[2]).at(-1), /^The user skipped OTHER_KEY/);
    assert.deepEqual(of(events, 'question').map((e) => e.secret.name), ['GITHUB_TOKEN', 'OTHER_KEY']);
    assert.deepEqual(of(events, 'answer').map((e) => e.secret), [{ name: 'GITHUB_TOKEN', set: true }, { name: 'OTHER_KEY', set: false }]);
    assert.ok(!JSON.stringify(events).includes(secret) && !JSON.stringify(bodies).includes(secret), 'the value is in no event and no model call');
  }
  { // setSecret replaces a line in place and quotes what needs it; parseEnv reads it back
    const dir = tempDir('quorx-env-');
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\r\nKEY=old\r\n');
    assert.deepEqual(setSecret(dir, 'KEY', 'a "b" #c\nd'), { created: false, replaced: true, gitignored: false });
    const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.equal(text, 'X=1\r\nKEY="a \\"b\\" #c\\nd"\r\n');
    assert.deepEqual(parseEnv(text), { X: '1', KEY: 'a "b" #c\nd' });
    assert.deepEqual(parseEnv("export A='x # y'\nB=plain # note\n# C=no\n"), { A: 'x # y', B: 'plain' });
    assert.equal(secretKind('.env.example'), '', 'templates are meant to be read');
    assert.equal(secretKind('app/.env.local'), 'env');
    assert.equal(secretKind('.env. '), 'env', 'Windows drops trailing dots and spaces');
    assert.equal(scrubSecrets(dir, 'X=1 KEY=a "b" #c\nd'), 'X=1 KEY=[secret removed]', 'six or more characters are removed; short ones stay');
  }
});

test('launch_config lists, saves, renames and removes saved servers; direct writes to launch.json point to it', async () => {
  let b = 0;
  const { bodies, dir } = await run(() => [
    reply('', [['launch_config', { action: 'save', name: 'web', command: 'npm', args: ['run', 'dev'] }]]),
    reply('', [['launch_config', { action: 'save', name: 'api', command: 'node', args: ['api.js'], port: 4010 }]]),
    reply('', [['launch_config', { action: 'save', name: 'site', old_name: 'web', args: ['run', 'start'] }]]),
    reply('', [['launch_config', { action: 'remove', name: 'api' }]]),
    reply('', [['launch_config', { action: 'save', name: 'bad', command: 'npm & calc' }]]),
    reply('', [['write_file', { path: '.quorx/launch.json', content: '{}' }]]),
    reply('', [['launch_config', { action: 'list' }]]),
    reply('Done.'),
  ][b++]);
  const results = bodies.at(-1).messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.match(results[0], /Saved:\n- web: npm run dev/);
  assert.match(results[2], /- site: npm run start/, 'a rename keeps the command and takes the new args');
  assert.match(results[3], /Removed "api"/);
  assert.match(results[4], /^Error:/, 'a command line with shell characters is refused');
  assert.match(results[5], /^Refused: .*launch_config/);
  assert.match(results[6], /^Saved launch configs:\n- site: npm run start\n\n\[steps/);
  const file = JSON.parse(fs.readFileSync(path.join(dir, '.quorx', 'launch.json'), 'utf8'));
  assert.deepEqual(file.configurations.map((c) => c.name), ['site']);
});

// npm, npx and pip used to skip the command check in start_server. Now every line gets it: a plain dev server still
// starts with no card, and in Strict a package fetched and run (new or saved) or an install asks, as it does in shell.
test('start_server: every line goes through the command check; plain dev servers, npx vite and local installs start with no card, even in YOLO', async () => {
  { // start_server: every line, saved or new, goes through the command check; a plain dev server still starts
    let b = 0, cards = [];
    const { events, bodies } = await run(() => [
      reply('', [['start_server', { name: 'web', command: 'npm', args: ['run', 'dev'] }]]),
      reply('', [['start_server', { name: 'api', command: 'node', args: ['server.js'] }]]),
      reply('', [['start_server', { name: 'tool', command: 'npx', args: ['-y', 'somepkg'] }]]),
      reply('', [['start_server', { name: 'deps', command: 'pip', args: ['install', '-r', 'requirements.txt'] }]]),
      reply('', [['launch_config', { action: 'save', name: 'fetched', command: 'npx', args: ['-y', 'otherpkg'] }]]),
      reply('', [['start_server', { name: 'fetched' }]]),
      reply('Done.'),
    ][b++], { settings: { approval: 'strict' },
      prep: (d) => { fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } })); fs.writeFileSync(path.join(d, 'server.js'), 'console.log(1);\n'); fs.writeFileSync(path.join(d, 'requirements.txt'), 'flask\n'); },
      onEvent: (e, id) => { if (e.t === 'approval') { cards.push(e.what); setTimeout(() => answerApproval(id, e.id, { approve: false }), 5); } } });
    const results = toolResults(bodies.at(-1));
    assert.match(results[0], /Server "web" is running/);
    assert.match(results[1], /Server "api" is running/);
    assert.doesNotMatch(results[2], /is running/);
    assert.doesNotMatch(results[3], /is running/);
    assert.doesNotMatch(results[5], /is running/, 'a saved config is checked the same way');
    assert.deepEqual(cards, ['npx -y somepkg', 'pip install -r requirements.txt', 'npx -y otherpkg']);
    assert.deepEqual(of(events, 'server').map((e) => e.name), ['web', 'api']);
  }
  { // start_server in YOLO: dev servers, npx vite and local installs start with no card and no decider vote
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith('https://registry.npmjs.org/left-pad')) return new Response(JSON.stringify({ time: { created: '2014-03-14T00:00:00Z' } }));
      if (u.startsWith('https://api.npmjs.org/downloads/')) return new Response(JSON.stringify({ downloads: 2000000 }));
      return real(url, init);
    };
    const starts = [['web', 'npm', ['run', 'dev']], ['api', 'node', ['server.js']], ['py', 'python', ['-m', 'http.server', '{PORT}']], ['vite', 'npx', ['vite']],
      ['deps', 'npm', ['install']], ['pad', 'npm', ['install', 'left-pad']], ['req', 'pip', ['install', '-r', 'requirements.txt']]];
    let b = 0;
    try {
      const { events, bodies } = await run(() => [...starts.map(([name, command, args]) => reply('', [['start_server', { name, command, args }]])), reply('Done.')][b++], {
        prep: (d) => { fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } })); fs.writeFileSync(path.join(d, 'server.js'), 'console.log(1);\n'); fs.writeFileSync(path.join(d, 'requirements.txt'), 'flask\n'); } });
      const results = toolResults(bodies.at(-1));
      starts.forEach(([name], k) => assert.match(results[k], new RegExp(`Server "${name}" is running`), name));
      assert.deepEqual(of(events, 'approval'), [], 'no card and no vote');
      assert.deepEqual(of(events, 'server').map((e) => e.name), starts.map(([name]) => name));
    } finally { globalThis.fetch = real; }
  }
});

test('✨ Enhance rewrites a draft with the given model, sees earlier turns, and drops fences or quotes', async () => {
  const { rewritePrompt, REWRITE_SYSTEM } = await import('../server/enhancer.js');
  let sent = null;
  const call = async (body) => { sent = body; return { message: { content: '```\n"Build a snake game in one HTML file.\n- Arrow keys to move\n- Score shown"\n```' }, usage: { cost: 0.00002 } }; };
  const r = await rewritePrompt({ text: 'make snake', earlier: ['hi', 'use plain js'], model: 'test/cheap', call });
  assert.equal(r.text, 'Build a snake game in one HTML file.\n- Arrow keys to move\n- Score shown');
  assert.equal(r.model, 'test/cheap');
  assert.equal(r.cost, 0.00002);
  assert.equal(sent.model, 'test/cheap');
  assert.equal(sent.messages[0].content, REWRITE_SYSTEM);
  assert.match(sent.messages[1].content, /- use plain js[\s\S]*The draft to improve:\nmake snake/);
  assert.equal(await rewritePrompt({ text: 'x', model: 'm', call: async () => ({ message: { content: '  ' } }) }), null);
});

// ---------- Video Mode (server/videomode.js): a film gets a brief, a story pick and a storyboard first ----------
const userText = (body) => { const u = body.messages.filter((m) => m.role === 'user').at(-1).content; return typeof u === 'string' ? u : u.filter((x) => x.type === 'text').map((x) => x.text).join('\n'); };
const toolNames = (body) => body.tools.map((t) => t.function.name);

test('Video Mode: the enhancer\'s kind decides first, then the chat, then plain words that tell a film from a feature that plays video', async () => {
  { // Video Mode: plain words tell a film from a feature that plays video
    for (const t of ['Make me a nice video of India winning the 2026 T20 World Cup', 'I need a 30 second promo for my bakery', 'create a trailer for my indie game', 'a short film about a lighthouse keeper, please', 'Turn these photos into a reel for Instagram', 'make a music video for my song']) assert.equal(looksLikeFilm(t), true, t);
    for (const t of ['build a snake game', 'add a video player to my site', 'make a promo page for the launch', 'fix the video upload in my app', 'make a game with animation', 'build a video streaming app like YouTube', 'what is the best film camera?', 'make a landing page with a video background']) assert.equal(looksLikeFilm(t), false, t);
  }
  { // Video Mode: the enhancer's kind decides first, then the chat, then the words; off and benchmarks never
    const root = 'x';
    assert.equal(videoModeFor({ kind: 'video', text: 'something cinematic for the launch', root }).on, true);
    assert.equal(videoModeFor({ kind: 'app', text: 'make a video editor', root }).on, false);
    assert.equal(videoModeFor({ text: 'make a trailer', root }).on, true);
    assert.equal(videoModeFor({ chatMode: 'off', kind: 'video', text: 'make a trailer', root }).on, false);
    assert.equal(videoModeFor({ chatMode: 'on', text: 'make it longer', root }).on, true);
    assert.equal(videoModeFor({ settings: { videoMode: 'off' }, kind: 'video', text: 'make a trailer', root }).on, false);
    assert.equal(videoModeFor({ kind: 'video', text: 'make a trailer', root, bench: true }).on, false);
    assert.equal(videoModeFor({ kind: 'video', text: 'make a trailer', root: null }).on, false);
  }
  { // Video Mode: the enhancer's kind wins over the words both ways
    const says = (kind) => async () => ({ message: { content: JSON.stringify({ goal: 'x', kind, includes: [], assumptions: [] }) }, usage: {} });
    const app = await run((body, i) => [reply('Done.')][i], { text: 'make a video editor for my team', enhance: says('app') });
    assert.equal(of(app.events, 'video_mode').length, 0);
    const film = await run((body, i) => [reply('Done.')][i], { text: 'something cinematic for our launch, 20 seconds', enhance: says('video') });
    assert.equal(of(film.events, 'video_mode')[0]?.why, 'enhancer');
    assert.equal(of(film.events, 'reading')[0].kind, 'video');
  }
});

test('Video Mode: a request that is not a film gets exactly what it got before; a film gets the video skills, the storyboard tool and the brief', async () => {
  { // Video Mode: a request that is not a film gets exactly the prompt, tools and limits it got before
    const script = (body, i) => [reply('', [['ask_user', { questions: [{ question: 'A?', options: ['1', '2'] }, { question: 'B?', options: ['1', '2'] }, { question: 'C?', options: ['1', '2'] }, { question: 'D?', options: ['1', '2'] }] }]]), reply('', [['ask_user', { question: 'E?', options: ['1', '2'] }]]), reply('Done.')][i];
    const answer = (runId) => (e) => { if (e.t === 'question') setTimeout(() => answerQuestion(runId.id, e.id, { defaults: true, answers: [{ choice: 0 }, { choice: 0 }, { choice: 0 }, { choice: 0 }] }), 5); };
    const go = async (settings) => { const r = { id: null }; const out = await run(script, { text: 'build a snake game with a video player for replays', settings: { approval: 'strict', ...settings }, onEvent: (e) => { if (e.t === 'start') r.id = e.runId; answer(r)(e); } }); return out; };
    const on = await go({}), off = await go({ videoMode: 'off' });
    assert.equal(of(on.events, 'video_mode').length, 0);
    assert.deepEqual(toolNames(on.bodies[0]), toolNames(off.bodies[0]));
    assert.ok(!toolNames(on.bodies[0]).includes('storyboard'));
    assert.equal(userText(on.bodies[0]), userText(off.bodies[0]));
    const own = (t) => t.replace(/quorx-run-\w+/g, 'quorx-run-X'); // each run has its own throwaway project folder
    assert.equal(own(on.bodies[0].messages[0].content), own(off.bodies[0].messages[0].content));
    assert.match(toolResults(on.bodies[2]).at(-1), /You have asked 4 questions in this reply, the most the user allows/, 'the usual limit of 4 still holds');
  }
  { // Video Mode: a film loads the video skills, adds the storyboard tool, and allows the brief and story questions
    let runId;
    const brief = { questions: [{ question: 'Length?', options: ['30 s', '60 s'], recommended: 0 }, { question: 'Route?', options: ['Stills', 'Code'], recommended: 0 }, { question: 'People?', options: ['Licensed', 'Generic'], recommended: 0 }, { question: 'Sound?', options: ['Score', 'Voice'], recommended: 0 }] };
    const { events, bodies } = await run((body, i) => [reply('', [['ask_user', brief]]), reply('', [['ask_user', { question: 'Which story?', options: ['Journey', 'Countdown', 'Then and now'], recommended: 0 }]]), reply('Done.')][i], {
      text: 'Make me a nice video of India winning the 2026 T20 World Cup', settings: { approval: 'strict' },
      onEvent: (e) => { if (e.t === 'start') runId = e.runId; if (e.t === 'question') setTimeout(() => answerQuestion(runId, e.id, e.questions ? { defaults: true, answers: [{ choice: 0 }, { choice: 0 }, { choice: 0 }, { choice: 0 }] } : { choice: 0 }), 5); },
    });
    const vm = of(events, 'video_mode')[0];
    assert.ok(vm?.on, 'a video_mode event');
    assert.deepEqual(vm.skills, ['video-direction', 'film-sound', 'film-review']);
    assert.ok(toolNames(bodies[0]).includes('storyboard'));
    const sent = userText(bodies[0]);
    assert.match(sent, /\[Video Mode: the harness reads this request as a film/);
    assert.match(sent, /# Skill: video-direction/);
    assert.match(sent, /# Skill: film-review/);
    assert.match(toolResults(bodies[2]).at(-1), /^The user chose: "Journey"/, 'the fifth question is asked: Video Mode allows 8');
  }
});

test('Video Mode: paid media waits for the storyboard (changes go back to the agent), and in YOLO an unanswered brief takes the agent\'s recommendations', async () => {
  { // Video Mode: paid media waits for the storyboard, and Go ahead lets it through
    let runId;
    const shots = [{ time: '0:00', framing: 'wide', move: 'push', what: 'Stadium hush' }, { time: '0:03', what: 'Title' }, { time: '0:06', what: 'The six', sound: 'crowd roar' }];
    const { events, bodies, dir } = await run((body, i) => [reply('', [['imagine', { prompt: 'a stadium', why: 'shot 1' }]]), reply('', [['storyboard', { title: 'One More Time', shots }]]), reply('', [['imagine', { prompt: 'a stadium', why: 'shot 1' }]]), reply('Done.')][i], {
      text: 'make a trailer for the final', chatId: 'chat-vm', settings: { approval: 'strict', mediaEnabled: true, tools: { browser: { on: false }, image: { on: true } } },
      generateImage: async () => ({ url: 'data:image/png;base64,iVBORw0KGgo=', cost: 0.01, ms: 1, model: 'test/image' }),
      onEvent: (e) => { if (e.t === 'start') runId = e.runId; if (e.t === 'question' && e.gate === 'storyboard') setTimeout(() => answerQuestion(runId, e.id, { choice: 0 }), 5); if (e.t === 'approval') setTimeout(() => answerApproval(runId, e.id, { approve: false }), 5); },
    });
    assert.match(toolResults(bodies[1])[0], /^Refused: Video Mode: show the storyboard first/);
    const card = of(events, 'question').find((e) => e.gate === 'storyboard');
    assert.ok(card?.artifact, 'the storyboard card points at its sheet');
    const sheet = of(events, 'artifact').find((e) => e.artifact.id === card.artifact);
    assert.match(sheet.artifact.html, /Storyboard · One More Time/);
    assert.match(sheet.artifact.html, /crowd roar/);
    assert.match(toolResults(bodies[2]).at(-1), /^The user approved the storyboard/);
    assert.doesNotMatch(toolResults(bodies[3]).at(-1), /storyboard/i, 'after Go ahead the picture is no longer refused for the storyboard');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.quorx', 'video', 'storyboard.json'), 'utf8')).approved, true);
  }
  { // Video Mode: changes to the storyboard go back to the agent, and paid media still waits
    let runId;
    const shots = [{ time: '0:00', what: 'A' }, { time: '0:03', what: 'B' }, { time: '0:06', what: 'C' }];
    const { bodies } = await run((body, i) => [reply('', [['storyboard', { title: 'T', shots }]]), reply('', [['imagine', { prompt: 'x', why: 'y' }]]), reply('Done.')][i], {
      text: 'make a trailer', settings: { approval: 'strict', mediaEnabled: true, tools: { browser: { on: false }, image: { on: true } } },
      onEvent: (e) => { if (e.t === 'start') runId = e.runId; if (e.t === 'question') setTimeout(() => answerQuestion(runId, e.id, { text: 'swap shots 2 and 3' }), 5); },
    });
    assert.match(toolResults(bodies[1])[0], /The user wants the storyboard changed: "swap shots 2 and 3"/);
    assert.match(toolResults(bodies[2]).at(-1), /^Refused: Video Mode: the user has not approved the storyboard yet/);
  }
  { // Video Mode in YOLO: an unanswered brief takes the agent's recommendations, not the deciders' guesses
    let deciderCalls = 0;
    const qs = [{ question: 'Length?', options: ['60 s', '30 s'], recommended: 1 }, { question: 'Sound?', options: ['Score', 'Voice'], recommended: 0 }];
    const { events, bodies } = await run((body, i) => [reply('', [['ask_user', { questions: qs }]]), reply('', [['storyboard', { title: 'T', shots: [{ time: '0', what: 'A' }, { time: '1', what: 'B' }, { time: '2', what: 'C' }] }]]), reply('Done.')][i], {
      text: 'make a promo video for my bakery', settings: { approval: 'yolo', videoWaitSecs: 0.05 },
      ensemble: async () => { deciderCalls++; throw new Error('the deciders should not be asked'); },
    });
    assert.equal(deciderCalls, 0);
    const res = toolResults(bodies[1])[0];
    assert.match(res, /1\. Length\?\nThe user did not answer in time, so your recommendation stands \(⚡ YOLO, Video Mode\): "30 s"/);
    assert.match(res, /2\. Sound\?\nThe user did not answer in time, so your recommendation stands \(⚡ YOLO, Video Mode\): "Score"/);
    const ans = of(events, 'answer')[0];
    assert.equal(ans.by, 'recommended');
    assert.match(toolResults(bodies[2]).at(-1), /the storyboard stands/);
  }
});

test('Video Mode: later replies and continued chats keep the mode and the approved storyboard without asking the brief again', async () => {
  { // Video Mode: a later reply in a film chat keeps the mode but doesn't ask the brief again; "Not a video" turns it off
    const history = [{ role: 'user', content: 'make a trailer' }, { role: 'assistant', content: 'Here it is.' }];
    const later = await run((body, i) => [reply('Done.')][i], { text: 'make it a bit longer', history, videoMode: 'on' });
    assert.match(userText(later.bodies[0]), /Video Mode is on for this chat.*The brief and the story were settled earlier/s);
    assert.equal(of(later.events, 'video_mode')[0].first, false);
    const off = await run((body, i) => [reply('Done.')][i], { text: 'make a trailer', videoMode: 'off' });
    assert.equal(of(off.events, 'video_mode').length, 0);
    assert.ok(!toolNames(off.bodies[0]).includes('storyboard'));
  }
  { // Video Mode: a chat continued from a film chat keeps Video Mode and the storyboard approved there
    const { bodies, events } = await run((body, i) => [reply('', [['imagine', { prompt: 'x', why: 'y' }]]), reply('Done.')][i], {
      text: 'Carry on with this work.', chatId: 'chat-new', videoMode: 'on', videoFrom: 'chat-old',
      settings: { approval: 'strict', mediaEnabled: true, tools: { browser: { on: false }, image: { on: true } } },
      prep: (d) => { fs.mkdirSync(path.join(d, '.quorx', 'video'), { recursive: true }); fs.writeFileSync(path.join(d, '.quorx', 'video', 'storyboard.json'), JSON.stringify({ chatId: 'chat-old', approved: true, title: 'T', shots: [] })); },
      onEvent: (e, id) => { if (e.t === 'approval') setTimeout(() => answerApproval(id, e.id, { approve: false }), 5); },
    });
    assert.equal(of(events, 'video_mode')[0].first, false, 'no new brief');
    assert.match(userText(bodies[0]), /The brief and the story were settled earlier/);
    assert.doesNotMatch(toolResults(bodies[1])[0], /storyboard/i, 'the approval carried over');
  }
});

test('Video Mode: the film facts read ffprobe and ffmpeg\'s loudness and black-frame output', async () => {
  const dir = tempDir('quorx-film-');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const ff = async (cmd, args) => {
    if (cmd === 'ffprobe') return { ok: true, out: JSON.stringify({ format: { duration: '28.8' }, streams: [{ codec_type: 'video', width: 1280, height: 720, r_frame_rate: '30/1' }, { codec_type: 'audio' }] }), err: '' };
    if (args.includes('ebur128=peak=true')) return { ok: true, out: '', err: 'Summary:\n  Integrated loudness:\n    I:         -14.2 LUFS\n  True peak:\n    Peak:       -1.3 dBFS\n' };
    if (args.some((a) => String(a).startsWith('blackdetect'))) return { ok: true, out: '', err: '[blackdetect] black_start:0 black_end:0.6 black_duration:0.6\n' };
    if (args.some((a) => String(a).includes('astats'))) return { ok: true, out: '', err: `Overall\nRMS level dB: ${args.some((a) => String(a).startsWith('lowpass')) ? '-18.0' : '-22.5'}\n` };
    fs.writeFileSync(args.at(-1), 'jpg'); return { ok: true, out: '', err: '' };
  };
  const beats = Array.from({ length: 46 }, (_, i) => +(i * 0.625).toFixed(3));
  const music = async () => ({ bpm: 96, beats, ending: { clean: false } });
  const f = await filmFacts(dir, 'assets/film.mp4', { ff, music, cuts: async () => [4, 8.125, 12.5, 16, 20.9] });
  assert.deepEqual({ ...f, sheet: !!f.sheet }, { rel: 'assets/film.mp4', seconds: 28.8, width: 1280, height: 720, fps: 30, audio: true, lufs: -14.2, peak: -1.3, black: 0.6, bassDb: 4.5, bpm: 96, endsClean: false, cuts: { cuts: 5, onBeat: 2, offsets: [0.25, 0, 0, 0.25, 0.275], worst: 0.275 }, sheet: true });
  assert.equal(factsText(f), 'assets/film.mp4: 28.8 s, 1280×720 at 30 fps, sound at -14.2 LUFS, peak -1.3 dBFS, 0.6 s black, bass +4.5 dB against the rest, 96 BPM, 2 of 5 cuts on the beat. Off: the bass (below 150 Hz) is 4.5 dB louder than everything above it, so it rumbles; keep it about 3 dB below; only 2 of 5 cuts land on a beat (within 2 frames); the sound stops abruptly at the end instead of ending');
  const plain = { rel: 'a.mp4', seconds: 10, width: 1280, height: 720, fps: 30, audio: true, lufs: -14, peak: -1.5, black: 0 };
  assert.equal(factsText(plain), 'a.mp4: 10 s, 1280×720 at 30 fps, sound at -14 LUFS, peak -1.5 dBFS', 'a film measured without the music checks reads as before');
  assert.match(factsText({ ...plain, audio: false, lufs: null, peak: null }), /Off: it has no sound track/);
});

// ---------- Video Mode v2: music first, moving pictures, files not pages ----------
test('music map: a tempo asked for settles the detector, a click track\'s tempo and bars are found, and fitting keeps the ending on whole bars', () => {
  { // music map: the tempo asked for settles a detector that lands on a related tempo
    assert.deepEqual(settleTempo(95.7, 96), { bpm: 95.7, source: 'detected', detected: 95.7 });
    assert.deepEqual(settleTempo(129.2, 96), { bpm: 96, source: 'hint', detected: 129.2 });
    assert.deepEqual(settleTempo(110, 0), { bpm: 110, source: 'detected', detected: 110 });
  }
  { // music map: a click track's tempo and bars are found
    const sr = 11025, bpm = 120, x = new Float32Array(sr * 12);
    for (let b = 0; b * 0.5 < 12; b++) { const at = Math.round((0.25 + b * 0.5) * sr), loud = b % 4 === 0 ? 1 : 0.5; for (let k = 0; k < 400 && at + k < x.length; k++) x[at + k] = loud * Math.sin(k / 3) * Math.exp(-k / 120); }
    const a = analyse(x, sr);
    const t = tempoOf(a.onset, a.fps);
    assert.ok(Math.abs(t.bpm - bpm) / bpm < 0.04, `tempo ${t.bpm}`);
    const g = barsOf(a, bpm);
    assert.equal(g.bar, 2);
    assert.ok(Math.abs(g.bars[0] - 0.25) < 0.06, `first bar at ${g.bars[0]}`);
  }
  { // fit music: shorter keeps the ending and starts on a bar; longer plays whole bars again on the downbeat
    const bars = Array.from({ length: 11 }, (_, i) => +(1.881 + i * 2.508).toFixed(3));
    const map = { dur: 27.9, bar: 2.508, bars, loud: Array(56).fill(-12) };
    const longer = fitPlan(map, 35);
    assert.deepEqual(longer.parts, [[0, 14.421], [6.897, 14.421], [14.421, 27.9]]);
    assert.ok(Math.abs(longer.seconds - 35.42) < 0.02);
    const shorter = fitPlan(map, 20);
    assert.equal(shorter.parts.length, 1);
    assert.equal(shorter.parts[0][1], 27.9, 'the ending stays');
    assert.ok(bars.includes(shorter.parts[0][0]), 'it starts on a bar line');
    assert.equal(fitPlan(map, 28).method, 'as is');
    const peak = pickWindows({ ...map, loud: map.loud.map((v, i) => (i >= 34 && i < 49 ? -6 : v)) }, { seconds: 8, shape: 'peak' })[0];
    assert.equal(peak.start, 16.929);
    assert.equal(peak.bars, 3);
    assert.deepEqual(cutsVsBeats([1, 1.6, 3], [0, 0.5, 1, 1.5, 2, 2.5, 3]), { cuts: 3, onBeat: 2, offsets: [0, 0.1, 0], worst: 0.1 });
  }
});

test('Video Mode v2: the brief recommends moving stills and AI music when those tools are on, and the film is delivered as a file', () => {
  const on = videoRules({ ...VIDEO_DEFAULTS }, { first: true, ask: true, limit: 8, text: 'make a film about a monsoon evening in Mumbai', cats: ['image', 'video', 'music'] });
  assert.match(on, /each turned into a short AI clip that starts from it/);
  assert.match(on, /music from the music model/);
  assert.match(on, /music_map/);
  assert.match(on, /site:assets\/edits\/<name>\.mp4/);
  assert.doesNotMatch(on, /index\.html/);
  assert.doesNotMatch(on, /switched off/);
  const off = videoRules({ ...VIDEO_DEFAULTS }, { first: true, ask: true, limit: 8, text: 'make a film about a monsoon evening in Mumbai', cats: ['image'] });
  assert.match(off, /stills with camera moves only/);
  assert.match(off, /a score written in code/);
  assert.match(off, /video clips and music switched off/);
  assert.match(videoRules({ ...VIDEO_DEFAULTS, videoViewer: true }, { first: true, ask: true, limit: 8, text: 'a film', cats: [] }), /viewer page \(index\.html\)/);
  assert.equal(recommendedRoute(VIDEO_DEFAULTS, 'a launch video for my app', ['video']), 'code');
  assert.equal(recommendedMusic({ videoMusic: 'ai' }, []), 'code');
});

test('Video Mode v2: music_map and fit_music work on a track in the project', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const { bodies, dir } = await run((body, i) => [
    reply('', [['music_map', { path: 'assets/audio/beat.wav', bpm: 96, seconds: 5, shape: 'peak' }]]),
    reply('', [['fit_music', { path: 'assets/audio/beat.wav', out: 'assets/audio/beat-30s.wav', seconds: 30, bpm: 96 }]]),
    reply('', [['fit_music', { path: 'assets/audio/beat.wav', out: '../outside.wav', seconds: 30 }]]),
    reply('Done.'),
  ][i], {
    text: 'make a trailer for my band',
    prep: (d) => { fs.mkdirSync(path.join(d, 'assets', 'audio'), { recursive: true }); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'aevalsrc=0.8*sin(2*PI*90*t)*exp(-30*mod(t-0.1\\,0.625)):s=44100:d=20', path.join(d, 'assets', 'audio', 'beat.wav')]); },
  });
  const map = toolResults(bodies[1]).at(-1);
  assert.match(map, /assets\/audio\/beat\.wav: 20 s, 9[5-7](\.\d)? BPM/);
  assert.match(map, /Bar lines \(s\): /);
  assert.match(map, /Best peak stretches of about 5 s/);
  const fit = toolResults(bodies[2]).at(-1);
  assert.match(fit, /^Wrote assets\/audio\/beat-30s\.wav: \d+\.\d+ s \(asked 30 s/);
  const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, 'assets', 'audio', 'beat-30s.wav')]).toString());
  assert.ok(Math.abs(secs - 30) < 2.6, `about 30 s on bar lines, got ${secs}`);
  assert.match(toolResults(bodies[3]).at(-1), /^Error: /, 'outside the project is refused');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.quorx', 'video', 'music.json'), 'utf8')).bpm, 96, 'the tempo asked for is kept for the film checks');
});

test('a command that edits a file in place is steered to edit_file, before any approval', async () => {
  const { bodies, events } = await run((body, i) => [reply('', [['shell', { command: "(Get-Content src/app.js -Raw) -replace 'a','b' | Set-Content src/app.js; node build.mjs" }]]), reply('Done.')][i], { settings: { approval: 'strict' } });
  assert.match(toolResults(bodies[1])[0], /^Not run: this command edits src\/app\.js in place\. Make that change with edit_file/);
  assert.equal(of(events, 'approval').length, 0);
  assert.equal(inPlaceEdit('sed -i "s/x/y/" a.txt'), 'a.txt');
  assert.equal(inPlaceEdit('(Get-Content a.txt) -replace x,y | Set-Content b.txt'), '');
  assert.equal(inPlaceEdit('Get-Content log.txt | Select-String error'), '');
});

test('a reply that finishes its plan on the very last step is not "out of steps"; one with items left still is', async () => {
  const items = (s) => [{ text: 'a', status: s }, { text: 'b', status: s }];
  const done = await run((body, i) => [reply('', [['plan', { spec: 'x', items: items('done') }]]), reply('All done.')][i], { settings: { maxSteps: 2, review: 'off' } });
  assert.equal(of(done.events, 'out_of_steps').length, 0);
  assert.equal(done.done.stats.stop, 'answered');
  const open = await run((body, i) => [reply('', [['plan', { spec: 'x', items: items('todo') }]]), reply('Ran out.')][i], { settings: { maxSteps: 2, review: 'off', continueRounds: 0 } });
  assert.equal(of(open.events, 'out_of_steps').length, 1);
});

// ---------- fixes from the first real v2 film (false alarms from QuorX's own checks) ----------
test('films are reviewed as films (picture, motion, sound, rhythm, story); clips and silent, draft and test copies are not', () => {
  { // Video Mode: only finished films are reviewed as films, not the clips they are made from
    const found = [{ r: 'assets/clips/shot09.mp4', t: 9 }, { r: 'assets/generated/video_slow_crane.mp4', t: 8 }, { r: 'assets/edits/mumbai-monsoon.mp4', t: 5 }, { r: 'teaser.mp4', t: 7 }, { r: 'assets/shot01.mp4', t: 10 }];
    assert.deepEqual(finishedFilms(found), ['assets/edits/mumbai-monsoon.mp4', 'teaser.mp4']);
  }
  { // a film is reviewed as a film: picture, motion, sound, rhythm and story
    assert.deepEqual(FILM_KEYS, ['picture', 'motion', 'sound', 'rhythm', 'story']);
    const film = REVIEW_SYSTEM(3, true, false, true);
    assert.match(film, /skeptical film reviewer/);
    assert.match(film, /rhythm \(cuts land on the music's beats/);
    assert.doesNotMatch(film, /accessibility/);
    assert.match(REVIEW_SYSTEM(3, true), /accessibility/, 'a page is still reviewed as a page');
  }
  { // silent, draft and test copies of a film are not reviewed as films
    assert.deepEqual(finishedFilms([{ r: 'assets/edits/quorx-teaser-silent.mp4', t: 9 }, { r: 'assets/edits/quorx-teaser.mp4', t: 8 }, { r: 'assets/edits/teaser_draft.mp4', t: 7 }]), ['assets/edits/quorx-teaser.mp4']);
  }
});

test('Video Mode: the film checks measure the beat at the tempo the music was made at', async () => {
  const dir = tempDir('quorx-film-');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const ff = async (cmd, args) => {
    if (cmd === 'ffprobe') return { ok: true, out: JSON.stringify({ format: { duration: '30' }, streams: [{ codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '24/1' }, { codec_type: 'audio' }] }), err: '' };
    if (args.some((a) => String(a).includes('astats'))) return { ok: true, out: '', err: 'RMS level dB: -20\n' };
    if (args.includes('ebur128=peak=true')) return { ok: true, out: '', err: 'Summary:\n    I:   -14.0 LUFS\n    Peak:   -1.2 dBFS\n' };
    if (args.some((a) => String(a).startsWith('blackdetect'))) return { ok: true, out: '', err: '' };
    fs.writeFileSync(args.at(-1), 'jpg'); return { ok: true, out: '', err: '' };
  };
  const asked = [];
  const music = async (file, opts) => { asked.push(opts.bpm); const bpm = opts.bpm || 129.2, beat = 60 / bpm; return { bpm, beats: Array.from({ length: Math.ceil(30 / beat) }, (_, i) => +(i * beat).toFixed(3)), ending: { clean: true } }; };
  const cuts = async () => [5, 7.5, 10, 15, 17.5, 20, 25, 27.5];
  const right = await filmFacts(dir, 'assets/film.mp4', { ff, music, cuts, bpm: 96 });
  assert.equal(asked[0], 96);
  assert.equal(right.cuts.onBeat, 8, 'at 96 BPM all eight cuts are on the beat');
  assert.doesNotMatch(factsText(right), /cuts land on a beat/);
  const wrong = await filmFacts(dir, 'assets/film.mp4', { ff, music, cuts });
  assert.ok(wrong.cuts.onBeat < 8, 'without the tempo, a detector that hears 129 BPM makes them look off');
});

test('a picture for the deciders is scaled down first, and sent as it is when that fails', () => {
  const dir = tempDir('quorx-pic-'), file = path.join(dir, 'sheet.png');
  fs.writeFileSync(file, Buffer.alloc(64, 7));
  let args = null;
  const small = deciderPicture(file, 'image/png', (cmd, a) => { args = a; return Buffer.alloc(800, 1); });
  assert.match(small, /^data:image\/jpeg;base64,/);
  assert.ok(args.some((a) => String(a).includes("min(1280,iw)")));
  assert.match(deciderPicture(file, 'image/png', () => { throw new Error('no ffmpeg'); }), /^data:image\/png;base64,/);
});

// ---------- the motion test: render without scripts, switch paid tools on, pick models ----------
test('render_film plays a page frame by frame in QuorX\'s browser and encodes it, with no command to approve', { skip: (!(await import('../server/browser.js')).browserPath() && 'no Chromium browser installed') || (!hasFfmpeg && 'ffmpeg is not installed') }, async () => {
  const page = '<!doctype html><html><body style="margin:0;background:#000"><canvas id="c" width="1080" height="1080"></canvas><script>const g = document.getElementById("c").getContext("2d"); window.DUR = 1; window.render = (t) => { g.fillStyle = "#000"; g.fillRect(0, 0, 1080, 1080); g.fillStyle = "#c6ff3d"; g.fillRect(100 + t * 600, 440, 200, 200); }; window.READY = true;</script></body></html>';
  const { bodies, events, dir } = await run((body, i) => [
    reply('', [['render_film', { page: 'film/index.html', out: 'assets/edits/box.mp4', fps: 12, aspect: '1:1' }]]),
    reply('', [['render_film', { page: 'film/empty.html', out: 'assets/edits/none.mp4' }]]),
    reply('Done.'),
  ][i], {
    text: 'make a 1 second motion graphics teaser', videoMode: 'on', settings: { approval: 'strict', tools: { browser: { on: true } } },
    prep: (d) => { fs.mkdirSync(path.join(d, 'film'), { recursive: true }); fs.writeFileSync(path.join(d, 'film', 'index.html'), page); fs.writeFileSync(path.join(d, 'film', 'empty.html'), '<!doctype html><p>no film here</p>'); },
  });
  assert.match(toolResults(bodies[1]).at(-1), /^Rendered assets\/edits\/box\.mp4: 1 s, 12 frames at 12 fps, 1080×1080, no sound/);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', path.join(dir, 'assets', 'edits', 'box.mp4')]).toString().trim().replace(/,+$/, '');
  assert.equal(probe, '1080,1080,12');
  assert.equal(of(events, 'approval').length, 0, 'nothing to approve');
  assert.match(toolResults(bodies[2]).at(-1), /has no window\.render\(t\)/);
});

test('enable_media: one card switches paid tools on with the user\'s model; in YOLO it switches on after the wait', async () => {
  { // enable_media: one card switches paid tools on for the chat, with the model the user picked
    let runId;
    const { bodies, events } = await run((body, i) => [
      reply('', [['enable_media', { kinds: ['music'], why: 'a real score instead of one written in code' }]]),
      reply('', [['enable_media', { kinds: ['video'], why: 'moving shots' }]]),
      reply('Done.'),
    ][i], {
      text: 'make a teaser', settings: { approval: 'strict', mediaEnabled: true, tools: { browser: { on: false }, image: { on: true }, video: { on: false }, music: { on: false }, speech: { on: false } } },
      onEvent: (e) => { if (e.t === 'start') runId = e.runId; if (e.t === 'approval') setTimeout(() => answerApproval(runId, e.id, e.kinds?.includes('music') ? { approve: true, models: { music: 'google/lyria-3-pro-preview' } } : { approve: false }), 5); },
    });
    const names = (b) => b.tools.map((t) => t.function.name);
    assert.ok(names(bodies[0]).includes('enable_media'));
    assert.ok(!names(bodies[0]).includes('compose_music'));
    const card = of(events, 'approval')[0];
    assert.deepEqual(card.kinds, ['music']);
    assert.match(toolResults(bodies[1]).at(-1), /^Switched on for this chat: music \(models: music google\/lyria-3-pro-preview\)/);
    assert.ok(names(bodies[1]).includes('compose_music'), 'its tool is offered at once');
    assert.deepEqual(of(events, 'tools_on')[0].kinds, ['music']);
    assert.match(toolResults(bodies[2]).at(-1), /^The user kept video clips off/);
    assert.ok(!names(bodies[2]).includes('make_video'));
  }
  { // enable_media in YOLO switches on after the wait (switching on spends nothing)
    const { bodies } = await run((body, i) => [reply('', [['enable_media', { kinds: ['music'], why: 'score' }]]), reply('Done.')][i], {
      text: 'make a teaser', settings: { approval: 'yolo', mediaEnabled: true, tools: { browser: { on: false }, music: { on: false } } },
    });
    assert.match(toolResults(bodies[1]).at(-1), /^Switched on for this chat: music/);
  }
});

test('every generate card has a model choice: a production plan line, and a single call, can switch to any model of that kind', async () => {
  primeCatalogue('videos', [TEST_VIDEO, TEST_VIDEO_TEXT]);
  let runId;
  const { bodies, events } = await run((body, i) => [
    reply('', [['media_plan', { why: 'two shots', items: [{ kind: 'video', count: 2, seconds: 5, what: 'two shots' }] }]]),
    reply('', [['make_video', { prompt: 'a lighthouse at dusk', why: 'an extra shot' }]]),
    reply('Done.'),
  ][i], {
    settings: { ...videoSettings('test/vid-start'), approval: 'strict' },
    generateVideo: async () => ({ url: `data:video/mp4;base64,${Buffer.from('mp4').toString('base64')}`, usage: { cost: 0.1 }, ms: 5 }),
    onEvent: (e) => { if (e.t === 'start') runId = e.runId; if (e.t === 'approval' && e.mode === 'strict') setTimeout(() => answerApproval(runId, e.id, e.tool === 'media_plan' ? { approve: true, models: { 0: 'test/vid-text' } } : { approve: true, model: 'test/vid-start' }), 5); },
  });
  const planCard = of(events, 'approval').find((e) => e.tool === 'media_plan');
  assert.deepEqual(planCard.items[0].options.map((o) => o.model), ['test/vid-start'], 'each line offers the kind\'s models with prices');
  assert.match(toolResults(bodies[1]).at(-1), /^Plan approved/);
  assert.match(toolResults(bodies[1]).at(-1), /test\/vid-text/, 'the model picked from the catalogue is in the plan');
  // The later call uses the model picked on the plan, so it fits the plan and needs no second card.
  const call = of(events, 'approval').find((e) => e.tool === 'make_video');
  assert.equal(call.model, 'test/vid-text');
  assert.equal(of(events, 'approval_done').find((e) => e.id === call.id).by, 'plan');
});

test('the link check skips tags a script builds as text, and still finds a real broken link', async () => {
  const dir = tempDir('quorx-links-');
  const html = '<!doctype html><body><img src="missing.png"><script>const a = `<img src="out/${n}.png">`; const b = \'<img src="teaser/stills/t\' + t + \'.png">\';</script></body>';
  const problems = await checkHtml(html, { label: 'review.html', dir });
  assert.deepEqual(problems.filter((p) => /links to/.test(p)), ['review.html: links to missing.png, which does not exist']);
});

