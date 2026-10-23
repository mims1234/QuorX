// ⚙ Settings → Storage, the desktop app's part: Chromium caches (the app window, the browser agent's tabs, your tabs),
// the settings folder left from before the name QuorX (%APPDATA%\OpenHarness), and update downloads that have been
// installed. The harness measures and clears its own data (server/storage.js); the page shows both together.
// Caches are cleared through Electron's sessions, because the running app holds their files open; the GPU caches
// can't be cleared while it runs, so they go the next time QuorX starts. Your tabs' cache is cleared without
// touching their cookies and site data, so sign-ins stay.
const path = require('node:path');
const fs = require('node:fs');

const CACHES = ['Cache', 'Code Cache', 'GPUCache'];
const GPU = ['GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache'];
const AGENT_EXTRA = ['Service Worker'];

async function sizeOf(p) {
  let bytes = 0, files = 0;
  const walk = async (q) => {
    let st; try { st = await fs.promises.lstat(q); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (!st.isDirectory()) { bytes += st.size; files++; return; }
    let list; try { list = await fs.promises.readdir(q); } catch { return; }
    for (const n of list) await walk(path.join(q, n));
  };
  await walk(p);
  return { bytes, files };
}
async function sumOf(paths) {
  let bytes = 0, files = 0;
  for (const p of paths) { const s = await sizeOf(p); bytes += s.bytes; files += s.files; }
  return { bytes, files };
}
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
// "QuorX-Setup-0.2.12.exe" → [0, 2, 12]; newer(a, b): a is a later version than b.
const versionIn = (name) => (/(\d+)\.(\d+)\.(\d+)/.exec(name) || []).slice(1).map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return false; };

/**
 * deps: { userData, appData, localAppData, resourcesPath, version, packaged, ownUserData (false when OH_USER_DATA points
 * elsewhere), sessions: { app, agent, tabs } (each with clearCache, clearCodeCaches, clearStorageData), trashItem,
 * readConfig, writeConfig, updateBusy () → bool, updaterDir? }
 */
function createStorage(d) {
  const ud = (...p) => path.join(d.userData, ...p);
  const legacy = path.join(d.appData, 'OpenHarness');
  const updaterDir = () => {
    if (d.updaterDir) return d.updaterDir;
    let name = 'quorx-desktop-updater';
    try { name = (/^updaterCacheDirName:\s*["']?([^"'\r\n]+)/m.exec(fs.readFileSync(path.join(d.resourcesPath, 'app-update.yml'), 'utf8')) || [])[1]?.trim() || name; } catch { /* the default */ }
    return path.join(d.localAppData, name);
  };
  // Update downloads for this version or an older one: the update has been installed (or skipped). A newer download
  // waiting to install stays, and so does everything while a download or install is under way.
  const staleUpdates = () => {
    if (d.updateBusy?.()) return [];
    const dir = updaterDir(), out = [];
    const walk = (q) => { let l = []; try { l = fs.readdirSync(q, { withFileTypes: true }); } catch { return; } for (const e of l) { const p = path.join(q, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
    walk(dir);
    const cur = versionIn(d.version);
    const waiting = out.some((p) => /\.(exe|msi|7z|nupkg)$/i.test(p) && versionIn(path.basename(p)).length && newer(versionIn(path.basename(p)), cur));
    return out.filter((p) => { const v = versionIn(path.basename(p)); return v.length ? !newer(v, cur) : !waiting; });
  };
  const legacyOk = () => d.ownUserData && path.resolve(legacy) !== path.resolve(d.userData) && exists(path.join(d.userData, 'config.json')) && exists(legacy);

  const PARTS = [
    { id: 'desk:app', label: 'App window cache', help: 'Pages and code QuorX\'s own window keeps to start faster. Some GPU caches go the next time QuorX starts.', safe: true,
      paths: () => [...CACHES, ...GPU].map((n) => ud(n)).filter(exists),
      clear: async () => { await d.sessions.app.clearCache(); await d.sessions.app.clearCodeCaches({}); d.writeConfig({ ...d.readConfig(), clearGpuAtStart: true }); } },
    { id: 'desk:agent', label: 'Browser agent\'s cache', help: 'What the agent\'s browser tabs saved from sites: page files, code and offline copies (service workers). Its sign-ins stay.', safe: true,
      paths: () => [...CACHES, ...GPU, ...AGENT_EXTRA].map((n) => ud('Partitions', 'agent', n)).filter(exists),
      clear: async () => { const s = d.sessions.agent; await s.clearCache(); await s.clearCodeCaches({}); await s.clearStorageData({ storages: ['serviceworkers', 'cachestorage', 'shadercache'] }); } },
    { id: 'desk:tabs', label: 'Your tabs\' cache', help: 'Page files your own browser tabs saved. Sign-ins and site settings stay; sites load a little slower the first time.', safe: true, offInBulk: true,
      paths: () => [...CACHES, ...GPU].map((n) => ud('Partitions', 'browse', n)).filter(exists),
      clear: async () => { const s = d.sessions.tabs; await s.clearCache(); await s.clearCodeCaches({}); } },
    { id: 'desk:legacy', label: 'Old OpenHarness settings folder', help: 'Left from before the name QuorX. What QuorX needed from it was copied when it first started.', safe: true, how: 'recycle',
      paths: () => (legacyOk() ? [legacy] : []),
      clear: async () => { if (legacyOk()) await d.trashItem(legacy); } },
    { id: 'desk:updates', label: 'Installed update downloads', help: 'Installers for this version of QuorX or older ones. A newer one waiting to install stays.', safe: true,
      paths: () => staleUpdates(),
      clear: async (paths) => { for (const p of paths) { try { fs.rmSync(p, { force: true }); } catch { /* in use */ } } } },
  ];

  async function measure() {
    const items = [];
    for (const p of PARTS) {
      const paths = p.paths();
      if (!paths.length && p.id !== 'desk:app') continue;
      items.push({ id: p.id, group: 'cache', label: p.label, help: p.help, how: p.how || 'delete', safe: p.safe, offInBulk: !!p.offInBulk, desktop: true, ...(await sumOf(paths)) });
    }
    return items;
  }
  async function clear(list) {
    const results = [];
    for (const it of list || []) {
      const p = PARTS.find((x) => x.id === it?.id);
      if (!p) { results.push({ id: it?.id, error: 'nothing to clear by that name' }); continue; }
      const paths = p.paths(), before = await sumOf(paths);
      if (it.expect != null && before.bytes > Number(it.expect) * 1.2 + 1e6) { results.push({ id: p.id, changed: true, ...before }); continue; }
      try { await p.clear(paths); } catch (e) { results.push({ id: p.id, error: String(e?.message || e) }); continue; }
      const after = await sumOf(p.paths());
      const later = p.id === 'desk:app' ? await sumOf(GPU.map((n) => ud(n)).filter(exists)) : { bytes: 0 };
      results.push({ id: p.id, bytes: Math.max(0, before.bytes - after.bytes), files: Math.max(0, before.files - after.files), wentTo: p.how === 'recycle' ? 'recycle' : 'deleted', skipped: [], ...(later.bytes ? { atNextStart: later.bytes } : {}) });
    }
    return { results };
  }
  return { measure, clear };
}

// Before the window opens (and only in the copy that owns the settings folder): the GPU caches asked for last time,
// and the browser agent's cache when "Clear it each time QuorX starts" is ticked.
function cleanAtStart(userData, cfg) {
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* in use: next time */ } };
  if (cfg.clearGpuAtStart) for (const n of GPU) rm(path.join(userData, n));
  if (cfg.storage?.agentCacheOnStart) for (const n of [...CACHES, ...GPU, ...AGENT_EXTRA]) rm(path.join(userData, 'Partitions', 'agent', n));
  return !!cfg.clearGpuAtStart;
}

module.exports = { createStorage, cleanAtStart, versionIn, newer };
