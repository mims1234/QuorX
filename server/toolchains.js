// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Which toolchains this computer has, so the agent doesn't guess (and the Setup check can offer to install one).
// The list comes from the platform packs (server/packs/): each says how to find its toolchain, whether it really
// builds here, and how to install it. Each probe runs a version command with a short limit; results are cached.
import { WIN, run, ver } from './packs/_lib.js';
import { allToolchains } from './packs/index.js';

/** Every toolchain the packs know, with its install ids (winget, brew, apt). */
export const TOOLCHAINS = allToolchains();

// An installer adds its folder to the PATH in the registry, but a program that is already running keeps the PATH it
// started with, so QuorX wouldn't see a toolchain installed while it runs. This adds the registry's new entries
// (never removes any); the agent's commands inherit them too.
const readRegPath = async (key) => {
  const o = await run('reg.exe', ['query', key, '/v', 'Path']);
  const m = o && o.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
  return m ? m[1].trim().replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all) : '';
};
export async function refreshPath() {
  if (!WIN) return 0;
  const reg = [...(await readRegPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')).split(';'), ...(await readRegPath('HKCU\\Environment')).split(';')]
    .map((p) => p.trim()).filter(Boolean);
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const have = new Set(String(process.env[key] || '').split(';').map((p) => p.trim().replace(/\\$/, '').toLowerCase()));
  const add = [...new Set(reg)].filter((p) => !have.has(p.replace(/\\$/, '').toLowerCase()));
  if (add.length) process.env[key] = [process.env[key], ...add].filter(Boolean).join(';');
  return add.length;
}

// Installed is not the same as working: a pack's works() builds something tiny (Rust needs a C linker, for one).
async function probe(t) {
  if (!t.host) return { id: t.id, label: t.label, for: t.for, pack: t.pack, found: false, version: null, works: false, problem: '', winget: null, fixWith: null, host: false };
  let version = null;
  try { version = t.detect ? await t.detect() : ver(t.re)(await run(...t.probe)); } catch { version = null; }
  const r = { id: t.id, label: t.label, for: t.for, pack: t.pack, found: !!version, version, works: !!version, problem: '', winget: t.winget || null, fixWith: t.fixWith || null };
  if (version && t.works) { try { const b = await t.works(); r.works = b.ok; r.problem = b.why; } catch (e) { r.works = false; r.problem = e.message; } }
  return r;
}

let cache = null;
/**
 * [{ id, label, for, pack, found, works, problem, version, winget, fixWith }] — cached 10 minutes; `fresh` probes
 * again. What was missing or couldn't build is looked at again after a minute, so a toolchain the user installs
 * mid-chat (from the Setup check, or a winget the agent ran) counts on the next reply without restarting QuorX.
 */
export async function detectToolchains(fresh = false) {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < 600e3) {
    const gaps = cache.list.filter((t) => !t.found || !t.works);
    if (!gaps.length || now - cache.gapsAt < 60e3) return cache.list;
    await refreshPath();
    const again = await Promise.all(gaps.map((g) => probe(TOOLCHAINS.find((t) => t.id === g.id))));
    const list = cache.list.map((t) => again.find((a) => a.id === t.id) || t);
    cache = { ...cache, list, gapsAt: now };
    return list;
  }
  await refreshPath();
  const list = await Promise.all(TOOLCHAINS.map(probe));
  cache = { at: now, gapsAt: now, list };
  return list;
}

/** One paragraph for the agent: what it can build with here, what is missing, and what to do about a broken one. */
export function toolchainNote(list) {
  const def = (id) => TOOLCHAINS.find((t) => t.id === id) || {};
  const have = list.filter((t) => t.found).map((t) => `${t.label} ${t.version}${t.works ? '' : ' (installed, but it can\'t build programs here)'}`);
  const missing = list.filter((t) => !t.found && t.host !== false).map((t) => t.label);
  const broken = list.filter((t) => t.found && !t.works);
  const after = 'Installing runs outside this chat and can take a while: say so, and ask the user to tell you when it is done; QuorX looks for toolchains again on each reply, so you carry on from there';
  return `Toolchains on this computer: ${have.join(', ') || 'none found'}.${missing.length ? ` Not installed: ${missing.join(', ')} (if the task needs one, tell the user; they can install it from ⚙ Settings → Setup check, or you can run its winget install if they allow it).` : ''}`
    + broken.map((t) => { const d = def(t.id), hint = typeof d.brokenHint === 'function' ? d.brokenHint() : d.brokenHint || ''; return ` ${t.label}: ${t.problem}. ${d.checkStillWorks ? `Checking code still works (${d.checkStillWorks}), but building or running a program won't: before` : 'Before'} you try, tell the user.${hint ? ` ${hint}` : ''}`; }).join('')
    + (missing.length || broken.length ? ` ${after}.` : '')
    + list.filter((t) => t.found && def(t.id).note).map((t) => ` ${def(t.id).note}`).join('');
}
