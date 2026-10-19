// Shared by the pack self-tests: a throwaway data folder (imported first), a temp project, and what is installed.
// Self-tests drive QuorX's real code paths (compiler checks, the debugger, builds) with no model and no key, and
// skip themselves when their toolchain is missing, so anyone can run them: npm run test:packs.
import '../../../scripts/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectToolchains } from '../../toolchains.js';

export const WIN = process.platform === 'win32';

/** A fresh project folder with these files ({ 'src/main.rs': '…' }). */
export function project(label, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qx-pack-${label}-`));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return dir;
}

let chains = null;
/** { found, works, version } for a toolchain id, from the same detection QuorX uses. */
export async function tool(id) {
  chains ||= await detectToolchains(true);
  return chains.find((t) => t.id === id) || { found: false, works: false };
}
/** A reason to skip when the toolchain is missing (or false to run). */
export async function skipUnless(id, { works = false } = {}) {
  const t = await tool(id);
  if (!t.found) return `${id} is not installed`;
  if (works && !t.works) return `${id} is installed but ${t.problem || 'cannot build here'}`;
  return false;
}
