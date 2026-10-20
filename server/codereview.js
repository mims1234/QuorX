// /review: a reviewer model reads what changed in a project (the last reply's changes, the uncommitted git
// changes, or a branch against main) and reports concrete bugs with file:line, severity and why.
// The harness collects the diff and the changed files itself; the reviewer gets no tools and reads nothing
// else. Its findings are checked against the diff before they reach the page, so a weak model that names a
// file or line it was never shown can't send the agent on a wild goose chase.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewFiles, reviewDiff, safePath } from './workspace.js';
import { SECRET_FILE, findKey, redactSecrets } from './secrets.js';

export const SEVERITIES = ['breaks', 'annoying', 'minor'];
const MAX_FINDINGS = 12, MAX_FILES = 40, WHOLE_FILE_LINES = 400;
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const SKIP = /(^|\/)(node_modules|\.git|\.quorx|dist|build|\.next|vendor)\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.min\.(js|css)|.*\.map)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|svg|mp3|mp4|wav|ogg|webm|woff2?|ttf|otf|zip|gz|pdf|exe|dll|so|dylib|wasm|db|sqlite)$/i;

// ---------- the changes ----------
const DIFF_FLAGS = ['--no-color', '--unified=3', '--no-ext-diff', '--no-textconv'];
// A project's own .git/config can run programs on git diff (core.fsmonitor, diff drivers, textconv): those are off,
// and revisions come after --end-of-options, so a name can never be read as an option.
function git(root, args, max = 20e6) {
  return execFileSync('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: max, timeout: 20e3, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}
const isRepo = (root) => { try { return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; } };
// The branch to compare against: main, else master, else what origin/HEAD points at.
export function baseBranch(root) {
  for (const b of ['main', 'master', 'origin/main', 'origin/master']) { try { git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', b]); return b; } catch { /* next */ } }
  try { return git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim() || null; } catch { return null; }
}

// `git diff` output → files with hunks of [op, oldLine, newLine, text], the shape workspace.reviewDiff gives.
export function parseGitDiff(text) {
  const files = [];
  let f = null, ln = [0, 0];
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) { f = { path: '', status: 'modified', hunks: [] }; files.push(f); continue; }
    if (!f) continue;
    if (line.startsWith('new file mode')) f.status = 'added';
    else if (line.startsWith('deleted file mode')) f.status = 'deleted';
    else if (line.startsWith('Binary files')) f.binary = true;
    else if (line.startsWith('+++ ')) { const p = line.slice(4).replace(/^b\//, ''); if (p !== '/dev/null') f.path = p; }
    else if (line.startsWith('--- ')) { const p = line.slice(4).replace(/^a\//, ''); if (p !== '/dev/null' && !f.path) f.path = p; }
    else if (line.startsWith('@@')) { const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/); ln = [Number(m?.[1] || 1), Number(m?.[2] || 1)]; f.hunks.push({ lines: [] }); }
    else if (f.hunks.length && /^[ +-]/.test(line)) {
      const op = line[0], t = line.slice(1);
      f.hunks.at(-1).lines.push([op, op === '+' ? null : ln[0], op === '-' ? null : ln[1], t]);
      if (op !== '+') ln[0]++;
      if (op !== '-') ln[1]++;
    }
  }
  return files.filter((x) => x.path);
}

/**
 * What changed, as { scope, label, files: [{ path, status, hunks, binary }] }.
 * scope: 'reply' (the files a reply changed, from its undo copy; needs runId), 'changes' (uncommitted git
 * changes, untracked files included), 'branch' (this branch against `base`, default main), or 'auto' (the
 * reply if it has an undo copy, else uncommitted changes, else the branch).
 */
export function collectChanges(root, { scope = 'auto', runId = '', base = '' } = {}) {
  const tried = [];
  const want = (s) => scope === s || scope === 'auto';
  if (want('reply') && runId) {
    try {
      const list = reviewFiles(root, runId).files;
      const files = list.map((f) => (f.binary || f.large ? { path: f.path, status: f.status, binary: true, hunks: [] } : { path: f.path, status: f.status, hunks: reviewDiff(root, runId, f.path).hunks }));
      if (files.length) return { scope: 'reply', label: 'the last reply\'s changes', files };
      tried.push('the last reply changed no files');
    } catch (e) { tried.push(e.message); }
  } else if (scope === 'reply') tried.push('no reply in this chat changed files');
  const repo = (want('changes') || want('branch')) && isRepo(root);
  if (!repo && scope !== 'reply') tried.push('the project folder is not a git repository');
  if (repo && want('changes')) {
    const diff = git(root, ['diff', ...DIFF_FLAGS, '--end-of-options', 'HEAD']);
    const files = parseGitDiff(diff);
    // Untracked files are whole new files.
    for (const rel of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (files.some((f) => f.path === rel)) continue;
      if (SECRET_FILE.test(rel)) { files.push({ path: rel, status: 'added', secret: true, hunks: [] }); continue; } // never read
      const text = readOr(root, rel);
      files.push(text == null ? { path: rel, status: 'added', binary: true, hunks: [] } : { path: rel, status: 'added', hunks: [{ lines: text.split('\n').map((t, i) => ['+', null, i + 1, t]) }] });
    }
    if (files.length) return { scope: 'changes', label: 'uncommitted changes', files };
    tried.push('there are no uncommitted changes');
  }
  if (repo && want('branch')) {
    const b = String(base || '').trim() || baseBranch(root);
    if (!b) tried.push('there is no main branch to compare with');
    else {
      if (!/^[\w.][\w./-]*$/.test(b)) throw new Error(`"${b}" is not a branch name.`);
      const head = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      const files = parseGitDiff(git(root, ['diff', ...DIFF_FLAGS, '--end-of-options', `${b}...HEAD`]));
      if (files.length) return { scope: 'branch', label: `${head} against ${b}`, files };
      tried.push(`${head} has no changes against ${b}`);
    }
  }
  const err = new Error(`Nothing to review: ${[...new Set(tried)].join('; ') || 'no changes found'}.`);
  err.empty = true;
  throw err;
}
function readOr(root, rel) {
  try { const p = safePath(root, rel); const b = fs.readFileSync(p); return b.length > 400e3 || b.includes(0) ? null : b.toString('utf8'); } catch { return null; }
}

// ---------- what the reviewer reads ----------
const pad = (n, w) => String(n ?? '').padStart(w);
function hunkText(f) {
  const w = String(Math.max(1, ...f.hunks.flatMap((h) => h.lines.map((l) => l[2] || l[1] || 0)))).length;
  return f.hunks.map((h) => h.lines.map(([op, , nl, t]) => `${op === '-' ? '-' : op === '+' ? '+' : ' '}${pad(op === '-' ? '' : nl, w)} | ${clip(t, 400)}`).join('\n')).join('\n   ...\n');
}
/**
 * The reviewer's request, built only from the changed files: each file's diff with new line numbers, and its
 * whole current text when it is short and the model's context allows. `chars` is the budget for all of it.
 */
export function reviewBrief(root, changes, { chars = 60000 } = {}) {
  const files = changes.files.filter((f) => !SKIP.test(f.path)).slice(0, MAX_FILES);
  const skipped = changes.files.length - files.length;
  const parts = [], shown = [], secretFiles = [];
  let used = 0, cut = false, redacted = 0;
  for (const f of files) {
    // Secrets files (.env, keys, credentials) are never sent, nor is a file holding a private key.
    if (f.secret || SECRET_FILE.test(f.path) || f.hunks.some((h) => h.lines.some((l) => findKey(l[3]) === 'a private key'))) { secretFiles.push(f.path); continue; }
    if (f.binary || BINARY.test(f.path)) { parts.push(`### ${f.path} (${f.status}, binary: not shown)`); continue; }
    let block = `### ${f.path} (${f.status})\nDiff (+ added, - removed; the number is the line in the new file):\n${hunkText(f) || '(no line changes)'}`;
    const now = f.status === 'deleted' ? null : readOr(root, f.path);
    const lines = now?.replace(/\r?\n$/, '').split('\n') || [];
    if (now && findKey(now) === 'a private key') { secretFiles.push(f.path); continue; }
    // The whole file helps the reviewer see what the change breaks elsewhere in it; only when it is short and new lines aren't the whole file already.
    if (now && f.status !== 'added' && lines.length <= WHOLE_FILE_LINES && used + block.length + now.length * 1.1 < chars * 0.8) {
      const w = String(lines.length).length;
      block += `\nWhole file now:\n${lines.map((t, i) => `${pad(i + 1, w)} | ${clip(t, 400)}`).join('\n')}`;
    }
    // Keys and tokens in the code itself are replaced before anything leaves this computer.
    const red = redactSecrets(block);
    block = red.text; redacted += red.count;
    if (used + block.length > chars) { block = block.slice(0, Math.max(0, chars - used)); cut = true; }
    if (!block) break;
    parts.push(block); shown.push(f.path); used += block.length;
    if (cut) break;
  }
  return { text: parts.join('\n\n'), shown, cut, skipped, secretFiles, redacted };
}

export const CODE_REVIEW_SYSTEM = `You review code changes and report real bugs. You did not write this code.
Read the diff of each changed file. Report problems in the changed lines, or problems the change causes elsewhere in the files shown.
For each problem give:
- file: the path exactly as shown after ###
- line: the line number shown in the diff (the new file's line)
- severity: "breaks" (crash, wrong result, lost data, security hole, the feature does not work), "annoying" (wrong in some cases, missing error handling a user will hit), or "minor" (small issue worth a look; at most 3 of these)
- title: the bug in a few words
- why: one or two sentences: what goes wrong and when
- fix: one sentence on how to fix it
Only report bugs you can point to in the code shown. Do not report style, naming or formatting. Do not guess about files you were not shown. If the changes look correct, return no findings.`;

const FINDINGS_SCHEMA = { type: 'object', required: ['findings'], properties: {
  findings: { type: 'array', items: { type: 'object', required: ['file', 'line', 'severity', 'why'], properties: {
    file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: SEVERITIES },
    title: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' } } } },
  summary: { type: 'string', description: 'One sentence on the changes overall.' } } };
export const SUBMIT_FINDINGS = { type: 'function', function: { name: 'submit_findings', description: 'Submit the bugs you found (an empty list when the changes look correct).', parameters: FINDINGS_SCHEMA } };

// A model's answer as findings: the tool call's arguments, else the first JSON object in its text.
export function parseFindings(msg) {
  const call = (msg.tool_calls || []).find((t) => t.function?.name === 'submit_findings');
  const raw = call ? call.function.arguments : String(msg.content || '');
  const tryJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let j = tryJSON(raw);
  if (!j) { const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) j = tryJSON(m[1]); }
  if (!j) { const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) j = tryJSON(raw.slice(a, b + 1)); }
  if (Array.isArray(j)) j = { findings: j };
  if (!j || !Array.isArray(j.findings)) return null;
  return { findings: j.findings, summary: typeof j.summary === 'string' ? j.summary : '' };
}

// Keeps only findings that point into the changes: a known file (matched by its path or, failing that, a unique
// file name) and a line inside it. Duplicates go, minor ones are capped at 3, the worst come first.
export function checkFindings(list, changes, root) {
  const paths = changes.files.map((f) => f.path);
  const byName = (p) => { const n = path.posix.basename(String(p).replaceAll('\\', '/')); const hits = paths.filter((x) => path.posix.basename(x) === n); return hits.length === 1 ? hits[0] : null; };
  const out = [], seen = new Set(), dropped = [];
  for (const x of list || []) {
    if (!x || typeof x !== 'object') continue;
    const given = String(x.file || x.path || '').replace(/^\.?\/+/, '').replace(/^[ab]\//, '').replace(/:\d+$/, '');
    const file = paths.includes(given) ? given : byName(given);
    if (!file) { dropped.push(given || '(no file)'); continue; }
    const sev = SEVERITIES.includes(String(x.severity).toLowerCase()) ? String(x.severity).toLowerCase() : 'annoying';
    const f = changes.files.find((y) => y.path === file);
    const max = f.status === 'deleted' ? Infinity : (readOr(root, file)?.replace(/\r?\n$/, '').split('\n').length || Math.max(1, ...f.hunks.flatMap((h) => h.lines.map((l) => l[2] || 0))));
    let line = Math.round(Number(String(x.line ?? '').match(/\d+/)?.[0]));
    if (!Number.isFinite(line) || line < 1) line = null; else if (line > max) line = max;
    const why = clip(String(x.why || x.description || '').trim(), 500);
    if (!why) continue;
    const key = `${file}:${line}:${why.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, line, severity: sev, title: clip(String(x.title || '').trim(), 120), why, fix: clip(String(x.fix || '').trim(), 300) });
  }
  out.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const minor = out.filter((x) => x.severity === 'minor').slice(3);
  return { findings: out.filter((x) => !minor.includes(x)).slice(0, MAX_FINDINGS), dropped };
}

/**
 * Reviews the changes with one model call (and one retry asking again for the format when the answer can't
 * be read). `model` is the reviewer; `info` is its catalogue entry ({ tools, ctx }) when known.
 * deps.chat(body) → { message, usage } (openrouter.chat, or a scripted model in tests).
 */
const noForce = new Set();
export async function reviewCode(root, opts, deps) {
  const t0 = Date.now();
  const changes = collectChanges(root, opts);
  const info = opts.info || {};
  // A small window gets a small brief (about 4 characters a token, half the window for the request).
  const chars = Math.max(8000, Math.min(120000, Math.round((Number(info.ctx) || 64000) * 4 * 0.45)));
  const brief = reviewBrief(root, changes, { chars });
  if (!brief.shown.length) { const e = new Error(`Nothing to review: only ${brief.secretFiles.length ? 'secrets files (never sent), ' : ''}binary, generated or lock files changed.`); e.empty = true; throw e; }
  const tools = info.tools !== false;
  const user = `Changes to review: ${changes.label}.${opts.ask ? `\nThe user asks you to look especially at: ${clip(opts.ask, 300)}` : ''}${brief.cut ? '\nThe diff was cut to fit; review what is shown.' : ''}\n\n${brief.text}\n\n${tools ? 'Call submit_findings once with what you found.' : 'Answer with only a JSON object: {"findings": [{"file", "line", "severity", "title", "why", "fix"}], "summary": "..."}'}`;
  const messages = [{ role: 'system', content: CODE_REVIEW_SYSTEM }, { role: 'user', content: user }];
  let cost = 0, calls = 0, parsed = null;
  // One call, retried once on a provider hiccup (429, 5xx). Some models refuse a forced tool choice (400): those
  // get tool_choice auto, and are remembered, so later reviews skip the failed attempt.
  const call = async (body) => {
    for (let k = 0; ; k++) {
      const forced = body.tools && !noForce.has(body.model);
      try { return await deps.chat(forced ? body : { ...body, ...(body.tools ? { tool_choice: 'auto' } : {}) }, opts.signal); }
      catch (e) {
        if (opts.signal?.aborted || k > 1) throw e;
        if (forced && e.status === 400) { noForce.add(body.model); continue; }
        if (k > 0 || !(e.status === 429 || e.status >= 500)) throw e;
        await new Promise((ok) => setTimeout(ok, deps.retryMs ?? 1500));
      }
    }
  };
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const body = { model: opts.model, messages, max_tokens: 3000, temperature: 0.1, reasoning: { enabled: false }, ...(tools ? { tools: [SUBMIT_FINDINGS], tool_choice: { type: 'function', function: { name: 'submit_findings' } } } : {}) };
    const r = await call(body);
    calls++; cost += Number(r.usage?.cost) || 0;
    parsed = parseFindings(r.message || {});
    if (!parsed) messages.push({ role: 'assistant', content: clip(r.message?.content || '', 2000) || '(no answer)' }, { role: 'user', content: 'That could not be read. Answer with only a JSON object: {"findings": [{"file", "line", "severity", "title", "why", "fix"}], "summary": "..."}' });
  }
  if (!parsed) throw new Error(`The reviewer (${opts.model}) did not return findings in a form QuorX can read.`);
  const { findings, dropped } = checkFindings(parsed.findings, changes, root);
  return { scope: changes.scope, label: changes.label, files: brief.shown, skipped: brief.skipped, cut: brief.cut, secretFiles: brief.secretFiles, redacted: brief.redacted, findings, dropped: dropped.length, summary: clip(parsed.summary, 300), model: opts.model, cost, calls, ms: Date.now() - t0 };
}

// The reviewer model, chosen as the build reviewer is: a model picked in Settings, else the Cheap or Strong
// default (its alternative when the chat already uses that model, so a model never reviews its own work).
export function pickReviewer({ reviewModel = '', reviewTier = 'cheap' } = {}, chatModel = '', R) {
  const chosen = String(reviewModel || '').trim();
  if (chosen) return chosen;
  return reviewTier === 'strong' ? (chatModel === R.REVIEW_STRONG ? R.REVIEW_STRONG_ALT : R.REVIEW_STRONG) : (chatModel === R.REVIEW_MODEL ? R.REVIEW_ALT : R.REVIEW_MODEL);
}
