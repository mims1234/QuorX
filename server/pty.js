// Your terminal tabs as a true terminal: a pseudo-terminal (node-pty: ConPTY on Windows, a pty elsewhere) running
// your shell, drawn on the page by xterm.js. Ctrl+C, colours, Tab completion, full-screen programs (vim, htop, less),
// password prompts and arrow-key menus all work. Output streams to the page over Server-Sent Events; keystrokes and
// resizes come back as small POSTs. If node-pty can't load, the plain shell in shell.js is used instead.
// Only your own windows reach these routes (other sites are refused; the agent's pages are sandboxed and its browser
// can't open the harness itself); the agent never uses them. The shell gets your whole environment (userenv.js), as a
// terminal you opened yourself would: colours, your tokens, programs that open the browser.
import { createRequire } from 'node:module';
import { shellInfo } from './shell.js';
import { userEnv } from './userenv.js';

const require = createRequire(import.meta.url);
let pty = null, loadError = '';
try { pty = require('node-pty'); } catch (e) { loadError = e.message; }
export const ptyAvailable = () => !!pty;

const KEEP = 400_000; // characters of recent output kept per terminal, replayed when the page reconnects
const SESS = new Map(); // `${projectId}:${tab}` → { term, buf, subs:Set, exited, code, cols, rows }
const key = (projectId, tab) => `${projectId}:${tab}`;

// A tab's terminal, started on first use in `cwd` (the project folder).
export function ptyOpen(projectId, tab, cwd, cols = 100, rows = 30) {
  if (!pty) throw new Error(`the full terminal is not available (${loadError || 'node-pty is not installed'})`);
  const k = key(projectId, tab);
  const old = SESS.get(k);
  if (old && !old.exited) { ptyResize(projectId, tab, cols, rows); return old; }
  const sh = shellInfo();
  const args = sh.kind === 'ps' ? ['-NoLogo'] : (/(bash|zsh)$/.test(sh.exe) ? ['-l'] : []);
  const term = pty.spawn(sh.exe, args, {
    name: 'xterm-256color', cols: clampCols(cols), rows: clampRows(rows), cwd,
    env: userEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'QuorX' }),
  });
  const s = { term, buf: '', subs: new Set(), exited: false, code: null, cols, rows, shell: sh.name, started: Date.now() };
  term.onData((d) => {
    s.buf += d;
    if (s.buf.length > KEEP) s.buf = s.buf.slice(s.buf.length - KEEP);
    for (const cb of s.subs) cb({ d });
  });
  term.onExit(({ exitCode }) => {
    s.exited = true; s.code = exitCode;
    for (const cb of s.subs) cb({ exit: exitCode });
  });
  SESS.set(k, s);
  return s;
}
const clampCols = (n) => Math.max(20, Math.min(500, Math.round(Number(n) || 100)));
const clampRows = (n) => Math.max(5, Math.min(300, Math.round(Number(n) || 30)));

export function ptyWrite(projectId, tab, data) {
  const s = SESS.get(key(projectId, tab));
  if (!s || s.exited) return false;
  s.term.write(String(data).slice(0, 100_000));
  return true;
}
export function ptyResize(projectId, tab, cols, rows) {
  const s = SESS.get(key(projectId, tab));
  if (!s || s.exited) return false;
  const c = clampCols(cols), r = clampRows(rows);
  if (c === s.cols && r === s.rows) return true;
  s.cols = c; s.rows = r;
  try { s.term.resize(c, r); } catch { /* it just exited */ }
  return true;
}
// Recent output first (so a reload shows the screen again), then live output. Returns an unsubscribe function.
export function ptyFollow(projectId, tab, cb) {
  const s = SESS.get(key(projectId, tab));
  if (!s) { cb({ none: true }); return () => {}; }
  if (s.buf) cb({ d: s.buf, replay: true });
  if (s.exited) cb({ exit: s.code });
  s.subs.add(cb);
  return () => s.subs.delete(cb);
}
export function ptyClose(projectId, tab) {
  const k = key(projectId, tab), s = SESS.get(k);
  if (!s) return false;
  SESS.delete(k);
  try { s.term.kill(); } catch { /* gone */ }
  for (const cb of s.subs) cb({ exit: s.code ?? 0, closed: true });
  return true;
}
/** Your open terminal tabs in a project: [{ tab, shell, started }] (for the Running tab). */
export const ptyList = (projectId) => [...SESS.entries()].filter(([k, s]) => k.startsWith(`${projectId}:`) && !s.exited)
  .map(([k, s]) => ({ tab: k.slice(projectId.length + 1), shell: s.shell, started: s.started }));
// The harness stopping ends every terminal it started.
process.once('exit', () => { for (const s of SESS.values()) { try { s.term.kill(); } catch { /* gone */ } } });
