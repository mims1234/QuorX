// Imported first by the test files: every test writes into a throwaway data folder, never into your real
// chats, projects, run logs and keys. (OH_HOME is read when server/openrouter.js loads, so this must come first.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.OH_HOME) {
  // Test results for News (scripts/test-results.mjs) still go to the real data folder: the app folder itself.
  process.env.QX_RESULTS_HOME ||= path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quorx-test-home-'));
  process.env.OH_HOME = home;
  process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* still in use */ } });
}
