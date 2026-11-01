// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The harness upgrades: the edit guard, background-job notices, other agents' notes, tools loaded when needed, the
// new hook events, the status nudge, helper roles, typed memory and the wrap-up. The agent loop runs with a scripted
// model (agent-harness.mjs): no network, no money.
import './test-home.mjs';
import { reply, run, toolResults, of } from './agent-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { answerApproval } from '../server/agent.js';
import { saveHooks, matchHooks, toolMatches, hookLine, cleanHook, HOOK_EVENTS } from '../server/hooks.js';
import { cleanRole, rolesFrom, HELPER_ROLES } from '../server/helperroles.js';
import { readOtherNotes, cleanNoteFiles } from '../server/othernotes.js';
import { splitTools, loadToolsDef } from '../server/lazytools.js';
import { saveMemory, addMemory, checkMemory, memoryPrompt, loadMemory, worstPromptTokens, itemsFor, MEMORY_TOKENS } from '../server/memory.js';

// Strict, with every card approved, like the hook tests.
const strictRun = (script, opts = {}) => run(script, { ...opts, settings: { approval: 'strict', ...opts.settings }, onEvent: (e, id) => { if (e.t === 'approval' && e.mode === 'strict') setTimeout(() => answerApproval(id, e.id, { approve: true }), 5); } });
const names = (body) => (body.tools || []).map((t) => t.function.name);
const firstUser = (body) => { const m = body.messages.find((x) => x.role === 'user'); return typeof m.content === 'string' ? m.content : m.content.map((x) => x.text || '').join('\n'); };

test('the edit guard: a file changed by someone else since the agent read it must be read again; its own commands do not count', async () => {
  let dir = '';
  const script = (body, i) => {
    // Between the agent's read and its edit, the user changes the file (a later time, so the stamp surely differs).
    if (i === 1) { const f = path.join(dir, 'notes.txt'); fs.writeFileSync(f, 'one\ntwo\nby the user\n'); const t = Date.now() / 1000 + 5; fs.utimesSync(f, t, t); }
    return [
      reply('', [['read_file', { path: 'notes.txt' }]]),
      reply('', [['edit_file', { path: 'notes.txt', find: 'one', replace: 'ONE' }]]),
      reply('', [['read_file', { path: 'notes.txt' }]]),
      reply('', [['edit_file', { path: 'notes.txt', find: 'one', replace: 'ONE' }]]),
      reply('', [['shell', { command: 'node touch.mjs' }]]),
      reply('', [['edit_file', { path: 'notes.txt', find: 'two', replace: 'TWO' }]]),
      reply('Done.'),
    ][i];
  };
  const r = await strictRun(script, { prep: (d) => {
    dir = d;
    fs.writeFileSync(path.join(d, 'notes.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(d, 'touch.mjs'), "import fs from 'node:fs';\nfs.appendFileSync('notes.txt', 'three\\n');\n");
  } });
  assert.match(toolResults(r.bodies[2])[1], /^Not changed: notes\.txt changed on disk since you last read or wrote it/);
  assert.match(toolResults(r.bodies[4])[3], /^Edited notes\.txt/, 'after reading it again, the edit goes ahead');
  assert.match(toolResults(r.bodies[6])[5], /^Edited notes\.txt/, 'what its own command changed is not someone else\'s change');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'ONE\nTWO\nby the user\nthree\n');
  assert.equal(of(r.events, 'guard').length, 1);
  const off = await strictRun((body, i) => { if (i === 1) { const f = path.join(dir, 'notes.txt'); fs.writeFileSync(f, 'one\n'); const t = Date.now() / 1000 + 9; fs.utimesSync(f, t, t); } return [reply('', [['read_file', { path: 'notes.txt' }]]), reply('', [['edit_file', { path: 'notes.txt', find: 'one', replace: 'ONE' }]]), reply('Done.')][i]; },
    { settings: { guardEdits: false }, prep: (d) => { dir = d; fs.writeFileSync(path.join(d, 'notes.txt'), 'one\n'); } });
  assert.match(toolResults(off.bodies[2])[1], /^Edited/, 'off: no guard');
});

test('helper roles: cleaned, built-ins filled in, read always included', () => {
  assert.deepEqual(rolesFrom().map((r) => r.id), ['explore', 'test', 'draft']);
  const r = cleanRole({ id: 'review', name: 'Review', can: ['commands', 'nope'], steps: 999, context: 'weird', model: 'bad id' });
  assert.deepEqual(r.can, ['read', 'commands']);
  assert.equal(r.steps, 60);
  assert.equal(r.context, 'fresh');
  assert.equal(r.model, '');
  assert.equal(r.builtin, false);
  assert.equal(cleanRole({ id: 'test' }).builtin, true);
  assert.deepEqual(rolesFrom([{ id: 'a' }, { id: 'a' }]).map((x) => x.id), ['a'], 'one role per id');
  assert.equal(HELPER_ROLES.length, 3);
});

test('other agents\' notes: only plain names in the project, all of them under the size limit', () => {
  assert.deepEqual(cleanNoteFiles('AGENTS.md, ../x.md, /etc/passwd, AGENT.md, agents.md, .github/copilot-instructions.md'), ['AGENTS.md', '.github/copilot-instructions.md']);
  const d = fs.mkdtempSync(path.join(process.env.QX_TMP || path.resolve('.'), '.qx-notes-'));
  try {
    fs.writeFileSync(path.join(d, 'AGENTS.md'), 'Use pnpm.\n');
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'x'.repeat(5000));
    const n = readOtherNotes(d, ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'], 2);
    assert.deepEqual(n.map((x) => x.file), ['AGENTS.md', 'CLAUDE.md']);
    assert.equal(n[1].cut, true);
    assert.ok(n.reduce((s, x) => s + Buffer.byteLength(x.text.replace(/\n… \(cut at the size limit\)$/, '')), 0) <= 2048);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('other agents\' notes reach the system prompt, and not when switched off', async () => {
  const prep = (d) => fs.writeFileSync(path.join(d, 'AGENTS.md'), 'Always run the linter before you finish.\n');
  const on = await run(() => reply('Done.'), { prep });
  assert.match(on.bodies[0].messages[0].content, /--- AGENTS\.md ---\nAlways run the linter/);
  assert.deepEqual(of(on.events, 'notes_read')[0].files.map((f) => f.file), ['AGENTS.md']);
  const off = await run(() => reply('Done.'), { prep, settings: { otherNotes: false } });
  assert.doesNotMatch(off.bodies[0].messages[0].content, /AGENTS\.md ---/);
});

test('tools loaded when needed: rare tools wait in load_tools, load on request or on a direct call, and Off sends them all', async () => {
  const tools = [{ function: { name: 'read_file', description: 'Read.' } }, { function: { name: 'android', description: 'Test an Android app. More words.' } }, { function: { name: 'mcp__a__x', description: 'X.' } }];
  const s = splitTools(tools, { isMcp: (n) => n.startsWith('mcp__') });
  assert.deepEqual(s.active.map((t) => t.function.name), ['read_file', 'mcp__a__x'], 'a few MCP tools stay');
  assert.deepEqual([...s.deferred.keys()], ['android']);
  assert.match(loadToolsDef(s.deferred).function.description, /- android: Test an Android app\./);
  assert.equal(splitTools(tools, { mode: 'off' }).deferred.size, 0);

  const r = await run((body, i) => [
    reply('', [['load_tools', { names: ['launch_config'] }]]),
    reply('', [['save_skill', { name: 'x', description: 'y', body: 'z' }]]),
    reply('Done.'),
  ][i]);
  assert.ok(!names(r.bodies[0]).includes('launch_config') && names(r.bodies[0]).includes('load_tools'));
  assert.match(toolResults(r.bodies[1])[0], /^Loaded: launch_config/);
  assert.ok(names(r.bodies[1]).includes('launch_config'), 'loaded tools join the reply');
  assert.ok(names(r.bodies[2]).includes('save_skill'), 'calling a waiting tool by name loads it');
  assert.deepEqual(of(r.events, 'tools_loaded').map((e) => e.names), [['launch_config'], ['save_skill']]);
  const off = await run(() => reply('Done.'), { settings: { lazyTools: 'off' } });
  assert.ok(names(off.bodies[0]).includes('launch_config') && !names(off.bodies[0]).includes('load_tools'));
});

test('hook events: tool patterns, {tool}, and the new events are kept', () => {
  assert.ok(toolMatches('', 'browser'));
  assert.ok(toolMatches('browser, mcp__gh__*', 'mcp__gh__issue'));
  assert.ok(!toolMatches('browser', 'fetch_url'));
  assert.equal(hookLine({ command: 'node log.mjs {tool}' }, { tool: 'fetch_url' }), 'node log.mjs fetch_url');
  assert.equal(hookLine({ command: 'node log.mjs {tool}' }, { tool: 'a;b' }), 'node log.mjs ');
  for (const e of HOOK_EVENTS) assert.equal(cleanHook({ event: e, command: 'x' }).event, e);
  const hooks = [cleanHook({ event: 'before_write', command: 'a', match: 'migrations/**' }), cleanHook({ event: 'reply_end', command: 'b' }), cleanHook({ event: 'before_tool', command: 'c', match: 'fetch_url' })];
  assert.equal(matchHooks(hooks, 'before_write', { file: 'migrations/001.sql' }).length, 1);
  assert.equal(matchHooks(hooks, 'before_write', { file: 'src/a.js' }).length, 0);
  assert.equal(matchHooks(hooks, 'reply_end').length, 1);
  assert.equal(matchHooks(hooks, 'before_tool', { tool: 'browser' }).length, 0);
});

const hookFiles = (hooks) => (d) => {
  fs.writeFileSync(path.join(d, 'deny.mjs'), "console.log('migrations are frozen'); process.exit(2);\n");
  fs.writeFileSync(path.join(d, 'status.mjs'), "console.log('On branch main, 2 files changed');\n");
  // Fails until done.txt exists: a test suite that is red until the agent fixes it.
  fs.writeFileSync(path.join(d, 'check.mjs'), "import fs from 'node:fs';\nif (!fs.existsSync('done.txt')) { console.log('1 test failing: done.txt missing'); process.exit(1); }\nconsole.log('all green');\n");
  saveHooks(d, hooks);
};

test('a before-write hook stops a write; a before-tool hook stops a tool call', async () => {
  const { bodies, dir, events } = await strictRun((body, i) => [
    reply('', [['write_file', { path: 'migrations/001.sql', content: 'drop table x;' }]]),
    reply('', [['list_files', {}]]),
    reply('Done.'),
  ][i], { prep: hookFiles([{ event: 'before_write', command: 'node deny.mjs', match: 'migrations/**' }, { event: 'before_tool', command: 'node deny.mjs', match: 'list_files' }]) });
  assert.match(toolResults(bodies[1])[0], /^Your change to migrations\/001\.sql was not made: the user's hook "node deny\.mjs" runs before file writes and failed/);
  assert.ok(!fs.existsSync(path.join(dir, 'migrations', '001.sql')));
  assert.match(toolResults(bodies[2])[1], /^Your list_files call did not run: the user's hook "node deny\.mjs" runs before tool calls/);
  assert.ok(of(events, 'hook').every((h) => h.blocked));
});

test('a reply-start hook\'s output reaches the agent; a failing reply-end hook sends the reply back until it passes', async () => {
  const { bodies, events, done } = await strictRun((body, i) => [
    reply('', [['write_file', { path: 'a.txt', content: 'x' }]]),
    reply('All done.'),
    reply('', [['write_file', { path: 'done.txt', content: 'ok' }]]),
    reply('Fixed: the test passes now.'),
  ][i], { prep: hookFiles([{ event: 'reply_start', command: 'node status.mjs' }, { event: 'reply_end', command: 'node check.mjs' }]) });
  assert.match(firstUser(bodies[0]), /Output of the user's reply-start hook "node status\.mjs".*\nOn branch main/);
  assert.match(bodies[2].messages.at(-1).content, /hook "node check\.mjs" runs when you finish and failed \(exit code 1\)\. Its output:\n1 test failing/);
  assert.equal(bodies.length, 4);
  assert.deepEqual(of(events, 'hook').filter((h) => h.event === 'reply_end').map((h) => h.ok), [false, true]);
  assert.ok(of(events, 'sent_back').some((e) => e.by === 'hook'));
  assert.match(done.reply, /Fixed/);
});

test('a background job that ends is reported to the agent before its next step', async () => {
  const { bodies, events } = await strictRun((body, i) => [
    reply('', [['shell', { command: 'node job.mjs', background: true }]]),
    reply('', [['shell', { command: 'node wait.mjs' }]]),
    reply('Done.'),
  ][i], { prep: (d) => {
    fs.writeFileSync(path.join(d, 'job.mjs'), "setTimeout(() => { console.log('build finished: 3 files'); }, 300);\n");
    fs.writeFileSync(path.join(d, 'wait.mjs'), 'setTimeout(() => {}, 1500);\n');
  } });
  const note = bodies[2].messages.filter((m) => m.role === 'user').map((m) => String(m.content)).find((c) => /a background job ended/.test(c));
  assert.ok(note, 'the agent hears that the job ended');
  assert.match(note, /exit code 0[\s\S]*build finished: 3 files/);
  assert.equal(of(events, 'job_done').length, 1);
});

test('the status nudge asks for one sentence after N silent steps, and never when 0', async () => {
  const script = (body, i) => (i < 3 ? reply('', [['list_files', {}]]) : reply('Done.'));
  const r = await run(script, { settings: { statusEvery: 2 } });
  assert.match(toolResults(r.bodies[2]).at(-1), /without a word to the user\. With your next tool calls, write one short sentence/);
  const off = await run(script, { settings: { statusEvery: 0 } });
  assert.ok(off.bodies.every((b) => toolResults(b).every((t) => !/without a word to the user/.test(t))));
});

test('helper roles reach delegate: a role enum, and a helper writes only in scratch', async () => {
  const r = await run((body, i) => {
    if (/You are a helper \("Draft"\)/.test(body.messages[0].content)) {
      const n = body.messages.filter((m) => m.role === 'tool').length;
      return n === 0 ? reply('', [['write_file', { path: 'index.html', content: 'x' }], ['write_file', { path: '.quorx/scratch/try/a.txt', content: 'idea' }]]) : reply('Tried it in scratch: it works.');
    }
    return [reply('', [['delegate', { task: 'try an idea', role: 'draft' }]]), reply('Done.')][i > 1 ? 1 : i];
  }, { settings: { helperMinFiles: 0 } });
  const d = r.bodies[0].tools.find((t) => t.function.name === 'delegate');
  assert.deepEqual(d.function.parameters.properties.role.enum, ['explore', 'test', 'draft']);
  assert.ok(fs.existsSync(path.join(r.dir, '.quorx', 'scratch', 'try', 'a.txt')));
  assert.ok(!fs.existsSync(path.join(r.dir, 'index.html')), 'never the project\'s own files');
  const start = of(r.events, 'helper_start')[0];
  assert.equal(start.role, 'draft');
  assert.equal(start.context, 'summary');
});

test('memory: types, why, details and project scope; the token limit counts what one chat gets', () => {
  saveMemory({ on: true, items: [] });
  try {
    assert.ok(addMemory('Uses pnpm, not npm', 'you', { type: 'feedback', why: 'the lockfile is pnpm-lock.yaml' }).item);
    assert.ok(addMemory('The API lives in server/', 'you', { type: 'project', project: 'p1', details: 'Routes are in server.js; handlers in server/*.js.' }).item);
    assert.ok(addMemory('Uses pnpm, not npm', 'you', { project: 'p2' }).item, 'the same words for one project are a different item');
    const m = loadMemory();
    assert.equal(itemsFor(m, 'p1').length, 2);
    assert.equal(itemsFor(m, 'p3').length, 1);
    const p = memoryPrompt(m, { projectId: 'p1' });
    assert.match(p, /How they want you to work:\n- Uses pnpm, not npm \(why: the lockfile is pnpm-lock\.yaml\)/);
    assert.match(p, /About this project:\n- The API lives in server\/ \[more: recall m[0-9a-f]+\]/);
    assert.doesNotMatch(memoryPrompt(m, { projectId: 'p3' }), /API lives/);
    assert.ok(worstPromptTokens(m.items) <= MEMORY_TOKENS);
    assert.match(checkMemory('fine', m, { details: 'my token: abc123xyz' }), /never keeps secrets/, 'details are checked for secrets too');
    // Items in two projects never share one prompt, so each project has the whole limit beside the every-project items.
    const long = (k) => `Project fact ${k}: ${'plain words please '.repeat(9)}`.slice(0, 190);
    let k = 0;
    while (!addMemory(long(k++), 'you', { project: 'pa' }).error) { /* fill pa */ }
    assert.ok(addMemory(long(500), 'you', { project: 'pb' }).item, 'pb still has room');
  } finally { saveMemory({ on: true, items: [] }); }
});

test('the wrap-up: harness facts on what was not checked, a recap and next steps from a helper call', async () => {
  const r = await run((body, i) => {
    if (/You write the wrap-up/.test(body.messages[0].content)) return reply(JSON.stringify({ recap: 'The page is written; nobody has opened it yet.', next: [{ label: 'Open it', text: 'Open the page and check it works.' }, { label: '', text: 'dropped' }, { label: 'x', text: 'third' }] }));
    return [reply('', [['write_file', { path: 'a.txt', content: 'x' }]]), reply('Wrote a.txt.')][Math.min(i, 1)];
  }, { settings: { verify: false }, wrapUp: true });
  const w = r.done.stats.wrap;
  assert.equal(w.recap, 'The page is written; nobody has opened it yet.');
  assert.deepEqual(w.next, [{ label: 'Open it', text: 'Open the page and check it works.' }]);
  assert.ok(w.unchecked.some((x) => /checks before the final reply are off/.test(x)));
  assert.equal(of(r.events, 'wrap_up').length, 1);
  const quiet = await run(() => reply('Just an answer.'), { wrapUp: true });
  assert.equal(quiet.done.stats.wrap, undefined, 'no wrap-up after a reply that did no work');
});
