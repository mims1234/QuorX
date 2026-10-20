// The agent's own terminal, for programs that need one: prompts, menus, full-screen terminal apps (TUIs), REPLs.
// Each session is a pseudo-terminal (node-pty: ConPTY on Windows) whose program starts through jobgate.cjs and waits
// until it is inside a Windows job, like every other agent command, so Stop ends everything it started. What it
// draws goes through a small terminal screen (vtscreen.js), so the agent reads the screen as text, the way a person
// sees it. These sessions are the agent's; the user's own terminal tabs (pty.js) stay off limits to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Screen } from './vtscreen.js';
import { childEnv } from './workspace.js';
import { jobsAvailable, adoptPid, killJob, closeJob } from './jobhost.js';

const require = createRequire(import.meta.url);
let pty = null, loadError = '';
try { pty = require('node-pty'); } catch (e) { loadError = e.message; }
export const agentTermAvailable = () => !!pty;

const GATE = fileURLToPath(new URL('./jobgate.cjs', import.meta.url));
const SESS = new Map();
let seq = 0;

// Named keys the agent can send.
export const KEYS = { Enter: '\r', Tab: '\t', Esc: '\x1b', Escape: '\x1b', Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
  Backspace: '\x7f', Delete: '\x1b[3~', Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Space: ' ',
  'Ctrl+C': '\x03', 'Ctrl+D': '\x04', 'Ctrl+Z': '\x1a', 'Ctrl+L': '\x0c', 'Ctrl+A': '\x01', 'Ctrl+E': '\x05', 'Ctrl+U': '\x15', 'Ctrl+W': '\x17',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F10: '\x1b[21~', 'Shift+Tab': '\x1b[Z', y: 'y', n: 'n', q: 'q' };

const view = (s) => ({ id: s.id, projectId: s.projectId, chatId: s.chatId || null, label: s.label, running: !s.exited, code: s.code ?? null, cols: s.screen.cols, rows: s.screen.rows, started: s.started });
/** The last few lines with something on them, as the screen shows them now (for the Running tab). */
export function termTail(id, n = 4) {
  const s = SESS.get(String(id)); if (!s) return [];
  return s.screen.text().split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n);
}

/** Starts a program in a new terminal session. Resolves once it is running inside its job. */
export async function termStart({ projectId, chatId = null, cwd, line, shell = 'direct', cols = 100, rows = 30, env = {}, onExit }) {
  if (!pty) throw new Error(`the agent terminal needs node-pty, which could not load (${loadError || 'not installed'})`);
  const id = `t${++seq}`;
  const goFile = path.join(os.tmpdir(), `qx-go-${process.pid}-${Date.now().toString(36)}-${seq}`);
  // useConptyDll: node-pty's bundled ConPTY, whose kill needs no console-list helper (that helper fails once the
  // console is gone), so a finished session can always be released.
  const term = pty.spawn(process.execPath, [GATE, shell, line], { name: 'xterm-256color', cols, rows, cwd, useConptyDll: process.platform === 'win32', env: { ...childEnv(env), QX_GO_FILE: goFile, TERM: 'xterm-256color' } });
  const s = { id, projectId, chatId, label: line, term, screen: new Screen(cols, rows, (r) => { try { term.write(r); } catch { /* closed */ } }), raw: '', last: Date.now(), exited: false, code: null, job: null, started: Date.now() };
  term.onData((d) => { s.screen.write(d); s.raw = (s.raw + d).slice(-60000); s.last = Date.now(); });
  term.onExit(({ exitCode }) => {
    s.exited = true; s.code = exitCode;
    if (s.job) closeJob(s.job);
    try { fs.rmSync(goFile, { force: true }); } catch { /* gone */ }
    // The program is gone: release the terminal's own pipe and worker, or they keep QuorX's process busy.
    setTimeout(() => { try { term.kill(); } catch { /* already released */ } }, 50);
    onExit?.(s);
  });
  if (term.pid) {
    const job = `t${term.pid}x${Date.now().toString(36)}`;
    try { if (await jobsAvailable()) { await adoptPid(job, term.pid); s.job = job; } } catch { /* basic Stop */ }
  }
  fs.writeFileSync(goFile, 'go');
  SESS.set(id, s);
  return s;
}

const getS = (id) => { const s = SESS.get(String(id)); if (!s) throw new Error(`no terminal session ${id}`); return s; };

// Waits until the program has drawn and gone quiet for `quiet` ms (or ended), at most `max` ms.
async function settle(s, quiet = 350, max = 4000) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 120));
  while (!s.exited && Date.now() - t0 < max && Date.now() - s.last < quiet) await new Promise((r) => setTimeout(r, 80));
}

/** The screen now: { session, screen (text), cursor: [col,row] }. */
export function termScreen(id) {
  const s = getS(id);
  return { session: view(s), screen: s.screen.text({ cursor: true }), cursor: [s.screen.x, s.screen.y] };
}

/** Types text and/or presses keys (names from KEYS, in order), then waits for the screen to settle. */
export async function termSend(id, { text, keys } = {}) {
  const s = getS(id);
  if (s.exited) throw new Error(`terminal ${id} has ended (exit code ${s.code})`);
  if (text) s.term.write(String(text));
  for (const k of Array.isArray(keys) ? keys : keys ? [keys] : []) {
    const seqs = KEYS[k] ?? (String(k).length === 1 ? String(k) : null);
    if (seqs == null) throw new Error(`unknown key "${k}" (known: ${Object.keys(KEYS).join(', ')}, or any single character)`);
    s.term.write(seqs);
    await new Promise((r) => setTimeout(r, 60));
  }
  await settle(s);
  return termScreen(id);
}

/**
 * Waits (up to `wait` ms) for the program to draw something new or to end, then until it has been quiet for
 * `quiet` ms, and returns the screen. (A shell draws its own set-up codes first and the program's text a moment later.)
 */
export async function termRead(id, wait = 0, quiet = 350) {
  const s = getS(id);
  if (wait > 0) {
    const since = s.last, t0 = Date.now();
    while (!s.exited && s.last === since && Date.now() - t0 < wait) await new Promise((r) => setTimeout(r, 100));
    await settle(s, quiet, Math.max(4000, wait - (Date.now() - t0)));
  }
  return termScreen(id);
}

/** Ends the session's program and everything it started. */
export async function termStop(id) {
  const s = getS(id);
  if (s.exited) return { already: true, code: s.code };
  let r = { left: 0, mode: 'basic' };
  if (s.job) { try { const k = await killJob(s.job); r = { left: k.left, names: k.names, mode: k.mode }; } catch { /* fall back */ } }
  // Once its program is gone the terminal closes by itself; node-pty's own kill is only the fallback (it lists the
  // console's processes through a helper that fails when the console has already gone).
  const t0 = Date.now();
  while (!s.exited && Date.now() - t0 < 2000) await new Promise((x) => setTimeout(x, 100));
  if (!s.exited) { try { s.term.kill(); } catch { /* gone */ } }
  return r;
}
export const listTerms = (projectId) => [...SESS.values()].filter((s) => !projectId || s.projectId === projectId).map(view);
