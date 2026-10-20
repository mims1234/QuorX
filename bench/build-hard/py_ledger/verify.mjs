// Hidden checks for py_ledger: runs the builder's ledger.py on fixtures it never saw.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const num = (s) => Number(String(s).replace(/[^0-9.\-]/g, ''));
// "label: 12.50", "label  12.50" or "label 12.50": the label and the last number on the line.
const pairs = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  .map((l) => { const m = l.match(/^(.+?)[:\s]+(-?[\d,]*\.?\d+)\s*$/); return m ? [m[1].trim().toLowerCase(), num(m[2])] : null; }).filter(Boolean);
const near = (a, b) => Math.abs(a - b) < 0.006;

export default async function verify({ dir, python }) {
  const out = [];
  const run = (...args) => spawnSync(python[0], [...python.slice(1), 'ledger.py', ...args], { cwd: dir, encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' } });
  const check = (name, fn) => { try { const note = fn(); out.push({ name, ok: note === true, note: note === true ? '' : String(note) }); } catch (e) { out.push({ name, ok: false, note: e.message }); } };
  const fx = (f) => path.join(FIX, f);
  const summary = (f, want) => {
    const r = run('summary', fx(f));
    if (r.status !== 0) return `exit ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}`;
    const got = Object.fromEntries(pairs(r.stdout));
    const bad = Object.entries(want).filter(([k, v]) => !(k in got) || !near(got[k], v));
    return !bad.length || `got ${r.stdout.trim().replace(/\s*\n\s*/g, ' · ')}`;
  };

  if (!fs.existsSync(path.join(dir, 'ledger.py'))) return [{ name: 'ledger.py exists', ok: false, note: 'no ledger.py' }];
  check('summary on a clean file', () => summary('clean.csv', { income: 3250, spending: 1086.4, net: 2163.6 }));
  check('a BOM and quoted fields with commas', () => summary('bom-quoted.csv', { income: 1000, spending: 245.5, net: 754.5 }));
  check('bad rows are skipped with a warning', () => {
    const r = run('summary', fx('messy.csv'));
    const s = summary('messy.csv', { income: 500, spending: 60, net: 440 });
    return s === true ? (/\S/.test(r.stderr) || 'no warning on stderr') : s;
  });
  check('check lists the bad rows and exits 1', () => {
    const r = run('check', fx('messy.csv'));
    const lines = [...`${r.stdout}\n${r.stderr}`.matchAll(/line\s+(\d+)/gi)].map((m) => Number(m[1]));
    const want = [3, 5, 6, 7];
    return (r.status === 1 && want.every((n) => lines.includes(n)) && !lines.some((n) => !want.includes(n))) || `exit ${r.status}, lines ${[...new Set(lines)].join(',') || 'none'} (expected 3,5,6,7)`;
  });
  check('check exits 0 on a clean file', () => { const r = run('check', fx('clean.csv')); return r.status === 0 || `exit ${r.status}`; });
  check('months in order with their net', () => {
    const r = run('months', fx('clean.csv'));
    const got = pairs(r.stdout);
    const want = [['2026-08', 1460], ['2026-09', 1153.6], ['2026-10', -450]];
    return (r.status === 0 && got.length === 3 && want.every(([m, v], i) => got[i][0].startsWith(m) && near(got[i][1], v))) || `got ${r.stdout.trim().replace(/\s*\n\s*/g, ' · ')}`;
  });
  check('top --n 2 by spending', () => {
    const r = run('top', fx('clean.csv'), '--n', '2');
    const got = pairs(r.stdout);
    return (r.status === 0 && got.length === 2 && got[0][0] === 'rent' && near(Math.abs(got[0][1]), 900) && got[1][0] === 'food' && near(Math.abs(got[1][1]), 136.4)) || `got ${r.stdout.trim().replace(/\s*\n\s*/g, ' · ')}`;
  });
  check('a missing file: one-line error, exit 2', () => {
    const r = run('summary', fx('no-such-file.csv'));
    return (r.status === 2 && /\S/.test(r.stderr) && !/Traceback/.test(r.stderr)) || `exit ${r.status}${/Traceback/.test(r.stderr) ? ' with a traceback' : ''}`;
  });
  check('an unknown command exits 2', () => { const r = run('frobnicate', fx('clean.csv')); return r.status === 2 || `exit ${r.status}`; });
  check('--help works', () => { const r = run('--help'); return (r.status === 0 && /summary/.test(r.stdout)) || `exit ${r.status}`; });
  check("the builder's own tests pass", () => {
    if (!fs.existsSync(path.join(dir, 'test_ledger.py'))) return 'no test_ledger.py';
    const r = spawnSync(python[0], [...python.slice(1), '-m', 'unittest', 'test_ledger'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    return r.status === 0 || `exit ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}`;
  });
  return out;
}
