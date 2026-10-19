// Electron: desktop apps made of a Node main process and web-page windows. The windows are driven through the app's
// own DevTools port (the browser tool's cdp:<port> target); the main process is debugged by attaching to its Node
// inspector (debug attach). TypeScript in an Electron project is checked by the Node pack.
import fs from 'node:fs';
import path from 'node:path';
import nodePack from './node.js';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const deps = (pkg) => ({ ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) });

/** Whether `root`'s package.json depends on electron. */
export const isElectron = (root) => 'electron' in deps(readJson(path.join(root, 'package.json')));

/** The Electron binary npm installed for the project in `root` (node_modules/electron/path.txt names it), or null. */
export function electronBinary(root) {
  const mod = path.join(root, 'node_modules', 'electron');
  try {
    const exe = path.join(mod, 'dist', fs.readFileSync(path.join(mod, 'path.txt'), 'utf8').trim());
    return fs.existsSync(exe) ? exe : null;
  } catch { return null; }
}

/** How the project in `root` is packaged: { tool, cmd, out }, or null when it has no packager yet. */
export function packager(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const d = deps(pkg);
  if (d['@electron-forge/cli'] || pkg?.config?.forge || fs.existsSync(path.join(root, 'forge.config.js'))) return { tool: 'electron-forge', cmd: 'npx electron-forge make', out: 'out/make' };
  if (d['electron-builder'] || pkg?.build || ['electron-builder.yml', 'electron-builder.json'].some((f) => fs.existsSync(path.join(root, f)))) return { tool: 'electron-builder', cmd: 'npx electron-builder --win', out: 'dist' };
  if (d['electron-packager'] || d['@electron/packager']) return { tool: 'electron-packager', cmd: 'npx electron-packager .', out: 'a folder named <app>-win32-x64' };
  return null;
}

export default {
  id: 'electron',
  label: 'Electron',
  summary: 'Desktop apps with web-page windows and a Node main process',
  toolchains: nodePack.toolchains, // Electron itself is a package each project installs with npm
  detect: isElectron,
  notes: (have, root) => {
    const pkg = root ? readJson(path.join(root, 'package.json')) : null;
    const pack = root ? packager(root) : null;
    return [
      `the main process (Node: ${pkg?.main || 'package.json\'s "main"'}) opens windows that are web pages.${root && !electronBinary(root) ? ' Electron is not in node_modules yet: run npm install first.' : ''}`,
      'Run it as a background job (shell, background: true) with a DevTools port: npx electron . --remote-debugging-port=<port> (a free port, e.g. 9400-9499); not electron.exe itself, which returns at once from PowerShell (it is a window app) and the job would end without it. Then browser open cdp:<port> attaches to its first window: read it, click, type and press like a page; its "Console errors" line is the renderer\'s errors.',
      'The main process\'s console output and crashes go to the job\'s output (job_output). Never set ELECTRON_RUN_AS_NODE: Electron would run as plain Node.',
      "To debug the main process, add --inspect=<another port> to the same command (--inspect-brk=<port> stops on Electron's first line, before the main file loads), then debug attach with that port and break in the main file. For code a click runs: click in the window, then debug state shows where it stopped (not continue, which would run past it). While the main process is stopped its window doesn't answer the browser tool (a click there gives up after 10 s), so continue or debug stop before using the window again. debug stop only disconnects; job_stop ends the app.",
      pack ? `Package with ${pack.cmd} (${pack.tool}; output in ${pack.out}).` : 'No packager is set up; electron-forge is the usual one (ask before adding it).',
      'The app\'s own log files are where it writes them, usually app.getPath(\'logs\') (under %APPDATA%\\<app name> on Windows); --enable-logging prints Chromium\'s log to the job output.',
    ].join(' ');
  },
  test: { needs: ['node'] },
};
