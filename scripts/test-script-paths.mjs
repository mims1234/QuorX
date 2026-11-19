// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// File names in a command line become links to read the file before you allow it: which words name a file it runs
// (public/script-paths.js), and reading one through the agent's own path checks (server/scriptfile.js).
import './test-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scriptPaths, cleanPath, looksScript } from '../public/script-paths.js';
import { readScript, findScript } from '../server/scriptfile.js';

const paths = (line, o) => scriptPaths(line, o).map((h) => h.path);
const named = (line) => scriptPaths(line).map((h) => line.slice(h.start, h.end));

test('script paths: a script handed to an interpreter', () => {
  assert.deepEqual(paths('node .quorx/scratch/by_modality.mjs image'), ['.quorx/scratch/by_modality.mjs']);
  assert.deepEqual(paths('node --max-old-space-size 4096 scripts/build.mjs --prod'), ['scripts/build.mjs']);
  assert.deepEqual(paths('python -u tools/x.py --n 3'), ['tools/x.py']);
  assert.deepEqual(paths('py -3 a/b.py'), ['a/b.py']);
  assert.deepEqual(paths('python3 manage'), [], 'a bare word with no ending or folder is not a file');
  assert.deepEqual(paths('bash run.sh'), ['run.sh']);
  assert.deepEqual(paths('npx tsx src/main.ts'), ['src/main.ts']);
  assert.deepEqual(paths('sudo -E node app/server.js'), ['app/server.js']);
  assert.deepEqual(paths('deno run --allow-net mod.ts'), ['mod.ts']);
  assert.deepEqual(paths('bun run x.ts'), ['x.ts']);
});

test('script paths: powershell -File, quoted paths and the spot in the line', () => {
  const line = 'powershell -NoProfile -ExecutionPolicy Bypass -File "setup dir\\setup.ps1" -Force';
  assert.deepEqual(paths(line), ['setup dir/setup.ps1']);
  assert.deepEqual(named(line), ['setup dir\\setup.ps1'], 'the link covers the name without its quotes');
  assert.deepEqual(paths('pwsh -f tools/x.ps1'), ['tools/x.ps1']);
  assert.deepEqual(paths('powershell .\\go.ps1'), ['go.ps1']);
});

test('script paths: a script run by its own name', () => {
  assert.deepEqual(paths('./run.sh --fast'), ['run.sh']);
  assert.deepEqual(paths('.\\setup.ps1'), ['setup.ps1']);
  assert.deepEqual(paths('& .\\tools\\a.ps1 -X 1'), ['tools/a.ps1']);
  assert.deepEqual(paths('tools\\make.bat clean'), ['tools/make.bat']);
  assert.deepEqual(paths('cmd /c tools\\make.bat'), ['tools/make.bat']);
  assert.deepEqual(paths('C:\\work\\x\\go.cmd'), ['C:/work/x/go.cmd']);
});

test('script paths: npm run points at package.json, a cd moves the folder', () => {
  const h = scriptPaths('npm run build');
  assert.equal(h.length, 1);
  assert.equal(h[0].path, 'package.json');
  assert.equal('npm run build'.slice(h[0].start, h[0].end), 'build');
  assert.match(h[0].label, /"build" line in package\.json/);
  assert.deepEqual(paths('cd web && npm test'), ['web/package.json']);
  assert.deepEqual(paths('cd web; node ../tools/a.js'), ['tools/a.js']);
  assert.deepEqual(paths('pnpm run dev'), ['package.json']);
  assert.deepEqual(paths('npm install left-pad'), [], 'installing is not running a script');
  assert.deepEqual(paths('node x.js', { cwd: 'app' }), ['app/x.js'], 'a command that starts in a subfolder');
});

test('script paths: other words that name scripts, and what is never one', () => {
  assert.deepEqual(paths('cat a.py | grep x'), ['a.py']);
  assert.deepEqual(paths('node a.js && python b.py'), ['a.js', 'b.py']);
  for (const line of ['git status', 'python -m http.server', 'python -c "import x.py"', 'node -e "require(\'./x.js\')"', 'curl https://x.com/a.js', 'ls *.js', 'echo $HOME/x.sh', 'npm --version', ''])
    assert.deepEqual(paths(line), [], line);
});

test('script paths: helpers', () => {
  assert.equal(cleanPath('./a/../b/c.js'), 'b/c.js');
  assert.equal(cleanPath('..\\x.py', 'web'), 'x.py');
  assert.equal(cleanPath('x.py', 'a/b'), 'a/b/x.py');
  assert.equal(looksScript('a.mjs'), true);
  assert.equal(looksScript('--flag'), false);
  assert.equal(looksScript('/c'), false);
  assert.equal(looksScript('notes.txt'), false);
  assert.equal(looksScript('bin/tool', { loose: true }), true);
});

test('script file: read from the project or an added folder, refused anywhere else', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-script-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj'), added = path.join(base, 'extra'), away = path.join(base, 'away');
  for (const d of [root, added, away, path.join(root, 'tools')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'x.py'), '\uFEFFprint("hi")\n');
  fs.writeFileSync(path.join(added, 'go.ps1'), 'Write-Host go');
  fs.writeFileSync(path.join(away, 'secret.sh'), 'echo no');
  fs.writeFileSync(path.join(root, 'bin.js'), Buffer.from([0x4d, 0x5a, 0, 0, 1, 2]));
  fs.writeFileSync(path.join(root, 'big.js'), 'x'.repeat(5000));

  assert.equal(readScript(root, [], 'tools/x.py').text, 'print("hi")\n', 'relative to the project, byte-order mark dropped');
  assert.equal(readScript(root, [], path.join(root, 'tools', 'x.py')).text, 'print("hi")\n', 'a full path inside the project');
  assert.equal(readScript(root, [added], path.join(added, 'go.ps1')).text, 'Write-Host go', 'a full path in an added folder');
  // As it is on disk now: a change shows on the next read.
  fs.writeFileSync(path.join(root, 'tools', 'x.py'), 'print("changed")\n');
  assert.equal(readScript(root, [], 'tools/x.py').text, 'print("changed")\n');

  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(() => readScript(root, [], 'tools/nope.py')), 'missing');
  assert.equal(code(() => readScript(root, [], '../away/secret.sh')), 'outside', 'climbing out of the project');
  assert.equal(code(() => readScript(root, [], path.join(away, 'secret.sh'))), 'outside', 'a full path elsewhere');
  assert.equal(code(() => readScript(root, [], path.join(added, 'go.ps1'))), 'outside', 'a folder the chat did not add');
  assert.equal(code(() => readScript(root, [], '\\\\server\\share\\x.ps1')), 'outside', 'a network path is never looked up');
  assert.equal(code(() => readScript(root, [], 'bin.js')), 'binary');
  assert.equal(code(() => readScript(root, [], 'big.js', { max: 1000 })), 'big');
  assert.equal(code(() => findScript(root, [], 'tools')), 'notfile');
  assert.equal(code(() => readScript(root, [], 'tools/x.py:evil')), 'outside', 'no alternate data streams');
});

test('script file: the page links names in the command card and step rows, and the server serves them as text', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(app, /<pre class="sc-line[^`]*\$\{cmdWithFiles\(c\.what, \{ cwd: c\.cwd \}\)\}<\/pre>/, 'the command card links its files');
  assert.match(app, /cmdOf\(x\.e\) != null \? cmdWithFiles\(cmdOf\(x\.e\)/, 'a command step\'s row links its files');
  assert.match(app, /\/api\/script-file\?project=/);
  assert.match(server, /url\.pathname === '\/api\/script-file'[\s\S]{0,1600}readScript\(root, folders/);
  assert.match(server, /'Cache-Control': 'no-store'/, 'always the file as it is now');
});
