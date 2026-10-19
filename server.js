// QuorX: a chat agent with artifacts, self-built decisions and paid media behind an
// approval gate. Zero dependencies (Node 20+). The OpenRouter key stays on this server; every
// step of a run streams to the page as Server-Sent Events.
//
//   server/openrouter.js  OpenRouter client: chat, Decisions, images, speech, music, catalogues
//   server/decisions.js   the decider ensemble: one Decisions call per decider, soft vote, confidence
//   server/agent.js       one run: the tool loop, decide-with-guess, artifacts, media approvals
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { currentKey, PORT, runtime, ROOT, HOME, chatModels, decisionModels, imageModels, speechModels, musicModels, videoModels, transcribe, clearCatalogues } from './server/openrouter.js';
import { listKeys, addKey, removeKey, setActive, renameKey, keyUsage, activeUsage, accountCredits, startSampling } from './server/keys.js';
import { setupCheck, runFix } from './server/setup-check.js';
import { startSignIn, signInStatus, cancelSignIn, finishByCallback, finishWithCode, callbackPage } from './server/oauth.js';
import { runAgent, answerApproval, answerQuestion, answerBudget, raiseCap, setRunApproval, steerRun, DEFAULTS, MEDIA, briefFor, briefForChat } from './server/agent.js';
import { CHECKS } from './server/harness-checks.js';
import { startRun, getRun, stopRun, follow, runStatus, activeRuns, validRunId, scorecard } from './server/runs.js';
import { setBudget, budgetState } from './server/budget.js';
import { shellRun, shellClose, shellInfo } from './server/shell.js';
import { ptyAvailable, ptyLoadError, ptyOpen, ptyWrite, ptyResize, ptyFollow, ptyClose } from './server/pty.js';
// Pages the agent wrote, served from this app's own address, get their own opaque origin: their requests to /api are refused.
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads';
import { listChats, getChat, saveChat, patchChat, trashChat, validId, listProjects, saveProject, forgetProject, setProjectColor, costSummary, costChats } from './server/store.js';
import { ALLOWED, copyTemplate, workspaceDir, safePath, listFiles, listServers, stopServer, stopServerWait, restartServer, serverLog, startServer, restoreCheckpoint, listCheckpoints, pruneCheckpoints, undoConflicts, changedFiles, reviewFiles, reviewDiff, undoFile, checkCommand, runCommand, serverOverview, launchConfigs, saveLaunchConfig, removeLaunchConfig, ensureAgentDir, agentSpace, clearAgentSpace } from './server/workspace.js';
import { followTerm, runningJobs, stopJob } from './server/terminal.js';
import { decide as decideCommand, loadRules, saveRules, suggestedRules } from './server/cmdpolicy.js';
import { jobHostStatus, jobsAvailable } from './server/jobhost.js';
import { safetySettings } from './server/safety.js';
import { readAudit } from './server/audit.js';
import { pickFolder } from './server/pickfolder.js';
import { userBrowse } from './server/userbrowser.js';
import { openLink, linkReply } from './server/desktop.js';
import { saveUpload, processDoc, listDocs, removeDoc, DOC_DEFAULTS, officeText } from './server/docs.js';
import { embeddingModels } from './server/openrouter.js';
import { listSkills, listTemplates } from './server/skills.js';
import { hostedHtml, browserPath } from './server/browser.js';
import { artifactContent, servedArtifact, ARTIFACT_HEADERS, folderStamp } from './server/artifacts.js';
import { gate, hostAllowed, crossSiteApi, isLoopback, accessInfo, setLan, resetToken } from './server/access.js';
import { serveBlob, startSweeping } from './server/blobs.js';
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
// The app's own pages may run only its own scripts (and KaTeX from jsDelivr), so text that slipped into the page
// unescaped can't run code with the harness's powers.
const APP_CSP = "script-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
// The app's own files: revalidated on every load (an edit shows on reload) but answered with 304 when unchanged,
// and text files gzipped once per version, so phones on Wi-Fi don't pull ~900 KB of script and styles every time.
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
  return fs.createReadStream(file).pipe(res);
}
// A path from the address bar; a malformed %-escape is a bad request, not a server error.
const decodePath = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
// Server-Sent Events for one run, from event number `from`. Closing the page only stops listening.
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
    // The Host must name this computer (no DNS rebinding); other devices must be paired; no /api calls from other sites.
    if (!hostAllowed(req)) return json(res, 403, { error: 'unknown host name: open QuorX at localhost or this computer\'s address (or list the name in OH_ALLOWED_HOSTS)' });
    if (gate(req, res, url)) return;
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
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      return res.end(callbackPage(r));
    }
    if (req.method === 'GET' && url.pathname === '/api/stale') return json(res, 200, codeChanged());
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { ...codeChanged(), version: VERSION, pagePort: runtime.pagePort || null, shell: shellInfo().name, pty: ptyAvailable(), defaults: DEFAULTS, checks: CHECKS, media: MEDIA, hasKey: !!currentKey(), browser: browserPath(), allowed: ALLOWED });

    // ---- chat history (data/chats; delete = move to data/trash) ----
    if (url.pathname === '/api/chats' && req.method === 'GET') return json(res, 200, listChats());
    if (url.pathname === '/api/costs' && req.method === 'GET') return json(res, 200, costSummary({ per: Number(url.searchParams.get('per')) || 5, sort: url.searchParams.get('sort') || 'cost' }));
    if (url.pathname === '/api/costs/chats' && req.method === 'GET') {
      const q = url.searchParams;
      return json(res, 200, costChats({ project: q.get('project') || '', q: q.get('q') || '', sort: q.get('sort') || 'cost', offset: q.get('offset'), limit: q.get('limit') }));
    }
    // A short brief of a whole chat (/fresh, and attaching a chat to another), cached until the chat changes.
    const brm = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)\/brief$/i);
    if (brm && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4) || '{}'); try { return json(res, 200, await briefForChat(brm[1], { model: b.model })); } catch (e) { return json(res, 400, { error: e.message }); } }
    const cm = url.pathname.match(/^\/api\/chats\/([a-z0-9-]+)$/i);
    if (cm) {
      if (req.method === 'GET') { const c = getChat(cm[1]); return c ? json(res, 200, c) : json(res, 404, { error: 'no such chat' }); }
      if (req.method === 'PUT') return json(res, 200, saveChat(cm[1], JSON.parse(await readBody(req, 200e6))));
      // Only what changed since the page's last save; 409 when the file has moved on, and the page sends it whole.
      if (req.method === 'PATCH') { const r = patchChat(cm[1], JSON.parse(await readBody(req, 200e6))); return json(res, r.stale ? 409 : 200, r); }
      if (req.method === 'DELETE') return json(res, 200, { ok: trashChat(cm[1]) });
    }

    // ---- projects (a folder shared by many chats) ----
    // Each project with its budget (null = none) and what all its chats have spent so far.
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, listProjects().map((p) => ({ ...p, ...budgetState(p.id) })));
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
      let file = safePath(root, rel || 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      // Project files are the agent's work: sandboxed (a separate origin), so a page can't use this app's own routes.
      // A sandboxed project page loading its own scripts (module scripts need CORS): its Origin is "null" and its
      // Referer is a page of this project (or an artifact or preview page) on this app's address. Other sites, and
      // pages of other projects, can't read the files this way.
      const ref = String(req.headers.referer || ''), base = `http://${req.headers.host}/`;
      const own = req.headers.origin === 'null' && [`ws/${wm[1]}/`, 'art/', 'preview/'].some((p) => ref.startsWith(base + p));
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...(/html|svg|xml/.test(type) && !req.pageOrigin ? { 'Content-Security-Policy': SANDBOX_CSP } : {}), ...(own ? { 'Access-Control-Allow-Origin': 'null' } : {}) });
      return fs.createReadStream(file).pipe(res);
    }
    // Open a project's folder in the computer's own file manager (File Explorer on Windows).
    if (url.pathname === '/api/open-folder' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4) || '{}');
      if (!validId(b.projectId) || !listProjects().some((p) => p.id === b.projectId)) return json(res, 400, { error: 'unknown project' });
      const dir = workspaceDir(b.projectId);
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
      try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); return json(res, 200, { ok: true, dir }); }
      catch (e) { return json(res, 500, { error: e.message }); }
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
    if (url.pathname === '/api/files' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      if (!validId(pid)) return json(res, 400, { error: 'bad project id' });
      return json(res, 200, listFiles(workspaceDir(pid)));
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
    if (url.pathname === '/api/skills' && req.method === 'GET') {
      const pid = url.searchParams.get('project');
      const dir = validId(pid) ? (() => { try { return workspaceDir(pid); } catch { return null; } })() : null;
      return json(res, 200, listSkills(dir).map(({ name, description, source }) => ({ name, description, source })));
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
      const rules = loadRules(root);
      return json(res, 200, { project: rules.filter((r) => r.scope === 'project'), everywhere: rules.filter((r) => r.scope === 'everywhere'),
        suggested: root ? suggestedRules(root, rules) : [], stop: (await jobsAvailable(), jobHostStatus()), shell: shellInfo().name });
    }
    if (url.pathname === '/api/permissions' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 2e5));
      if (b.scope === 'project' && !validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      if (!['project', 'everywhere'].includes(b.scope)) return json(res, 400, { error: 'scope must be project or everywhere' });
      try { return json(res, 200, { ok: true, rules: saveRules(b.scope, b.rules, b.scope === 'project' ? workspaceDir(b.projectId) : null) }); } catch (e) { return json(res, 200, { error: e.message }); }
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
          mode: b.mode === 'yolo' ? 'yolo' : 'strict', yolo: { external: S.yoloExternal, opaque: S.yoloOpaque, outside: S.yoloOutside } });
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
    // ---- other devices (phones on Wi-Fi): the pairing links, on/off and a new link; only from this computer ----
    if (url.pathname.startsWith('/api/access')) {
      if (!isLoopback(req)) return json(res, 200, { paired: true });
      if (url.pathname === '/api/access' && req.method === 'GET') return json(res, 200, accessInfo(runtime.port));
      if (url.pathname === '/api/access' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e3) || '{}'); setLan(b.lan); return json(res, 200, accessInfo(runtime.port)); }
      if (url.pathname === '/api/access/reset' && req.method === 'POST') { resetToken(); return json(res, 200, accessInfo(runtime.port)); }
    }
    // ---- the desktop app's link (see server/desktop.js): only from this computer ----
    if (url.pathname.startsWith('/api/desktop/')) {
      const ip = req.socket.remoteAddress || '';
      if (!/^(127\.|::1$|::ffff:127\.)/.test(ip) || req.headers.origin) return json(res, 403, { error: 'the desktop link is only for the app on this computer' });
      if (url.pathname === '/api/desktop/link' && req.method === 'GET') return openLink(req, res, url.searchParams.get('token'));
      if (url.pathname === '/api/desktop/reply' && req.method === 'POST') return json(res, linkReply(JSON.parse(await readBody(req, 50e6) || '{}')) ? 200 : 403, {});
    }
    // ---- the Browser tab's "your view" for sites that refuse frames (see server/userbrowser.js) ----
    if (url.pathname === '/api/ubrowser' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e5) || '{}');
      try { return json(res, 200, await userBrowse(String(b.sid || ''), String(b.op || 'look'), b)); } catch (e) { return json(res, 200, { error: e.message }); }
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
    if (url.pathname === '/api/agent-space/clear' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 1e4));
      if (!validId(b.projectId)) return json(res, 400, { error: 'bad project id' });
      try { const root = workspaceDir(b.projectId); return json(res, 200, { cleared: clearAgentSpace(root, b.what, Number(b.keep) || 10), ...agentSpace(root) }); } catch (e) { return json(res, 200, { error: e.message }); }
    }

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
      if (!getRun(runId)) startRun({ runId, chatId: body.chatId }, (emit, signal) => runAgent(body, emit, signal));
      return stream(res, runId, 0);
    }
    const rm = url.pathname.match(/^\/api\/runs\/([\w-]+)(?:\/(events|stop|mode|steer|brief))?$/);
    if (rm && validRunId(rm[1])) {
      // The out-of-steps card's "Fresh chat": a short handover brief of that reply.
      if (rm[2] === 'brief' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4) || '{}'); try { return json(res, 200, await briefFor(rm[1], { model: b.model })); } catch (e) { return json(res, 400, { error: e.message }); } }
      if (rm[2] === 'events' && req.method === 'GET') return stream(res, rm[1], Math.max(0, Number(url.searchParams.get('from')) || 0));
      if (rm[2] === 'stop' && req.method === 'POST') return json(res, 200, { ok: stopRun(rm[1]) });
      // While a reply runs: switch it between Strict and YOLO, or send it a note it reads at its next step.
      if (rm[2] === 'mode' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 1e4) || '{}'); return json(res, 200, { ok: setRunApproval(rm[1], b.approval) }); }
      if (rm[2] === 'steer' && req.method === 'POST') { const b = JSON.parse(await readBody(req, 2e7) || '{}'); return json(res, 200, { ok: steerRun(rm[1], b.text, { images: b.images, docs: b.docs, context: b.context }) }); }
      if (!rm[2] && req.method === 'GET') return json(res, 200, runStatus(rm[1]));
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') return json(res, 200, activeRuns());
    if (url.pathname === '/api/scorecard' && req.method === 'GET') return json(res, 200, scorecard(Number(url.searchParams.get('days')) || 14));
    const vm = url.pathname.match(/^\/vendor\/(xterm\.js|xterm\.css|addon-fit\.js)$/);
    if (vm && req.method === 'GET') {
      const file = { 'xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', 'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', 'addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js' }[vm[1]];
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full)) return json(res, 404, { error: 'xterm.js is not installed (run npm install)' });
      res.writeHead(200, { 'Content-Type': vm[1].endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(full).pipe(res);
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
function listen(port, triesLeft = 40) {
  server.once('error', (e) => {
    // A restart (⟳) waits for the old copy to let go of the port instead of moving to another one.
    if (e.code === 'EADDRINUSE' && process.env.OH_PORT_WAIT && triesLeft > 0) { return setTimeout(() => listen(port, triesLeft - 1), 300); }
    if (e.code === 'EADDRINUSE' && triesLeft > 0 && port + 1 < 5300) {
      console.warn(`Port ${port} is in use by another program; trying ${port + 1}…`);
      return listen(port + 1, triesLeft - 1);
    }
    console.error(e.message); process.exit(1);
  });
  // AGENT_HOST=127.0.0.1 keeps the harness on this computer only; by default other devices can reach it once paired.
  server.listen(port, process.env.AGENT_HOST || undefined);
}
// Stops this harness (dev servers and the headless browser stop with it). With restart, a fresh copy
// starts first in the background, waits for the port, and takes over; its output goes to logs/harness.log.
function shutDown(restart) {
  server.close(); pageServer.close();
  if (restart) {
    const logDir = path.join(HOME, 'logs'); fs.mkdirSync(logDir, { recursive: true });
    const out = fs.openSync(path.join(logDir, 'harness.log'), 'a');
    spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: { ...process.env, AGENT_PORT: String(runtime.port), OH_PORT_WAIT: '1' }, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  }
  setTimeout(() => process.exit(0), 150);
}
server.once('listening', () => {
  runtime.port = server.address().port; console.log(`QuorX → http://localhost:${runtime.port}`);
  listenPages(runtime.port + 1000, 8);
});
listen(PORT);

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
  pageServer.listen(port, () => { runtime.pagePort = pageServer.address().port; });
}
