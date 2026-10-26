// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Go: command-line programs and services. Debugging goes through Delve (dlv dap), over the Debug Adapter Protocol:
// Delve builds the package with debug info, starts it paused and stops on breakpoints and unrecovered panics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WIN, run } from './_lib.js';

const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
export const DLV_INSTALL = 'go install github.com/go-delve/delve/cmd/dlv@latest';

// Delve is a Go program: go install puts it in GOBIN or GOPATH/bin (%USERPROFILE%\go\bin by default), which is often
// not on PATH. QX_DLV overrides (tests).
export async function findDlv(env = process.env) {
  const name = WIN ? 'dlv.exe' : 'dlv';
  const dirs = [...String(env.PATH || '').split(path.delimiter), env.GOBIN, ...String(env.GOPATH || '').split(path.delimiter).map((p) => p && path.join(p, 'bin')), path.join(os.homedir(), 'go', 'bin')];
  const hit = [env.QX_DLV, ...dirs.filter(Boolean).map((d) => path.join(d, name))].find((f) => f && fs.existsSync(f));
  if (hit) return hit;
  const o = await run('go', ['env', 'GOBIN', 'GOPATH']); // a GOPATH set with go env -w
  const more = String(o || '').split(/\r?\n/).filter(Boolean).flatMap((l, i) => (i === 0 ? [l] : l.split(path.delimiter).map((p) => path.join(p, 'bin'))));
  return more.map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) || null;
}

/**
 * Delve's launch request for a .go file: its package runs (mode debug), a _test.go file runs its package's tests
 * (mode test, args like -test.run TestName), and a `program` that is a built binary runs as it is (mode exec).
 */
export function goLaunch({ file, args = [], cwd, program }) {
  const abs = path.resolve(cwd, file);
  if (program) {
    const p = path.resolve(cwd, program);
    const isDir = (() => { try { return fs.statSync(p).isDirectory(); } catch { return !path.extname(p); } })();
    return { mode: isDir ? 'debug' : 'exec', program: p, args, cwd };
  }
  const pkg = path.dirname(abs);
  return /_test\.go$/i.test(abs) ? { mode: 'test', program: pkg, args, cwd: pkg } : { mode: 'debug', program: pkg, args, cwd };
}

/** The go command the debug session amounts to, for the rules and the approval card. */
export function goGate({ file, args = [], cwd = '.', program }) {
  const l = goLaunch({ file, args, cwd, program });
  if (l.mode === 'exec') return [quote(program), ...args.map(quote)].join(' ');
  const rel = path.relative(cwd, l.program).split(path.sep).join('/');
  const pkg = !rel ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? quote(l.program) : `./${rel}`;
  return [l.mode === 'test' ? 'go test' : 'go run', pkg, ...args.map(quote)].join(' ');
}

export default {
  id: 'go',
  label: 'Go',
  summary: 'Command-line programs and services',
  toolchains: [
    { id: 'go', label: 'Go', for: 'Go programs and services', probe: ['go', ['version']], re: /go(\d+\.\d+(\.\d+)?)/, winget: 'GoLang.Go', brew: 'go', apt: 'golang-go' },
    { id: 'dlv', label: 'Delve (Go debugger)', for: 'debugging Go programs', url: 'https://github.com/go-delve/delve', install: DLV_INSTALL,
      detect: async () => { const d = await findDlv(); return d ? (/Version: (\d+\.\d+\.\d+)/.exec(await run(d, ['version']) || '')?.[1] || 'found') : null; } },
  ],
  markers: [/^go\.mod$/],
  checks: [{ id: 'go', tool: 'go', ext: /\.go$/i, marker: (d) => fs.existsSync(path.join(d, 'go.mod')), cmd: 'go vet ./...' }],
  debug: {
    exts: ['.go'], tool: 'dlv', label: 'Go (Delve)',
    gate: goGate,
    start: async ({ file, args = [], cwd, port, program }) => {
      const dlv = await findDlv();
      if (!dlv) throw new Error(`Delve is not installed. It installs with ${DLV_INSTALL}, which puts dlv in the user's Go bin folder for every project, so ask the user before running it.`);
      return {
        line: `${quote(dlv)} dap --listen=127.0.0.1:${port}`,
        adapterID: 'go', request: 'launch', args: goLaunch({ file, args, cwd, program }),
        initWait: 180000, // Delve compiles the package before it says it is ready
        missing: 'Delve did not open its port',
      };
    },
  },
  notes: (have) => `build with go build ./..., test with go test ./... (one test: go test -run TestName ./pkg, with -v for its output); run with go run . A failing test prints its file:line and what it got against what it wanted. A panic prints "panic:" and each goroutine's stack: the first frame in the project's own package is the place to look (a nil map write or a nil pointer is the usual cause); GOTRACEBACK=all shows every goroutine. The debug tool runs a .go file's package under Delve (a _test.go file runs its tests) and stops on a panic by itself.${have.has('dlv') ? '' : ` Delve is not installed: ${DLV_INSTALL} puts it in the user's Go bin folder for every project, so ask the user first.`}`,
  test: { needs: ['go'] },
};
