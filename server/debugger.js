// A real debugger for the agent: start a program paused, set breakpoints, step, read the stack and local variables,
// evaluate an expression in a frame. Node programs use V8's inspector (the same DevTools protocol as the browser
// tool). Every other language goes through the Debug Adapter Protocol, the one most debuggers speak (debugpy for
// Python; netcoredbg, Delve, lldb-dap and others as platform packs add them): a pack says how to start its adapter
// listening on a port, and this file talks DAP to it. The program runs as one of the agent's background jobs, so it
// sits in a Windows job and Stop ends it. Research found a debugger helps strong models most when it comes after
// plain debugging fails, and can make weaker ones worse when given from the start, so the agent gets it only after a
// few failed tries (see agent.js).
import net from 'node:net';
import path from 'node:path';
import { startBackground, stopBackground, getBackground, listBackground } from './bgjobs.js';
import { debugAdapters } from './packs/index.js';
import { stdioLine } from './dapbridge.js';

const NODE_EXTS = ['.js', '.mjs', '.cjs'];
const adapterFor = (file) => debugAdapters().find((a) => a.exts.includes(path.extname(file).toLowerCase()));
/** The languages the debug tool can run, for its description: "Node (.js, .mjs, .cjs), Python (.py), …". */
export const debugLanguages = () => [`Node (${NODE_EXTS.join(', ')})`, ...debugAdapters().map((a) => `${a.label} (${a.exts.join(', ')})`)].join(', ');
/** The command a debug session runs, as the rules and the approval card see it (`program`, `cwd`: as debugStart). */
export function debugGateLine(file, args = [], { program, cwd } = {}) {
  if (NODE_EXTS.includes(path.extname(file).toLowerCase())) return ['node', file, ...args].join(' ');
  const a = adapterFor(file);
  return a?.gate ? a.gate({ file, args, ...(program ? { program } : {}), ...(cwd ? { cwd } : {}) }) : [file, ...args].join(' ');
}

const SESS = new Map();
let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const clip = (s, n = 120) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

// ---------- Node: V8 inspector over a WebSocket ----------
async function nodeSession(port, brk = true) {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0]; } catch { await sleep(250); } }
  if (!target?.webSocketDebuggerUrl) throw new Error('the program did not open its debugger port');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('could not connect to the debugger')); });
  let id = 0;
  const waiting = new Map(), scripts = new Map();
  const s = { kind: 'node', ws, paused: null, waiters: [], ended: false };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
    if (m.method === 'Debugger.scriptParsed') scripts.set(m.params.scriptId, m.params.url);
    if (m.method === 'Debugger.paused') { s.paused = m.params; for (const w of s.waiters.splice(0)) w(); }
    if (m.method === 'Debugger.resumed') s.paused = null;
  };
  ws.onclose = () => { s.ended = true; for (const w of s.waiters.splice(0)) w(); };
  s.send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; waiting.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (waiting.delete(n)) rej(new Error(`${method} timed out`)); }, 15000); });
  s.urlOf = (sid) => scripts.get(sid) || '';
  await s.send('Runtime.enable');
  await s.send('Debugger.enable');
  await s.send('Runtime.runIfWaitingForDebugger').catch(() => {});
  if (brk) await nodeWait(s, 5000); // --inspect-brk stops on the first line once the debugger lets it run
  return s;
}
const fileOf = (url) => { try { return url.startsWith('file:') ? decodeURIComponent(new URL(url).pathname.replace(/^\/(\w:)/, '$1')) : url; } catch { return url; } };
async function nodeWait(s, ms = 10000) {
  if (s.paused || s.ended) return;
  await Promise.race([new Promise((r) => s.waiters.push(r)), sleep(ms)]);
}
async function nodeState(s) {
  if (s.ended) return { state: 'ended' };
  if (!s.paused) return { state: 'running' };
  // Node's own frames (node:internal/…) are left out: only the program's code.
  const frames = s.paused.callFrames.map((f) => ({ fn: f.functionName || '(top level)', url: s.urlOf(f.location.scriptId) || f.url, line: f.location.lineNumber + 1, id: f.callFrameId }))
    .filter((f) => !/^node:/.test(f.url)).slice(0, 12).map(({ url, ...f }) => ({ ...f, file: fileOf(url) }));
  const top = s.paused.callFrames[0];
  const locals = [];
  for (const sc of (top?.scopeChain || []).filter((x) => ['local', 'closure', 'block'].includes(x.type)).slice(0, 2)) {
    const props = await s.send('Runtime.getProperties', { objectId: sc.object.objectId, ownProperties: true }).catch(() => ({ result: [] }));
    for (const p of props.result.slice(0, 30)) locals.push(`${p.name} = ${clip(p.value?.description ?? p.value?.value ?? p.value?.type, 100)}`);
  }
  return { state: 'paused', reason: s.paused.reason, frames, locals };
}

// ---------- every other language: the Debug Adapter Protocol over a local port ----------
// `plan` (from the pack): { adapterID, request: 'attach' | 'launch', args, missing } — attach to a program that waits
// for the debugger (debugpy), or ask the adapter to launch it (netcoredbg, Delve, lldb-dap). Either way the program
// doesn't run a line until configurationDone, which is sent on the first continue, after the breakpoints are set.
// Optional: initWait (ms to wait for `initialized`; Delve builds the program first), evalContext (lldb reads 'repl'
// input as its own commands, so lldb packs ask for 'watch').
async function dapSession(port, plan, kind) {
  let sock = null;
  for (let i = 0; i < 80 && !sock; i++) {
    sock = await new Promise((r) => { const c = net.connect({ host: '127.0.0.1', port }); c.once('connect', () => r(c)); c.once('error', () => r(null)); });
    if (!sock) await sleep(250);
  }
  if (!sock) throw new Error(plan.missing || `the ${kind} debugger did not open its port`);
  let buf = Buffer.alloc(0), seqN = 0;
  const waiting = new Map();
  const s = { kind, sock, paused: null, thread: null, waiters: [], ended: false, events: [], output: '', evalContext: plan.evalContext || 'repl' };
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const head = buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, head).toString())?.[1] || 0);
      if (buf.length < head + 4 + len) return;
      const m = JSON.parse(buf.slice(head + 4, head + 4 + len).toString());
      buf = buf.slice(head + 4 + len);
      if (m.type === 'response' && waiting.has(m.request_seq)) { const w = waiting.get(m.request_seq); waiting.delete(m.request_seq); m.success ? w.res(m.body || {}) : w.rej(new Error(m.message || 'debugger error')); }
      if (m.type === 'event') {
        s.events.push(m.event);
        if (m.event === 'stopped') { s.paused = m.body; s.thread = m.body.threadId; for (const w of s.waiters.splice(0)) w(); }
        if (m.event === 'continued') s.paused = null;
        // What the program prints, when the adapter runs it (netcoredbg): what is new goes with the next state.
        if (m.event === 'output' && m.body?.category !== 'telemetry') s.output = `${s.output}${m.body?.output || ''}`.slice(-4000);
        if (m.event === 'terminated' || m.event === 'exited') { s.ended = true; for (const w of s.waiters.splice(0)) w(); }
      }
    }
  });
  sock.on('close', () => { s.ended = true; for (const w of s.waiters.splice(0)) w(); });
  s.send = (command, args = {}) => new Promise((res, rej) => {
    const n = ++seqN; waiting.set(n, { res, rej });
    const body = JSON.stringify({ seq: n, type: 'request', command, arguments: args });
    sock.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    setTimeout(() => { if (waiting.delete(n)) rej(new Error(`${command} timed out`)); }, 15000);
  });
  await s.send('initialize', { clientID: 'quorx', clientName: 'QuorX', adapterID: plan.adapterID || kind, linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsRunInTerminalRequest: false });
  // Many adapters answer attach/launch only after configurationDone, so the answer is collected later.
  s.attach = s.send(plan.request || 'attach', plan.args || {});
  s.attach.catch((e) => { s.launchError = e.message; }); // a build that failed, a program that isn't there
  for (let i = 0; i < (plan.initWait || 6000) / 100 && !s.events.includes('initialized') && !s.ended && !s.launchError; i++) await sleep(100);
  if (s.launchError) { sock.destroy(); throw new Error(`the debugger could not start the program: ${s.launchError}`); }
  // Stop where an exception the program doesn't catch is thrown, when the pack names the adapter's filter for it.
  if (plan.exceptions) await s.send('setExceptionBreakpoints', { filters: plan.exceptions }).catch(() => {});
  s.bps = new Map(); // file → [{ line, condition }]
  return s;
}
async function dapWait(s, ms = 10000) { if (s.paused || s.ended) return; await Promise.race([new Promise((r) => s.waiters.push(r)), sleep(ms)]); }
async function dapState(s) {
  const output = s.output.trim().split(/\r?\n/).slice(-15).join('\n');
  s.output = '';
  if (s.ended) return { state: 'ended', output };
  if (!s.paused) return { state: 'running', output };
  const st = await s.send('stackTrace', { threadId: s.thread, levels: 12 });
  const frames = st.stackFrames.map((f) => ({ fn: f.name, file: f.source?.path || '', line: f.line, id: f.id }));
  const locals = [];
  if (frames[0]) {
    const sc = await s.send('scopes', { frameId: frames[0].id });
    for (const scope of sc.scopes.filter((x) => /local/i.test(x.name)).slice(0, 1)) {
      const v = await s.send('variables', { variablesReference: scope.variablesReference });
      for (const x of v.variables.filter((y) => !/^(special|function) variables$/i.test(y.name)).slice(0, 30)) locals.push(`${x.name} = ${clip(x.value, 100)}`);
    }
  }
  return { state: 'paused', reason: s.paused.reason, frames, locals, output };
}

// ---------- the agent's interface ----------
/**
 * Starts `file` in cwd paused under a debugger: Node's inspector for .js/.mjs/.cjs, or the debug adapter a platform
 * pack gives for its file type. `program`: for compiled languages, the built program to launch when the pack can't
 * find it itself. `python` overrides the Python interpreter (tests). Returns { id, job, kind, note }.
 */
export async function debugStart({ projectId, cwd, file, args = [], program, python, logTo, logRel, term }) {
  const ext = path.extname(file).toLowerCase();
  const port = await freePort();
  const quoted = [file, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  let kind, line, plan = null;
  if (NODE_EXTS.includes(ext)) { kind = 'node'; line = `node --inspect-brk=127.0.0.1:${port} ${quoted}`; }
  else {
    const a = adapterFor(file);
    if (!a) throw new Error(`the debugger works on ${debugLanguages()} files`);
    plan = await a.start({ file, args, cwd, port, ...(program ? { program } : {}), ...(python ? { python } : {}) });
    kind = a.pack; line = plan.stdio ? stdioLine(port, plan.line) : plan.line; // stdio: an adapter with no port of its own
  }
  const job = startBackground({ projectId, cwd, line, shell: 'direct', label: `debug ${file}`, logTo, logRel, term });
  let s;
  try { s = kind === 'node' ? await nodeSession(port) : await dapSession(port, plan, kind); } catch (e) { await stopBackground(job.id).catch(() => {}); throw e; }
  const id = `d${++seq}`;
  SESS.set(id, Object.assign(s, { id, job: job.id, file, cwd, projectId })); // the same object its message handler updates
  return { id, job: job.id, kind, note: plan?.note || '' };
}
/**
 * Attaches to the Node inspector of one of the agent's running background jobs: an Electron app's main process or a
 * server started with --inspect=<port> (or --inspect-brk=<port>, which waits on its first line). Only a job of this
 * project whose command opened that port, never another program's. Stop then only disconnects; the job keeps running.
 */
export async function debugAttach({ projectId, cwd, port }) {
  port = Number(port);
  if (!(Number.isInteger(port) && port >= 1024 && port <= 65535)) throw new Error('attach needs the inspector port (1024-65535) the program was started with');
  const re = new RegExp(`--inspect(-brk)?[= ](?:[\\w.]+:)?${port}(?!\\d)`);
  const job = listBackground(projectId).find((j) => j.status === 'running' && re.test(j.label));
  if (!job) throw new Error(`none of your running background jobs was started with --inspect=${port}: start the program with shell (background: true) and that flag first`);
  const s = await nodeSession(port, /--inspect-brk/.test(re.exec(job.label)[0]));
  const id = `d${++seq}`;
  SESS.set(id, Object.assign(s, { id, job: job.id, file: '', cwd, projectId, attached: true }));
  return { id, job: job.id, kind: 'node', paused: !!s.paused };
}
const getD = (id) => { const s = SESS.get(String(id)); if (!s) throw new Error(`no debug session ${id}`); return s; };

/** Sets a breakpoint at file:line (an optional condition: an expression in the program's language). */
export async function debugBreak(id, file, line, condition) {
  const s = getD(id);
  const abs = path.resolve(s.cwd, file);
  if (s.kind === 'node') {
    // The file's folders count too, not only its name: Electron's own loader is a main.js as well. Script URLs
    // spell a space as %20, so each part matches either way.
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = abs.split(/[\\/]/).slice(-3).map((x) => (encodeURI(x) === x ? esc(x) : `(?:${esc(x)}|${esc(encodeURI(x))})`)).join('[\\\\/]');
    const r = await s.send('Debugger.setBreakpointByUrl', { urlRegex: `${tail}$`, lineNumber: Number(line) - 1, ...(condition ? { condition } : {}) });
    return `breakpoint at ${path.basename(abs)}:${line}${r.locations?.length ? '' : ' (the file is not loaded yet: it will bind when it is)'}`;
  }
  const list = [...(s.bps.get(abs) || []), { line: Number(line), ...(condition ? { condition } : {}) }];
  s.bps.set(abs, list);
  const r = await s.send('setBreakpoints', { source: { path: abs }, breakpoints: list });
  const bp = r.breakpoints?.at(-1);
  return `breakpoint at ${path.basename(abs)}:${line}${bp?.verified === false ? ` (not verified: ${bp.message || 'check the line has code'})` : ''}`;
}

/** continue | step (over) | into | out. Waits up to `wait` ms for the next pause or the end, then returns the state. */
export async function debugMove(id, how = 'continue', wait = 10000) {
  const s = getD(id);
  if (s.kind === 'node') {
    const m = { continue: 'Debugger.resume', step: 'Debugger.stepOver', into: 'Debugger.stepInto', out: 'Debugger.stepOut' }[how];
    if (!m) throw new Error('move must be continue, step, into or out');
    if (!s.paused && how !== 'continue') throw new Error('the program is running; pause it at a breakpoint first');
    if (s.paused) { s.paused = null; await s.send(m); } // running already: just wait for the next pause
    await nodeWait(s, wait);
    return nodeState(s);
  }
  if (!s.configured) { s.configured = true; await s.send('configurationDone'); await s.attach.catch(() => {}); if (how === 'continue') { await dapWait(s, wait); return dapState(s); } }
  const m = { continue: 'continue', step: 'next', into: 'stepIn', out: 'stepOut' }[how];
  if (!m) throw new Error('move must be continue, step, into or out');
  // Running already (a window waiting for a click): continue just waits for the next stop, as Node's does.
  if (!s.paused && how === 'continue') { await dapWait(s, wait); return dapState(s); }
  if (!s.paused) throw new Error('the program is running; pause it at a breakpoint first');
  s.paused = null;
  await s.send(m, { threadId: s.thread });
  await dapWait(s, wait);
  return dapState(s);
}

/**
 * The debug session whose program runs as background job `job`, when it is paused (waiting up to `wait` ms for it to
 * stop): { id, at: 'app.py:10' }, else null. A paused program's windows can't answer, so the desktop tool asks first.
 */
export async function debugPausedIn(job, wait = 0) {
  const s = [...SESS.values()].find((x) => x.job === job && !x.ended);
  if (!s) return null;
  if (!s.paused && wait) await (s.kind === 'node' ? nodeWait(s, wait) : dapWait(s, wait));
  if (!s.paused) return null;
  const top = (await debugState(s.id).catch(() => null))?.frames?.[0];
  return { id: s.id, at: top ? `${path.basename(top.file || '?')}:${top.line}` : '?' };
}

/** Where it is now: { state, reason, frames, locals }. */
export const debugState = (id) => { const s = getD(id); return s.kind === 'node' ? nodeState(s) : dapState(s); };

/** Evaluates an expression in the top frame (or `frame`). */
export async function debugEval(id, expr, frame = 0) {
  const s = getD(id);
  if (!s.paused) throw new Error('the program is running; evaluate when it is paused');
  if (s.kind === 'node') {
    const f = s.paused.callFrames[frame];
    const r = await s.send('Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression: String(expr), returnByValue: false, generatePreview: true });
    if (r.exceptionDetails) return `error: ${clip(r.exceptionDetails.exception?.description || r.exceptionDetails.text, 300)}`;
    return clip(r.result.description ?? JSON.stringify(r.result.value), 1500);
  }
  const st = await dapState(s);
  const r = await s.send('evaluate', { expression: String(expr), frameId: st.frames[frame]?.id, context: s.evalContext });
  return clip(r.result, 1500);
}

/** Ends the program and the session (an attached session only disconnects). */
export async function debugStop(id) {
  const s = getD(id);
  if (s.attached && s.paused) await s.send('Debugger.resume').catch(() => {}); // the app goes on without the debugger
  try { s.kind === 'node' ? s.ws.close() : s.sock.destroy(); } catch { /* closed */ }
  SESS.delete(String(id));
  if (s.attached) return { detached: true, job: s.job };
  const j = getBackground(s.job);
  return j && j.status === 'running' ? stopBackground(s.job) : { already: true };
}

/** Text for the agent. */
export function stateText(st) {
  const out = st.output ? `\nNew program output:\n${st.output}` : '';
  if (st.state !== 'paused') return `${st.state === 'ended' ? 'The program has ended.' : 'The program is running (no breakpoint hit yet within the wait).'}${out}`;
  return `Paused (${st.reason}) at ${path.basename(st.frames[0]?.file || '?')}:${st.frames[0]?.line}.\nStack:\n${st.frames.map((f, i) => `  ${i}. ${f.fn} (${path.basename(f.file)}:${f.line})`).join('\n')}\nLocals:\n${st.locals.length ? st.locals.map((l) => `  ${l}`).join('\n') : '  (none)'}${out}`;
}
