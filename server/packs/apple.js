// Apple apps: iPhone, iPad and Mac apps (SwiftUI, UIKit, AppKit) built with Xcode, and Swift packages. Needs a Mac:
// Xcode, the simulators and Apple's signing only run on macOS.
// Detect: Xcode (and that it is the active developer folder, licensed and set up), the simulators, lldb-dap.
// Check: a quiet xcodebuild of the project's scheme for a simulator or the Mac, with signing off; swift build for
// Swift packages. Run and drive: simctl (boot, install, launch, screenshot, logs), and the desktop tool on the
// Simulator app or a Mac app. Crashes: the newest .ips report, summed up above the output of the run that crashed.
// Debug: lldb-dap launches a Mac app or a Swift package's program, or attaches to the app in the simulator.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { MAC, run } from './_lib.js';
import { parseSimctl, pickSimulator, buildErrors, tidyDiag, xcodeContainer, listSchemes, pickScheme, projectPlatform, projectBundleId, DESTINATIONS,
  xcodeCheckLine, parseIps, crashText, newestCrash, CRASHED } from './_apple.js';

const quote = (a) => (/[^\w@%+=:,./-]/.test(a) ? `'${String(a).replace(/'/g, "'\\''")}'` : a);
/** A command with its exit code: { code, out }. */
const sh = (cmd, args, { cwd, timeout = 600e3 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout, encoding: 'utf8', maxBuffer: 64 << 20 }, (err, out, errOut) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: `${out || ''}${errOut || ''}` }));
});

// ---------- detect ----------
let devDir = '/Applications/Xcode.app/Contents/Developer'; // xcode-select -p, read when Xcode is detected
async function xcodeVersion() {
  if (!MAC) return null;
  const d = (await run('xcode-select', ['-p']))?.split('\n')[0];
  if (d) devDir = d;
  return /Xcode (\d+(?:\.\d+)+)/.exec((await run('xcodebuild', ['-version'], { timeout: 20000 })) || '')?.[1] || null;
}
// Xcode installed is not Xcode ready: the active developer folder may be the Command Line Tools, the license may not
// be accepted, or the first launch (its system parts) not done. Each needs the user's password, so it is theirs to run.
async function xcodeWorks() {
  if (/CommandLineTools/.test(devDir)) return { ok: false, why: 'the active developer folder is the Command Line Tools, not Xcode', fix: 'sudo xcode-select -s /Applications/Xcode.app' };
  if ((await sh('xcodebuild', ['-license', 'check'], { timeout: 20000 })).code) return { ok: false, why: 'the Xcode license is not accepted yet', fix: 'sudo xcodebuild -license accept' };
  if ((await sh('xcodebuild', ['-checkFirstLaunchStatus'], { timeout: 20000 })).code) return { ok: false, why: 'Xcode\'s first launch is not done', fix: 'sudo xcodebuild -runFirstLaunch' };
  return { ok: true, why: '' };
}
let fixLine = '';
async function xcodeReady() { const r = await xcodeWorks(); fixLine = r.fix || ''; return r; }

let sims = null; // the last simctl list, for the notes
async function simulators() {
  if (!MAC) return null;
  sims = parseSimctl(await run('xcrun', ['simctl', 'list', '-j'], { timeout: 30000 }));
  const rt = sims.runtimes.filter((r) => r.available);
  return rt.length ? rt.slice(0, 3).map((r) => r.name).join(', ') : null;
}

async function lldbDap() {
  if (!MAC) return null;
  const p = (await run('xcrun', ['--find', 'lldb-dap']))?.split('\n')[0];
  if (!p || !fs.existsSync(p)) return null;
  return /lldb-(\d+(?:\.\d+)+)/.exec((await run('xcrun', ['lldb', '--version'])) || '')?.[1] || 'found';
}

// ---------- debug ----------
// lldb-dap listens on a port with --connection (LLVM 20 and later) or --port before.
const listenArgs = (help, port) => (/--connection/.test(help || '') ? ['--connection', `listen://127.0.0.1:${port}`] : ['--port', String(port)]);
const firstErrors = (out) => buildErrors(out).slice(0, 5).map((e) => (e.file ? `${path.basename(e.file)}:${e.line}: ${e.msg}` : e.msg)).join('; ') || String(out).trim().split('\n').slice(-3).join(' ');

/** A Swift package's program: builds it, then the executable product whose sources hold `file` (or the first). */
async function packageProgram(dir, file) {
  const b = await sh('swift', ['build'], { cwd: dir });
  if (b.code) throw new Error(`swift build failed: ${firstErrors(b.out)}`);
  const bin = (await sh('swift', ['build', '--show-bin-path'], { cwd: dir })).out.trim().split('\n').pop();
  let products = [];
  try {
    const j = JSON.parse((await sh('swift', ['package', 'describe', '--type', 'json'], { cwd: dir })).out.replace(/^[^{]*/, ''));
    products = (j.products || []).filter((p) => p.type && 'executable' in p.type).map((p) => ({ name: p.name, targets: p.targets || [] }));
    const targetOf = (j.targets || []).find((t) => file && path.resolve(dir, file).startsWith(path.resolve(dir, t.path || `Sources/${t.name}`)));
    const hit = targetOf && products.find((p) => p.targets.includes(targetOf.name));
    if (hit) products = [hit, ...products.filter((p) => p !== hit)];
  } catch { /* fall back to the folder's name */ }
  const name = products[0]?.name || path.basename(dir);
  const program = path.join(bin, name);
  if (!fs.existsSync(program)) throw new Error(`the package built, but its program ${name} is not in ${bin}`);
  return program;
}

/** Build settings of an Xcode scheme for a destination: { TARGET_BUILD_DIR, EXECUTABLE_PATH, PRODUCT_BUNDLE_IDENTIFIER, … }. */
async function buildSettings(dir, where, scheme, dest) {
  const r = await sh('xcodebuild', [...where, '-scheme', scheme, '-destination', dest, '-showBuildSettings', '-json'], { cwd: dir, timeout: 120e3 });
  try { const j = JSON.parse(r.out.slice(r.out.indexOf('['))); return (j.find((x) => x.buildSettings?.WRAPPER_EXTENSION === 'app') || j[0]).buildSettings; } catch { throw new Error(`could not read the build settings of ${scheme}: ${firstErrors(r.out)}`); }
}

/**
 * The lldb-dap plan for `file`'s project: a Swift package's program or a Mac app is launched under lldb-dap; an iPhone
 * or iPad app is built, installed and started in the simulator, waiting for the debugger, and lldb-dap attaches to it.
 */
async function debugPlan({ file, args = [], cwd, port }) {
  if (!MAC) throw new Error('debugging Apple apps needs a Mac');
  const dap = (await run('xcrun', ['--find', 'lldb-dap']))?.split('\n')[0];
  if (!dap || !fs.existsSync(dap)) throw new Error('lldb-dap is not here: it comes with Xcode 16 or later. Tell the user; updating Xcode is theirs to do (App Store).');
  const line = [quote(dap), ...listenArgs(await run(dap, ['--help']), port)].join(' ');
  const base = { line, adapterID: 'lldb-dap', missing: 'lldb-dap did not open its port', evalContext: 'watch' };
  const c = xcodeContainer(cwd);
  if (!c && fs.existsSync(path.join(cwd, 'Package.swift'))) {
    return { ...base, request: 'launch', args: { program: await packageProgram(cwd, file), args, cwd, stopOnEntry: false } };
  }
  if (!c) throw new Error('no Xcode project or Package.swift in the project folder');
  let pbx = ''; try { pbx = fs.readFileSync(path.join(cwd, c.project, 'project.pbxproj'), 'utf8'); } catch { /* none */ }
  const scheme = pickScheme(listSchemes(cwd, c), c);
  if (!scheme) throw new Error('the project shares no scheme: open it in Xcode once (or share a scheme), then try again');
  const where = [c.kind === 'workspace' ? '-workspace' : '-project', c.name];
  const platform = projectPlatform(pbx);
  if (platform === 'macos' || platform === 'multi') {
    const dest = DESTINATIONS.macos;
    const b = await sh('xcodebuild', ['-quiet', ...where, '-scheme', scheme, '-destination', dest, '-configuration', 'Debug', 'build'], { cwd });
    if (b.code) throw new Error(`the build failed: ${firstErrors(b.out)}`);
    const s = await buildSettings(cwd, where, scheme, dest);
    return { ...base, request: 'launch', args: { program: path.join(s.TARGET_BUILD_DIR, s.EXECUTABLE_PATH), args, cwd, stopOnEntry: false } };
  }
  // iPhone and iPad (and the other simulators): the app runs inside the simulator, as a process of this Mac.
  const list = parseSimctl(await run('xcrun', ['simctl', 'list', '-j'], { timeout: 30000 }));
  const sim = pickSimulator(list, { platform: { ios: 'iOS', visionos: 'xrOS', tvos: 'tvOS', watchos: 'watchOS' }[platform] || 'iOS' });
  if (!sim) throw new Error('no simulator is installed for this app: Xcode → Settings → Components adds one (the user does that)');
  const dest = `id=${sim.udid}`;
  const b = await sh('xcodebuild', ['-quiet', ...where, '-scheme', scheme, '-destination', dest, '-configuration', 'Debug', 'build'], { cwd });
  if (b.code) throw new Error(`the build failed: ${firstErrors(b.out)}`);
  const s = await buildSettings(cwd, where, scheme, dest);
  const app = path.join(s.TARGET_BUILD_DIR, s.WRAPPER_NAME || `${s.PRODUCT_NAME}.app`);
  if (sim.state !== 'Booted') await sh('xcrun', ['simctl', 'boot', sim.udid], { timeout: 180e3 });
  const inst = await sh('xcrun', ['simctl', 'install', sim.udid, app], { timeout: 180e3 });
  if (inst.code) throw new Error(`the app could not be installed in ${sim.name}: ${inst.out.trim().split('\n').slice(-2).join(' ')}`);
  const launch = await sh('xcrun', ['simctl', 'launch', '--wait-for-debugger', '--terminate-running-process', sim.udid, s.PRODUCT_BUNDLE_IDENTIFIER, ...args], { timeout: 120e3 });
  const pid = Number(/:\s*(\d+)\s*$/m.exec(launch.out)?.[1]);
  if (!pid) throw new Error(`the app did not start in ${sim.name}: ${launch.out.trim().split('\n').slice(-2).join(' ')}`);
  return { ...base, request: 'attach', args: { pid, program: path.join(app, s.EXECUTABLE_PATH?.split('/').pop() || s.PRODUCT_NAME), stopOnEntry: false },
    note: `The app runs in the ${sim.name} simulator (process ${pid}), waiting for the debugger; continue lets it start.` };
}

// ---------- crashes ----------
// Reading a report (cat …ips) or running something that crashed puts a summary of the report above the output.
function ipsSummary(out) {
  const s = String(out || ''), at = s.search(/^\{"/m);
  return at < 0 ? '' : crashText(parseIps(s.slice(at)));
}
function crashSummary(out) {
  if (!CRASHED.test(String(out || ''))) return '';
  const file = newestCrash({ since: Date.now() - 180e3 });
  if (!file) return '';
  try { return crashText(parseIps(fs.readFileSync(file, 'utf8')), { file: file.replace(process.env.HOME || '\0', '~') }); } catch { return ''; }
}
const RUNS = /(\.app\/Contents\/MacOS\/|(^|[\s;&|])swift (run|test)\b|\bxcodebuild\b.*\btest\b|\bsimctl\b.*\blaunch\b|\.build\/(debug|release)\/)/;

// ---------- notes ----------
function notes(have, root) {
  const c = root ? xcodeContainer(root) : null;
  const pkg = root && fs.existsSync(path.join(root, 'Package.swift'));
  const direct = 'Run commands directly with the shell tool, never through a wrapper script.';
  const crash = 'When a run crashes, QuorX puts a summary of its crash report above the output (the exception, the message and the first frame in your code); reports are in ~/Library/Logs/DiagnosticReports (ls -t ~/Library/Logs/DiagnosticReports | head -5, then cat one for its summary).';
  const signing = 'A real device, TestFlight and the App Store need the user\'s Apple ID and certificates in Xcode: don\'t try to set up signing; the simulator and the Mac need none for a debug build.';
  const ready = !have.has('xcode') ? ' Xcode isn\'t installed here: the user installs it from the App Store (it is large); until then only Swift packages build.'
    : fixLine ? ` Xcode isn't ready here: the user runs ${fixLine} in a terminal tab (it needs their password); until then nothing can build.` : '';
  if (!c) {
    if (!pkg) return '';
    return `a Swift package. Build with swift build, test with swift test, run with swift run <product> -- <args>. ${direct} ${crash} For an app with windows, make an Xcode project (or an executable target with SwiftUI's App) and start its program with background: true.${ready}`;
  }
  let pbx = ''; try { pbx = fs.readFileSync(path.join(root, c.project, 'project.pbxproj'), 'utf8'); } catch { /* none */ }
  const scheme = pickScheme(listSchemes(root, c), c) || '<scheme>';
  const platform = projectPlatform(pbx);
  const where = `${c.kind === 'workspace' ? '-workspace' : '-project'} ${quote(c.name)} -scheme ${quote(scheme)}`;
  const bundle = projectBundleId(pbx) || '<bundle id>';
  const build = (dest) => `xcodebuild ${where} -destination ${quote(dest)} -derivedDataPath build`;
  const head = `an Xcode ${c.kind} (${c.name}, scheme ${scheme}${platform === 'multi' ? ', iPhone and Mac' : platform === 'macos' ? ', Mac' : `, ${platform === 'ios' ? 'iPhone and iPad' : platform}`}, bundle id ${bundle}).`;
  const mac = `Build: ${build('platform=macOS')} build (add -quiet for errors only; test with test instead of build). Run its program with background: true: build/Build/Products/Debug/<Product>.app/Contents/MacOS/<Product> (not open: that hands it to macOS, out of your reach); the desktop tool then reads and presses its window (^ is the Command key).`;
  const sim = pickSimulator(sims || { devices: [] })?.name || 'iPhone 16';
  const simulator = `Build for the simulator: ${build(`platform=iOS Simulator,name=${sim}`)} build (test with test). Then: xcrun simctl boot ${quote(sim)} (once; xcrun simctl list devices available lists them), xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/<Product>.app, xcrun simctl launch --console-pty booted ${bundle} with background: true (its print output goes to the job; job_output reads it). To see and use the screen, start the Simulator app by its own program with background: true: ${quote(`${devDir}/Applications/Simulator.app/Contents/MacOS/Simulator`)}; the desktop tool then reads the app's controls and presses them. A picture for the user: xcrun simctl io booted screenshot .quorx/scratch/screen.png. Logs: xcrun simctl spawn booted log stream --level debug --predicate 'subsystem == "${bundle}"' with background: true. Simulator data and crashes stay in the simulator; xcrun simctl erase deletes a simulator's data and asks the user.${have.has('idb') ? ' idb is installed too: idb ui describe-all reads the screen as text, idb ui tap X Y taps.' : ''}`;
  return `${head} ${platform === 'macos' ? mac : platform === 'multi' ? `${mac} ${simulator}` : simulator} ${direct} ${crash} The debugger (debug start on a .swift or .m file) builds the app and starts it paused: a Mac app under lldb-dap, an iPhone app in the simulator with lldb-dap attached. ${signing}${ready}`;
}

export default {
  id: 'apple',
  label: 'Apple apps',
  summary: 'iPhone, iPad and Mac apps (SwiftUI, UIKit, AppKit) and Swift packages',
  hosts: ['darwin'],
  toolchains: [
    { id: 'xcode', label: 'Xcode', for: 'iPhone, iPad and Mac apps', detect: xcodeVersion, works: xcodeReady, url: 'https://apps.apple.com/app/xcode/id497799835',
      brokenHint: () => `The user fixes this in a terminal tab (it needs their password): ${fixLine || 'sudo xcode-select -s /Applications/Xcode.app'}. Then carry on.` },
    { id: 'swift', label: 'Swift', for: 'Swift packages and command-line tools', probe: ['swift', ['--version']], re: /Swift version (\d+\.\d+(?:\.\d+)?)/ },
    { id: 'simulator', label: 'Simulators', for: 'running iPhone and iPad apps without a phone', detect: simulators },
    { id: 'lldb-dap', label: 'lldb-dap (Xcode)', for: 'debugging Swift and Objective-C', detect: lldbDap },
    { id: 'idb', label: 'idb', for: 'reading and tapping the simulator\'s screen from the command line (optional)', detect: async () => (MAC && /usage/i.test((await run('idb', ['--help'])) || '') ? 'found' : null), brew: 'facebook/fb/idb-companion', url: 'https://fbidb.io' },
  ],
  markers: [/\.xcodeproj$/, /\.xcworkspace$/, /^Package\.swift$/],
  checks: [
    // The dir's scheme is built for a simulator (or the Mac) with signing off: no device or certificate needed.
    { id: 'xcode', tool: 'xcode', ext: /\.(swift|m|mm|h|metal)$/i, marker: (d) => !!xcodeContainer(d), cmd: (a) => xcodeCheckLine(typeof a === 'string' ? a : a.dir), tidy: tidyDiag },
    { id: 'swiftpm', tool: 'swift', ext: /\.swift$/i, marker: (d) => fs.existsSync(path.join(d, 'Package.swift')) && !xcodeContainer(d), cmd: 'swift build -q', tidy: tidyDiag },
  ],
  summaries: [{ cmd: /\.ips\b/, summarize: ipsSummary }, { cmd: RUNS, summarize: crashSummary }],
  debug: {
    exts: ['.swift', '.m', '.mm'], label: 'Swift and Objective-C (lldb-dap)',
    // What the rules and the approval card judge: the program run under the debugger.
    gate: ({ file, args = [] }) => ['lldb', file, ...args].map(quote).join(' '),
    start: debugPlan,
  },
  notes,
  test: { needs: ['swift'] },
};
