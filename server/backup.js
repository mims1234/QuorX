// Export my QuorX / Import: one .zip with the chats, the projects (their folders' paths and settings, never their
// files), the page's settings, the command rules, your own skills (data/skills), memory, schedules when there are
// any, and, when asked, the logs and the API keys. Import restores it on another computer: it never overwrites without being told to, and a project whose
// folder isn't there can be pointed at a new one.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HOME } from './openrouter.js';
import { zipBuffer } from './zip.js';
import { listProjects, validId, getWholeChat } from './store.js';
import { loadRules, saveRules } from './cmdpolicy.js';
import { loadMemory, saveMemory, checkMemory } from './memory.js';

const DATA = path.join(HOME, 'data');
const LOGS = path.join(HOME, 'logs');
const FORMAT = 'quorx-backup';
const CHAT_ID = /^[\w-]{1,100}$/;
const BLOB = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/;
const MAX_LOG = 25e6; // a log bigger than this stays out
const MAX_SKILL_FILE = 5e6; // a file in a skill's folder bigger than this stays out
// A skill's folder and the files in it: letters, digits, - _ and dots, never starting with a dot (so never "..").
const SKILL_FILE = /^skills\/([\w-][\w.-]{0,63})\/((?:[\w-][\w.-]{0,63}\/){0,4}[\w-][\w.-]{0,63})$/;
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const files = (dir, test) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && test(e.name)).map((e) => e.name); } catch { return []; } };
// Your own skills: { name, files: [path inside its folder] } for each folder in data/skills that has a SKILL.md.
function ownSkills() {
  const base = path.join(DATA, 'skills'), out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const name of dirs) {
    if (!fs.existsSync(path.join(base, name, 'SKILL.md'))) continue;
    const list = [], walk = (rel, depth) => {
      for (const e of fs.readdirSync(path.join(base, name, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() && depth < 4) walk(r, depth + 1);
        else if (e.isFile() && SKILL_FILE.test(`skills/${name}/${r}`) && fs.statSync(path.join(base, name, r)).size <= MAX_SKILL_FILE) list.push(r);
      }
    };
    walk('', 0);
    if (list.length) out.push({ name, files: list });
  }
  return out;
}
// The user's own logs: what QuorX wrote while they worked, not benchmark runs.
const ownLog = (n) => /\.(jsonl|log|json)$/i.test(n) && !/^bench-|^test-results/i.test(n);

// Today on this computer's clock, as 2026-10-21.
const today = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** A file name for today's backup: quorx-backup-2026-10-21.zip (then -2, -3 … if that one exists). */
export function backupName(dir, now = new Date()) {
  for (let i = 1; ; i++) { const n = `quorx-backup-${today(now)}${i > 1 ? `-${i}` : ''}.zip`; if (!fs.existsSync(path.join(dir, n))) return n; }
}

/**
 * Writes the backup into `dir`. settings: the page's own saved settings (they live in the browser). Keys go in only
 * with includeKeys; logs only with includeLogs. Returns { file, bytes, counts }.
 */
export function exportBackup({ dir, settings = null, includeLogs = false, includeKeys = false, version = '' }) {
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('pick a folder that exists for the backup');
  const entries = [], add = (name, data) => entries.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2)) });
  const projects = listProjects().map(({ dir: _d, missing: _m, needsFolder: _n, ...p }) => p);
  add('projects.json', projects);
  // Command rules: everywhere, and each project's own (kept by its folder on this computer, so saved by project id).
  add('rules/everywhere.json', { rules: loadRules(null).map(({ scope: _s, ...r }) => r) });
  for (const p of projects) {
    if (!p.path) continue;
    const own = loadRules(p.path).filter((r) => r.scope === 'project').map(({ scope: _s, ...r }) => r);
    if (own.length) add(`rules/projects/${p.id}.json`, { rules: own });
  }
  const chats = files(path.join(DATA, 'chats'), (n) => n.endsWith('.json') && CHAT_ID.test(n.slice(0, -5)));
  // Whole chats: an older reply's steps kept apart (data/traces) go back inside it, so the backup restores anywhere.
  for (const n of chats) { const raw = fs.readFileSync(path.join(DATA, 'chats', n)); add(`chats/${n}`, raw.includes('"traceRef"') ? JSON.stringify(getWholeChat(n.slice(0, -5))) : raw); }
  // Pictures and files the chats point at (stored once each, by their hash).
  const blobs = files(path.join(DATA, 'blobs'), (n) => BLOB.test(n));
  for (const n of blobs) add(`blobs/${n}`, fs.readFileSync(path.join(DATA, 'blobs', n)));
  if (fs.existsSync(path.join(DATA, 'schedules.json'))) add('schedules.json', fs.readFileSync(path.join(DATA, 'schedules.json')));
  // Your own skills (every file in each one's folder) and memory. Project skills live in the project folders.
  const skills = ownSkills();
  for (const s of skills) for (const r of s.files) add(`skills/${s.name}/${r}`, fs.readFileSync(path.join(DATA, 'skills', s.name, r)));
  const mem = loadMemory();
  if (mem.items.length || fs.existsSync(path.join(DATA, 'memory.json'))) add('memory.json', { on: mem.on, items: mem.items });
  if (settings && typeof settings === 'object') add('settings.json', settings);
  const logs = includeLogs ? files(LOGS, (n) => ownLog(n) && fs.statSync(path.join(LOGS, n)).size <= MAX_LOG) : [];
  for (const n of logs) add(`logs/${n}`, fs.readFileSync(path.join(LOGS, n)));
  let keys = 0;
  if (includeKeys) { const k = readJson(path.join(DATA, 'keys.json'), null); if (k?.keys?.length) { add('keys.json', k); keys = k.keys.length; } }
  const counts = { projects: projects.filter((p) => p.id !== 'scratch').length, chats: chats.length, files: blobs.length, logs: logs.length, keys, schedules: entries.some((e) => e.name === 'schedules.json'), settings: !!settings, skills: skills.length, memory: mem.items.length };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: FORMAT, version: 1, app: version, created: new Date().toISOString(), platform: process.platform, counts }, null, 2)) });
  const zip = zipBuffer(entries);
  const file = path.join(dir, backupName(dir));
  writeAtomic(file, zip);
  return { file, bytes: zip.length, counts };
}

// ---------- reading a backup ----------
// The entries of a ZIP (ours: no ZIP64), each read on demand, with a capped inflate.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('that file is not a QuorX backup (not a ZIP file)');
  const out = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0 && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    out.set(name, () => {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
      return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 512 * 1024 * 1024 }) : Buffer.alloc(0);
    });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
function open(file) {
  if (!file || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('there is no backup file there');
  const z = unzip(fs.readFileSync(file));
  const json = (n, dflt = null) => { const f = z.get(n); if (!f) return dflt; try { return JSON.parse(f().toString('utf8')); } catch { return dflt; } };
  const manifest = json('manifest.json');
  if (manifest?.format !== FORMAT) throw new Error('that file is not a QuorX backup');
  return { z, json, manifest };
}

/** The backups in a folder, newest first: [{ file, name, bytes, at }]. */
export function findBackups(dir) {
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) return [];
  return files(dir, (n) => /^quorx-backup-.*\.zip$/i.test(n)).map((n) => { const st = fs.statSync(path.join(dir, n)); return { file: path.join(dir, n), name: n, bytes: st.size, at: st.mtimeMs }; }).sort((a, b) => b.at - a.at);
}

/** What importing `file` would do: its projects (and whether each folder is on this computer), clashes, and what else it holds. */
export function inspectBackup(file) {
  const { z, json, manifest } = open(file);
  const here = listProjects();
  const projects = (json('projects.json', []) || []).filter((p) => p && validId(p.id) && p.id !== 'scratch').map((p) => {
    const mine = here.find((x) => x.id === p.id);
    return { id: p.id, name: String(p.name || p.id), path: p.path || null, found: !!p.path && fs.existsSync(p.path), clash: !!mine, herePath: mine?.path || null };
  });
  const chats = [...z.keys()].filter((n) => /^chats\/[\w-]{1,100}\.json$/.test(n)).map((n) => n.slice(6, -5));
  const skills = [...new Set([...z.keys()].map((n) => n.match(SKILL_FILE)?.[1]).filter(Boolean))];
  return {
    file, manifest, projects, chats: chats.length, chatClashes: chats.filter((id) => fs.existsSync(path.join(DATA, 'chats', `${id}.json`))).length,
    settings: z.has('settings.json'), schedules: z.has('schedules.json'), keys: z.has('keys.json') ? (json('keys.json')?.keys || []).length : 0,
    logs: [...z.keys()].filter((n) => n.startsWith('logs/')).length,
    skills: skills.length, skillClashes: skills.filter((s) => fs.existsSync(path.join(DATA, 'skills', s))).length,
    memory: z.has('memory.json') ? (json('memory.json')?.items || []).length : 0,
  };
}

// The items of `theirs` that `mine` lacks are added; with overwrite, the ones it has are replaced too.
const mergeBy = (key, mine, theirs, overwrite) => {
  const out = [...mine];
  for (const t of theirs) { const i = out.findIndex((m) => key(m) === key(t)); if (i < 0) out.push(t); else if (overwrite) out[i] = t; }
  return out;
};

// A file is replaced whole or not at all: written beside it, then renamed over it (a crash or a full disk mid-write
// leaves the old file, never half of one).
function writeAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
}
// A log's name: letters, digits, - _ and dots, not starting with a dot (so never "." or "..").
const LOG_NAME = /^logs\/[\w-][\w.-]{0,120}$/;

/**
 * Restores `file`. overwrite: replace chats, projects, rules and schedules that are here already (else they are
 * kept). folders: { projectId: new folder } for projects whose folder moved; skip: [projectId] to leave out.
 * keys: also add the backup's API keys (if it has any). Everything is read and checked first, and nothing is written
 * if any part is broken. Imported schedules arrive paused: a backup may be old, or someone else's.
 * Returns what was done, plus the settings for the page to apply.
 */
export function importBackup(file, { overwrite = false, folders = {}, skip = [], keys = false } = {}) {
  const { z, json } = open(file);
  const done = { projects: 0, chats: 0, files: 0, rules: 0, schedules: 0, paused: 0, keys: 0, logs: 0, skills: 0, memory: 0, kept: 0, missing: [] };
  for (const [id, dir] of Object.entries(folders || {})) if (dir && (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())) throw new Error(`there is no folder at ${dir} (for ${id})`);
  const bad = (what) => { throw new Error(`the backup is damaged (${what}): nothing was imported`); };

  // ---- 1. read and check everything ----
  const projects = json('projects.json', []);
  if (!Array.isArray(projects)) bad('projects.json');
  const chats = [], blobs = [], logs = [], skillFiles = [];
  for (const [n, read] of z) {
    const chat = n.match(/^chats\/([\w-]{1,100})\.json$/), blob = n.match(/^blobs\/([a-f0-9]{64}\.[a-z0-9]{1,8})$/), skill = n.match(SKILL_FILE);
    if (chat) {
      const data = read();
      let c = null;
      try { c = JSON.parse(data.toString('utf8')); } catch { bad(n); }
      if (!c || typeof c !== 'object' || (c.id != null && c.id !== chat[1])) bad(`${n}: its id doesn't match its name`);
      chats.push({ id: chat[1], data });
    } else if (blob) blobs.push({ name: blob[1], read });
    else if (skill) skillFiles.push({ name: skill[1], rel: skill[2], read });
    else if (n.startsWith('skills/')) bad(n);
    else if (n.startsWith('logs/')) { if (!LOG_NAME.test(n)) bad(n); logs.push(n); }
  }
  const theirMemory = json('memory.json');
  if (z.has('memory.json') && !Array.isArray(theirMemory?.items)) bad('memory.json');
  const sched = json('schedules.json');
  const arr = (s) => (Array.isArray(s) ? s : Array.isArray(s?.schedules) ? s.schedules : null);
  if (z.has('schedules.json') && !arr(sched)) bad('schedules.json');
  const theirKeys = json('keys.json');
  if (z.has('keys.json') && !Array.isArray(theirKeys?.keys)) bad('keys.json');
  const every = json('rules/everywhere.json')?.rules;
  if (z.has('rules/everywhere.json') && !Array.isArray(every)) bad('rules/everywhere.json');

  // ---- 2. write ----
  // Projects: the path from the backup, or the folder the user pointed it at. A folder that isn't on this computer
  // is kept as it is: the project shows as missing until its folder is reselected. Its name stays its own.
  const listFile = path.join(DATA, 'projects.json');
  const list = readJson(listFile, []);
  const where = {};
  for (const p of projects) {
    if (!p || !validId(p.id) || p.id === 'scratch' || skip.includes(p.id)) continue;
    const moved = folders?.[p.id], dir = moved ? path.resolve(moved) : p.path || null;
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0 && !overwrite) { done.kept++; where[p.id] = list[i].path; continue; }
    const next = { ...p, path: dir, name: String(p.name || (dir ? path.basename(dir) : p.id)).slice(0, 80) };
    if (i >= 0) list[i] = next; else list.push(next);
    where[p.id] = dir;
    done.projects++;
    if (!dir || !fs.existsSync(dir)) done.missing.push(p.id);
  }
  writeAtomic(listFile, JSON.stringify(list, null, 2));

  // Chats and the files they point at.
  for (const c of chats) {
    const f = path.join(DATA, 'chats', `${c.id}.json`);
    if (fs.existsSync(f) && !overwrite) { done.kept++; continue; }
    writeAtomic(f, c.data); done.chats++;
  }
  for (const b of blobs) {
    const f = path.join(DATA, 'blobs', b.name);
    if (fs.existsSync(f)) continue; // named by their content: one that is here is the same file
    writeAtomic(f, b.read()); done.files++;
  }

  // Command rules: added to the ones here (or, with overwrite, replacing them).
  const ruleKey = (r) => `${r.effect}|${r.match}`;
  if (Array.isArray(every)) {
    const mine = loadRules(null).map(({ scope: _s, ...r }) => r);
    done.rules += saveRules('everywhere', overwrite ? every : mergeBy(ruleKey, mine, every, false), null).length - (overwrite ? 0 : mine.length);
  }
  for (const n of z.keys()) {
    const m = n.match(/^rules\/projects\/([a-z0-9][a-z0-9-]{2,63})\.json$/i);
    const root = m && where[m[1]];
    if (!root || !fs.existsSync(root)) continue;
    const theirs = json(n)?.rules;
    if (!Array.isArray(theirs)) continue;
    const mine = loadRules(root).filter((r) => r.scope === 'project').map(({ scope: _s, ...r }) => r);
    done.rules += saveRules('project', overwrite ? theirs : mergeBy(ruleKey, mine, theirs, false), root).length - (overwrite ? 0 : mine.length);
  }

  // Schedules: by id, like the rest, and every one that comes in is paused until the user starts it here.
  if (sched) {
    const f = path.join(DATA, 'schedules.json'), mine = readJson(f, null);
    const incoming = arr(sched).filter((s) => s && s.id).map((s) => ({ ...s, paused: true, nextAt: null }));
    const before = arr(mine) || [];
    const merged = mergeBy((s) => s.id, before, incoming, overwrite);
    done.paused = merged.filter((s) => incoming.includes(s)).length;
    done.schedules = done.paused;
    writeAtomic(f, JSON.stringify(Array.isArray(mine) ? merged : { ...(mine && typeof mine === 'object' ? mine : { version: 1 }), schedules: merged }, null, 2));
  }

  // Your own skills: a skill that is here already is kept (with overwrite, the backup's files are written over it).
  const skillNames = [...new Set(skillFiles.map((f) => f.name))];
  for (const name of skillNames) {
    const dir = path.join(DATA, 'skills', name);
    if (fs.existsSync(dir) && !overwrite) { done.kept++; continue; }
    for (const f of skillFiles.filter((x) => x.name === name)) writeAtomic(path.join(dir, ...f.rel.split('/')), f.read());
    done.skills++;
  }

  // Memory: the backup's items are added after yours (with overwrite, they replace yours). Each one goes through the
  // same checks as one typed in Settings, so a duplicate, something like a secret, or one past the size limit stays out.
  if (theirMemory) {
    const mine = loadMemory(), next = { on: overwrite ? theirMemory.on !== false : mine.on, items: overwrite ? [] : [...mine.items] };
    for (const x of theirMemory.items) {
      if (!x || typeof x.text !== 'string' || checkMemory(x.text, next)) continue;
      next.items.push({ text: x.text }); done.memory++;
    }
    saveMemory(next);
  }

  // API keys: only when the user asked, and only keys this computer doesn't have yet.
  if (keys && theirKeys) {
    const f = path.join(DATA, 'keys.json'), mine = readJson(f, { active: null, keys: [] });
    const add = theirKeys.keys.filter((k) => k?.key && !mine.keys.some((m) => m.key === k.key));
    mine.keys.push(...add);
    if (!mine.active && add[0]) mine.active = add[0].id ?? null;
    writeAtomic(f, JSON.stringify(mine, null, 2));
    done.keys = add.length;
  }

  // Logs go beside this computer's own, in a folder of their own.
  const logDir = path.join(LOGS, `imported-${today()}`);
  for (const n of logs) { const f = path.join(logDir, n.slice(5)); if (!fs.existsSync(f) || overwrite) { writeAtomic(f, z.get(n)()); done.logs++; } }
  return { ...done, settings: json('settings.json') };
}
