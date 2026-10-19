// Before an install runs: does each package it names exist on its registry, and how new is it? Models invent
// plausible package names (about 1 in 5 code samples in a 2025 study), and attackers register those names
// ("slopsquatting"). A name that doesn't exist is blocked; a very new or barely used one goes to the user, even in
// YOLO. Registries that can't be reached are reported, never treated as "fine".
const TIMEOUT = 6000;
const UA = { 'User-Agent': 'QuorX package check (https://github.com/mims1234/QuorX)' };

const get = async (url) => {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), TIMEOUT);
  try { const r = await fetch(url, { headers: UA, signal: ac.signal }); return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null }; }
  catch { return { status: 0, json: null }; } finally { clearTimeout(t); }
};

// The packages an install command names: [{ eco, name }]. Versions, extras, flags and local paths are dropped.
export function packagesOf(text) {
  const w = String(text || '').trim().split(/\s+/).map((x) => x.replace(/^["']|["']$/g, ''));
  const prog = (w[0] || '').toLowerCase().replace(/\.(exe|cmd|bat)$/, '').split(/[\\/]/).pop();
  const out = [];
  // Flags whose next word is their value, not a package.
  const VALUED = new Set(['--features', '-F', '--version', '--vers', '--registry', '--index', '--index-url', '-i', '--extra-index-url', '--target', '--git', '--path', '--branch', '--rev', '--tag', '--source', '-s', '--framework', '-f', '-c', '--constraint', '--prefix', '--save-prefix', '--group', '-G', '--rename', '--root', '--trusted-host', '--platform']);
  const after = (i, eco, clean) => {
    for (let k = i; k < w.length; k++) {
      const x = w[k];
      if (VALUED.has(x)) { k++; continue; }
      const scoped = eco === 'npm' && /^@[^/\s]+\/[^/\s]+$/.test(x.split('@').slice(0, 2).join('@'));
      if (!x || x.startsWith('-') || (/[\\/]/.test(x) && !scoped && eco !== 'go') || /^\.|:\/\/|^git\+|\.(tgz|whl|tar\.gz|zip)$/i.test(x)) continue;
      const n = clean(x); if (n) out.push({ eco, name: n });
    }
  };
  const npmName = (x) => (x.startsWith('@') ? x.split('@').slice(0, 2).join('@') : x.split('@')[0]) || null;
  const pyName = (x) => x.replace(/\[.*?\]/, '').split(/[=<>!~;]/)[0] || null;
  const sub = (w[1] || '').toLowerCase();
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog) && ['install', 'i', 'add', 'in'].includes(sub)) after(2, 'npm', npmName);
  else if (prog === 'npx' && w[1] && !w[1].startsWith('-')) after(1, 'npm', npmName);
  else if (['pip', 'pip3'].includes(prog) && sub === 'install') { if (!w.includes('-r') && !w.includes('--requirement')) after(2, 'pypi', pyName); }
  else if (['python', 'python3', 'py'].includes(prog) && w.includes('-m') && w[w.indexOf('-m') + 1] === 'pip' && w[w.indexOf('-m') + 2] === 'install') { if (!w.includes('-r')) after(w.indexOf('-m') + 3, 'pypi', pyName); }
  else if (prog === 'uv' && sub === 'pip' && (w[2] || '').toLowerCase() === 'install') { if (!w.includes('-r')) after(3, 'pypi', pyName); }
  else if (['uv', 'poetry', 'pipenv'].includes(prog) && ['add', 'install'].includes(sub)) after(2, 'pypi', pyName);
  else if (prog === 'cargo' && ['add', 'install'].includes(sub)) after(2, 'crates', (x) => x.split('@')[0]);
  else if (prog === 'dotnet' && sub === 'add' && (w[2] || '').toLowerCase() === 'package') after(3, 'nuget', (x) => x);
  else if (prog === 'go' && ['get', 'install'].includes(sub)) after(2, 'go', (x) => x.split('@')[0]);
  return out.filter((p) => p.name && p.name.length < 214).slice(0, 12);
}

async function npm(name) {
  const r = await get(`https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`);
  if (r.status === 404) return { exists: false };
  if (!r.json) return { exists: null };
  const created = r.json.time?.created || null;
  const dl = await get(`https://api.npmjs.org/downloads/point/last-week/${name}`);
  return { exists: true, created, weekly: dl.json?.downloads ?? null };
}
async function pypi(name) {
  const r = await get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (r.status === 404) return { exists: false };
  if (!r.json) return { exists: null };
  const times = Object.values(r.json.releases || {}).flat().map((f) => f.upload_time_iso_8601 || f.upload_time).filter(Boolean).sort();
  return { exists: true, created: times[0] || null };
}
async function crates(name) {
  const r = await get(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
  if (r.status === 404) return { exists: false };
  if (!r.json) return { exists: null };
  return { exists: true, created: r.json.crate?.created_at || null, total: r.json.crate?.downloads ?? null };
}
async function nuget(name) {
  const r = await get(`https://api.nuget.org/v3/registration5-semver1/${encodeURIComponent(name.toLowerCase())}/index.json`);
  if (r.status === 404) return { exists: false };
  return { exists: r.json ? true : null, created: null };
}
async function gomod(name) {
  const r = await get(`https://proxy.golang.org/${encodeURIComponent(name.toLowerCase()).replace(/%2F/gi, '/')}/@v/list`);
  if (r.status === 404 || r.status === 410) return { exists: false };
  return { exists: r.status === 200 ? true : null, created: null };
}
const CHECK = { npm, pypi, crates, nuget, go: gomod };
const REG = { npm: 'npm', pypi: 'PyPI', crates: 'crates.io', nuget: 'NuGet', go: 'the Go module proxy' };

/**
 * Checks each package. Returns [{ eco, name, exists: true|false|null, ageDays, weekly, verdict: 'ok'|'new'|'missing'|'unknown', note }].
 * 'new': published under `newDays` days ago, or (npm) fewer than `fewWeekly` downloads last week.
 */
export async function checkPackages(list, { newDays = 30, fewWeekly = 500 } = {}) {
  return Promise.all(list.map(async ({ eco, name }) => {
    const r = await (CHECK[eco] || (async () => ({ exists: null })))(name).catch(() => ({ exists: null }));
    const ageDays = r.created ? Math.floor((Date.now() - Date.parse(r.created)) / 864e5) : null;
    let verdict = 'ok', note = '';
    if (r.exists === false) { verdict = 'missing'; note = `“${name}” does not exist on ${REG[eco]}: the name may be made up, and someone could register it later with harmful code`; }
    else if (r.exists === null) { verdict = 'unknown'; note = `${REG[eco]} could not be reached to check “${name}”`; }
    else if (ageDays != null && ageDays < newDays) { verdict = 'new'; note = `“${name}” was first published ${ageDays} day${ageDays === 1 ? '' : 's'} ago`; }
    else if (r.weekly != null && r.weekly < fewWeekly) { verdict = 'new'; note = `“${name}” had only ${r.weekly} downloads last week`; }
    return { eco, name, exists: r.exists, ageDays, weekly: r.weekly ?? null, verdict, note };
  }));
}
