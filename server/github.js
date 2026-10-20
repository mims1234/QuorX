// A project's GitHub repo: the link from its own git settings (a local file read), and whether the repo is public or
// private and owned by a person or an organization (from GitHub, cached). The page shows these on project cards and in
// project settings; nothing here is given to the agent.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The folder's git config: .git/config, or for a worktree (.git is a file) the main repository's config.
function gitConfigFile(dir) {
  const dotGit = path.join(dir, '.git');
  let st; try { st = fs.statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return path.join(dotGit, 'config');
  const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
  if (!m) return null;
  const gitdir = path.resolve(dir, m[1].trim());
  try { return path.join(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()), 'config'); }
  catch { return path.join(gitdir, 'config'); }
}

// git@github.com:owner/repo.git, https://github.com/owner/repo(.git), ssh://git@github.com/owner/repo
export function parseGitHubUrl(u) {
  const m = String(u || '').trim().match(/github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
}

const remotes = new Map(); // config file → { mtime, value }
/** The GitHub repo of a project folder (origin first, else any remote on github.com), or null. */
export function gitHubRemote(dir) {
  const file = dir && gitConfigFile(dir);
  if (!file) return null;
  let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const hit = remotes.get(file);
  if (hit && hit.mtime === mtime) return hit.value;
  let value = null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const found = [];
    let section = '';
    for (const line of text.split(/\r?\n/)) {
      const sec = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/); if (sec) { section = sec[1]; continue; }
      if (/^\s*\[/.test(line)) { section = ''; continue; }
      const u = section && line.match(/^\s*url\s*=\s*(.+?)\s*$/); if (u) found.push({ name: section, url: u[1] });
    }
    const pick = found.find((r) => r.name === 'origin' && parseGitHubUrl(r.url)) || found.find((r) => parseGitHubUrl(r.url));
    if (pick) value = { ...parseGitHubUrl(pick.url), remote: pick.name };
  } catch { /* unreadable: no link */ }
  remotes.set(file, { mtime, value });
  return value;
}

// The GitHub command line, when installed and signed in, also answers for private repos.
function ghApi(route) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try { p = spawn('gh', ['api', route], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return finish(null); }
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish(null); }, 6000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); finish(null); });
    p.on('close', (code) => { clearTimeout(t); if (code !== 0) return finish(null); try { finish(JSON.parse(out)); } catch { finish(null); } });
  });
}
async function publicApi(route) {
  try {
    const r = await fetch(`https://api.github.com/${route}`, { headers: { 'User-Agent': 'QuorX', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(6000) });
    return { status: r.status, body: r.ok ? await r.json() : null };
  } catch { return { status: 0, body: null }; }
}

const infos = new Map(); // owner/repo → { at, ttl, value }
/**
 * { visibility: 'public' | 'private' | 'internal' | null, ownerType: 'Organization' | 'User' | null, source }.
 * Without the command line a private repo looks the same as a missing one: then it is reported as not public.
 */
export async function gitHubInfo(owner, repo, { fresh = false } = {}) {
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = infos.get(key);
  if (!fresh && hit && Date.now() - hit.at < hit.ttl) return hit.value;
  let value = null;
  const viaGh = await ghApi(`repos/${owner}/${repo}`);
  if (viaGh?.owner) value = { visibility: viaGh.visibility || (viaGh.private ? 'private' : 'public'), ownerType: viaGh.owner.type || null, source: 'gh' };
  if (!value) {
    const r = await publicApi(`repos/${owner}/${repo}`);
    if (r.body?.owner) value = { visibility: r.body.visibility || (r.body.private ? 'private' : 'public'), ownerType: r.body.owner.type || null, source: 'public' };
    else if (r.status === 404) {
      const u = await publicApi(`users/${owner}`);
      value = { visibility: 'private', ownerType: u.body?.type || null, source: 'public', guess: true };
    }
  }
  value ||= { visibility: null, ownerType: null, source: 'none' };
  infos.set(key, { at: Date.now(), ttl: value.source === 'none' ? 10 * 60e3 : 60 * 60e3, value });
  return value;
}
