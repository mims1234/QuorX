// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Loads node-pty for the terminal tabs (pty.js) and the agent's terminal (agentterm.js). On Windows, node-pty closes a
// terminal by starting a small Node helper (child_process.fork) that lists the programs still in it, and it starts that
// helper without hiding its window: under the desktop app, which has no console, every closed terminal left a
// Terminal window open on the desktop. Here fork hides its window unless the caller says otherwise.
import cp from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform === 'win32' && !cp.fork.qxHidden) {
  const fork = cp.fork;
  cp.fork = function (mod, args, opts) {
    if (!Array.isArray(args)) { opts = args; args = []; }
    return fork.call(this, mod, args, { windowsHide: true, ...opts });
  };
  cp.fork.qxHidden = true;
}

const require = createRequire(import.meta.url);
let pty = null, loadError = '';
try { pty = require('node-pty'); } catch (e) { loadError = e.message; }
/** node-pty, or null with the reason it could not load. */
export const loadPty = () => ({ pty, loadError });
