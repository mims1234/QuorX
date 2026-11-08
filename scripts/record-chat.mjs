// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Records one reply with a real model into scripts/fixtures/replay/<name>.json, for scripts/test-replay.mjs.
// It runs in a throwaway data folder and a throwaway project, with the same settings the replay test uses, and needs
// OPENROUTER_API_KEY in the environment. Every model call costs real money (cheap models cost a fraction of a cent).
//
//   node scripts/record-chat.mjs --name hello-py --model deepseek/deepseek-v4.1-flash --text "Make hello.py ..." [--file notes.txt=hi]
import { tempDir } from './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './agent-harness.mjs';
import { chatStream } from '../server/openrouter.js';
import { recorder, scrub, outcomeOf, RECORDING_VERSION } from '../server/replay.js';
import { REPLAY_SETTINGS } from './replay-settings.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const name = opt('name'), model = opt('model'), text = opt('text');
if (!name || !model || !text) { console.error('Usage: record-chat.mjs --name <name> --model <openrouter id> --text <message> [--file path=content]...'); process.exit(2); }
if (!process.env.OPENROUTER_API_KEY) { console.error('Set OPENROUTER_API_KEY first.'); process.exit(2); }
const files = {};
args.forEach((a, i) => { if (a === '--file') { const [p, ...rest] = String(args[i + 1]).split('='); files[p] = rest.join('='); } });

const calls = [];
let dir = null;
const stream = recorder(chatStream, { model, onCall: (c) => calls.push(c) });
const r = await run((body, i) => stream(body), {
  text, settings: REPLAY_SETTINGS,
  prep: (d) => { dir = d; for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); } },
});
const folders = { project: dir, temp: os.tmpdir(), home: os.homedir() };
const recording = scrub({ version: RECORDING_VERSION, name, model, recorded: new Date().toISOString().slice(0, 10), text, files, calls, outcome: outcomeOf(r.events) }, folders);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay', `${name}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(recording, null, 1) + '\n');
const cost = calls.reduce((n, c) => n + c.answer.usage.cost, 0);
console.log(`Saved ${path.relative(process.cwd(), out)}: ${calls.length} model calls, tools ${recording.outcome.tools.join(', ') || 'none'}, stop ${recording.outcome.stop}, cost $${cost.toFixed(5)}`);
void tempDir;
process.exit(0); // open network connections would otherwise keep it waiting for minutes
