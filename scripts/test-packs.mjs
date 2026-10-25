// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The tester kit: runs every platform pack's self-test that this computer can run, and writes a report to paste into
// a pull request or an issue. Packs whose toolchain isn't installed are listed as not tested, with what they need.
//
//   npm run test:packs                 every pack
//   npm run test:packs -- --pack dotnet  one pack (repeat --pack for more)
//
// Set QX_PYTHON to a Python with debugpy to include the Python debugger. No OpenRouter key is needed: self-tests
// drive QuorX's own checks, debugger and builds directly. The report goes to pack-test-report.md (git ignores it).
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PACKS, PACK_ERRORS } from '../server/packs/index.js';
import { detectToolchains } from '../server/toolchains.js';
import { saveTestResult } from './test-results.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.flatMap((a, i, all) => (a === '--pack' && all[i + 1] ? [all[i + 1]] : []));
const log = (...a) => console.log(...a);

// One test file in its own Node process, so a hung toolchain can't stop the rest. TAP output is read for counts.
function runFile(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--test', '--test-force-exit', '--test-reporter=tap', file], { cwd: ROOT, env: process.env, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill(), 15 * 60e3);
    p.on('close', (code) => {
      clearTimeout(timer);
      const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] || 0);
      const tests = [...out.matchAll(/^(not ok|ok) \d+ - (.+?)(?: # SKIP ?(.*))?$/gm)].map((m) => ({ ok: m[1] === 'ok', name: m[2].trim(), skip: m[3] != null ? (m[3] || 'skipped') : null }));
      const fails = [...out.matchAll(/^not ok \d+ - (.+)$[\s\S]*?error: ([^\n]+)/gm)].map((m) => ({ name: m[1].trim(), error: m[2].replace(/^['|>-]\s*/, '').trim() }));
      resolve({ code, pass: n('pass'), fail: n('fail'), skipped: n('skipped'), tests, fails, ms: Date.now() - t0, out });
    });
  });
}

const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();
const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return '?'; } })();

log('Checking which toolchains this computer has…');
const chains = await detectToolchains(true);
const byId = new Map(chains.map((t) => [t.id, t]));
const rows = [];
// QuorX's own safety layer on this system (Stop through process groups on macOS and Linux, the bash and zsh rules,
// the folders that are off limits, the desktop tool's keys): `--pack system` runs only this.
if (!only.length || only.includes('system')) {
  const label = `QuorX on ${{ darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[process.platform] || process.platform}: Stop, rules, desktop keys`;
  log(`Testing ${label}…`);
  const r = await runFile(path.join(ROOT, 'scripts', 'test-posix.mjs'));
  rows.push({ p: { id: 'system', label }, status: r.fail ? 'failed' : r.pass ? 'passed' : 'skipped', r });
}
for (const p of PACKS.filter((x) => !only.length || only.includes(x.id))) {
  const file = path.join(ROOT, 'server', 'packs', 'tests', `${p.id}.test.mjs`);
  const needs = p.test?.needs || [];
  const missing = needs.filter((id) => !byId.get(id)?.found);
  if (p.hosts && !p.hosts.includes(process.platform)) {
    // Its logic (parsers, rules, notes) is still tested here; the parts that need its system skip themselves.
    const r = fs.existsSync(file) ? (log(`Testing ${p.label} (its logic only)…`), await runFile(file)) : null;
    rows.push({ p, status: r?.fail ? 'failed' : 'not here', why: `works on ${p.hosts.join(', ')}${r ? '; only its logic was tested here' : ''}`, r });
    continue;
  }
  if (!fs.existsSync(file)) { rows.push({ p, status: 'no self-test', why: 'this pack has no self-test yet' }); continue; }
  if (missing.length) { rows.push({ p, status: 'not tested', why: `needs ${missing.map((id) => byId.get(id)?.label || id).join(', ')}` }); continue; }
  log(`Testing ${p.label}…`);
  const r = await runFile(file);
  rows.push({ p, status: r.fail ? 'failed' : r.pass ? 'passed' : 'skipped', r });
}

const icon = { passed: '✅', failed: '❌', skipped: '⚪', 'not tested': '⚪', 'no self-test': '⚪', 'not here': '⚪' };
const found = chains.filter((t) => t.found);
const md = [
  `# QuorX platform pack report`,
  '',
  `- QuorX ${version} (commit ${commit}) · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  `- ${os.type()} ${os.release()} (${process.platform}, ${process.arch}) · Node.js ${process.versions.node}`,
  `- Toolchains found: ${found.map((t) => `${t.label} ${t.version}${t.works ? '' : ' (cannot build here)'}`).join(', ') || 'none'}`,
  ...(PACK_ERRORS.length ? [`- Packs that failed to load: ${PACK_ERRORS.map((e) => `${e.file} (${e.error})`).join('; ')}`] : []),
  '',
  '| Pack | Result | Tests | Notes |',
  '|---|---|---|---|',
  ...rows.map(({ p, status, why, r }) => `| ${p.label} | ${icon[status]} ${status} | ${r ? `${r.pass} passed, ${r.fail} failed, ${r.skipped} skipped` : '–'} | ${why || (r?.tests.filter((x) => x.skip).map((x) => `${x.name}: ${x.skip}`).join('; ')) || ''} |`),
  '',
  ...rows.filter((x) => x.r?.fails.length).flatMap(({ p, r }) => [`## ${p.label}: failures`, '', ...r.fails.map((f) => `- **${f.name}**: ${f.error}`), '']),
].join('\n');

saveTestResult('packs', {
  packs: only.length ? only : null, // null: every pack was run
  toolchains: found.map((t) => ({ label: t.label, version: t.version, works: t.works !== false })),
  rows: rows.map(({ p, status, why, r }) => ({ id: p.id, label: p.label, status, pass: r?.pass ?? 0, fail: r?.fail ?? 0, skipped: r?.skipped ?? 0, why: why || null })),
});

const out = path.join(ROOT, 'pack-test-report.md');
fs.writeFileSync(out, md + '\n');
log('\n' + md);
log(`\nReport: ${out}\nPaste it into the pull request (or a "Pack test report" issue) for the packs you tested.`);
process.exit(rows.some((x) => x.status === 'failed') ? 1 : 0);
