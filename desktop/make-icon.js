// Writes build/icon.png (256×256) for the installer: node make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const { pngIcon } = require('./icon.js');
fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'build', 'icon.png'), pngIcon(256));
console.log('build/icon.png written');
