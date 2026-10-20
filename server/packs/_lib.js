// Small helpers the platform packs share. (Files starting with "_" are not packs.)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const WIN = process.platform === 'win32';
export const MAC = process.platform === 'darwin';

/** Runs a short command and resolves to its output (stdout + stderr), or null when it couldn't run at all. */
export const run = (cmd, args, { cwd, timeout = 6000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout, windowsHide: true, encoding: 'utf8', shell: WIN && !/\.exe$/i.test(cmd) }, (err, out, errOut) => resolve(err && !out && !errOut ? null : `${out || ''}${errOut || ''}`.trim()));
});

/** A version reader for a probe's output: the first group of `re`, or null. */
export const ver = (re) => (o) => (o && re.test(o) ? o.match(re)[1] : null);

/** Whether `dir` has a file whose name matches `re` (one level, no recursion). */
export const hasFile = (dir, re) => { try { return fs.readdirSync(dir).some((f) => re.test(f)); } catch { return false; } };

// Visual Studio's C++ Build Tools: the Microsoft compiler and the linker Rust needs on Windows. A plain Build Tools
// install has no compiler or linker: the C++ workload must be named, or link.exe never arrives.
export const VS_BUILD_TOOLS = { winget: 'Microsoft.VisualStudio.2022.BuildTools', wingetArgs: '--override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' };
export const VS_LINE = `winget install --id ${VS_BUILD_TOOLS.winget} -e ${VS_BUILD_TOOLS.wingetArgs}`;

/** A fresh temporary folder for a probe build; removed by the caller with `rm`. */
export const tempDir = (prefix) => fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', `qx-${prefix}-`));
export const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* in use */ } };
