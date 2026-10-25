// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The last result of each test suite, kept in logs/test-results.json so News can show it ("On this computer", the tests
// view). npm test (through scripts/results-reporter.mjs), npm run test:packs and npm run test:ui each replace their
// own entry. Only counts, test names, pack names and toolchain versions are kept: nothing from chats or projects.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The QuorX data folder the tests were started for. test-home.mjs points OH_HOME at a throwaway folder for the tests
// themselves, and remembers the real one in QX_RESULTS_HOME first.
const home = () => path.resolve(process.env.QX_RESULTS_HOME || process.env.OH_HOME || ROOT);
export const resultsFile = () => path.join(home(), 'logs', 'test-results.json');

export const version = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return null; } };
export const commit = () => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

/** Replaces one suite's entry ('test', 'packs' or 'ui'). Best effort: a test run never fails because of this. */
export function saveTestResult(kind, data) {
  const file = resultsFile();
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first result */ }
    all[kind] = { at: new Date().toISOString(), version: version(), commit: commit(), platform: process.platform, ...data };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* best effort */ }
}
