// Copies the desktop app's version into the main package.json, so the app, the harness and the sidebar
// show one version. Run by "npm run release" after the version is raised.
const fs = require('node:fs');
const path = require('node:path');
const v = require('./package.json').version;
const file = path.join(__dirname, '..', 'package.json');
const s = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, s.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`));
console.log(`version ${v} everywhere`);
