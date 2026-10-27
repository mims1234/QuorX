// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// QuorX: a chat agent with artifacts, self-built decisions and paid media behind an
// approval gate. Zero dependencies (Node 20+). The OpenRouter key stays on this server; every
// step of a run streams to the page as Server-Sent Events.
//
//   server/openrouter.js  OpenRouter client: chat, Decisions, images, speech, music, catalogues
//   server/decisions.js   the decider ensemble: one Decisions call per decider, soft vote, confidence
//   server/agent.js       one run: the tool loop, decide-with-guess, artifacts, media approvals
// First: QuorX's web requests refuse Brotli until its Node has the October 2026 security fix (server/nobrotli.js).
import './server/nobrotli.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openDetached } from './server/userenv.js';
import { currentKey, PORT, runtime, ROOT, HOME, chat, chatModels, decisionModels, imageModels, speechModels, musicModels, videoModels, transcribe, clearCatalogues } from './server/openrouter.js';
import { listKeys, addKey, removeKey, setActive, renameKey, keyUsage, activeUsage, accountCredits, startSampling, lockDown } from './server/keys.js';
import { setupCheck, runFix } from './server/setup-check.js';
import { startSignIn, signInStatus, cancelSignIn, finishByCallback, finishWithCode, callbackPage } from './server/oauth.js';
import { runAgent, answerApproval, answerQuestion, answerSecret, answerBudget, raiseCap, setRunApproval, steerRun, setRunReading, setRunVideo, holdCard, DEFAULTS, MEDIA, briefFor, briefForChat, REVIEW_MODEL, HELPER_MODEL, REVIEW_ALT, REVIEW_STRONG, REVIEW_STRONG_ALT } from './server/agent.js';
import { reviewCode, pickReviewer } from './server/codereview.js';
import { loadHooks, saveHooks, HOOK_EVENTS } from './server/hooks.js';
import { createScheduler, loadSchedules, scheduleView, addSchedule, changeSchedule, removeSchedule, runScheduleNow, scheduleHooks } from './server/schedules.js';
import { startScheduledChat } from './server/schedrun.js';
import { loadMemory, saveMemory, memoryTokens, MEMORY_TOKENS } from './server/memory.js';
import { CHECKS } from './server/harness-checks.js';
import { startRun, getRun, stopRun, follow, runStatus, activeRuns, validRunId, scorecard, readLog, runEvents, recordRun, onRunEvent } from './server/runs.js';
import { setBudget, budgetState } from './server/budget.js';
import { shellRun, shellClose, shellInfo } from './server/shell.js';
import { ptyAvailable, ptyOpen, ptyWrite, ptyResize, ptyFollow, ptyClose } from './server/pty.js';
// Pages the agent wrote, served from this app's own address, get their own opaque origin: their requests to /api are refused.
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads';
import { listChats, sidebarChats, chatPage, chatPictureRefs, pictureRefCounts, getTrace, getChatForPage, getChat, saveChat, patchChat, settleReply, trashChat, validId, listProjects, saveProject, forgetProject, setProjectColor, setProjectFlags, costSummary, costChats } from './server/store.js';
import { ALLOWED, copyTemplate, workspaceDir, safePath, fullLocalPath,chatFolder, listFiles, listDir, listServers, stopServerWait, restartServer, serverLog, startServer, restoreCheckpoint, listCheckpoints, pruneCheckpoints, undoConflicts, changedFiles, reviewFiles, reviewDiff, undoFile, serverOverview, launchConfigs, saveLaunchConfig, removeLaunchConfig, ensureAgentDir, agentSpace } from './server/workspace.js';
import { followTerm, runningJobs, stopJob } from './server/terminal.js';
import { runningIn, stopRunning, stopAllIn } from './server/running.js';
import { decide as decideCommand, loadRules, saveRules, suggestedRules, ruleProblem, updateRule, removeRule } from './server/cmdpolicy.js';
import { jobHostStatus, jobsAvailable } from './server/jobhost.js';
import { safetySettings, yoloOf } from './server/safety.js';
import { readAudit } from './server/audit.js';
import { pickFolder } from './server/pickfolder.js';
import { userBrowse, giveTab, givenTab, takeBackTab, takeBackSid, lentChromeTabs } from './server/userbrowser.js';
import { rewritePrompt } from './server/enhancer.js';
import { extUpgrade, extKey, extInfo, onExtRequest, defaultBrowser, extPairing, extPair, extPush } from './server/extlink.js';
import { openLink, linkReply, desktopReady, desktopCall } from './server/desktop.js';
import { saveUpload, processDoc, listDocs, removeDoc, DOC_DEFAULTS, officeText } from './server/docs.js';
import { embeddingModels } from './server/openrouter.js';
import { listSkills, listTemplates, saveSkill, getSkill, deleteSkill, skillId, routineSkill } from './server/skills.js';
import { hostedHtml, browserPath, openTab } from './server/browser.js';
import { zipFolder } from './server/zip.js';
import { exportBackup, findBackups, inspectBackup, importBackup } from './server/backup.js';
import { artifactContent, servedArtifact, ARTIFACT_HEADERS, folderStamp } from './server/artifacts.js';
import { gate, appGate, appLink, hostAllowed, crossSiteApi, isLoopback, handoffPut, handoffTake } from './server/access.js';
import { gitHubRemote, gitHubInfo } from './server/github.js';
import { serveBlob, startSweeping, chatFootprint, sendFile } from './server/blobs.js';
import { measureStorage, clearStorage, clearProjectParts, previewProjectParts, recentClears, startStorageRules } from './server/storage.js';
import { storageRules, saveStorageRules, rotateLog, RULE_DEFAULTS } from './server/storagerules.js';
import { listDesignSystems, readDesignSystem, projectDesign, applyDesignSystem, saveProjectDesign } from './server/design.js';
import { newsRoute } from './server/news.js';
import { runningForChat } from './server/runs.js';
import { startNewsSync, remoteState as newsRemoteState } from './server/newsremote.js';
import { uiCards } from './server/modelcards.js';
import zlib from 'node:zlib';

const PUBLIC = path.join(ROOT, 'public');
// Server code edited since this process started (by you or a coding session): the page says to restart,
// because pages load fresh from disk but the server keeps running the code it started with.
const STARTED = Date.now();
// The version shown in the sidebar and Settings (package.json; the desktop release script keeps it in step).
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();
function codeChanged() {
  let latest = 0, file = '';
  for (const f of [path.join(ROOT, 'server.js'), ...fs.readdirSync(path.join(ROOT, 'server')).filter((x) => x.endsWith('.js')).map((x) => path.join(ROOT, 'server', x))]) {
    try { const t = fs.statSync(f).mtimeMs; if (t > latest) { latest = t; file = path.relative(ROOT, f).replaceAll('\\', '/'); } } catch { /* removed */ }
  }
  return { started: STARTED, stale: latest > STARTED + 1000 ? { since: Math.round(latest), file } : null };
}
if (!currentKey()) console.warn('!! No OpenRouter key yet: add one in the page (⚙ Settings → API keys) or set OPENROUTER_API_KEY in .env');
startSampling();
startSweeping();
startStorageRules();
startNewsSync(); // News from the QuorX website: a check soon after start, then a few times a day (server/newsremote.js)
setTimeout(lockDown, 2000).unref?.(); // keys and data: this account only (server/keys.js)

const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska', '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.xml': 'application/xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };

function readBody(req, limit = 60e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
// The raw bytes of an upload.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error(`the file is over the ${Math.round(limit / 1e6)} MB upload limit (⚙ Settings → Documents)`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
// One-time passes for exporting API keys (see /api/backup/key-pass): each works once, within a minute.
const KEY_PASSES = new Map();
const keyPass = () => { const p = randomBytes(18).toString('base64url'); KEY_PASSES.set(p, Date.now() + 60e3); return p; };
const takeKeyPass = (p) => { const until = typeof p === 'string' && KEY_PASSES.get(p); if (until) KEY_PASSES.delete(p); for (const [k, t] of KEY_PASSES) if (t < Date.now()) KEY_PASSES.delete(k); return !!until && until >= Date.now(); };
// The app's own pages may run only its own scripts (KaTeX ships with the app, under /vendor/katex), so text that slipped into the page
// unescaped can't run code with the harness's powers.
const APP_CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'";
// The app's own files: revalidated on every load (an edit shows on reload) but answered with 304 when unchanged,
// and text files gzipped once per version, so a reload doesn't pull ~900 KB of script and styles every time.
const GZIP = new Map(); // file → { tag, buf }
function sendStatic(req, res, file, type, extra = {}) {
  const st = fs.statSync(file), tag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
  const head = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: tag, ...extra };
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, head); return res.end(); }
  if (st.size > 1024 && /text|javascript|json|svg/.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    let z = GZIP.get(file);
    if (!z || z.tag !== tag) { z = { tag, buf: zlib.gzipSync(fs.readFileSync(file), { level: 6 }) }; GZIP.set(file, z); }
    res.writeHead(200, { ...head, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': z.buf.length });
    return res.end(z.buf);
  }
  res.writeHead(200, head);
  return sendFile(file, res);
}
// A path from the address bar; a malformed %-escape is a bad request, not a server error.
const decodePath = (s) => { try { return decodeURIComponent(s); } catch { return null; } };// Server-Sent Events for one run, from event number `from`. Closing the page only stops listening.
function stream(res, runId, from) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
  let stop = () => {};
  const end = () => { clearInterval(ping); stop(); if (!res.writableEnded) res.end(); };
  stop = follow(runId, from, (e) => { if (e === null) return end(); if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); });
  res.on('close', () => { clearInterval(ping); stop(); });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  try {
    // The Host must name this computer (no DNS rebinding); only this computer may connect; no /api calls from other sites.
    if (!hostAllowed(req)) return json(res, 403, { error: 'unknown host name: open QuorX at localhost or this computer\'s address (or list the name in OH_ALLOWED_HOSTS)' });
    if (gate(req, res, url)) return;
    if (!req.pageOrigin && appGate(req, res, url)) return;
    if (crossSiteApi(req, url.pathname)) return json(res, 403, { error: 'requests from other sites are not allowed' });
    // Changes only from this app's own pages: a request from another site (its Origin differs) is refused.
    if (req.method !== 'GET' && req.headers.origin) {
      let same = false; try { same = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ }
      if (!same) return json(res, 403, { error: 'requests from other sites are not allowed' });
    }
    // OpenRouter sends the browser back here after "Sign in with OpenRouter" (a top-level visit from openrouter.ai).
    if (req.method === 'GET' && url.pathname === '/oauth/openrouter/callback') {
      const q = url.searchParams, r = await finishByCallback({ state: q.get('state'), code: q.get('code'), error: q.get('error') });
      if (r.ok) clearCatalogues();
      // In the desktop app the window comes to the front, so the user is back in QuorX, signed in.
      const desktop = desktopReady();
      if (desktop) desktopCall('app.focus', {}, 5000).catch(() => {});
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      return res.end(callbackPage({ ...r, desktop }));
    }
    // Settings this browser kept at localhost:<port>, carried to quorx.localhost once (server/access.js, public/move.js).
    const hfm = url.pathname.match(/^\/api\/prefs\/handoff\/([\w-]+)$/);
    if (hfm && req.method === 'POST') { let b = {}; try { b = JSON.parse(await readBody(req, 8e6) || '{}'); } catch { /* below */ } return handoffPut(hfm[1], b.items) ? json(res, 200, { ok: true }) : json(res, 410, { error: 'this handoff is used or expired' }); }
    if (hfm && req.method === 'GET') { const items = handoffTake(hfm[1]); return items ? json(res, 200, { items }) : json(res, 410, { error: 'this handoff is used or expired' }); }
    if (req.method === 'GET' && url.pathname === '/api/stale') return json(res, 200, codeChanged());
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { ...codeChanged(), version: VERSION, platform: process.platform, pagePort: runtime.pagePort || null, shell: shellInfo().name, pty: ptyAvailable(), defaults: DEFAULTS, docDefaults: DOC_DEFAULTS, storageDefaults: RULE_DEFAULTS, checks: CHECKS, media: MEDIA, newsRemote: newsRemoteState().on, hasKey: !!currentKey(), browser: browserPath(), allowed: ALLOWED });

    // ---- chat history (data/chats; delete = move to data/trash) ----
    // The sidebar: each project's newest chats, the open ones by id, and every project's counts (store.js sidebarChats).
    if (url.pathname === '/api/chats' && req.method === 'GET' && url.searchParams.get('view') === 'sidebar') {
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(validId).slice(0, 50);
      return json(res, 200, sidebarChats({ per: Math.max(1, Math.min(200, Number(url.searchParams.get('per')) || 30)), ids }));
    }
    if (url.pathname === '/api/chats' && req.method === 'GET') return json(res, 200, listChats());
    // A page of chats: a project's older ones (Show more), or a search across every project.
    if (url.pathname === '/api/chats/page' && req.method === 'GET') return json(res, 200, chatPage({ project: url.searchParams.get('project') || '', q: url.searchParams.get('q') || '', offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') }));
    if (url.pathname === '/api/costs' && req.method === 'GET') return json(res, 200, costSummary({ per: Number(url.searchParams.get('per')) || 5, sort: url.searchParams.get('sort') || 'cost' }));
    if (url.pathname === '/api/costs/chats' && req.method === 'GET') {
      const q = url.searchParams;
      return json(res, 200, costChats({ project: q.get('project') || '', q: q.get('q') || '', sort: q.get('sort') || 'cost', offset: q.get('offset'), limit: q.get('limit') }));
    }
    // A short brief of a whole chat (/fresh, and attaching a chat to another), cached until the chat changes.
    const brm = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)\/brief$/i);
    if (brm && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4) || '{}'); try { return json(res, 200, await briefForChat(brm[1], { model: b.model })); } catch (e) { return json(res, 400, { error: e.message }); } }
    // An older reply's steps, kept apart from its chat (store.js splitTraces): the page asks when that reply is shown.
    const trm = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)\/trace\/([\w-]+)$/i);
    if (trm && req.method === 'GET') { const t = getTrace(trm[1], trm[2]); return t ? json(res, 200, t) : json(res, 404, { error: 'no such steps' }); }
    // What deleting a chat frees once QuorX's trash is emptied (its file, and pictures no other chat uses).
    const csm = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)\/footprint$/i);
    if (csm && req.method === 'GET') { if (!validId(csm[1])) return json(res, 400, { error: 'bad chat id' }); const f = await chatFootprint(chatPictureRefs(csm[1]), pictureRefCounts()); return f ? json(res, 200, f) : json(res, 404, { error: 'no such chat' }); }
    const cm = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)$/i);
    if (cm) {
      if (req.method === 'GET') { const c = getChatForPage(cm[1]); return c ? json(res, 200, c) : json(res, 404, { error: 'no such chat' }); }
      if (req.method === 'PUT') return json(res, 200, saveChat(cm[1], JSON.parse(await readBody(req, 200e6))));
      // Only what changed since the page's last save; 409 when the file has moved on, and the page sends it whole.
      if (req.method === 'PATCH') { const r = patchChat(cm[1], JSON.parse(await readBody(req, 200e6))); return json(res, r.stale ? 409 : 200, r); }
      if (req.method === 'DELETE') return json(res, 200, { ok: trashChat(cm[1]) });
    }

    // ---- projects (a folder shared by many chats) ----
    // Each project with its budget (null = none) and what all its chats have spent so far.
    // With its GitHub repo when its folder has one (from the folder's git settings: no network).
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, listProjects().map((p) => { let github = null; try { github = gitHubRemote(workspaceDir(p.id)); } catch { /* folder missing */ } return { ...p, ...budgetState(p.id), ...(github ? { github } : {}) }; }));
    // Whether that repo is public or private, and a person's or an organization's (asked of GitHub, cached for an hour).
    const ghm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/github$/i);
    if (ghm && req.method === 'GET') {
      if (!listProjects().some((p) => p.id === ghm[1])) return json(res, 404, { error: 'unknown project' });
      let remote = null; try { remote = gitHubRemote(workspaceDir(ghm[1])); } catch { /* folder missing */ }
      if (!remote) return json(res, 200, { github: null });
      return json(res, 200, { github: { ...remote, ...(await gitHubInfo(remote.owner, remote.repo, { fresh: url.searchParams.get('fresh') === '1' })) } });
    }
    const bm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/budget$/i);
    if (bm && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      // Not while a chat in the project is working, unless it is that reply's own "budget reached" card asking.
      if (budgetState(bm[1]).running && !b.fromCard) return json(res, 200, { error: 'a chat in this project is working; change the budget when it finishes', ...budgetState(bm[1]) });
      try { return json(res, 200, { ok: true, ...setBudget(bm[1], b.budget ?? null) }); } catch (e) { return json(res, 200, { error: e.message, ...budgetState(bm[1]) }); }
    }
    // The colour of a project's name (null: the automatic one).
    const pcm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/color$/i);
    if (pcm && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      try { return json(res, 200, { ok: true, ...setProjectColor(pcm[1], b.color || null) }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // Design systems: the starters, and a project's own DESIGN.md + tokens.css (apply a starter, edit, remove).
    if (url.pathname === '/api/design-systems' && req.method === 'GET') return json(res, 200, listDesignSystems());
    const dsm = url.pathname.match(/^\/api\/design-systems\/([a-z0-9-]+)$/i);
    if (dsm && req.method === 'GET') { const s = readDesignSystem(dsm[1]); return s ? json(res, 200, s) : json(res, 404, { error: 'no such design system' }); }
    const pdm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/design$/i);
    if (pdm && req.method === 'GET') {
      try { const d = projectDesign(workspaceDir(pdm[1])); return json(res, 200, d ? { md: d.md, tokens: d.tokens, name: d.name, colors: d.colors.size } : { md: '', tokens: '', name: null }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (pdm && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 2e5) || '{}');
      try {
        const root = workspaceDir(pdm[1]);
        if (b.system) return json(res, 200, applyDesignSystem(root, String(b.system), { overwrite: !!b.overwrite }));
        if (b.remove) return json(res, 200, saveProjectDesign(root, null));
        if (typeof b.md === 'string') return json(res, 200, saveProjectDesign(root, b.md));
        return json(res, 200, { error: 'give system, md or remove' });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // A chat's own notes (<project>/.quorx/chats/<chat>.md), which its agent keeps: read and edited from the chat header.
    const cnm = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)\/notes$/i);
    if (cnm && (req.method === 'GET' || req.method === 'POST')) {
      try {
        // A chat not saved yet (no message sent) is found by the project the page names.
        const chat = validId(cnm[1]) ? getChat(cnm[1]) : null, pid = chat?.projectId || url.searchParams.get('project') || '';
        if (!validId(cnm[1]) || !listProjects().some((p) => p.id === pid)) return json(res, 200, { error: 'no such chat' });
        const rel = `.quorx/chats/${cnm[1]}.md`, abs = path.join(workspaceDir(pid), rel);
        if (req.method === 'POST') {
          const b = JSON.parse(await readBody(req, 2e5) || '{}');
          if (typeof b.md !== 'string') return json(res, 200, { error: 'give md' });
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          if (b.md.trim()) fs.writeFileSync(abs, b.md); else fs.rmSync(abs, { force: true });
        }
        return json(res, 200, { rel, md: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '' });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // Pin (up to 3) or archive a project.
    const pfm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/flags$/i);
    if (pfm && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      const flags = {}; for (const k of ['pinned', 'archived']) if (typeof b[k] === 'boolean') flags[k] = b[k];
      try { return json(res, 200, { ok: true, ...setProjectFlags(pfm[1], flags) }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e5));
      try { return json(res, 200, saveProject(b)); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    const fp = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/i);
    if (fp && req.method === 'DELETE') return json(res, 200, { ok: forgetProject(fp[1]) });

    // ---- project folders: static files for site previews, and a file list ----
    const wm = url.pathname.match(/^\/ws\/([a-z0-9-]+)\/(.*)$/i);
    if (wm && req.method === 'GET') {
      const root = workspaceDir(wm[1]);
      const rel = decodePath(wm[2]);
      if (rel == null) return json(res, 400, { error: 'bad address' });
      // Dot files and folders (.env, .git, .quorx) hold settings and keys, never site content.
      if (/(^|[/\\])\.(?!well-known([/\\]|$))/.test(rel)) return json(res, 404, { error: 'not found' });
      let file = safePath(root, rel || 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      // ?player=1 on a film, a sound or a picture: a plain player page around it. A bare .mp4 in a tab sat under a black
      // band, and agents built pages just to centre it. The file loads from the same address, so it stays in this project.
      const kindOf = (f) => (/\.(mp4|webm|mov|m4v)$/i.test(f) ? 'video' : /\.(mp3|wav|m4a|ogg|flac)$/i.test(f) ? 'audio' : /\.(png|jpe?g|gif|webp|avif)$/i.test(f) ? 'img' : '');
      if (url.searchParams.get('player') === '1' && kindOf(file)) {
        const name = path.basename(file), src = encodeURIComponent(name), title = name.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const tag = { video: `<video src="${src}" controls autoplay playsinline></video>`, audio: `<audio src="${src}" controls autoplay></audio>`, img: `<img src="${src}" alt="${title}">` }[kindOf(file)];
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(!req.pageOrigin ? { 'Content-Security-Policy': SANDBOX_CSP } : {}) });
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html,body{margin:0;height:100%;background:#000}body{display:grid;place-items:center}video,img{max-width:100vw;max-height:100vh;display:block}audio{width:min(640px,90vw)}</style></head><body>${tag}</body></html>`);
      }
      // Project files are the agent's work: sandboxed (a separate origin), so a page can't use this app's own routes.
      // A sandboxed project page loading its own scripts (module scripts need CORS): its Origin is "null" and its
      // Referer is a page of this project (or an artifact or preview page) on this app's address. Other sites, and
      // pages of other projects, can't read the files this way.
      const ref = String(req.headers.referer || ''), base = `http://${req.headers.host}/`;
      // On the pages address every project shares one origin: a page may load files of its own project only.
      if (req.pageOrigin && req.headers['sec-fetch-mode'] !== 'navigate' && !ref.startsWith(`${base}ws/${wm[1]}/`)) return json(res, 404, { error: 'not found' });
      const own = req.headers.origin === 'null' && ref.startsWith(`${base}ws/${wm[1]}/`);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...(/html|svg|xml/.test(type) && !req.pageOrigin ? { 'Content-Security-Policy': SANDBOX_CSP } : {}), ...(own ? { 'Access-Control-Allow-Origin': 'null' } : {}) });
      return sendFile(file, res);
    }
    // A folder outside the project that a chat added (/wsf/<chat>/<n>/<path>): its pages open in the browser like a
    // project's, sandboxed the same way, and only while the chat has it.
    const wf = url.pathname.match(/^\/wsf\/([a-z0-9-]+)\/(\d+)\/(.*)$/i);
    if (wf && req.method === 'GET') {
      const dir = chatFolder(wf[1], wf[2]), rel = decodePath(wf[3]);
      if (!dir || rel == null || /(^|[/\\])\.(?!well-known([/\\]|$))/.test(rel)) return json(res, 404, { error: 'not found' });
      let file;
      try { file = safePath(dir, rel || 'index.html'); } catch { return json(res, 404, { error: 'not found' }); }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      const ref = String(req.headers.referer || ''), base = `http://${req.headers.host}/`, mine = `${base}wsf/${wf[1]}/${wf[2]}/`;
      if (req.pageOrigin && req.headers['sec-fetch-mode'] !== 'navigate' && !ref.startsWith(mine)) return json(res, 404, { error: 'not found' });
      const own = req.headers.origin === 'null' && ref.startsWith(mine);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...(/html|svg|xml/.test(type) && !req.pageOrigin ? { 'Content-Security-Policy': SANDBOX_CSP } : {}), ...(own ? { 'Access-Control-Allow-Origin': 'null' } : {}) });
      return sendFile(file, res);
    }
    // Open a project's folder in the computer's own file manager (File Explorer on Windows). With a path inside the
    // project, a folder opens and a file is shown selected in its folder (Files → right-click → Show in File Explorer).
    // A full path (C:\…, file:///…), as a reply names it, opens the same way, wherever it is on this computer.
    if (url.pathname === '/api/open-folder' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      const full = b.path && fullLocalPath(b.path);
      if (full === null) return json(res, 400, { error: 'that is a network path: QuorX only opens folders on this computer' });
      if (!full && (!validId(b.projectId) || !listProjects().some((p) => p.id === b.projectId))) return json(res, 400, { error: 'unknown project' });
      let dir = full ? '' : workspaceDir(b.projectId), file = null;
      if (b.path) {
        try { const t = full || safePath(dir, String(b.path)); if (fs.statSync(t).isDirectory()) dir = t; else { file = t; dir = path.dirname(t); } }
        catch (e) { return json(res, 400, { error: e.code === 'ENOENT' ? 'that file is gone' : e.message }); }
      }
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [file ? `/select,${file}` : dir]] : process.platform === 'darwin' ? ['open', file ? ['-R', file] : [dir]] : ['xdg-open', [dir]];
      try { openDetached(cmd, args); return json(res, 200, { ok: true, dir }); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    // Which of the paths a reply names are there: { found: { path: 'file' | 'dir' } }. The page makes those into links
    // that show them in File Explorer. A path is inside the project (relative to it) or a full one.
    if (url.pathname === '/api/paths/check' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e5) || '{}');
      const root = validId(b.projectId) && listProjects().some((p) => p.id === b.projectId) ? workspaceDir(b.projectId) : null;
      const found = {};
      for (const p of (Array.isArray(b.paths) ? b.paths : []).slice(0, 200).map(String)) {
        try {
          const full = fullLocalPath(p), t = full || (full === '' && root ? safePath(root, p) : null);
          if (t) found[p] = fs.statSync(t).isDirectory() ? 'dir' : 'file';
        } catch { /* not there, or outside the project */ }
      }
      return json(res, 200, { found });
    }
    if (url.pathname === '/api/files/text' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid) || !listProjects().some((p) => p.id === pid)) return json(res, 400, { error: 'unknown project' });
      try {
        const file = safePath(workspaceDir(pid), String(url.searchParams.get('path') || ''));
        if (fs.statSync(file).size > 60e6) return json(res, 200, { error: 'too big to preview (over 60 MB)' });
        return json(res, 200, { text: officeText(file).slice(0, 400000) });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // One text file of a project, in windows of up to 100k characters (for the MCP server's read_file).
    if (url.pathname === '/api/files/read' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid) || !listProjects().some((p) => p.id === pid)) return json(res, 400, { error: 'unknown project' });
      try {
        const file = safePath(workspaceDir(pid), String(url.searchParams.get('path') || ''));
        const st = fs.statSync(file);
        if (!st.isFile()) return json(res, 200, { error: 'not a file' });
        if (st.size > 20e6) return json(res, 200, { error: 'too big to read (over 20 MB)' });
        const buf = fs.readFileSync(file);
        if (buf.subarray(0, 8000).includes(0)) return json(res, 200, { error: 'a binary file', size: st.size });
        const text = buf.toString('utf8'), off = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return json(res, 200, { text: text.slice(off, off + 100000), offset: off, total: text.length, more: off + 100000 < text.length });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // A flat list for the pickers (@ files, the palette, a project as context): `limit` paths (20 000 by default), or
    // with q only paths holding every word, found within 2 s. The Files pane reads folder by folder (/api/files/dir).
    if (url.pathname === '/api/files' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      const limit = Math.max(1, Math.min(100000, Number(url.searchParams.get('limit')) || 20000));
      const words = String(url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
      // At most 1.5 s of walking either way: a project with a million files never holds the server up.
      return json(res, 200, listFiles(workspaceDir(pid), limit, { until: Date.now() + 1500, ...(words.length ? { match: (p) => words.every((w) => p.includes(w)) } : {}) }));
    }
    // One folder of a project for the Files pane, a page at a time.
    if (url.pathname === '/api/files/dir' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, await listDir(workspaceDir(pid), String(url.searchParams.get('path') || ''), { offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') })); }
      catch (e) { return json(res, 200, { error: e.code === 'ENOENT' ? 'that folder is gone' : e.message }); }
    }
    // When anything in a project folder last changed (previews of sites and apps reload on a change).
    if (url.pathname === '/api/files/stamp' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, folderStamp(workspaceDir(pid))); } catch (e) { return json(res, 200, { stamp: 0, error: e.message }); }
    }
    // Page artifacts, hosted: always the newest version, sandboxed (see server/artifacts.js).
    const am = url.pathname.match(/^\/art\/([a-z0-9-]+)\/([\w.-]+)$/i);
    if (am && req.method === 'GET') {
      if (!validId(am[1])) return json(res, 400, { error: 'bad chat id' });
      // On the shared pages address an artifact is opened, never read by another page's script.
      if (req.pageOrigin && req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'navigate') return json(res, 404, { error: 'not found' });
      const content = artifactContent(am[1], am[2]);
      const headers = { ...ARTIFACT_HEADERS };
      if (req.pageOrigin) delete headers['Content-Security-Policy'];
      if (!content) { res.writeHead(404, headers); return res.end('<!doctype html><body style="font:14px system-ui;color:#889;background:#0b0f0d;padding:24px">This artifact is not available (the chat may have been deleted or cleared).</body>'); }
      res.writeHead(200, headers); return res.end(servedArtifact(content));
    }
    const pm = url.pathname.match(/^\/preview\/page\/([a-z0-9]+)$/i);
    if (pm) { const h = hostedHtml(pm[1]); if (h == null) return json(res, 404, { error: 'expired' }); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(req.pageOrigin ? {} : { 'Content-Security-Policy': SANDBOX_CSP }) }); return res.end(h); }

    // ---- skills (for the Settings list) and undo ----
    // ⚙ Settings → Setup check (server/setup-check.js). Fixes open winget on this computer, so only its own windows may ask.
    if (url.pathname === '/api/setup-check' && req.method === 'GET') return json(res, 200, await setupCheck());
    if (url.pathname === '/api/setup-check/fix' && req.method === 'POST') {
      if (!isLoopback(req)) return json(res, 403, { error: 'Fixes run only from the computer running QuorX.' });
      try { return json(res, 200, runFix(JSON.parse(await readBody(req, 1e4) || '{}').id)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/starters' && req.method === 'GET') return json(res, 200, listTemplates().map(({ name, description }) => ({ name, description })));
    // Your own skills ('mine', every project) and a project's ('project') can be written, edited and trashed here.
    if (url.pathname.startsWith('/api/skills')) {
      const dirOf = (pid) => (validId(pid) ? (() => { try { return workspaceDir(pid); } catch { return null; } })() : null);
      if (url.pathname === '/api/skills' && req.method === 'GET') return json(res, 200, listSkills(dirOf(url.searchParams.get('project'))).map(({ name, description, source }) => ({ name, description, source })));
      if (url.pathname === '/api/skills/one' && req.method === 'GET') {
        const q = url.searchParams, k = getSkill(dirOf(q.get('project')), q.get('name'), q.get('where'));
        return k ? json(res, 200, k) : json(res, 404, { error: 'no such skill' });
      }
      if (url.pathname === '/api/skills' && (req.method === 'POST' || req.method === 'DELETE')) {
        const b = JSON.parse(await readBody(req, 3e5) || '{}'), dir = dirOf(b.projectId);
        try {
          if (req.method === 'DELETE') { deleteSkill(dir, String(b.name || ''), b.where); return json(res, 200, { ok: true }); }
          const where = b.where === 'mine' ? 'mine' : 'project';
          const was = b.was && typeof b.was === 'object' ? { name: String(b.was.name || ''), where: b.was.where === 'mine' ? 'mine' : 'project' } : null;
          if (!was && getSkill(dir, skillId(b.name), where)) throw new Error('there is already a skill with that name there: edit it instead');
          return json(res, 200, { ok: true, name: saveSkill(dir, b, { where, by: 'written by you', was }) });
        } catch (e) { return json(res, 200, { error: e.message }); }
      }
    }
    // Replies that can still be undone (the newest ones; see pruneCheckpoints).
    if (url.pathname === '/api/checkpoints' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      try {
        const root = workspaceDir(pid);
        if (url.searchParams.get('keep')) pruneCheckpoints(root, { keep: Number(url.searchParams.get('keep')), days: Number(url.searchParams.get('days')) || 7 });
        return json(res, 200, listCheckpoints(root));
      } catch (e) { return json(res, 200, { error: e.message, list: [] }); }
    }
    // Review changes: the files a reply changed, one file's diff, and Undo for one file (server/workspace.js).
    if (url.pathname === '/api/review' && req.method === 'GET') {
      const q = url.searchParams, pid = q.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, q.get('path') ? reviewDiff(workspaceDir(pid), q.get('run'), q.get('path')) : reviewFiles(workspaceDir(pid), q.get('run'))); }
      catch (e) { return json(res, 200, { error: e.message }); }
    }
    // /review in a chat: a reviewer model reads what changed (the last reply, uncommitted changes, or the branch)
    // and returns bugs with file:line. Its cost goes to the project's ledger and budget like a reply's.
    if (url.pathname === '/api/code-review' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      const st = budgetState(b.projectId);
      if (st.budget != null && st.left <= 0) return json(res, 200, { error: 'This project has reached its budget. Raise it in the sidebar to run a review.' });
      try {
        const model = pickReviewer({ reviewModel: b.reviewModel, reviewTier: b.reviewTier }, String(b.chatModel || ''), { REVIEW_MODEL, REVIEW_ALT, REVIEW_STRONG, REVIEW_STRONG_ALT });
        const info = (await chatModels().catch(() => [])).find((m) => m.id === model) || {};
        const r = await reviewCode(workspaceDir(b.projectId), { scope: String(b.scope || 'auto'), runId: validRunId(String(b.runId || '')) ? String(b.runId) : '', base: String(b.base || ''), ask: String(b.ask || ''), model, info }, { chat });
        const id = `cr-${Date.now().toString(36)}`;
        if (r.cost) recordRun({ ts: new Date().toISOString(), runId: id, kind: 'review', project: b.projectId, chatId: b.chatId || null, model, stop: r.scope, cost: +r.cost.toFixed(6) });
        return json(res, 200, { ...r, id });
      } catch (e) { return json(res, 200, { error: e.message, empty: !!e.empty }); }
    }
    if (url.pathname === '/api/review/undo' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, undoFile(workspaceDir(b.projectId), String(b.runId), String(b.path || ''), { force: !!b.force })); }
      catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/checkpoints/restore' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4));
      if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      try {
        const root = workspaceDir(b.projectId), runId = String(b.runId);
        // Files changed again since this reply: ask first, then undo everything ("all") or only the rest ("rest").
        const conflicts = undoConflicts(root, runId);
        if (conflicts.length && !b.mode) return json(res, 200, { conflicts });
        const only = conflicts.length && b.mode === 'rest' ? changedFiles(root, runId).filter((f) => !conflicts.includes(f)) : undefined;
        return json(res, 200, { restored: restoreCheckpoint(root, runId, { only }), conflicts });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // ---- dev servers and the project's launch configs (.quorx/launch.json) ----
    if (url.pathname === '/api/servers' && req.method === 'GET') return json(res, 200, listServers(url.searchParams.get('project') || undefined));
    if (url.pathname === '/api/servers/overview' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, { servers: serverOverview(pid), jobs: runningJobs(pid) }); } catch (e) { return json(res, 200, { error: e.message, code: e.code, servers: [], jobs: [] }); }
    }
    if (url.pathname === '/api/servers/log' && req.method === 'GET') return json(res, 200, { log: serverLog(url.searchParams.get('key')) });
    if (url.pathname === '/api/servers/stop' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4)); const r = await stopServerWait(b.key, 'you'); return json(res, 200, { ok: !!r, ...(r || {}) }); }
    if (url.pathname === '/api/servers/start' && req.method === 'POST') {
      // Start a server you picked: a saved launch config by name, or an app's saved command.
      const b = JSON.parse(await readBody(req, 1e4));
      try {
        const saved = !b.cmd && launchConfigs(b.projectId).find((x) => x.name.toLowerCase() === String(b.name || '').toLowerCase());
        if (!b.cmd && !saved) return json(res, 200, { error: `no launch config named "${b.name}"` });
        const cfg = saved || { command: b.cmd, args: b.args || [], port: b.port };
        return json(res, 200, await startServer({ projectId: b.projectId, name: b.name, cmd: cfg.command, args: (cfg.args || []).map(String), port: cfg.port || undefined, source: 'you' }));
      } catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/servers/restart' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4));
      try { return json(res, 200, await restartServer(b.key, 'you')); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/launch' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4));
      if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, { ok: true, config: saveLaunchConfig(b.projectId, b) }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/launch' && req.method === 'DELETE') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      return json(res, 200, { ok: removeLaunchConfig(pid, url.searchParams.get('name')) });
    }

    // ---- command permissions: the rules the rule engine applies, per project and everywhere ----
    if (url.pathname === '/api/permissions' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      const root = pid && validId(pid) ? workspaceDir(pid) : null;
      const rules = loadRules(root).map((r) => ({ ...r, problem: ruleProblem(r.match) || undefined }));
      return json(res, 200, { project: rules.filter((r) => r.scope === 'project'), everywhere: rules.filter((r) => r.scope === 'everywhere'),
        suggested: root ? suggestedRules(root, rules) : [], stop: (await jobsAvailable(), jobHostStatus()), shell: shellInfo().name });
    }
    if (url.pathname === '/api/permissions' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 2e5));
      if (b.scope === 'project' && !validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      if (!['project', 'everywhere'].includes(b.scope)) return json(res, 400, { error: 'scope must be project or everywhere' });
      try { return json(res, 200, { ok: true, rules: saveRules(b.scope, b.rules, b.scope === 'project' ? workspaceDir(b.projectId) : null) }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // One rule at a time, by id: turn it on or off (PATCH { on }), or remove it (DELETE).
    if (url.pathname === '/api/permissions/rule' && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      if (!['project', 'everywhere'].includes(b.scope)) return json(res, 400, { error: 'scope must be project or everywhere' });
      if (b.scope === 'project' && !validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      const root = b.scope === 'project' ? workspaceDir(b.projectId) : null;
      const rules = req.method === 'PATCH' ? updateRule(b.scope, String(b.id || ''), { on: b.on }, root) : removeRule(b.scope, String(b.id || ''), root);
      return rules ? json(res, 200, { ok: true, rules }) : json(res, 404, { error: 'no such rule' });
    }
    // What each chat of a project allows on its own (its rules, tools, apps and folders), for the project's
    // Permissions section. Read only: a chat's own list changes in that chat.
    if (url.pathname === '/api/permissions/chats' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      const chats = listChats().filter((c) => c.projectId === pid).slice(0, 300).flatMap((c) => {
        const a = getChat(c.id)?.agent || {};
        const n = (a.cmdRules || []).length + (a.allowed || []).length + (a.apps || []).length + (a.folders || []).length;
        return n ? [{ id: c.id, title: c.title || 'Untitled chat', cmdRules: a.cmdRules || [], allowed: a.allowed || [], apps: a.apps || [], folders: a.folders || [] }] : [];
      });
      return json(res, 200, { chats });
    }
    // ---- memory: facts and preferences every chat gets (server/memory.js); the agent can only propose ----
    if (url.pathname === '/api/memory' && req.method === 'GET') { const m = loadMemory(); return json(res, 200, { ...m, tokens: memoryTokens(m.items), limit: MEMORY_TOKENS }); }
    if (url.pathname === '/api/memory' && req.method === 'PUT') {
      const b = JSON.parse(await readBody(req, 1e5) || '{}');
      try { const m = saveMemory(b); return json(res, 200, { ok: true, ...m, tokens: memoryTokens(m.items), limit: MEMORY_TOKENS }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // ---- scheduled tasks: list, add, change (pause, resume), remove, run now; and notices for the page ----
    if (url.pathname === '/api/schedules' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json(res, 200, { schedules: loadSchedules().map(scheduleView), notices: notices.filter((n) => n.id > since), noticeSeq, now: Date.now() });
    }
    if (url.pathname === '/api/schedules' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 5e5) || '{}');
      try { return json(res, 200, { ok: true, schedule: scheduleView(addSchedule(b, { projects: listProjects() })) }); }
      catch (e) { return json(res, 200, { error: e.message }); }
    }
    const scm = url.pathname.match(/^\/api\/schedules\/([\w-]{1,40})(\/run)?$/);
    if (scm) {
      if (!loadSchedules().some((s) => s.id === scm[1])) return json(res, 404, { error: 'no such schedule' });
      if (req.method === 'DELETE' && !scm[2]) { removeSchedule(scm[1]); return json(res, 200, { ok: true }); }
      if (req.method === 'PUT' && !scm[2]) {
        const b = JSON.parse(await readBody(req, 5e5) || '{}');
        try { return json(res, 200, { ok: true, schedule: scheduleView(changeSchedule(scm[1], b)) }); }
        catch (e) { return json(res, 200, { error: e.message }); }
      }
      if (req.method === 'POST' && scm[2]) {
        try { return json(res, 200, { ok: true, ...(await runScheduleNow(scm[1])) }); }
        catch (e) { return json(res, 200, { error: e.message }); }
      }
    }
    // ---- hooks: the user's commands around the agent's tool calls, per project, kept in the data folder ----
    const hkm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/hooks$/i);
    if (hkm) {
      if (!validId(hkm[1]) || !listProjects().some((p) => p.id === hkm[1])) return json(res, 400, { error: 'unknown project' });
      if (req.method === 'GET') return json(res, 200, { hooks: loadHooks(workspaceDir(hkm[1])), events: HOOK_EVENTS });
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req, 1e5) || '{}');
        try { return json(res, 200, { ok: true, hooks: saveHooks(workspaceDir(hkm[1]), b.hooks) }); } catch (e) { return json(res, 200, { error: e.message }); }
      }
    }
    if (url.pathname === '/api/audit' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      return json(res, 200, readAudit({ project: pid && validId(pid) ? pid : null, limit: Math.min(1000, Number(url.searchParams.get('limit')) || 200) }));
    }
    if (url.pathname === '/api/permissions/test' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 2e4));
      const root = b.projectId && validId(b.projectId) ? workspaceDir(b.projectId) : process.cwd();
      const S = safetySettings(b.safety);
      try {
        const d = await decideCommand(String(b.line || ''), { shell: S.shell, root, rules: [...(Array.isArray(b.chatRules) ? b.chatRules : []), ...loadRules(b.projectId && validId(b.projectId) ? root : null)],
          mode: b.mode === 'yolo' ? 'yolo' : 'strict', yolo: yoloOf(S) });
        return json(res, 200, { verdict: d.verdict, who: d.who, why: d.why, decidedBy: d.decidedBy, hint: d.hint, shell: d.shell,
          segments: d.segments.map((s) => ({ text: s.text, cls: s.cls, verdict: s.verdict, who: s.who, why: s.why, decidedBy: s.decidedBy, paths: (s.paths || []).map((p) => ({ path: p.resolved || p.raw, zone: p.zone, kind: p.kind, why: p.why })) })) });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // ---- terminal: live output of every command and server in a project; you can run commands too ----
    if (url.pathname === '/api/term/stream' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
      const stop = followTerm(pid, Math.max(0, Number(url.searchParams.get('from')) || 0), (e) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); });
      res.on('close', () => { clearInterval(ping); stop(); });
      return;
    }
    // Your terminal tabs: each is a real shell (PowerShell on Windows, your login shell elsewhere) that starts in the
    // project folder. The agent never uses this route: its run_command keeps the allow-list.
    if (url.pathname === '/api/term/run' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 2e4));
      if (!validId(b.projectId) || !listProjects().some((p) => p.id === b.projectId)) return json(res, 400, { error: 'unknown project' });
      const line = String(b.line ?? '').replace(/\r?\n/g, ' ');
      const tab = String(b.tab || '').replace(/[^\w-]/g, '').slice(0, 40) || 'u1';
      try { return json(res, 200, shellRun(b.projectId, tab, line, workspaceDir(b.projectId))); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // The full terminal (node-pty + xterm.js): open a tab's terminal, follow its output, send keys, resize, close.
    if (url.pathname.startsWith('/api/pty/')) {
      const op = url.pathname.slice(9);
      const b = req.method === 'POST' ? JSON.parse(await readBody(req, 200_000) || '{}') : {};
      const pid = String(b.projectId || url.searchParams.get('project') || ''), tab = String(b.tab || url.searchParams.get('tab') || '').replace(/[^\w-]/g, '').slice(0, 40);
      if (!validId(pid) || !listProjects().some((p) => p.id === pid) || !tab) return json(res, 400, { error: 'unknown project or tab' });
      if (op === 'open' && req.method === 'POST') { try { const t = ptyOpen(pid, tab, workspaceDir(pid), b.cols, b.rows); return json(res, 200, { ok: true, shell: t.shell }); } catch (e) { return json(res, 200, { error: e.message, fallback: true }); } }
      if (op === 'input' && req.method === 'POST') return json(res, 200, { ok: ptyWrite(pid, tab, b.data ?? '') });
      if (op === 'resize' && req.method === 'POST') return json(res, 200, { ok: ptyResize(pid, tab, b.cols, b.rows) });
      if (op === 'close' && req.method === 'POST') return json(res, 200, { ok: ptyClose(pid, tab) });
      if (op === 'stream' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
        const stop = ptyFollow(pid, tab, (e) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); });
        res.on('close', () => { clearInterval(ping); stop(); });
        return;
      }
      return json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/term/close' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4));
      return json(res, 200, { ok: shellClose(String(b.projectId || ''), String(b.tab || '').replace(/[^\w-]/g, '').slice(0, 40)) });
    }
    if (url.pathname === '/api/term/stop' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4)); const r = await stopJob(String(b.job)); return json(res, 200, { ok: !!r, ...(r || {}) }); }
    // ---- the Running tab: everything running in a project, and stopping any of it ----
    if (url.pathname === '/api/running' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, runningIn(pid)); } catch (e) { return json(res, 200, { error: e.message, items: [], elsewhere: [] }); }
    }
    if ((url.pathname === '/api/running/stop' || url.pathname === '/api/running/stop-all') && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4));
      if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, { ok: true, ...(url.pathname.endsWith('all') ? await stopAllIn(b.projectId) : await stopRunning(b.projectId, b.id)) }); }
      catch (e) { return json(res, 200, { error: e.message }); }
    }

    // ---- the agent's own folder (.quorx: scratch, undo checkpoints, trash): its size, and clearing it ----
    // ---- ⟳ restart (a fresh copy of this harness takes over the port) and stop: only from this computer ----
    if ((url.pathname === '/api/harness/restart' || url.pathname === '/api/harness/stop') && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      if (!/^(127\.|::1$|::ffff:127\.)/.test(ip)) return json(res, 403, { error: 'only from the computer running QuorX' });
      const restart = url.pathname.endsWith('/restart');
      json(res, 200, { ok: true, restarting: restart, port: runtime.port });
      setTimeout(() => shutDown(restart), 250);
      return;
    }
    // ---- the desktop app's link (see server/desktop.js): only from this computer ----
    if (url.pathname.startsWith('/api/desktop/')) {
      const ip = req.socket.remoteAddress || '';
      if (!/^(127\.|::1$|::ffff:127\.)/.test(ip) || req.headers.origin) return json(res, 403, { error: 'the desktop link is only for the app on this computer' });
      if (url.pathname === '/api/desktop/link' && req.method === 'GET') return openLink(req, res, url.searchParams.get('token'));
      if (url.pathname === '/api/desktop/reply' && req.method === 'POST') return json(res, linkReply(JSON.parse(await readBody(req, 50e6) || '{}')) ? 200 : 403, {});
    }
    // ✨ Enhance in the composer: the draft rewritten clearer and fuller, before the user sends it.
    if (url.pathname === '/api/enhance-prompt' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 2e5) || '{}');
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { error: 'nothing to enhance' });
      try {
        const r = await rewritePrompt({ text, earlier: Array.isArray(b.earlier) ? b.earlier.map(String).slice(-3) : [], model: String(b.model || '').trim() || HELPER_MODEL });
        return json(res, 200, r || { error: 'the model gave nothing usable' });
      } catch (e) { return json(res, 200, { error: /auth|401|api key/i.test(e.message) ? 'add an OpenRouter key in ⚙ Settings → API keys first' : e.message }); }
    }
    // ---- the Browser tab's "your view" for sites that refuse frames (see server/userbrowser.js) ----
    if (url.pathname === '/api/ubrowser' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e5) || '{}');
      try { return json(res, 200, await userBrowse(String(b.sid || ''), String(b.op || 'look'), b)); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // ---- 🧩 the QuorX Chrome extension: its connection key (⚙ Settings) and whether it is connected ----
    if (url.pathname === '/api/ext/state' && req.method === 'GET') return json(res, 200, { ...extInfo(), pairing: extPairing() });
    if (url.pathname === '/api/ext/pair' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e3) || '{}'); return json(res, 200, { ok: extPair(!!b.allow) }); }
    if (url.pathname === '/api/ext/status' && req.method === 'GET') return json(res, 200, { ...extInfo(), key: extKey(), lent: lentChromeTabs(), folder: path.join(ROOT, 'extension'), pairing: extPairing(), browser: await defaultBrowser() });
    if (url.pathname === '/api/ext/key' && req.method === 'POST') return json(res, 200, { key: extKey(true) });
    // ⚙ Settings → Chrome extension: open chrome://extensions in your Chrome, or show the extension's folder.
    if (url.pathname === '/api/ext/open-chrome' && req.method === 'POST') {
      // Your default browser's extensions page (brave://extensions for Brave…).
      const b = await defaultBrowser();
      if (!b) return json(res, 200, { error: 'no Chromium browser (Chrome, Brave, Edge…) was found on this computer' });
      if (!b.page) return json(res, 200, { error: `${b.name} can't run this extension: use Chrome, Brave or Edge` });
      try { openDetached(b.exe, [b.page]); return json(res, 200, { ok: true, browser: b.name }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/ext/show-folder' && req.method === 'POST') {
      const dir = path.join(ROOT, 'extension');
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
      try { openDetached(cmd, args); return json(res, 200, { ok: true }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // ---- 🤖 Give to agent: lend one of your Browser tabs to a chat, or take it back ----
    if (url.pathname === '/api/given-tab') {
      const chatId = String(url.searchParams.get('chat') || '');
      if (req.method === 'GET') return json(res, 200, { given: validId(chatId) ? givenTab(chatId) : null });
      if (req.method === 'DELETE') return json(res, 200, { ok: validId(chatId) && takeBackTab(chatId) });
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req, 1e4) || '{}');
        if (!validId(b.chatId)) return json(res, 400, { error: 'bad chat id' });
        try { return json(res, 200, { given: giveTab(b.chatId, String(b.sid || ''), b) }); } catch (e) { return json(res, 200, { error: e.message }); }
      }
    }
    // ---- export from the pane: a page as PDF or one long PNG, or the project's files as a ZIP ----
    if (url.pathname === '/api/export' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e5) || '{}');
      const fmt = String(b.format || ''), safeName = (s) => String(s || 'export').replace(/[^\w .-]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'export';
      const send = (buf, type, name) => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }); res.end(buf); };
      try {
        if (fmt === 'zip') {
          if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
          const proj = listProjects().find((p) => p.id === b.projectId);
          const r = await zipFolder(workspaceDir(b.projectId));
          if (r.skipped.length) res.setHeader('X-Skipped', String(r.skipped.length));
          return send(r.zip, 'application/zip', `${safeName(proj?.name || b.projectId)}.zip`);
        }
        if (fmt !== 'pdf' && fmt !== 'png') return json(res, 400, { error: 'format must be pdf, png or zip' });
        const target = String(b.url || '');
        if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: 'only http and https pages can be exported' });
        const tab = await openTab();
        try {
          await tab.open(target, { width: Math.max(360, Math.min(1920, Number(b.width) || 1280)), height: 900 });
          await new Promise((r) => setTimeout(r, 900));
          const title = await tab.eval('document.title').catch(() => '');
          return fmt === 'pdf' ? send(await tab.pdf({ landscape: !!b.landscape }), 'application/pdf', `${safeName(title)}.pdf`) : send(await tab.fullPage(), 'image/png', `${safeName(title)}.png`);
        } finally { await tab.close().catch(() => {}); }
      } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // ---- Export my QuorX / Import (server/backup.js) ----
    if (url.pathname.startsWith('/api/backup/') && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 5e6) || '{}');
      try {
        // A pass for putting API keys in a backup: asked for by the page right after you confirm, used once, gone in a
        // minute. Only the page's own request gets one (the browser marks it same-origin; other programs send no such
        // header), so a program holding the app key can't export your keys in plain text unasked.
        if (url.pathname === '/api/backup/key-pass') {
          if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty') return json(res, 403, { error: 'only the QuorX page can ask to export your keys' });
          return json(res, 200, { pass: keyPass() });
        }
        // API keys go in only with both boxes ticked and a fresh pass from the confirmation.
        if (url.pathname === '/api/backup/export') return json(res, 200, await exportBackup({ dir: String(b.dir || ''), settings: b.settings && typeof b.settings === 'object' ? b.settings : null, includeLogs: b.logs === true, includeKeys: b.keys === true && b.keysWarned === true && takeKeyPass(b.keyPass), version: VERSION }));
        if (url.pathname === '/api/backup/find') return json(res, 200, { backups: findBackups(String(b.dir || '')) });
        if (url.pathname === '/api/backup/inspect') return json(res, 200, inspectBackup(String(b.file || '')));
        if (url.pathname === '/api/backup/import') return json(res, 200, importBackup(String(b.file || ''), { overwrite: b.overwrite === true, folders: b.folders || {}, skip: Array.isArray(b.skip) ? b.skip : [], keys: b.keys === true && isLoopback(req) }));
        return json(res, 404, { error: 'no such backup call' });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // ---- attached documents: upload, read and index, list, remove (see server/docs.js) ----
    if (url.pathname === '/api/docs/upload' && req.method === 'POST') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      const max = Math.max(1, Number(url.searchParams.get('max')) || DOC_DEFAULTS.maxUploadMB) * 1e6;
      try { const buf = await readRaw(req, max); return json(res, 200, saveUpload(pid, url.searchParams.get('name') || 'file', buf, req.headers['content-type'])); }
      catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/docs/process' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e5));
      if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      try { return json(res, 200, await processDoc(b.projectId, String(b.id), { settings: b.settings, confirm: !!b.confirm, ocr: !!b.ocr, chatId: b.chatId })); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/docs' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      return json(res, 200, listDocs(pid));
    }
    if (url.pathname === '/api/docs' && req.method === 'DELETE') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      return json(res, 200, { ok: removeDoc(pid, String(url.searchParams.get('id'))) });
    }
    if (url.pathname === '/api/docs/models' && req.method === 'GET') {
      try { return json(res, 200, { defaults: DOC_DEFAULTS, models: await embeddingModels() }); } catch (e) { return json(res, 200, { defaults: DOC_DEFAULTS, models: [], error: e.message }); }
    }
    if (url.pathname === '/api/agent-space' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      try { const root = workspaceDir(pid); ensureAgentDir(root); return json(res, 200, agentSpace(root)); } catch (e) { return json(res, 200, { error: e.message, code: e.code }); }
    }
    // 🧹 in a chat header: the parts of .quorx you ticked and confirmed (scratch, agent trash, older undo, snapshots).
    if (url.pathname === '/api/agent-space/clear' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      return json(res, 200, await previewProjectParts(pid, { keep: Number(url.searchParams.get('keep')) || 10 }));
    }
    if (url.pathname === '/api/agent-space/clear' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      const r = await clearProjectParts(b.projectId, Array.isArray(b.parts) ? b.parts : [], { keep: Number(b.keep) || 10 });
      return json(res, r.busy ? 409 : 200, r);
    }

    // ---- ⚙ Settings → Storage (server/storage.js): sizes, clearing (QuorX's own data folder only), and the automatic cleanup rules ----
    if (url.pathname === '/api/storage' && req.method === 'GET') return json(res, 200, await measureStorage({ keep: Number(url.searchParams.get('keep')) || 10 }));
    if (url.pathname === '/api/storage/clear' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e5) || '{}');
      if (!Array.isArray(b.items) || !b.items.length) return json(res, 400, { error: 'nothing to clear' });
      const r = await clearStorage(b.items.slice(0, 500));
      return json(res, r.busy ? 409 : 200, r);
    }
    if (url.pathname === '/api/storage/rules') {
      if (req.method === 'POST') return json(res, 200, saveStorageRules(JSON.parse(await readBody(req, 1e4) || '{}')));
      return json(res, 200, storageRules());
    }
    if (url.pathname === '/api/storage/log' && req.method === 'GET') return json(res, 200, recentClears());

    // ---- "Browse…": the computer's own folder dialog (only for someone sitting at this computer) ----
    // A template starts a NEW project: a fresh folder <parent>/<name>, the template copied in, then the project.
    // A folder that already has files is refused, so a template never lands in an existing codebase.
    if (url.pathname === '/api/projects/from-template' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      const t = listTemplates().find((x) => x.name === b.template);
      if (!t) return json(res, 200, { error: 'no such template' });
      const name = String(b.name || '').trim();
      if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /^\.+$/.test(name)) return json(res, 200, { error: 'give the folder a plain name (no / \\ : * ? " < > |)' });
      const parent = String(b.parent || '');
      if (!parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return json(res, 200, { error: 'that location is not a folder' });
      const dir = path.join(parent, name);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) return json(res, 200, { error: `${dir} already has files in it. Pick another name, so the template starts in an empty folder.`, code: 'NOT_EMPTY' });
      const made = !fs.existsSync(dir);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const id = `p${Date.now().toString(36)}`;
        const p = saveProject({ id, name, path: dir });
        const copied = copyTemplate(dir, t.dir);
        return json(res, 200, { ok: true, id: p.id || id, name: p.name || name, dir, written: copied.written, start: t.start || null });
      } catch (e) {
        if (made) { try { fs.rmdirSync(dir); } catch { /* not empty or already gone */ } } // a refused folder isn't left behind
        return json(res, 200, { error: e.message });
      }
    }
    if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      if (!/^(127\.|::1$|::ffff:127\.)/.test(ip)) return json(res, 403, { error: 'the folder dialog opens on the computer running QuorX; type the path instead' });
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      try { return json(res, 200, { path: await pickFolder(b.start) }); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // Model cards (models/cards/): limits, quirks, tips and QuorX's results, shown on hover next to each rating.
    if (req.method === 'GET' && url.pathname === '/api/model-cards') return json(res, 200, uiCards());
    if (req.method === 'GET' && url.pathname === '/api/models') {
      if (url.searchParams.get('refresh')) clearCatalogues();
      // Each catalogue loads on its own, so one failing list doesn't hide the others. The lists are
      // public (no key needed); if none of them load, the page shows why and offers a retry.
      const errors = [];
      const safe = (name, p) => p.catch((e) => { errors.push(`${name}: ${e.message}`); return []; });
      const [chat, dec, img, tts, mus, vid] = await Promise.all([safe('chat', chatModels()), safe('decisions', decisionModels()), safe('images', imageModels()), safe('voices', speechModels()), safe('music', musicModels()), safe('video', videoModels())]);
      if (!chat.length && !dec.length) return json(res, 502, { error: `Could not load the model lists from OpenRouter (${errors[0] || 'no answer'}).` });
      // Audio-capable chat models double as the "listen" (speech-to-text) category.
      const ears = chat.filter((m) => m.in.includes('audio')).map((m) => ({ ...m, kind: 'listen' }));
      return json(res, 200, [...dec, ...img, ...tts, ...mus, ...vid, ...ears, ...chat.filter((m) => m.tools)]);
    }
    if (req.method === 'GET' && url.pathname === '/api/balance') {
      try { return json(res, 200, await activeUsage()); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // ---- OpenRouter keys (stored in data/keys.json; the page only ever gets them masked) ----
    if (url.pathname === '/api/keys' && req.method === 'GET') return json(res, 200, listKeys());
    if (url.pathname === '/api/keys' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      try { const r = await addKey(b.key, b.label); clearCatalogues(); return json(res, 200, { ok: true, id: r.id, keys: listKeys() }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/credits' && req.method === 'GET') {
      try { return json(res, 200, await accountCredits()); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    // Sign in with OpenRouter (server/oauth.js): start, ask how it went, paste the code (other devices), cancel.
    const sm = url.pathname.match(/^\/api\/keys\/signin(?:\/([\w-]+)(?:\/(code))?)?$/);
    if (sm) {
      if (!sm[1] && req.method === 'POST') return json(res, 200, startSignIn(req.headers.origin || `http://${req.headers.host}`));
      if (sm[1] && !sm[2] && req.method === 'GET') return json(res, 200, signInStatus(sm[1]));
      if (sm[1] && !sm[2] && req.method === 'DELETE') { cancelSignIn(sm[1]); return json(res, 200, { ok: true }); }
      if (sm[1] && sm[2] && req.method === 'POST') {
        try { await finishWithCode(sm[1], JSON.parse(await readBody(req, 1e4) || '{}').code); clearCatalogues(); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    const km =url.pathname.match(/^\/api\/keys\/([a-z0-9]+)(?:\/(usage|activate))?$/i);
    if (km) {
      try {
        if (km[2] === 'usage' && req.method === 'GET') return json(res, 200, await keyUsage(km[1]));
        if (km[2] === 'activate' && req.method === 'POST') { setActive(km[1]); clearCatalogues(); return json(res, 200, { ok: true, keys: listKeys() }); }
        if (!km[2] && req.method === 'PATCH') { renameKey(km[1], JSON.parse(await readBody(req, 1e4) || '{}').label); return json(res, 200, { ok: true, keys: listKeys() }); }
        if (!km[2] && req.method === 'DELETE') { removeKey(km[1]); return json(res, 200, { ok: true, keys: listKeys() }); }
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      // The mic: a WAV recording from the page goes to an audio-capable chat model.
      const b = JSON.parse(await readBody(req, 30e6));
      const allowed = DEFAULTS.tools.listen.models;
      const model = String(b.model || allowed[0]);
      try { const r = await transcribe({ model, audio: String(b.audio || ''), format: 'wav' }); return json(res, 200, { text: r.text, cost: r.usage.cost || 0, ms: r.ms, model }); }
      catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const b = JSON.parse(await readBody(req, 1e5));
      return json(res, 200, { ok: answerApproval(b.runId, b.id, b) });
    }
    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const b = JSON.parse(await readBody(req, 1e5));
      return json(res, 200, { ok: answerQuestion(b.runId, b.id, b) });
    }
    // request_secret's card: the value goes into the project's .env and nowhere else (never logged or saved in the chat).
    if (req.method === 'POST' && url.pathname === '/api/secret') {
      const b = JSON.parse(await readBody(req, 1e5));
      return json(res, 200, { ok: answerSecret(String(b.runId || ''), String(b.id || ''), { value: b.value, skip: !!b.skip }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/budget-stop') {
      const b = JSON.parse(await readBody(req, 1e4));
      return json(res, 200, { ok: answerBudget(b.runId, b.id) });
    }
    if (req.method === 'POST' && url.pathname === '/api/raise-cap') {
      const b = JSON.parse(await readBody(req, 1e4));
      return json(res, 200, { ok: raiseCap(b.runId, b.id, b.to) });
    }
    // A run belongs to the server, not to the page that started it: closing or reloading the page
    // leaves it working, and the page reattaches with /api/runs/<id>/events. Stop is explicit.
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = JSON.parse(await readBody(req));
      const runId = validRunId(String(body.runId || '')) ? String(body.runId) : `r${Date.now().toString(36)}`;
      body.runId = runId;
      // One reply at a time per chat: a second one would race the first over the same history and files.
      const busy = !getRun(runId) && runningForChat(body.chatId);
      if (busy) return json(res, 409, { error: 'This chat is already running a reply: stop it or wait for it to finish.', runId: busy.id });
      if (!getRun(runId)) startRun({ runId, chatId: body.chatId, onEnd: (end) => body.chatId && settleReply(String(body.chatId), runId, end) }, (emit, signal) => runAgent(body, emit, signal));
      return stream(res, runId, 0);
    }
    const rm = url.pathname.match(/^\/api\/runs\/([\w-]+)(?:\/(events|stop|mode|steer|reading|hold|brief|log))?$/);
    if (rm && validRunId(rm[1])) {
      // A reply's events so far as one JSON list (the MCP server and run replay read this; the page streams /events).
      if (rm[2] === 'log' && req.method === 'GET') return json(res, 200, { ...runStatus(rm[1]), events: readLog(rm[1]) });
      // The out-of-steps card's "Fresh chat": a short handover brief of that reply.
      if (rm[2] === 'brief' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4) || '{}'); try { return json(res, 200, await briefFor(rm[1], { model: b.model })); } catch (e) { return json(res, 400, { error: e.message }); } }
      if (rm[2] === 'events' && req.method === 'GET') return stream(res, rm[1], Math.max(0, Number(url.searchParams.get('from')) || 0));
      if (rm[2] === 'stop' && req.method === 'POST') return json(res, 200, { ok: stopRun(rm[1]) });
      // While a reply runs: switch it between Strict and YOLO, or send it a note it reads at its next step.
      if (rm[2] === 'mode' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4) || '{}'); return json(res, 200, { ok: setRunApproval(rm[1], b.approval) }); }
      if (rm[2] === 'hold' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4) || '{}'); return json(res, 200, { ok: holdCard(rm[1], String(b.id || '')) }); }
      if (rm[2] === 'video' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e3) || '{}'); return json(res, 200, { ok: setRunVideo(rm[1], b.on) }); }
      if (rm[2] === 'reading' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 2e4) || '{}'); return json(res, 200, { ok: setRunReading(rm[1], b.text) }); }
      if (rm[2] === 'steer' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 2e7) || '{}'); return json(res, 200, { ok: steerRun(rm[1], b.text, { images: b.images, docs: b.docs, context: b.context }) }); }
      if (!rm[2] && req.method === 'GET') return json(res, 200, runStatus(rm[1]));
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') return json(res, 200, activeRuns());
    // News (docs/news-format.md): What's new, articles and reports from news/, and the user's own numbers.
    if (url.pathname === '/api/news' || url.pathname.startsWith('/api/news/')) {
      const r = await newsRoute({ method: req.method, pathname: url.pathname, query: url.searchParams, body: req.method === 'POST' ? await readBody(req, 1e4) : '' });
      if (r?.file) return sendStatic(req, res, r.file, r.type, r.headers);
      if (r) return json(res, r.code, r.body);
    }
    if (url.pathname === '/api/scorecard' && req.method === 'GET') return json(res, 200, scorecard(Number(url.searchParams.get('days')) || 14));
    // KaTeX (math in messages): its script, stylesheet and fonts, from the installed package.
    const kxm = url.pathname.match(/^\/vendor\/katex\/(katex\.min\.(?:js|css)|fonts\/[\w-]+\.(?:woff2|woff|ttf))$/);
    if (kxm && req.method === 'GET') {
      const full = path.join(ROOT, 'node_modules', 'katex', 'dist', kxm[1]);
      if (!fs.existsSync(full)) return json(res, 404, { error: 'KaTeX is not installed (run npm install)' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return sendFile(full, res);
    }
    const vm = url.pathname.match(/^\/vendor\/(xterm\.js|xterm\.css|addon-fit\.js)$/);
    if (vm && req.method === 'GET') {
      const file = { 'xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', 'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', 'addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js' }[vm[1]];
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full)) return json(res, 404, { error: 'xterm.js is not installed (run npm install)' });
      res.writeHead(200, { 'Content-Type': vm[1].endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      return sendFile(full, res);
    }
    // Pictures and other media kept out of chat files (see server/blobs.js): named by their content, so never stale.
    const blm = url.pathname.match(/^\/blob\/([0-9a-f]{64}\.[a-z0-9]{2,5})$/);
    if (blm && req.method === 'GET') return serveBlob(req, res, blm[1]);
    if (req.method === 'GET') {
      const dec = url.pathname === '/' ? 'index.html' : decodePath(url.pathname);
      if (dec == null) return json(res, 400, { error: 'bad address' });
      const file = path.resolve(PUBLIC, dec.replace(/^\/+/, ''));
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'not found' });
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return sendStatic(req, res, file, type, type.startsWith('text/html') ? { 'Content-Security-Policy': APP_CSP } : {});
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

// Start on PORT (AGENT_PORT in .env, default 5188); if another program already uses it, try the
// next ports instead of failing. Agent dev servers use 5300-5999, so the search stops before them.
// QuorX is for the computer it runs on: it listens on 127.0.0.1 only, so nothing else on the network can connect.
// 🧩 The QuorX Chrome extension connects by WebSocket (server/extlink.js); nothing else upgrades.
server.on('upgrade', (req, socket) => {
  let p = ''; try { p = new URL(req.url, 'http://x').pathname; } catch { /* bad url */ }
  if (p === '/api/ext/socket' && hostAllowed(req)) return extUpgrade(req, socket);
  socket.destroy();
});
// What the extension's popup asks: recent chats to give a tab to, giving and taking back, stopping the agent,
// opening a chat in QuorX, and saving a routine you recorded.
const stopChat = (chatId) => { let n = 0; for (const r of activeRuns()) if (r.chatId === chatId && stopRun(r.runId)) n++; return n; };
onExtRequest({
  chats: () => listChats().slice(0, 25).map((c) => ({ id: c.id, title: c.title || 'New chat', project: listProjects().find((p) => p.id === c.projectId)?.name || '' })),
  lent: () => lentChromeTabs(),
  give: ({ tab, chatId, url: u, title, selection, link, image }) => {
    if (!validId(chatId) || !listChats().some((c) => c.id === chatId)) throw new Error('that chat is gone');
    if (!Number.isInteger(tab)) throw new Error('bad tab');
    return giveTab(chatId, `chrome-${tab}`, { url: u, title, ext: tab, selection, link, image });
  },
  stop: ({ chatId }) => ({ stopped: validId(chatId) ? stopChat(chatId) : 0 }),
  // The shortcut: every reply working in your Chrome.
  stopAll: () => ({ stopped: [...new Set(lentChromeTabs().map((x) => x.chatId))].reduce((n, c) => n + stopChat(c), 0) }),
  focus: async ({ chatId }) => { if (desktopReady()) await desktopCall('app.openChat', { chatId: validId(chatId) ? chatId : null }, 5000).catch(() => {}); return true; },
  saveRoutine: ({ chatId, name, steps }) => {
    const chat = validId(chatId) ? getChat(chatId) : null;
    const project = chat && listProjects().find((p) => p.id === chat.projectId);
    if (!project?.path) throw new Error('pick a chat whose project has a folder');
    const k = routineSkill(name, steps);
    saveSkill(project.path, { name: k.name, description: k.description, instructions: k.instructions }, { by: 'recorded in Chrome' });
    return { saved: true, name: k.name, steps: k.steps, project: project.name };
  },
  takeBack: ({ tab }) => takeBackSid(`chrome-${tab}`),
  disconnected: () => { for (const x of lentChromeTabs()) takeBackSid(`chrome-${x.tab}`); },
});
// 🧩 The agent's status in your Chrome: the extension's button says working, needs you or done for the tab a chat's
// agent uses, and a card waiting for you in such a chat shows a Windows notification (clicking it opens the chat).
// Only chats with one of your Chrome tabs; nothing is sent for the others.
const chromeState = new Map(); // chatId → the last state sent
onRunEvent((r, e) => {
  if (!r.chatId || !lentChromeTabs().some((x) => x.chatId === r.chatId)) return;
  const push = (state, what = '') => { if (chromeState.get(r.chatId) === state && state !== 'needs') return; chromeState.set(r.chatId, state); extPush({ kind: 'status', chatId: r.chatId, state, what }); };
  if (e === null) { push('done'); return; }
  if ((e.t === 'approval' && e.mode === 'strict') || (e.t === 'question' && !e.auto)) {
    const what = String(e.what || e.question || 'a question').slice(0, 200);
    push('needs', what);
    if (desktopReady()) desktopCall('app.notify', { title: 'QuorX needs you', body: what, chatId: r.chatId }, 5000).catch(() => {});
    return;
  }
  // Answered (or the agent moved on): working again.
  if (['approval_done', 'answer', 'tool_result', 'llm_start', 'tool'].includes(e.t)) push('working');
});
const HOST = '127.0.0.1';
const listener = server;
function listen(port, triesLeft = 40) {
  listener.once('error', (e) => {
    // A restart (⟳) waits for the old copy to let go of the port instead of moving to another one.
    if (e.code === 'EADDRINUSE' && process.env.OH_PORT_WAIT && triesLeft > 0) { return setTimeout(() => listen(port, triesLeft - 1), 300); }
    if (e.code === 'EADDRINUSE' && triesLeft > 0 && port + 1 < 5300) {
      console.warn(`Port ${port} is in use by another program; trying ${port + 1}…`);
      return listen(port + 1, triesLeft - 1);
    }
    console.error(e.message); process.exit(1);
  });
  listener.listen(port, HOST);
}
// Stops this harness (dev servers and the headless browser stop with it). With restart, a fresh copy
// starts first in the background, waits for the port, and takes over; its output goes to logs/harness.log.
function shutDown(restart) {
  listener.close(); server.close(); pageServer.close();
  if (restart) {
    const logDir = path.join(HOME, 'logs'); fs.mkdirSync(logDir, { recursive: true });
    rotateLog(path.join(logDir, 'harness.log'));
    const out = fs.openSync(path.join(logDir, 'harness.log'), 'a');
    spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: { ...process.env, AGENT_PORT: String(runtime.port), OH_PORT_WAIT: '1' }, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  }
  setTimeout(() => process.exit(0), 150);
}
listener.once('listening', () => {
  runtime.port = listener.address().port; console.log(`QuorX → http://localhost:${runtime.port}`);
  console.log(`Open QuorX with this link once (it signs this browser in): ${appLink(runtime.port)}`);
  // 1000 above the main port, when that is still a port; else any free one (a main port above 64535 crashed here).
  listenPages(runtime.port && runtime.port + 1000 <= 65535 ? runtime.port + 1000 : 0, 8);
});
listen(PORT);

// ---- scheduled tasks (server/schedules.js): checked every 30 s while QuorX runs (the desktop app or its tray) ----
// Each notice is kept for the page to show; the desktop app gets it straight away as a notification of its own.
const notices = [];
let noticeSeq = 0;
function scheduleNotice(kind, { schedule, chatId = null, text = '', cost = 0 }) {
  const n = { id: ++noticeSeq, at: Date.now(), kind, scheduleId: schedule.id, name: schedule.name, projectId: schedule.projectId, chatId, text: String(text || '').replace(/\s+/g, ' ').slice(0, 200), cost };
  notices.push(n); if (notices.length > 50) notices.shift();
  if (desktopReady()) {
    const title = { done: '✓ Scheduled chat finished', error: '✕ Scheduled chat stopped', approval: '⏸ Scheduled chat needs your approval', answer: '❓ Scheduled chat has a question', budget: '💲 Project budget reached' }[kind] || 'QuorX';
    desktopCall('app.notify', { title, body: `⏰ ${schedule.name}${n.text ? `\n${n.text}` : ''}`, chatId, silent: kind === 'done' }, 5000).catch(() => {});
  }
}
const scheduleDeps = { now: Date.now, listProjects, budgetState, saveChat, getChat, startRun, follow, runAgent, events: runEvents, notify: scheduleNotice };
const scheduler = createScheduler({ run: (s, info) => startScheduledChat(s, info, scheduleDeps), running: (id) => runStatus(id).status === 'running' });
// ▶ Run now, from the Schedules window or the agent's schedule tool.
scheduleHooks.runNow = (s) => startScheduledChat(s, { missed: false, due: Date.now() }, scheduleDeps);
if (!process.env.OH_NO_SCHEDULES) scheduler.start();

// Pages the agent made (project files, artifacts) also load from a second address on this computer. There they have
// an origin of their own, so localStorage, IndexedDB, cookies and module scripts work as on any site. On the app's
// own address they stay sandboxed (no storage), so they can't use this app's routes; on this one there are none:
// only /ws, /art and /preview/page answer, and /api calls from here to the app are refused as cross-site.
const pageServer = http.createServer((req, res) => {
  let p = '';
  try { p = new URL(req.url, 'http://x').pathname; } catch { /* below */ }
  if (!isLoopback(req) || !['GET', 'HEAD'].includes(req.method) || !/^\/(ws|art|preview\/page)\//.test(p)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not here'); }
  req.pageOrigin = true;
  server.emit('request', req, res);
});
function listenPages(port, triesLeft) {
  // The same port each time when it's free (storage belongs to an address, port included); else any free one.
  pageServer.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) return setTimeout(() => listenPages(port, triesLeft - 1), 300);
    if (e.code === 'EADDRINUSE' && port) return listenPages(0, 0);
    console.warn(`Pages address not available (${e.message}); agent pages stay sandboxed, without storage.`);
  });
  try { pageServer.listen(port, '127.0.0.1', () => { runtime.pagePort = pageServer.address().port; }); }
  catch (e) { pageServer.removeAllListeners('error'); if (port) return listenPages(0, 0); console.warn(`Pages address not available (${e.message}); agent pages stay sandboxed, without storage.`); }
}
