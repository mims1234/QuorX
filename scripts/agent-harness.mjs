// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The scripted model the agent tests share: run() runs one reply in a throwaway project, with no network and no money.
// Test files import test-home.mjs before this, so every server module reads the throwaway data folder.
import { tempDir } from './test-home.mjs';
import { runAgent } from '../server/agent.js';
import { saveProject, forgetProject, setProjectBudget } from '../server/store.js';
import { ledger } from '../server/runs.js';

let n = 0;
export const reply = (text, calls = [], finishReason = 'stop') => ({ text, toolCalls: calls.map(([name, args], i) => ({ id: `c${++n}_${i}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })), usage: { cost: 0.0001 }, ms: 1, firstMs: 1, finishReason });
/** Runs one reply. `script(body, i)` returns the model's i-th answer (or throws). */
// `budget` sets the project's budget and `spent` seeds what it has already spent (as a ledger row).
export async function run(script, { settings = {}, text = 'build it', resume, onEvent, signal, history, budget, spent, setup = {}, openTab, generateImage, generateVideo, ensemble, checks, chatId, prep, cont, images, context, comments, enhance, reading, catalogue, videoMode, videoFrom, generation, scheduledBy, sourceStream, noOpenRouter } = {}) {
  const id = `t${Date.now().toString(36)}${(n++).toString(36)}`;
  const dir = tempDir('quorx-run-');
  saveProject({ id, name: 'test', path: dir });
  prep?.(dir);
  if (budget != null) setProjectBudget(id, budget);
  if (spent) ledger.set(`seed-${id}`, { project: id, cost: spent });
  const events = [], bodies = [];
  let i = 0;
  const chatStream = async (body, sig, onText) => { bodies.push(structuredClone(body)); const r = await script(body, i++); if (r.text && onText) onText(r.text); return r; };
  try {
    await runAgent({ runId: id, projectId: id, ...(chatId ? { chatId } : {}), ...(scheduledBy ? { scheduledBy } : {}), ...(images ? { images } : {}), ...(context ? { context } : {}), ...(comments ? { comments } : {}), text, resume, ...(cont ? { continue: cont } : {}), ...(reading ? { reading } : {}), ...(videoMode ? { videoMode } : {}), ...(videoFrom ? { videoFrom } : {}), history, setup: { model: 'test/model', ...setup }, settings: { approval: 'yolo', mediaEnabled: false, tools: { browser: { on: false } }, ...settings } },
      (e) => { events.push(e); onEvent?.(e, id); }, signal || new AbortController().signal, { chatStream, catalogue: catalogue || [{ id: 'test/model', maxOut: 4000 }], quiet: true, startServer: async ({ name, args }) => ({ key: `fake-${name}`, url: 'http://localhost:9/', status: 'running', command: ['node', ...(args || [])].join(' '), log: '' }), ...(openTab ? { openTab } : {}), ...(generateImage ? { generateImage } : {}), ...(generateVideo ? { generateVideo } : {}), ...(ensemble ? { ensemble } : {}), ...(checks ? { checks } : {}), ...(enhance ? { enhance } : {}), ...(generation ? { generation } : {}), ...(sourceStream ? { sourceStream } : {}), ...(noOpenRouter != null ? { noOpenRouter } : {}) });
    return { events, bodies, dir, id, done: events.find((e) => e.t === 'done') };
  } finally { forgetProject(id); ledger.delete(`seed-${id}`); }
}
export const toolResults = (body) => body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
export const of = (events, t) => events.filter((e) => e.t === t);
