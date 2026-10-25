// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Writes build/icon.png (256×256) for the installer from the logo in assets/: node make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const { pngIcon } = require('./icon.js');
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'build', 'icon.png'), pngIcon(256));
console.log('build/icon.png written');
