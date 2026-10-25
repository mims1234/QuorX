// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Writes extension/pageops.js from server/pageops.js, so the extension's page scripts and the debugger path run the
// very same page operations. Run after changing server/pageops.js (scripts/test-browser.mjs fails until you do).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qxPage } from '../server/pageops.js';

export const extensionPageops = () => `// Generated from server/pageops.js by scripts/sync-extension.mjs: don't edit here.\n(${qxPage})();\n`;
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'pageops.js');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(out, extensionPageops());
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}
