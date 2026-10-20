// Other agent CLIs as builders, for the build benchmark only (scripts/bench-build.mjs --mode cli:<id>).
// Each one is a plain data object: the program, its arguments, how the prompt gets in, and how to read its answer.
// QuorX's approvals can't reach inside another agent, so these run only in the bench's throwaway folders, with each
// CLI's own flags limited to editing files there (no shell). More can be added in bench/clis.json, same shape.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAFE = /^[\w./:@-]+$/; // a model id or a flag: never text from a task

export const CLI_DEFS = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', version: ['--version'], stdin: true,
    // Print mode: files may be read and edited in the folder, nothing else (no Bash, no web).
    args: ({ model }) => ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,MultiEdit,Glob,Grep,LS', ...(model ? ['--model', model] : [])],
    parse: (out) => { const j = lastJson(out); return j ? { reply: String(j.result ?? ''), cost: Number(j.total_cost_usd) || 0, turns: Number(j.num_turns) || 0, error: j.is_error ? String(j.result || 'error') : null } : { reply: out.trim() }; } },
  { id: 'codex', name: 'Codex CLI', bin: 'codex', version: ['--version'], stdin: true,
    args: ({ model }) => ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...(model ? ['-m', model] : []), '-'],
    parse: (out) => ({ reply: out.trim() }) },
];
function lastJson(out) {
  for (const line of String(out).trim().split(/\r?\n/).reverse()) { try { const j = JSON.parse(line); if (j && typeof j === 'object') return j; } catch { /* not json */ } }
  return null;
}
/** The built-in definitions plus any in bench/clis.json (args there are fixed lists; "{model}" is replaced). */
export function cliDefs() {
  let extra = [];
  try { extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'clis.json'), 'utf8')); } catch { /* none */ }
  const fromFile = (Array.isArray(extra) ? extra : []).filter((d) => d && /^[\w-]+$/.test(d.id) && d.bin && Array.isArray(d.args)).map((d) => ({
    id: d.id, name: d.name || d.id, bin: d.bin, version: d.version || ['--version'], stdin: d.stdin !== false,
    args: ({ model }) => d.args.flatMap((a) => (a === '{model}' ? (model ? [model] : []) : [String(a)])), parse: (out) => ({ reply: out.trim() }) }));
  return [...CLI_DEFS.filter((d) => !fromFile.some((x) => x.id === d.id)), ...fromFile];
}

// Windows installs most CLIs as .cmd shims, which only start through the shell. Every argument is a fixed flag or a
// checked model id (the prompt goes in on stdin), so nothing a task says reaches a command line.
function resolveBin(bin) {
  if (process.platform !== 'win32' || path.isAbsolute(bin)) return { cmd: bin, shell: false };
  return { cmd: bin, shell: true };
}

/** Runs one CLI in `cwd` with the prompt on stdin; resolves with { reply, cost, turns, error, code, ms }. */
export function runCli(def, { cwd, prompt, model = '', minutes = 15, signal } = {}) {
  return new Promise((resolve) => {
    if (model && !SAFE.test(model)) return resolve({ reply: '', error: `unsafe model id ${model}`, ms: 0 });
    const args = def.args({ model });
    if (args.some((a) => !/^[\w.,:@/-]+$/.test(a))) return resolve({ reply: '', error: 'unsafe CLI arguments', ms: 0 });
    const t0 = Date.now();
    const { cmd, shell } = resolveBin(def.bin);
    let out = '', err = '', done = false;
    const p = spawn(cmd, args, { cwd, shell, windowsHide: true, env: { ...process.env, CI: '1' } });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', stop); resolve({ ...r, ms: Date.now() - t0 }); };
    const stop = () => { try { p.kill(); } catch { /* gone */ } finish({ reply: def.parse(out).reply || '', error: 'stopped', code: null }); };
    const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish({ reply: def.parse(out).reply || '', error: `stopped after ${minutes} min`, code: null }); }, minutes * 60e3);
    signal?.addEventListener?.('abort', stop, { once: true });
    p.stdout.on('data', (d) => { out = (out + d).slice(-2e6); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    p.on('error', (e) => finish({ reply: '', error: `${def.name} did not start: ${e.message}`, code: null }));
    p.on('close', (code) => { const r = def.parse(out); finish({ cost: 0, turns: 0, ...r, error: r.error || (code ? `exited with code ${code}${err.trim() ? `: ${err.trim().split(/\r?\n/).pop().slice(0, 200)}` : ''}` : null), code }); });
    if (def.stdin) { p.stdin.on('error', () => {}); p.stdin.end(String(prompt)); } else p.stdin.end();
  });
}
