// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Node.js and TypeScript: scripts, tools, servers, and the JavaScript half of Electron and Tauri apps.
// (Node programs are debugged with V8's own inspector, built into server/debugger.js.)
import fs from 'node:fs';
import path from 'node:path';

export default {
  id: 'node',
  label: 'Node.js and TypeScript',
  summary: 'Scripts, command-line tools and servers',
  toolchains: [{ id: 'node', label: 'Node.js', for: 'JavaScript and TypeScript; Electron apps', probe: ['node', ['--version']], re: /v(\d+\.\d+\.\d+)/, winget: 'OpenJS.NodeJS.LTS', brew: 'node', apt: 'nodejs' }],
  markers: [/^package\.json$/, /^tsconfig\.json$/],
  checks: [{
    id: 'ts', tool: 'node', ext: /\.(ts|tsx|mts|cts)$/i,
    marker: (d) => fs.existsSync(path.join(d, 'tsconfig.json')) && fs.existsSync(path.join(d, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')),
    cmd: 'npx --no-install tsc --noEmit --pretty false',
  }],
  notes: () => 'run scripts with node or the package.json scripts (npm run <name>); tests with npm test. A server or watcher keeps running: start it with start_server or shell (background: true). For a crash, read the stack trace\'s first line in your own code; the debug tool runs a .js file under the inspector once plain debugging has failed twice.',
  test: { needs: ['node'] },
};
