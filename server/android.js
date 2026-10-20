// Android apps for the agent, through adb: boot an emulator, list devices, install an APK built in the project,
// launch it, read its screen as numbered controls (uiautomator's view hierarchy), tap, type, press keys, take a
// picture, read the log (with the newest crash summed up first).
// Only emulators are used unless the user allows physical phones in ⚙ Safety & commands (a phone holds real data).
// Every adb call is made by QuorX with fixed arguments; the agent never types an adb command line here.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { sdkTool, listAvds, findCrash, crashText } from './packs/android.js';
import { startBackground, getBackground, jobOutput } from './bgjobs.js';

// adb is often only inside the SDK (platform-tools), not on the PATH.
const adbPath = () => sdkTool('adb') || 'adb';
const run = (args, { timeout = 30000, binary = false } = {}) => new Promise((resolve, reject) => {
  execFile(adbPath(), args, { timeout, windowsHide: true, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
    if (err && !out?.length) return reject(new Error(err.code === 'ENOENT' ? 'adb is not installed (⚙ Settings → Setup check can install Android platform tools)' : String(errOut || err.message).trim().split(/\r?\n/).slice(-2).join(' ')));
    resolve(out);
  });
});

/** [{ serial, state, model, emulator }] */
export async function devices() {
  const out = await run(['devices', '-l'], { timeout: 10000 });
  return out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state] = l.split(/\s+/);
    return { serial, state, model: /model:(\S+)/.exec(l)?.[1] || '', emulator: /^emulator-\d+$/.test(serial) };
  });
}

/** The device to use: the one named, or the only usable one. Phones only when allowed. */
export async function pickDevice(serial, { phones = false } = {}) {
  const list = (await devices()).filter((d) => d.state === 'device');
  const usable = list.filter((d) => d.emulator || phones);
  if (serial) {
    const d = list.find((x) => x.serial === serial);
    if (!d) throw new Error(`no device ${serial} (connected: ${list.map((x) => x.serial).join(', ') || 'none'})`);
    if (!d.emulator && !phones) throw new Error(`${serial} is a physical phone; QuorX uses emulators only unless you allow phones in ⚙ Settings → Safety & commands`);
    return d.serial;
  }
  if (!usable.length) throw new Error(list.length ? 'only physical phones are connected; start an emulator, or allow phones in ⚙ Settings → Safety & commands' : 'no emulator is running (android avds lists the virtual devices; android start {avd} boots one)');
  return usable[0].serial;
}

// ---------- the screen as numbered controls ----------
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")]));
/**
 * Parses a uiautomator dump: [{ ref, kind, text, id, clickable, x, y, w, h }] for every node that says or does
 * something. Interactive ones (clickable, checkable, editable) get a ref.
 */
export function parseHierarchy(xml) {
  const out = [];
  let ref = 0;
  for (const m of String(xml).matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || '');
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    const kind = String(a.class || '').split('.').pop();
    const text = a.text || a['content-desc'] || '';
    const interactive = a.clickable === 'true' || a.checkable === 'true' || kind === 'EditText' || a['long-clickable'] === 'true';
    if (!text && !interactive) continue;
    if (x2 <= x1 || y2 <= y1) continue;
    out.push({ ref: interactive ? ++ref : null, kind, text: text.slice(0, 80), id: (a['resource-id'] || '').split('/').pop(), checked: a.checkable === 'true' ? a.checked === 'true' : null, enabled: a.enabled !== 'false', x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) });
  }
  return out;
}
export function hierarchyText(nodes) {
  return nodes.map((n) => `${n.ref ? `[${n.ref}] ` : '    '}${n.kind}${n.text ? ` "${n.text}"` : ''}${n.id ? ` #${n.id}` : ''}${n.checked != null ? (n.checked ? ' checked' : ' unchecked') : ''}${n.enabled ? '' : ' (disabled)'} @${n.x},${n.y}`).join('\n');
}

const LAST = new Map(); // serial → the last screen's nodes (refs point into it)
export async function readScreen(serial) {
  await run(['-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/qx-ui.xml'], { timeout: 20000 });
  const xml = await run(['-s', serial, 'shell', 'cat', '/sdcard/qx-ui.xml']);
  const nodes = parseHierarchy(xml);
  LAST.set(serial, nodes);
  return { nodes, text: hierarchyText(nodes) };
}
export async function tap(serial, { ref, x, y }) {
  let p = { x, y };
  if (ref != null) { const n = (LAST.get(serial) || []).find((k) => k.ref === Number(ref)); if (!n) throw new Error(`no control [${ref}]: read the screen again`); p = n; }
  if (!(Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))) throw new Error('tap needs a ref, or x and y');
  await run(['-s', serial, 'shell', 'input', 'tap', String(Math.round(p.x)), String(Math.round(p.y))]);
  return `tapped ${ref != null ? `[${ref}]` : `${p.x},${p.y}`}`;
}
// `input text` treats spaces and shell characters specially.
export async function typeText(serial, text) {
  const safe = String(text ?? '').replace(/[\\'"`$&|;<>()*?~]/g, (c) => `\\${c}`).replace(/ /g, '%s');
  await run(['-s', serial, 'shell', 'input', 'text', safe]);
  return `typed ${String(text ?? '').length} characters`;
}
const KEYS = { back: 4, home: 3, enter: 66, tab: 61, delete: 67, menu: 82, up: 19, down: 20, left: 21, right: 22, recent: 187 };
export async function key(serial, name) {
  const code = KEYS[String(name).toLowerCase()];
  if (!code) throw new Error(`unknown key ${name} (known: ${Object.keys(KEYS).join(', ')})`);
  await run(['-s', serial, 'shell', 'input', 'keyevent', String(code)]);
  return `pressed ${name}`;
}
export async function screenshot(serial) {
  const png = await run(['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true });
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}
/** Installs an APK from inside the project. */
export async function install(serial, root, apk) {
  const abs = path.resolve(root, apk);
  if (!abs.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw new Error('the APK must be inside the project');
  if (!fs.existsSync(abs)) throw new Error(`no file ${apk}`);
  const out = await run(['-s', serial, 'install', '-r', abs], { timeout: 180000 });
  return String(out).trim().split(/\r?\n/).pop();
}
export async function launch(serial, pkg) {
  if (!/^[\w.]+$/.test(String(pkg))) throw new Error('a package name looks like com.example.app');
  await run(['-s', serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  return `launched ${pkg}`;
}
/** The newest log lines: errors and the app's own lines, after a summary of the newest crash when there is one. */
export async function logcat(serial, pkg) {
  const out = await run(['-s', serial, 'logcat', '-d', '-t', '2000', '-v', 'brief'], { timeout: 20000 });
  const crash = crashText(findCrash(out, pkg));
  const lines = String(out).split(/\r?\n/).filter((l) => /^[EF]\//.test(l) || (pkg && l.includes(pkg)) || /AndroidRuntime|FATAL/.test(l));
  return [crash, lines.slice(-80).join('\n') || '(no errors or lines from the app)'].filter(Boolean).join('\n\n');
}

// ---------- virtual devices ----------
export { listAvds };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Boots an AVD as a background job (in the Running tab; Stop ends it), on a console port of its own so its serial
 * is known (emulator-5556), and waits up to `wait` ms for Android to finish booting. { job, serial, booted, note }.
 */
export async function startEmulator({ avd, projectId, chatId, cwd, logTo, logRel, term, wait = 150e3, signal }) {
  if (!/^[\w.-]+$/.test(String(avd || ''))) throw new Error('an AVD name looks like Pixel_8_API_35 (android avds lists them)');
  const emu = sdkTool('emulator');
  if (!emu) throw new Error('the Android emulator is not installed (Android Studio → SDK Manager → Android Emulator)');
  const avds = await listAvds();
  if (!avds.includes(avd)) throw new Error(`no AVD ${avd} (this computer has: ${avds.join(', ') || 'none'})`);
  const taken = new Set((await devices().catch(() => [])).map((d) => d.serial));
  let port = 5554;
  while (taken.has(`emulator-${port}`) && port < 5682) port += 2;
  const serial = `emulator-${port}`;
  // -no-snapshot-save: the AVD's saved state stays as it was, so every boot starts from the same place.
  const line = `${/\s/.test(emu) ? `"${emu}"` : emu} -avd ${avd} -port ${port} -no-snapshot-save -no-boot-anim`;
  const job = startBackground({ projectId, chatId, cwd, line, shell: 'direct', label: `emulator ${avd}`, logTo, logRel, term });
  const t0 = Date.now();
  while (Date.now() - t0 < wait && !signal?.aborted) {
    if (getBackground(job.id)?.status !== 'running') {
      const o = await jobOutput(job.id, { max: 1500 }).catch(() => ({ text: '' }));
      return { job: job.id, serial, booted: false, ended: true, note: `the emulator stopped before it booted:\n${o.text.trim() || '(no output)'}` };
    }
    const v = await run(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 5000 }).catch(() => '');
    if (String(v).trim() === '1') {
      await run(['-s', serial, 'shell', 'input', 'keyevent', '82'], { timeout: 5000 }).catch(() => {}); // past the lock screen
      return { job: job.id, serial, booted: true, note: `booted in ${Math.round((Date.now() - t0) / 1000)}s` };
    }
    await sleep(2000);
  }
  return { job: job.id, serial, booted: false, note: `still booting after ${Math.round((Date.now() - t0) / 1000)}s` };
}
