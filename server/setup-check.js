// ⚙ Settings → Setup check: what this computer has, what each thing is for, and one Fix per missing piece.
// Every check is read-only and quick (each command has a 5 s limit). Fixes never run by themselves: on Windows the
// page can ask to open winget in its own console window, where the user sees and answers winget's own prompts.
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { activeKey, fetchKeyInfo } from './keys.js';
import { runtime, PORT, HOME } from './openrouter.js';
import { browserPath } from './browser.js';
import { shellInfo } from './shell.js';
import { ptyAvailable } from './pty.js';
import { PDFTOTEXT } from './docs.js';
import { detectToolchains, TOOLCHAINS } from './toolchains.js';

const WIN = process.platform === 'win32';
// What a Fix may install: winget ids (and fixed extra arguments) only from this list, so the page can never ask for
// anything else.
const WINGET = { git: 'Git.Git', python: 'Python.Python.3.12', pwsh: 'Microsoft.PowerShell', node: 'OpenJS.NodeJS.LTS',
  ...Object.fromEntries(TOOLCHAINS.filter((t) => t.winget).map((t) => [`tc-${t.id}`, t.winget])) };
const WINGET_ARGS = Object.fromEntries(TOOLCHAINS.filter((t) => t.wingetArgs).map((t) => [`tc-${t.id}`, t.wingetArgs]));
const wingetLine = (id) => `winget install --id ${WINGET[id]} -e${WINGET_ARGS[id] ? ` ${WINGET_ARGS[id]}` : ''}`;

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, out, errOut) => resolve(err && !out ? null : `${out || ''}${errOut || ''}`.trim()));
});
const firstOk = async (tries, re) => { for (const [c, a] of tries) { const o = await run(c, a); if (o && re.test(o)) return o.match(re)[0]; } return null; };
const gb = (n) => `${(n / 1e9).toFixed(n < 10e9 ? 1 : 0)} GB`;

export async function setupCheck() {
  const desktop = !!process.env.OH_DESKTOP;
  const [key, git, python, pdf, chains, wsl, ax] = await Promise.all([
    (async () => {
      const k = activeKey();
      if (!k) return { status: 'missing', detail: 'No key yet.' };
      try {
        const i = await fetchKeyInfo(k);
        if (i.limit != null && i.remaining != null && i.remaining <= 0.05) return { status: 'warn', detail: 'This key has almost no limit left.' };
        return { status: 'ok', detail: i.freeTier ? 'Active key works (free tier).' : 'Active key works.' };
      } catch (e) { return { status: 'warn', detail: `OpenRouter did not accept the active key (${e.message}).` }; }
    })(),
    firstOk([['git', ['--version']]], /\d+\.\d+(\.\d+)?/),
    firstOk(WIN ? [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]] : [['python3', ['--version']], ['python', ['--version']]], /3\.\d+(\.\d+)?/),
    (async () => { for (const p of PDFTOTEXT) { const o = await run(p, ['-v']); if (o && /pdftotext/i.test(o)) return p; } return null; })(),
    detectToolchains(true).catch(() => []),
    WIN ? run('wsl.exe', ['--status']).then((o) => !!o && /Default Version|Default Distribution|\u0000/i.test(o)) : Promise.resolve(false),
    // macOS: whether the app QuorX runs in may use the Accessibility API (the desktop tool). Asking never prompts.
    process.platform === 'darwin' ? run('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"]).then((o) => (o == null ? null : /true/.test(o))) : Promise.resolve(null),
  ]);
  const sh = shellInfo(), browser = browserPath();
  let free = null; try { const s = fs.statfsSync(HOME); free = s.bavail * s.bsize; } catch { /* older Node */ }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const fix = (id) => (WIN && WINGET[id] ? { kind: 'winget', id, label: `Install with winget`, cmd: wingetLine(id) } : null);

  return { checked: Date.now(), platform: process.platform, items: [
    { id: 'key', label: 'OpenRouter key', need: 'Every reply: models, deciders and media.', ...key, fix: key.status === 'ok' ? null : { kind: 'settings', cat: 'keys', label: 'Sign in with OpenRouter' } },
    { id: 'port', label: 'Harness address', need: 'Opening the app; phones on Wi-Fi when that is on.', status: 'ok',
      detail: runtime.port === PORT ? `Running on port ${runtime.port}.` : `Port ${PORT} was busy, so it runs on ${runtime.port}. Set AGENT_PORT in .env to choose one.` },
    { id: 'git', label: 'Git', need: 'Undo history and diffs in projects; Git for Windows also brings pdftotext.', status: git ? 'ok' : 'missing', detail: git ? `Version ${git}.` : 'Not found.', fix: git ? null : fix('git') },
    { id: 'python', label: 'Python 3', need: 'The Python server template and scripts the agent writes.', status: python ? 'ok' : 'warn', detail: python ? `Version ${python}.` : 'Not found. Only needed for Python work.', fix: python ? null : fix('python') },
    { id: 'browser', label: 'Edge or Chrome', need: 'The check before a final reply opens the pages it built; the agent\'s browser tool.', status: browser ? 'ok' : 'missing', detail: browser || 'Neither was found in the usual places.', fix: browser ? null : { kind: 'link', label: 'Get Chrome', url: 'https://www.google.com/chrome/' } },
    { id: 'pdf', label: 'pdftotext', need: 'Reading PDFs for free on this computer (otherwise OpenRouter\'s paid parser).', status: pdf ? 'ok' : 'warn', detail: pdf ? 'Found.' : 'Not found. PDFs still work, at a small cost.', fix: pdf ? null : fix('git') },
    { id: 'shell', label: WIN ? 'PowerShell 7' : 'Shell', need: 'Your own terminal tabs in the pane.', status: !WIN || /7/.test(sh.name) ? 'ok' : 'warn', detail: `Terminal tabs use ${sh.name}${ptyAvailable() ? ' as a full terminal' : ' as a plain shell (node-pty is missing)'}.`, fix: WIN && !/7/.test(sh.name) ? fix('pwsh') : null },
    ...(desktop ? [] : [{ id: 'node', label: 'Node.js', need: 'Running server.js (the desktop app brings its own).', status: nodeMajor >= 20 ? 'ok' : 'missing', detail: `Version ${process.versions.node}.`, fix: nodeMajor >= 20 ? null : fix('node') }]),
    // Sandboxing: what fences the agent's commands. QuorX's own layers always apply; an OS sandbox is not built yet.
    { id: 'sandbox', label: 'Command sandbox', need: 'An operating-system fence around the agent’s commands, on top of QuorX’s own checks.', status: 'warn',
      detail: `Not in use yet. QuorX fences commands itself: the rule engine, real-path checks on deletes, ${WIN ? 'Windows jobs' : 'process groups'} (Stop ends everything), snapshots for Undo, and the tripwire. ${WIN ? `${wsl ? 'WSL 2 is installed, which a future version can use as a sandbox for Linux toolchains.' : 'WSL 2 isn’t installed.'} Windows Sandbox needs Windows Pro or Enterprise.` : ''}` },
    // Toolchains (from the platform packs): optional, each only for the languages that need it. Installed but unable
    // to build (Rust with no C linker) is amber too, with the fix for what's missing (its pack's `fixWith`). Away from
    // Windows there is no Install button: the detail names the brew or apt package instead.
    ...chains.filter((c) => !['git', 'python', 'node'].includes(c.id) && c.host !== false).map((c) => {
      const t = TOOLCHAINS.find((x) => x.id === c.id) || {};
      const how = !WIN && (process.platform === 'darwin' ? t.brew && `brew install ${t.brew}` : t.apt && `sudo apt install ${t.apt}`) || (!WIN && t.url) || '';
      return { id: `tc-${c.id}`, label: c.label, need: c.for, status: c.found && c.works ? 'ok' : 'warn',
        detail: !c.found ? `Not installed. Only needed for this kind of project.${how ? ` Install: ${how}` : ''}` : c.works ? `Version ${c.version}.` : `Version ${c.version}, but ${c.problem}.`,
        fix: !c.found ? fix(`tc-${c.id}`) : !c.works && c.fixWith ? fix(`tc-${c.fixWith}`) : null };
    }),
    ...(ax == null ? [] : [{ id: 'accessibility', label: 'Accessibility (desktop apps)', need: 'The agent reading and pressing the windows of Mac apps it started.', status: ax ? 'ok' : 'warn',
      detail: ax ? 'Allowed.' : 'Not allowed yet. In System Settings → Privacy & Security → Accessibility, turn on the app QuorX runs in (QuorX, or Terminal when you started it with npm start). Screen Recording, in the same place, lets it take pictures of those windows.' }]),
    { id: 'disk', label: 'Free space', need: 'Chats, run logs, uploads and undo copies.', status: free == null ? 'ok' : free < 2e9 ? 'warn' : 'ok', detail: free == null ? 'Not measured.' : `${gb(free)} free where QuorX keeps its data.` },
  ] };
}

// Opens winget in a console window the user can see (Windows only, allow-listed ids only).
export function runFix(id) {
  if (!WIN) throw new Error('Installing from here works on Windows only. Use your package manager.');
  const pkg = WINGET[id];
  if (!pkg) throw new Error('unknown fix');
  spawn('cmd.exe', ['/c', 'start', `"Install ${pkg}"`, 'cmd.exe', '/k', `${wingetLine(id)} --source winget`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).on('error', () => {}).unref();
  return { ok: true, pkg };
}
