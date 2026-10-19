// Writes the winget manifests for the desktop installer that `npm run desktop:dist` built, so the app can be
// installed with `winget install QuorX.QuorX`. Run: npm run winget -- [--url <download base>] [--validate]
//
// The installer has to be downloadable from a public address first (winget fetches it to check its hash).
// The base comes from --url, else from quorx.updateUrl in desktop/package.json (the update feed serves the
// same files). Output: desktop/dist/winget/<version>/ with the three manifests winget-pkgs expects.
// Publishing is a pull request to github.com/microsoft/winget-pkgs: `wingetcreate submit <that folder>`
// (needs a GitHub token), or copy the folder to manifests/o/QuorX/QuorX/<version>/ in a fork.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// Who publishes it. Fill these in desktop/package.json → quorx.winget before the first submission.
const W = { publisher: 'QuorX', publisherUrl: '', license: 'Proprietary', licenseUrl: '', packageUrl: '', ...(pkg.quorx?.winget || {}) };
const ID = W.packageIdentifier || 'QuorX.QuorX';
const version = flag('--version') || pkg.version;
const exe = path.join(ROOT, 'desktop', 'dist', `QuorX-Setup-${version}.exe`);
if (!fs.existsSync(exe)) { console.error(`No installer for ${version} at ${path.relative(ROOT, exe)}. Run npm run desktop:dist first.`); process.exit(1); }
// winget pins the installer's hash, so the address must stay on this version forever: a "latest" feed address
// would break the day the next version ships. {version} in the base is filled in; a GitHub "releases/latest/download"
// feed becomes that version's own release ("releases/download/v<version>").
const raw = flag('--url') || W.downloadBase || pkg.quorx?.updateUrl || '';
const base = raw.replace(/\/releases\/latest\/download\/?$/, '/releases/download/v{version}').replaceAll('{version}', version).replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) { console.error('Give the public download base with --url https://… (or set quorx.winget.downloadBase in desktop/package.json; {version} is filled in). winget only takes https addresses.'); process.exit(1); }

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex').toUpperCase();
const MV = '1.10.0';
const head = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${MV}.schema.json\n# Written by scripts/winget-manifest.mjs\n\n`;
const files = {
  [`${ID}.yaml`]: `${head('version')}PackageIdentifier: ${ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${MV}
`,
  [`${ID}.installer.yaml`]: `${head('installer')}PackageIdentifier: ${ID}
PackageVersion: ${version}
InstallerType: nullsoft
Scope: user
InstallModes:
  - interactive
  - silent
UpgradeBehavior: install
Installers:
  - Architecture: x64
    InstallerUrl: ${base}/QuorX-Setup-${version}.exe
    InstallerSha256: ${sha256}
ManifestType: installer
ManifestVersion: ${MV}
`,
  [`${ID}.locale.en-US.yaml`]: `${head('defaultLocale')}PackageIdentifier: ${ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${W.publisher}
${W.publisherUrl ? `PublisherUrl: ${W.publisherUrl}\n` : ''}PackageName: QuorX
${W.packageUrl ? `PackageUrl: ${W.packageUrl}\n` : ''}License: ${W.license}
${W.licenseUrl ? `LicenseUrl: ${W.licenseUrl}\n` : ''}ShortDescription: An open-source AI agent with a quorum of models behind every call. Any model, through OpenRouter.
Moniker: quorx
Tags:
  - ai
  - agent
  - openrouter
  - developer-tools
ManifestType: defaultLocale
ManifestVersion: ${MV}
`,
};
const out = path.join(ROOT, 'desktop', 'dist', 'winget', version);
fs.mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text);
console.log(`winget manifests for ${ID} ${version} → ${path.relative(ROOT, out)}`);
console.log(`  installer: ${base}/QuorX-Setup-${version}.exe`);
console.log(`  sha256:    ${sha256}`);
if (args.includes('--validate')) {
  try { console.log(execFileSync('winget', ['validate', '--manifest', out], { encoding: 'utf8' }).trim()); }
  catch (e) { console.error(`winget validate failed:\n${(e.stdout || '') + (e.stderr || e.message)}`); process.exit(1); }
}
console.log('Next: make sure the installer is downloadable at that address, then `wingetcreate submit` this folder (or open a pull request to microsoft/winget-pkgs).');
