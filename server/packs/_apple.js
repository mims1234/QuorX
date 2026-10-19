// The Apple pack's plain data work, apart from the pack so it is tested on any computer: the simulators' list
// (xcrun simctl list -j), Xcode's and Swift's error lines, crash reports (.ips), and which scheme and platform an
// Xcode project builds. (Files starting with "_" are not packs.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- simulators ----------
/**
 * `xcrun simctl list -j` → { runtimes: [{ id, name, version, platform, available }], devices: [{ udid, name, state,
 * runtime, runtimeName, platform, version, available }] }, newest runtime first.
 */
export function parseSimctl(json) {
  let j; try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return { runtimes: [], devices: [] }; }
  const num = (v) => String(v || '0').split('.').map(Number);
  const newer = (a, b) => { const x = num(a.version), y = num(b.version); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
  const runtimes = (j?.runtimes || []).map((r) => ({ id: r.identifier, name: r.name, version: r.version, platform: r.platform || String(r.name || '').split(' ')[0], available: r.isAvailable !== false }))
    .sort(newer);
  const devices = [];
  for (const [rid, list] of Object.entries(j?.devices || {})) {
    const rt = runtimes.find((r) => r.id === rid) || { name: rid.replace(/^.*SimRuntime\./, '').replace(/-/g, ' ').replace(/ (\d+) (\d+)$/, ' $1.$2'), version: (rid.match(/(\d+)-(\d+)$/) || []).slice(1).join('.'), platform: (rid.match(/SimRuntime\.(\w+)-/) || [])[1] || '' };
    for (const d of list || []) devices.push({ udid: d.udid, name: d.name, state: d.state, runtime: rid, runtimeName: rt.name, platform: rt.platform, version: rt.version, available: d.isAvailable !== false });
  }
  devices.sort((a, b) => newer(a, b));
  return { runtimes, devices };
}

/** The simulator to use: a booted one, else the newest available iPhone (or `kind`: 'iPad', 'Apple Watch' …). */
export function pickSimulator(list, { kind = 'iPhone', platform = 'iOS' } = {}) {
  const ok = (list.devices || []).filter((d) => d.available && (!platform || d.platform === platform));
  return ok.find((d) => d.state === 'Booted') || ok.find((d) => d.name.startsWith(kind)) || ok[0] || null;
}

// ---------- build errors ----------
// clang, swiftc, ld and xcodebuild: "/Users/me/App/ContentView.swift:12:5: error: cannot find 'x' in scope".
const DIAG = /^((?:\/|[A-Za-z]:[\/])?[^:\n]+?\.[A-Za-z0-9]+):(\d+):(?:(\d+):)?\s*(error|warning|fatal error):\s*(.+)$/;
/** One diagnostic line → { file, line, col, severity, msg }, or null. */
export function parseDiag(l) {
  const m = DIAG.exec(String(l).trim());
  return m ? { file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : null, severity: m[4] === 'warning' ? 'warning' : 'error', msg: m[5].trim() } : null;
}
/** Every error in a build's output, once each (xcodebuild repeats them), plus xcodebuild's own (`xcodebuild: error: …`). */
export function buildErrors(out) {
  const seen = new Set(), list = [];
  for (const raw of String(out || '').split(/\r?\n/)) {
    const d = parseDiag(raw);
    const own = /^xcodebuild: error: (.+)/.exec(raw.trim());
    const e = d ? (d.severity === 'error' ? d : null) : own ? { file: null, line: null, col: null, severity: 'error', msg: own[1].trim() } : null;
    if (!e) continue;
    const key = `${e.file}:${e.line}:${e.col}:${e.msg}`;
    if (!seen.has(key)) { seen.add(key); list.push(e); }
  }
  return list;
}
/** An error line as the agent should read it: its path relative to the project folder. */
export function tidyDiag(line, dir) {
  const d = parseDiag(line);
  if (!d) return String(line).trim();
  const rel = path.isAbsolute(d.file) || d.file.startsWith('/') ? path.posix.relative(String(dir).replaceAll('\\', '/'), d.file) : d.file;
  return `${rel.startsWith('..') ? d.file : rel}:${d.line}${d.col ? `:${d.col}` : ''}: ${d.severity}: ${d.msg}`;
}

// ---------- which scheme, which platform ----------
/** The Xcode workspace or project in a folder (a workspace wins: CocoaPods puts the pods there). */
export function xcodeContainer(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const ws = names.find((n) => n.endsWith('.xcworkspace')), proj = names.find((n) => n.endsWith('.xcodeproj'));
  return ws ? { kind: 'workspace', name: ws, project: proj || null } : proj ? { kind: 'project', name: proj, project: proj } : null;
}
/** The schemes a project shares, then the user's own: ['MyApp', 'MyAppTests']. */
export function listSchemes(dir, container = xcodeContainer(dir)) {
  if (!container) return [];
  const found = [];
  const look = (d) => { try { for (const f of fs.readdirSync(d)) if (f.endsWith('.xcscheme')) found.push(f.replace(/\.xcscheme$/, '')); } catch { /* none */ } };
  for (const c of [container.name, container.project].filter(Boolean)) {
    look(path.join(dir, c, 'xcshareddata', 'xcschemes'));
    try { for (const u of fs.readdirSync(path.join(dir, c, 'xcuserdata'))) look(path.join(dir, c, 'xcuserdata', u, 'xcschemes')); } catch { /* none */ }
  }
  return [...new Set(found)];
}
/** The scheme to build: the one named like the project, else the first that isn't only tests. */
export function pickScheme(schemes, container) {
  const base = container ? container.name.replace(/\.(xcworkspace|xcodeproj)$/, '') : '';
  return schemes.find((s) => s === base) || schemes.find((s) => !/tests?$/i.test(s)) || schemes[0] || null;
}
/** What a project builds for, from its project.pbxproj: 'ios', 'macos', 'visionos', 'tvos', 'watchos' or 'multi'. */
export function projectPlatform(pbxproj) {
  const t = String(pbxproj || '');
  const sdks = new Set([...t.matchAll(/SDKROOT = "?([a-z]+)"?;/g)].map((m) => m[1]));
  const supported = [...t.matchAll(/SUPPORTED_PLATFORMS = "([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  const of = (s) => ({ iphoneos: 'ios', macosx: 'macos', xros: 'visionos', appletvos: 'tvos', watchos: 'watchos' }[s]);
  const set = new Set([...sdks].map(of).filter(Boolean));
  if (sdks.has('auto') || supported.length) for (const s of supported) if (of(s.replace(/simulator$/, 'os'))) set.add(of(s.replace(/simulator$/, 'os')));
  // A Mac app that only links an iOS framework still says macosx; a test target alone doesn't decide.
  if (set.size > 1) return set.has('ios') && set.has('macos') ? 'multi' : [...set][0];
  return [...set][0] || 'macos';
}
/** The app's bundle id from project.pbxproj (not a test target's), or null when it is set some other way. */
export function projectBundleId(pbxproj) {
  const ids = [...String(pbxproj || '').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.$()-]+)"?;/g)].map((m) => m[1]);
  return ids.find((x) => !/tests?$/i.test(x) && !x.includes('$')) || null;
}
/** The destination xcodebuild needs for a platform: generic simulators build without a device or signing. */
export const DESTINATIONS = { ios: 'generic/platform=iOS Simulator', macos: 'platform=macOS', multi: 'platform=macOS', visionos: 'generic/platform=visionOS Simulator',
  tvos: 'generic/platform=tvOS Simulator', watchos: 'generic/platform=watchOS Simulator' };

const q = (s) => (/[^\w@%+=:,./-]/.test(s) ? `'${String(s).replace(/'/g, "'\\''")}'` : s);
/**
 * The compiler check for an Xcode project folder: a quiet build of its scheme for a simulator (or the Mac), with
 * signing off, so no device or certificate is needed. null when the folder has no project.
 */
export function xcodeCheckLine(dir) {
  const c = xcodeContainer(dir);
  if (!c) return null;
  let pbx = '';
  try { if (c.project) pbx = fs.readFileSync(path.join(dir, c.project, 'project.pbxproj'), 'utf8'); } catch { /* unreadable */ }
  const scheme = pickScheme(listSchemes(dir, c), c);
  const where = c.kind === 'workspace' ? `-workspace ${q(c.name)}` : `-project ${q(c.name)}`;
  // A workspace can only be built by scheme; a project without shared schemes builds its first target.
  if (c.kind === 'workspace' && !scheme) return null;
  return `xcodebuild -quiet ${where}${scheme ? ` -scheme ${q(scheme)}` : ''} -destination ${q(DESTINATIONS[projectPlatform(pbx)])} CODE_SIGNING_ALLOWED=NO build`;
}

// ---------- crash reports ----------
/**
 * A crash report (.ips: one line of JSON about the report, then the report as JSON) → { app, bundleId, version, os,
 * time, type, signal, codes, termination, messages, thread, queue, frames: [{ n, image, symbol, file, line, own }],
 * thrown: frames where an Objective-C exception was thrown }, or null when it isn't a crash report.
 */
export function parseIps(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const nl = s.indexOf('\n');
  let head, body;
  try { head = JSON.parse(s.slice(0, nl)); body = JSON.parse(s.slice(nl + 1)); } catch { return null; }
  if (!body || !Array.isArray(body.threads)) return null;
  const images = body.usedImages || [];
  const procPath = body.procPath || '';
  const appRoot = procPath.includes('.app/') ? procPath.slice(0, procPath.indexOf('.app/') + 5) : procPath;
  const imageOf = (i) => { const im = images[i] || {}; const p = im.path || ''; return { name: im.name || path.posix.basename(p) || '?', own: !!p && (p === procPath || (appRoot.endsWith('.app/') && p.startsWith(appRoot))) }; };
  const framesOf = (list) => (list || []).map((f, n) => { const im = imageOf(f.imageIndex); return { n, image: im.name, own: im.own, symbol: f.symbol || `0x${Number(f.imageOffset || 0).toString(16)}`, file: f.sourceFile || null, line: f.sourceLine || null }; });
  const ti = Number.isInteger(body.faultingThread) ? body.faultingThread : body.threads.findIndex((t) => t.triggered);
  const thread = body.threads[ti] || body.threads.find((t) => t.triggered) || body.threads[0];
  const messages = [];
  for (const [lib, lines] of Object.entries(body.asi || {})) for (const l of [].concat(lines)) messages.push({ lib, text: String(l).trim() });
  if (body.crashInfo?.message) messages.push({ lib: '', text: String(body.crashInfo.message) });
  const ex = body.exception || {};
  return {
    app: body.procName || head.app_name || head.name || '?', bundleId: head.bundleID || body.bundleInfo?.CFBundleIdentifier || null,
    version: head.app_version || body.bundleInfo?.CFBundleShortVersionString || null, os: head.os_version || body.osVersion?.train || null,
    time: head.timestamp || body.captureTime || null, type: ex.type || null, signal: ex.signal || null, subtype: ex.subtype || null, codes: ex.codes || null,
    termination: body.termination?.indicator || body.termination?.reasons?.join('; ') || null, messages,
    thread: ti, queue: thread?.queue || thread?.name || null, frames: framesOf(thread?.frames), thrown: framesOf(body.lastExceptionBacktrace),
    simulator: /CoreSimulator|Simulator/.test(String(head.os_version || '')) || /\/CoreSimulator\/Devices\//.test(procPath),
  };
}

/** A crash report in a few lines for the agent: what happened, the message, and where (its own frames marked ▶). */
export function crashText(c, { frames = 12, file = '' } = {}) {
  if (!c) return '';
  const where = (f) => `${f.file ? `${path.posix.basename(f.file)}:${f.line} ` : ''}${f.symbol} (${f.image})`;
  const lines = [`Crash report${file ? ` ${file}` : ''}: ${c.app}${c.version ? ` ${c.version}` : ''}${c.bundleId ? ` (${c.bundleId})` : ''}${c.os ? `, ${c.os}` : ''}${c.time ? `, ${c.time}` : ''}`];
  lines.push(`${[c.type, c.signal && `(${c.signal})`, c.subtype].filter(Boolean).join(' ')}${c.termination ? ` · ${c.termination}` : ''}`);
  for (const m of c.messages.slice(0, 4)) lines.push(`Message${m.lib ? ` from ${m.lib}` : ''}: ${m.text.slice(0, 400)}`);
  const firstOwn = (c.thrown.length ? c.thrown : c.frames).find((f) => f.own);
  if (firstOwn) lines.push(`First frame in the app: ${where(firstOwn)}`);
  if (c.thrown.length) lines.push('Where the exception was thrown:', ...c.thrown.slice(0, frames).map((f) => `  ${f.own ? '▶' : ' '} ${f.n} ${where(f)}`));
  lines.push(`Crashed thread ${c.thread}${c.queue ? ` (${c.queue})` : ''}:`, ...c.frames.slice(0, frames).map((f) => `  ${f.own ? '▶' : ' '} ${f.n} ${where(f)}`));
  if (!firstOwn) lines.push('No frame is in the app itself: the crash happened inside a system library; the message above, or a frame lower down, says why.');
  return lines.join('\n');
}

/** Where crash reports land: the Mac's own (simulator apps' too), and each simulator's CrashReporter folder. */
export function crashDirs(home = os.homedir()) {
  const dirs = [path.join(home, 'Library', 'Logs', 'DiagnosticReports')];
  const devs = path.join(home, 'Library', 'Developer', 'CoreSimulator', 'Devices');
  try { for (const d of fs.readdirSync(devs)) dirs.push(path.join(devs, d, 'data', 'Library', 'Logs', 'CrashReporter')); } catch { /* no simulators */ }
  return dirs;
}
/** The newest .ips crash report written since `since` (ms), optionally for one app (its name starts the file name). */
export function newestCrash({ since = 0, app = '', dirs = crashDirs() } = {}) {
  let best = null;
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => n.endsWith('.ips') && (!app || n.toLowerCase().startsWith(app.toLowerCase()))); } catch { continue; }
    for (const n of names) {
      let st; try { st = fs.statSync(path.join(d, n)); } catch { continue; }
      if (st.mtimeMs >= since && (!best || st.mtimeMs > best.at)) best = { file: path.join(d, n), at: st.mtimeMs };
    }
  }
  return best?.file || null;
}

/** Signs in a program's output that it crashed (the shell's words for the signal, or Swift's own fatal error). */
export const CRASHED = /(Trace\/BPT trap|Illegal instruction|Segmentation fault|Bus error|Abort trap|Killed: 9|Fatal error:|terminating due to uncaught exception|EXC_BAD_ACCESS|EXC_BREAKPOINT|signal SIG[A-Z]+)/;
