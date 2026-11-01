// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// What the safety tests share: the window-test switch, small WinForms windows, and agentRun(), a reply run with a
// scripted model in a project of its own (its background jobs and terminals end with it).
// Test files import test-home.mjs before this, so every server module reads the throwaway data folder.
import { tempDir } from './test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { runAgent } from '../server/agent.js';
import { listBackground, stopBackground } from '../server/bgjobs.js';
import { listTerms, termStop } from '../server/agentterm.js';
import { saveProject, forgetProject } from '../server/store.js';

export const WIN = process.platform === 'win32';
// Tests that open windows or send keystrokes take the screen and keyboard for minutes: they run on CI, and on a PC
// only when asked (npm run test:desktop sets QX_DESKTOP_TESTS=1).
export const UI_SKIP = !WIN ? true : process.env.CI || process.env.QX_DESKTOP_TESTS === '1' ? false : 'opens windows: npm run test:desktop';
// A small WinForms window with a title, and checks on it by title.
export const FORM = (title) => `Add-Type -AssemblyName System.Windows.Forms\n$f = New-Object Windows.Forms.Form; $f.Text = '${title}'\n[void]$f.ShowDialog()\n`;
export const formOpen = (title) => /powershell/i.test(execSync(`tasklist /FI "WINDOWTITLE eq ${title}" /NH`).toString());
export const closeForm = (title) => { try { execSync(`taskkill /FI "WINDOWTITLE eq ${title}" /F`, { stdio: 'ignore' }); } catch { /* gone */ } };
export const tmp = (name) => tempDir(`qx-${name}-`);
// Pings still running with this -n count. Test files run at the same time and start pings of their own, so each test
// counts only its own count (test-safety 600, test-computer 30, test-guards 8). WMI costs a PowerShell start and
// ~300 ms a count, so one PowerShell stays up for the file and reads the command lines from ntdll (a few ms).
const PINGS = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class QxLine {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, IntPtr b, int n, out int r);
  public static string Of(System.Diagnostics.Process p) { IntPtr b = Marshal.AllocHGlobal(65536); int r;
    try { return NtQueryInformationProcess(p.Handle, 60, b, 65536, out r) != 0 ? "" : Marshal.PtrToStringUni(Marshal.ReadIntPtr(b, IntPtr.Size), (ushort)Marshal.ReadInt16(b) / 2); }
    catch { return ""; } finally { Marshal.FreeHGlobal(b); } } }'
while ($null -ne ($n = [Console]::In.ReadLine())) { [Console]::Out.WriteLine(@([Diagnostics.Process]::GetProcessesByName('PING') | Where-Object { [QxLine]::Of($_) -match " -n $n " }).Count); [Console]::Out.Flush() }`;
let ps;
export const pingsLeft = (n) => (!WIN ? 0 : new Promise((done) => {
  if (!ps) {
    ps = spawn('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(PINGS, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'] });
    ps.unref(); ps.stdin.unref(); ps.waiting = []; let out = '';
    ps.stdout.on('data', (d) => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { ps.waiting.shift()(Number(out.slice(0, i)) || 0); out = out.slice(i + 1); } if (!ps.waiting.length) ps.stdout.unref(); });
    ps.on('close', () => { for (const w of ps.waiting.splice(0)) w(NaN); ps = null; }); // never a quiet 0
  }
  const t = setTimeout(() => ps?.kill(), 15000); // a counter that never answers (Add-Type failed) fails, not hangs
  ps.waiting.push((v) => { clearTimeout(t); done(v); }); ps.stdout.ref(); ps.stdin.write(`${n}\n`);
}));
// ---------- the shell tool, end to end (scripted model, no network) ----------
let rn = 0;
export const reply = (text, calls = []) => ({ text, toolCalls: calls.map(([name, args], i) => ({ id: `s${++rn}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })), usage: { cost: 0 }, ms: 1, firstMs: 1, finishReason: 'stop' });
export async function agentRun(script, { settings = {}, prep, onEvent, chatId, more = {}, ensemble } = {}) {
  const id = `sh${Date.now().toString(36)}${(rn++).toString(36)}`;
  // Each project gets its own parent folder, so the tripwire watches that and not the busy shared Temp folder.
  const dir = path.join(tmp('agent'), 'p'); fs.mkdirSync(dir);
  saveProject({ id, name: 'test', path: dir });
  prep?.(dir);
  const events = [], bodies = [];
  let i = 0;
  const chatStream = async (body) => { bodies.push(structuredClone(body)); return script(body, i++); };
  try {
    await runAgent({ runId: id, projectId: id, ...(chatId ? { chatId } : {}), ...more, text: more.text ?? 'build my app', setup: { model: 'test/model' }, settings: { approval: 'strict', mediaEnabled: false, verify: false, review: 'off', checks: { gap: false, shots: false, click: false }, tools: { browser: { on: false } }, ...settings } },
      (e) => { events.push(e); onEvent?.(e, id); }, new AbortController().signal, { chatStream, catalogue: [{ id: 'test/model', maxOut: 4000 }], quiet: true, ...(ensemble ? { ensemble } : {}) });
    return { events, bodies, dir, id };
  } finally {
    // Background jobs a test started (an app it opened) end with the test, so a failed test can't hang the run.
    for (const j of listBackground(id)) if (j.status === 'running') await stopBackground(j.id).catch(() => {});
    for (const s of listTerms(id)) if (s.running) await termStop(s.id).catch(() => {});
    forgetProject(id);
  }
}
export const of = (events, t) => events.filter((e) => e.t === t);
export const toolOut = (bodies, k) => bodies[k].messages.filter((m) => m.role === 'tool').map((m) => m.content).at(-1);
