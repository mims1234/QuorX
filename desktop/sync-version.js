// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Copies the desktop app's version into the main package.json, package-lock.json and CITATION.cff, so the app, the
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
// The citation names the version too; its release date is today's, the day the version is raised
const citeFile = path.join(root, 'CITATION.cff');
if (fs.existsSync(citeFile)) {
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(citeFile, fs.readFileSync(citeFile, 'utf8').replace(/^version: "[^"]*"/m, `version: "${v}"`).replace(/^date-released: "[^"]*"/m, `date-released: "${today}"`));
}
console.log(`version ${v} everywhere`);
