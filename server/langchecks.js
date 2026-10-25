// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Compiler checks before the final reply, for languages a file-by-file syntax check can't cover. The checks come from
// the platform packs (server/packs/): Rust (cargo check), C# (dotnet build), Go (go vet), TypeScript (tsc --noEmit)
// and whatever packs add. Each runs once per project folder the reply changed, only when that toolchain is installed,
// and only errors that point at a file this reply changed are reported, so old problems elsewhere don't send a build
// back. Each check runs in its own job with a time limit (a pack can set a longer one: Unity).
import fs from 'node:fs';
import path from 'node:path';
import { runLine } from './workspace.js';
import { allChecks } from './packs/index.js';

// The nearest folder at or above `rel`'s folder (inside root) that has the language's project file.
function projectDirOf(root, rel, lang) {
  let d = path.dirname(path.join(root, rel));
  for (let i = 0; i < 12; i++) {
    if (lang.marker(d)) return d;
    if (path.resolve(d) === path.resolve(root)) return null;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/**
 * changed: project-relative paths this reply changed. have: ids of installed toolchains.
 * Returns { problems: ['file:line: message'], ran: [{ lang, dir, code, ms }] }.
 */
export async function languageChecks(root, changed, { have = [], signal, timeout = 150e3 } = {}) {
  const problems = [], ran = [];
  for (const lang of allChecks()) {
    if (!have.includes(lang.tool)) continue;
    const files = changed.filter((f) => lang.ext.test(f) && fs.existsSync(path.join(root, f)));
    if (!files.length) continue;
    const dirs = [...new Set(files.map((f) => projectDirOf(root, f, lang)).filter(Boolean))].slice(0, 3);
    for (const dir of dirs) {
      if (signal?.aborted) return { problems, ran };
      // cmd is one line, or a function of the folder (and its changed files) that gives one or more lines, or none: the
      // check can't run there (CMake's build folder, the engine version a project needs).
      const here = files.map((f) => path.resolve(root, f)).filter((f) => f.startsWith(path.resolve(dir) + path.sep)).map((f) => path.relative(dir, f));
      const cmds = [].concat(typeof lang.cmd === 'function' ? (await lang.cmd(dir, { files: here })) || [] : lang.cmd);
      if (!cmds.length) continue;
      const limit = lang.timeout || timeout;
      const r = { code: 0, out: '', ms: 0, timedOut: false };
      for (const line of cmds) {
        const one = await runLine(dir, line, { shell: 'direct', timeout: limit, signal, env: undefined });
        Object.assign(r, { code: r.code || one.code, out: `${r.out}${one.out}\n`, ms: r.ms + one.ms, timedOut: one.timedOut });
        if (one.timedOut || signal?.aborted) break;
      }
      ran.push({ lang: lang.id, dir: path.relative(root, dir) || '.', code: r.code, ms: r.ms, timedOut: r.timedOut });
      if (r.timedOut) { problems.push(`${lang.id} check in ${path.relative(root, dir) || '.'} did not finish in ${Math.round(limit / 1000)}s${lang.timeoutHint ? `: ${lang.timeoutHint}` : ''}`); continue; }
      // parse(out, { dir, files }): a pack's own reader, for tools whose errors span lines or that exit 0 after an error (Godot).
      if (r.code === 0 && !lang.parse) continue;
      const mine = new Set(files.map((f) => path.basename(f).toLowerCase()));
      const errorLine = lang.errors || /\berror\b|: error|error\[|\bE\d{4}\b|\.go:\d+:\d+:/i;
      const lines = lang.parse ? lang.parse(r.out, { dir, files: here }) : r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => errorLine.test(l));
      const hits = lines.filter((l) => [...mine].some((b) => l.toLowerCase().includes(b)));
      // A pack may rewrite its error lines (shorter paths, one line per error) before the agent reads them.
      for (const l of [...new Set(hits.map((h) => (lang.tidy ? lang.tidy(h, dir) : h)))].slice(0, 8)) problems.push(`${lang.id}: ${l.slice(0, 300)}`);
    }
  }
  return { problems, ran };
}
