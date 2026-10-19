// Python pack self-test: the project's venv is found and used, the compiler check catches an error in a changed file,
// a tkinter window is read and clicked with the desktop tool, the debugger (debugpy, over DAP) stops at a breakpoint
// and in a button handler after a click, and pytest's output is summed up.
// Set QX_PYTHON to the interpreter to debug with (one with debugpy installed), e.g. QX_PYTHON="C:\venv\Scripts\python.exe".
import { project, skipUnless, WIN } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { debugStart, debugBreak, debugMove, debugState, debugEval, debugStop, debugGateLine, debugPausedIn } from '../../debugger.js';
import { languageChecks } from '../../langchecks.js';
import { startBackground, stopBackground, jobOutput, getBackground } from '../../bgjobs.js';
import { desktopAvailable, appWindows, readWindow, clickControl, windowShot } from '../../uia.js';
import { venvOf, interpreter, debugpyMissing, pytestSummary } from '../python.js';
import { runAgent } from '../../agent.js';
import { saveProject, forgetProject } from '../../store.js';

const PY = process.env.QX_PYTHON || (WIN ? 'py' : 'python3');
const PYARGS = process.env.QX_PYTHON ? [] : WIN ? ['-3'] : [];
const SHELL = WIN && !process.env.QX_PYTHON;
const can = (code) => spawnSync(PY, [...PYARGS, '-c', code], { shell: SHELL, stdio: 'ignore' }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VENV_PY = WIN ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';
const fakeVenv = (dir) => { fs.mkdirSync(path.dirname(path.join(dir, VENV_PY)), { recursive: true }); fs.writeFileSync(path.join(dir, '.venv', 'pyvenv.cfg'), 'home = x\nversion = 3.11.4\n'); fs.writeFileSync(path.join(dir, VENV_PY), ''); };

const APP = 'def total(items):\n    s = 0\n    for price, qty in items:\n        s += price * qty\n    return s\n\nprint(total([(2, 3), (5, "2")]))\n';
// Line 10 is the button's handler body. The window stays on top, so the test's clicks land on it.
const TK_APP = `import tkinter as tk

root = tk.Tk()
root.title("QX Tk")
count = 0

def add():
    global count
    step = 2
    count += step
    root.title(f"QX Tk {count}")
    print("count", count, flush=True)

tk.Label(root, text="A label").pack(padx=60, pady=8)
tk.Button(root, text="Add two", command=add).pack(padx=60, pady=8)
tk.Entry(root).pack(padx=60, pady=8)
root.attributes("-topmost", True)
root.mainloop()
`;

// A desktop job's first window (the job host takes a moment to adopt the process).
async function firstWindow(job) {
  for (let i = 0; i < 60; i++) {
    try { const w = await appWindows(job, 1000); if (w.length) return w[0]; } catch { /* not adopted yet */ }
    await sleep(250);
  }
  throw new Error('the window did not appear');
}

test('python: a script runs', async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  const dir = project('py', { 'hello.py': 'import sys\nprint("hello", len(sys.argv) - 1)\n' });
  assert.match(execFileSync(PY, [...PYARGS, 'hello.py', 'x', 'y'], { cwd: dir, encoding: 'utf8', shell: SHELL }), /hello 2/);
});

test('python: the project\'s venv is found and the debugger uses it', () => {
  const plain = project('py-novenv', { 'app.py': 'print(1)\n' });
  assert.equal(venvOf(plain), null);
  assert.equal(interpreter(plain).line, WIN ? 'py -3' : 'python3');
  assert.equal(debugGateLine('app.py', ['in put.txt'], { cwd: plain }), `${WIN ? 'py -3' : 'python3'} app.py "in put.txt"`);
  assert.match(debugpyMissing(plain), /-m venv \.venv[\s\S]*-m pip install debugpy[\s\S]*Don't install it into the system's Python/);
  const dir = project('py-venv', { 'app.py': 'print(1)\n' });
  fakeVenv(dir);
  assert.deepEqual(venvOf(dir), { name: '.venv', python: VENV_PY, version: '3.11.4' });
  assert.equal(debugGateLine('app.py', [], { cwd: dir }), `${VENV_PY} app.py`);
  assert.equal(debugpyMissing(dir), `debugpy is not installed in this project's virtual environment (.venv). Install it there with: ${VENV_PY} -m pip install debugpy (a project install), then start the debugger again.`);
});

test('python: debug start without debugpy says exactly how to install it into the project', async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  const dir = project('py-nodebugpy', { 'app.py': 'print(1)\n' });
  execFileSync(WIN ? 'py' : 'python3', [...(WIN ? ['-3'] : []), '-m', 'venv', '--without-pip', '.venv'], { cwd: dir, stdio: 'pipe', timeout: 60000 });
  await assert.rejects(debugStart({ projectId: 'pack-test', cwd: dir, file: 'app.py' }), (e) => e.message.includes(`${VENV_PY} -m pip install debugpy`));
});

test('python: the compiler check uses the project\'s venv and reports only changed files, with file and line', async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  const dir = project('py-check', { 'pkg/broken.py': 'def f(:\n    pass\n', 'old.py': 'x = (\n', 'ok.py': 'print("fine")\n' });
  execFileSync(WIN ? 'py' : 'python3', [...(WIN ? ['-3'] : []), '-m', 'venv', '--without-pip', '.venv'], { cwd: dir, stdio: 'pipe', timeout: 60000 });
  const r = await languageChecks(dir, ['pkg/broken.py', 'ok.py'], { have: ['python'] });
  assert.equal(r.ran[0]?.lang, 'python');
  assert.ok(r.problems.some((p) => /broken\.py:1: SyntaxError/.test(p)), `problems: ${r.problems.join(' | ')}`);
  assert.ok(!r.problems.some((p) => /old\.py/.test(p)), 'an unchanged file is not reported');
  assert.equal((await languageChecks(dir, ['ok.py'], { have: ['python'] })).problems.length, 0);
});

test('python: with pyflakes, an undefined name is an error too', async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  if (!can('import pyflakes')) return t.skip('pyflakes is not installed (set QX_PYTHON to a Python that has it)');
  const dir = project('py-flakes', { 'app.py': 'import os\nprint(undefined_name)\n' });
  const r = spawnSync(PY, [...PYARGS, '-I', path.join(import.meta.dirname, '..', '_pycheck.py')], { cwd: dir, shell: SHELL, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /app\.py:2: undefined name 'undefined_name'/);
  assert.doesNotMatch(r.stdout, /imported but unused/, 'style warnings are left out');
});

test('python: a tkinter window is started, read and clicked with the desktop tool', { skip: !WIN && 'the desktop tool works on Windows' }, async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  if (!can('import tkinter')) return t.skip('this Python has no tkinter');
  if (!(await desktopAvailable())) return t.skip('the desktop helper could not start');
  const dir = project('py-tk', { 'app.py': TK_APP });
  const line = `${process.env.QX_PYTHON ? `"${PY}"` : WIN ? 'py -3' : 'python3'} -u app.py`;
  const job = startBackground({ projectId: 'pack-test', cwd: dir, line, shell: 'direct', label: 'tk app', logTo: path.join(dir, 'app.log') });
  try {
    assert.equal((await firstWindow(job.id)).title, 'QX Tk');
    const r = await readWindow(job.id);
    // What tkinter shows UI Automation: the title and its tk.Button, unnamed; the label and entry are invisible.
    assert.match(r.text, /Window "QX Tk"/);
    assert.doesNotMatch(r.text, /A label/);
    const ref = r.text.match(/\[(\d+)\] Button @/)?.[1];
    assert.ok(ref, `an unnamed tk button is listed:\n${r.text}`);
    assert.match(await clickControl(job.id, undefined, ref), /^clicked/);
    let title = '';
    for (let i = 0; i < 20 && title !== 'QX Tk 2'; i++) { await sleep(200); title = (await appWindows(job.id))[0]?.title; }
    assert.equal(title, 'QX Tk 2', 'the click ran the button\'s command');
    assert.match((await jobOutput(job.id)).text, /count 2/);
    assert.match(await windowShot(job.id), /^data:image\/png;base64,.{1000}/, 'a picture of the window (the fallback when controls can\'t be read)');
  } finally { await stopBackground(job.id).catch(() => {}); }
});

test('python: the debugger stops at a breakpoint and reads a variable', async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  if (!can('import debugpy')) return t.skip('debugpy is not installed (pip install debugpy into a venv, and set QX_PYTHON to its python)');
  const dir = project('pydbg', { 'app.py': APP });
  const python = process.env.QX_PYTHON ? `"${process.env.QX_PYTHON}"` : WIN ? 'py -3' : 'python3';
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'app.py', python });
  try {
    assert.match(await debugBreak(s.id, 'app.py', 4), /breakpoint at app\.py:4/);
    let st = await debugMove(s.id, 'continue', 15000);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 4);
    st = await debugMove(s.id, 'continue', 15000); // the second item: qty is a string
    assert.equal(await debugEval(s.id, 'type(qty).__name__'), "'str'");
  } finally { await debugStop(s.id).catch(() => {}); }
});

test('python: the debugger stops in a tkinter button handler after a click', { skip: !WIN && 'the desktop tool works on Windows' }, async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  if (!can('import debugpy, tkinter')) return t.skip('needs debugpy and tkinter (set QX_PYTHON to a Python that has both)');
  if (!(await desktopAvailable())) return t.skip('the desktop helper could not start');
  const dir = project('py-tkdbg', { 'app.py': TK_APP });
  const python = process.env.QX_PYTHON ? `"${process.env.QX_PYTHON}"` : WIN ? 'py -3' : 'python3';
  const s = await debugStart({ projectId: 'pack-test', cwd: dir, file: 'app.py', python });
  try {
    await debugBreak(s.id, 'app.py', 10);
    let st = await debugMove(s.id, 'continue', 2000);
    assert.equal(st.state, 'running', 'the window is up, waiting for a click');
    await firstWindow(s.job);
    const ref = (await readWindow(s.job)).text.match(/\[(\d+)\] Button @/)?.[1];
    await clickControl(s.job, undefined, ref);
    // The desktop tool asks this before touching the window: a paused app can't answer UI Automation.
    assert.deepEqual(await debugPausedIn(s.job, 10000), { id: s.id, at: 'app.py:10' });
    st = await debugState(s.id);
    assert.equal(st.state, 'paused');
    assert.equal(st.frames[0].line, 10);
    assert.equal(st.frames[0].fn, 'add');
    assert.ok(st.locals.includes('step = 2'), `locals: ${st.locals.join(', ')}`);
    assert.equal(await debugEval(s.id, 'count + step'), '2');
    st = await debugMove(s.id, 'continue', 1500);
    assert.equal(st.state, 'running', `it carries on after the stop (${st.state} at line ${st.frames?.[0]?.line}, ${st.locals?.join(', ')})`);
  } finally { await debugStop(s.id).catch(() => {}); }
});

test('python: pytest output is summed up in a few lines', () => {
  const quiet = `.FF                                                                      [100%]
================================== FAILURES ===================================
__________________________________ test_bad ___________________________________
tests\\test_a.py:8: in test_bad
    assert add(2, 2) == 5
E   assert 4 == 5
E    +  where 4 = add(2, 2)
__________________________________ test_err ___________________________________
tests\\test_a.py:11: in test_err
    raise ValueError("boom")
E   ValueError: boom
=========================== short test summary info ===========================
FAILED tests/test_a.py::test_bad - assert 4 == 5
FAILED tests/test_a.py::test_err - ValueError: boom
2 failed, 1 passed in 0.28s
`;
  assert.equal(pytestSummary(quiet), 'pytest: 2 failed, 1 passed (0.28s)\nFAILED tests/test_a.py::test_bad - assert 4 == 5\nFAILED tests/test_a.py::test_err - ValueError: boom');
  // -rN (no summary section): the sections themselves, with where each was raised.
  const noSummary = quiet.replace(/=+ short test summary info =+\n(FAILED.*\n)+/, '');
  assert.equal(pytestSummary(noSummary), 'pytest: 2 failed, 1 passed (0.28s)\nFAILED test_bad (tests\\test_a.py:8) - assert 4 == 5\nFAILED test_err (tests\\test_a.py:11) - ValueError: boom');
  // A test file that doesn't import: the error that stopped it.
  const collect = `=================================== ERRORS ====================================
______________________ ERROR collecting tests/test_b.py _______________________
ImportError while importing test module 'C:\\p\\tests\\test_b.py'.
Traceback:
tests\\test_b.py:1: in <module>
    import nosuchmodule
E   ModuleNotFoundError: No module named 'nosuchmodule'
=========================== short test summary info ===========================
ERROR tests/test_b.py
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
1 error in 0.49s
`;
  assert.equal(pytestSummary(collect), "pytest: 1 error (0.49s)\nERROR tests/test_b.py (it could not be imported) - ModuleNotFoundError: No module named 'nosuchmodule'");
  assert.equal(pytestSummary('========================= 5 passed, 1 warning in 0.10s ========================='), 'pytest: 5 passed, 1 warning (0.10s)');
  assert.equal(pytestSummary('no tests ran in 0.01s'), 'pytest: no tests ran');
  assert.equal(pytestSummary('Collecting packages...\nDone.'), '', 'not pytest output');
});

// The agent's own tools, with a scripted model (no key): debug start uses the project's venv, the desktop tool clicks
// the window's button, and says the app stopped at the breakpoint instead of waiting on its frozen window.
test('python: the agent debugs a tkinter app in the project\'s venv through its tools', { skip: !WIN && 'the desktop tool works on Windows' }, async (t) => {
  const skip = await skipUnless('python'); if (skip) return t.skip(skip);
  if (!process.env.QX_PYTHON || !can('import debugpy, tkinter')) return t.skip('set QX_PYTHON to a Python with debugpy and tkinter');
  if (!(await desktopAvailable())) return t.skip('the desktop helper could not start');
  const dir = project('py-agent', { 'app.py': TK_APP, '.quorx/permissions.json': JSON.stringify({ rules: [{ effect: 'allow', match: 'python app.py*', by: 'user' }] }) });
  // A venv without pip that borrows QX_PYTHON's packages (debugpy) through a .pth file, so nothing is downloaded.
  execFileSync(WIN ? 'py' : 'python3', [...(WIN ? ['-3'] : []), '-m', 'venv', '--without-pip', '.venv'], { cwd: dir, stdio: 'pipe', timeout: 60000 });
  const site = execFileSync(PY, ['-c', 'import debugpy, os; print(os.path.dirname(os.path.dirname(debugpy.__file__)))'], { encoding: 'utf8' }).trim();
  const venvSite = execFileSync(path.join(dir, VENV_PY), ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(venvSite, 'qx-test.pth'), `${site}\n`);
  const id = `pyagent${Date.now().toString(36)}`;
  saveProject({ id, name: 'py agent test', path: dir });
  let n = 0, sid = null, job = null, ran = '';
  const call = (name, args) => ({ text: '', toolCalls: [{ id: `p${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }], usage: { cost: 0 }, ms: 1, firstMs: 1, finishReason: 'stop' });
  const out = (body) => body.messages.filter((m) => m.role === 'tool').at(-1)?.content || '';
  const seen = [];
  const script = (body, i) => {
    if (i > 0) seen.push(out(body));
    if (i === 0) return call('debug', { action: 'start', file: 'app.py' });
    if (i === 1) { [, sid] = seen[0].match(/Debug session (d\d+)/) || []; [, job] = seen[0].match(/background job (bg\d+)/) || []; ran = getBackground(job)?.line || ''; return call('debug', { action: 'break', id: sid, file: 'app.py', line: 10 }); }
    if (i === 2) return call('debug', { action: 'continue', id: sid });
    if (i === 3) return call('desktop', { action: 'read', job });
    if (i === 4) return call('desktop', { action: 'click', job, ref: Number(seen[3].match(/\[(\d+)\] Button @/)?.[1]) });
    if (i === 5) return call('debug', { action: 'state', id: sid });
    if (i === 6) return call('debug', { action: 'eval', id: sid, expr: 'count + step' });
    if (i === 7) return call('debug', { action: 'stop', id: sid });
    return { text: 'Done.', toolCalls: [], usage: { cost: 0 }, ms: 1, firstMs: 1, finishReason: 'stop' };
  };
  try {
    await runAgent({ runId: id, projectId: id, text: 'debug my app', setup: { model: 'test/model' }, settings: { approval: 'strict', debugger: 'always', mediaEnabled: false, verify: false, review: 'off', checks: { gap: false, shots: false, click: false }, tools: { browser: { on: false } } } },
      () => {}, new AbortController().signal, { chatStream: async (body) => script(body, script.i = (script.i ?? -1) + 1), catalogue: [{ id: 'test/model', maxOut: 4000 }], quiet: true });
  } finally {
    if (sid) await debugStop(sid).catch(() => {});
    forgetProject(id);
  }
  assert.match(seen[0], /Debug session d\d+ \(python\) started[\s\S]*background job bg\d+/, seen[0]);
  assert.ok(ran.startsWith(`${VENV_PY} -m debugpy --listen 127.0.0.1:`), `it ran with the project's venv: ${ran}`);
  assert.match(seen[2], /running/);
  assert.match(seen[3], /Window \d+:[\s\S]*Window "QX Tk"[\s\S]*\[\d+\] Button @/);
  assert.match(seen[4], /clicked with the mouse\.\s*The app is paused at a breakpoint \(debug session d\d+, app\.py:10\)/, seen[4]);
  assert.match(seen[5], /Paused[\s\S]*app\.py:10[\s\S]*step = 2/);
  assert.match(seen[6], /count \+ step → 2/);
});
