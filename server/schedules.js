// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Scheduled tasks: "every weekday at 9, in project X, run this prompt", or "in an hour, remind me".
// A schedule starts a normal chat with its saved prompt, model, mode and settings (server/schedrun.js). It runs
// while QuorX runs (the desktop app or its tray process). A run missed while the computer slept, or while QuorX
// was closed, runs once when it is back, labelled as missed; several missed runs of one schedule become one.
// The clock is injectable, so the timing is tested without waiting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';

const FILE = () => path.join(HOME, 'data', 'schedules.json');
export const GRACE_MS = 2 * 60e3;      // a run this late is still on time; later than this it is "missed"
export const MIN_EVERY = 15;           // minutes between runs of an "every" schedule, at least
export const MAX_SCHEDULES = 50;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- when: { kind: 'once', at } · { kind: 'daily', time: 'HH:MM', days: [0-6] (empty: every day) } · { kind: 'every', minutes } ----------
export function cleanWhen(w = {}) {
  if (w.kind === 'once') { const at = Number(w.at); if (!Number.isFinite(at) || at <= 0) throw new Error('a one-off schedule needs a time'); return { kind: 'once', at }; }
  if (w.kind === 'every') { const m = Math.round(Number(w.minutes)); if (!(m >= MIN_EVERY)) throw new Error(`repeat at most every ${MIN_EVERY} minutes`); return { kind: 'every', minutes: Math.min(m, 7 * 24 * 60) }; }
  if (w.kind === 'daily') {
    const t = String(w.time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) throw new Error('a daily schedule needs a time like 09:00');
    const days = [...new Set((Array.isArray(w.days) ? w.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    return { kind: 'daily', time: `${t[1].padStart(2, '0')}:${t[2]}`, days: days.length === 7 ? [] : days };
  }
  throw new Error('when must be once, daily or every');
}
/** The first run strictly after `from` (ms), or null when there is none (a one-off that has run). */
export function nextAfter(w, from, created = from) {
  if (w.kind === 'once') return w.at > from ? w.at : null;
  if (w.kind === 'every') { const step = w.minutes * 60e3; const k = Math.floor((from - created) / step) + 1; return created + Math.max(1, k) * step; }
  const [h, m] = w.time.split(':').map(Number);
  const d = new Date(from);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0); // local time, so 9:00 stays 9:00 across DST
    if (c.getTime() > from && (!w.days.length || w.days.includes(c.getDay()))) return c.getTime();
  }
  return null;
}
export function describeWhen(w) {
  if (w.kind === 'once') return `once, ${new Date(w.at).toLocaleString()}`;
  if (w.kind === 'every') return w.minutes % 60 ? `every ${w.minutes} minutes` : `every ${w.minutes / 60 === 1 ? 'hour' : `${w.minutes / 60} hours`}`;
  const days = w.days.join() === '1,2,3,4,5' ? 'weekdays' : w.days.join() === '0,6' ? 'weekends' : w.days.length ? w.days.map((d) => DAY_NAMES[d]).join(', ') : 'every day';
  return `${days} at ${w.time}`;
}

// ---------- storage ----------
export function loadSchedules() { try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(j.schedules) ? j.schedules : []; } catch { return []; } }
export function saveSchedules(list) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE() + '.tmp', JSON.stringify({ version: 1, schedules: list }, null, 2));
  fs.renameSync(FILE() + '.tmp', FILE());
}
/**
 * A new or edited schedule from the page. The page sends the settings and tools a new chat in that project
 * would get, so a scheduled chat behaves like one you start yourself. YOLO only when chosen for this schedule.
 */
export function cleanSchedule(b, now = Date.now(), old = null) {
  const prompt = String(b.prompt ?? old?.prompt ?? '').trim();
  if (!prompt) throw new Error('a schedule needs a prompt');
  if (prompt.length > 20000) throw new Error('the prompt is too long (20,000 characters at most)');
  const projectId = String(b.projectId ?? old?.projectId ?? '');
  if (!/^[\w-]{1,64}$/.test(projectId)) throw new Error('a schedule needs a project');
  const model = String(b.model ?? old?.model ?? '').trim();
  if (!/^[\w.:/-]{3,120}$/.test(model)) throw new Error('a schedule needs a model');
  const when = cleanWhen(b.when ?? old?.when);
  const created = old?.created || now;
  const s = {
    id: old?.id || `s${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`,
    name: String(b.name ?? old?.name ?? '').trim().slice(0, 80) || prompt.replace(/\s+/g, ' ').slice(0, 50),
    projectId, prompt, model,
    reasoning: ['off', 'low', 'medium', 'high', 'default'].includes(b.reasoning) ? b.reasoning : old?.reasoning || 'off',
    approval: b.approval === 'yolo' ? 'yolo' : b.approval === 'strict' ? 'strict' : old?.approval || 'strict',
    settings: b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings) ? b.settings : old?.settings || {},
    tools: b.tools && typeof b.tools === 'object' && !Array.isArray(b.tools) ? b.tools : old?.tools || {},
    when, paused: b.paused ?? old?.paused ?? false, created,
    lastRun: old?.lastRun || null, runs: old?.runs || 0,
  };
  // The anchor of an "every" schedule is when it was made (or changed), so "every 2 hours" counts from then.
  if (when.kind === 'every' && JSON.stringify(when) !== JSON.stringify(old?.when)) s.created = now;
  s.nextAt = s.paused ? null : nextAfter(when, now, s.created);
  return s;
}

// ---------- the scheduler ----------
/**
 * Checks the schedules every `tickMs` and starts those that are due. deps:
 *   now()                  the clock (Date.now)
 *   run(schedule, info)    starts the chat; info = { missed, due, late }. Returns { chatId, runId } (or throws).
 *   load() / save(list)    storage (loadSchedules / saveSchedules)
 */
export function createScheduler({ now = Date.now, run, load = loadSchedules, save = saveSchedules, tickMs = 30e3, lease = takeLease } = {}) {
  let timer = null, busy = false;
  async function tick() {
    if (busy) return [];
    // Two copies of QuorX on one data folder (the app and its MCP server, say) must not both start a run.
    if (lease && !lease(now())) return [];
    busy = true;
    const started = [];
    try {
      const list = load(), t = now();
      let changed = false;
      for (const s of list) {
        if (s.paused || s.nextAt == null || s.nextAt > t) continue;
        const due = s.nextAt, late = t - due, missed = late > GRACE_MS;
        // Whatever happens, the next run is the first one after now: missed runs collapse into this one.
        s.nextAt = nextAfter(s.when, t, s.created);
        s.runs = (s.runs || 0) + 1;
        s.lastRun = { at: t, due, missed, status: 'starting' };
        changed = true;
        try {
          const r = await run(s, { missed, due, late });
          Object.assign(s.lastRun, { chatId: r?.chatId || null, runId: r?.runId || null, status: r?.status || 'running', ...(r?.note ? { note: r.note } : {}) });
          started.push({ id: s.id, ...s.lastRun });
        } catch (e) { Object.assign(s.lastRun, { status: 'failed', note: String(e.message || e).slice(0, 300) }); }
      }
      if (changed) save(list);
    } finally { busy = false; }
    return started;
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, tickMs); timer.unref?.(); setTimeout(() => tick().catch(() => {}), 3000).unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

// The scheduler lease: data/schedules.lock names the process that runs schedules. Another one takes over when the
// holder has not renewed it for 2 minutes (it was closed, or the computer slept and it hasn't ticked yet).
const LEASE = () => path.join(HOME, 'data', 'schedules.lock');
export function takeLease(t = Date.now()) {
  try {
    const cur = JSON.parse(fs.readFileSync(LEASE(), 'utf8'));
    if (cur.pid !== process.pid && t - cur.at < 120e3) {
      let alive = true; try { process.kill(cur.pid, 0); } catch { alive = false; }
      if (alive) return false;
    }
  } catch { /* no lease yet */ }
  try { fs.mkdirSync(path.dirname(LEASE()), { recursive: true }); fs.writeFileSync(LEASE(), JSON.stringify({ pid: process.pid, at: t })); } catch { return false; }
  return true;
}

/** Records how a scheduled chat ended (or that it waits for you) on its schedule's last run. */
export function noteRun(scheduleId, runId, patch) {
  const list = loadSchedules(), s = list.find((x) => x.id === scheduleId);
  if (!s || !s.lastRun || s.lastRun.runId !== runId) return null;
  Object.assign(s.lastRun, patch);
  saveSchedules(list);
  return s;
}
