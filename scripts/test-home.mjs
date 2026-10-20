// Imported first by the test files: every test writes into a throwaway data folder, never into your real
// chats, projects, run logs and keys. (OH_HOME is read when server/openrouter.js loads, so this must come first.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach } from 'node:test';

// Removes a folder, waiting a little for a process that still holds a file in it (Windows locks open files).
const remove = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return true; } catch { return false; } };

// Temp folders the tests make: each one goes when the test that made it ends, pass or fail; ones made outside a
// test (shared by several) and ones still locked then go when the test file ends.
const made = new Set();
let current = null;
/** A fresh folder in the temp folder, named `<prefix>XXXXXX`, removed after the test. */
export const tempDir = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.add(dir); current?.add(dir); return dir; };
beforeEach(() => { current = new Set(); });
afterEach(() => { for (const dir of current || []) if (remove(dir)) made.delete(dir); current = null; });

if (!process.env.OH_HOME) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quorx-test-home-'));
  process.env.OH_HOME = home;
  made.add(home);
}
process.on('exit', () => { for (const dir of made) remove(dir); });
