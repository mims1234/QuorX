// Copies the desktop app's version into the main package.json and package-lock.json, so the app, the
// harness and the sidebar show one version and a later "npm install" leaves the lockfile alone.
// Run by "npm run release" after the version is raised.
const fs = require('node:fs');
const path = require('node:path');
const v = require('./package.json').version;
const root = path.join(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const s = fs.readFileSync(pkgFile, 'utf8');
fs.writeFileSync(pkgFile, s.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`));
const lockFile = path.join(root, 'package-lock.json');
if (fs.existsSync(lockFile)) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = v;
  if (lock.packages && lock.packages['']) lock.packages[''].version = v;
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}
console.log(`version ${v} everywhere`);
