// After the Windows installer is signed (release.yml, publish job), its bytes have changed, so the files that
// describe it are rewritten: latest.yml (sha512 and size, which installed apps check before installing), the
// .blockmap (for small differential downloads) and its lines in SHA256SUMS.txt.
//   node desktop/after-sign.js <dist folder> <installer file name>
// The blockmap comes from electron-builder's own code (npm ci --ignore-scripts in desktop/ is enough).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function main(dir, exeName) {
  const exe = path.join(dir, exeName);
  if (!fs.existsSync(exe)) throw new Error(`no ${exeName} in ${dir}`);
  const buf = fs.readFileSync(exe);
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
  const size = buf.length;

  // latest.yml names one installer (files[0] and path); both sha512 lines and the size are that file's.
  const ymlFile = path.join(dir, 'latest.yml');
  const yml = fs.readFileSync(ymlFile, 'utf8');
  const urls = yml.match(/^\s*-\s*url:\s*(.+)$/gm) || [];
  if (urls.length !== 1 || !urls[0].includes(exeName)) throw new Error(`latest.yml should name only ${exeName}`);
  fs.writeFileSync(ymlFile, yml.replace(/^(\s*sha512:\s*).+$/gm, `$1${sha512}`).replace(/^(\s*size:\s*)\d+$/gm, `$1${size}`));

  let blockmap = false;
  try {
    const { buildBlockMap } = require(require.resolve('app-builder-lib/out/targets/blockmap/blockmap.js', { paths: [__dirname] }));
    await buildBlockMap(exe, 'gzip', `${exe}.blockmap`);
    blockmap = true;
  } catch (e) {
    // Without a matching blockmap, apps download the whole installer instead of the changed parts.
    fs.rmSync(`${exe}.blockmap`, { force: true });
    console.warn(`No new blockmap (${e.message}); the old one is removed.`);
  }

  // Same "<sha256>  <name>" lines, LF endings; only the lines for the changed files are rewritten.
  const sumsFile = path.join(dir, 'SHA256SUMS.txt');
  if (fs.existsSync(sumsFile)) {
    const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    const changed = new Set([exeName, 'latest.yml', `${exeName}.blockmap`]);
    const lines = fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/).filter(Boolean)
      .filter((l) => blockmap || l.split(/\s+/)[1] !== `${exeName}.blockmap`)
      .map((l) => { const name = l.replace(/^\S+\s+\*?/, ''); return changed.has(name) ? `${hash(name)}  ${name}` : l; });
    fs.writeFileSync(sumsFile, `${lines.join('\n')}\n`);
  }
  console.log(`${exeName}: ${size} bytes, sha512 ${sha512.slice(0, 16)}…; latest.yml${blockmap ? ', blockmap' : ''} and checksums updated`);
}

if (require.main === module) {
  const [dir, exeName] = process.argv.slice(2);
  if (!dir || !exeName) { console.error('usage: node after-sign.js <dist folder> <installer file name>'); process.exit(2); }
  main(dir, exeName).catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { main };
