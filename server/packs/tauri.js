// Tauri: desktop apps with a Rust back end and a web front end, shown in the system's web view (WebView2 on Windows).
// The Rust half is checked by the rust pack (cargo check runs in src-tauri, the nearest Cargo.toml) and the front
// end's TypeScript by the node pack. This pack finds the Tauri CLI and WebView2, and tells the agent how to start the
// app with a DevTools port, so the browser tool can read and click its window (cdp:<port>).
import fs from 'node:fs';
import path from 'node:path';
import { WIN, MAC, run, VS_LINE } from './_lib.js';
import rust from './rust.js';

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };

/** The Tauri CLI's version from `cargo tauri --version` or `tauri --version` ("tauri-cli 2.1.0"), or null. */
export const cliVersion = (out) => (/tauri-cli (\d+\.\d+\.\d+)/i.exec(out || '') || [])[1] || null;

/** The WebView2 runtime's version from `reg query … /v pv`, or null (an uninstalled runtime leaves 0.0.0.0). */
export const webview2Version = (out) => { const v = (/\bpv\s+REG_SZ\s+(\d+\.\d+\.\d+\.\d+)/i.exec(out || '') || [])[1]; return v && v !== '0.0.0.0' ? v : null; };

// WebView2 registers itself under EdgeUpdate: for the whole computer (64- or 32-bit Windows) or for one user.
const WV2 = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
const WV2_KEYS = [`HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WV2}`, `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WV2}`, `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${WV2}`];
async function webview2() {
  for (const k of WV2_KEYS) { const v = webview2Version(await run('reg.exe', ['query', k, '/v', 'pv'])); if (v) return v; }
  return null;
}

/**
 * The Tauri project in `root`: { dir, file, version (1 or 2), cli, devUrl, frontendDist, bin }, or null. Its config sits in
 * src-tauri/ (or, for a Rust-only app, the project folder). `cli` is how this project runs Tauri: its own
 * @tauri-apps/cli through a package.json script ("npm run tauri"), npx, or the cargo subcommand.
 */
export function tauriProject(root) {
  if (!root) return null;
  let dir = null, file = null;
  for (const d of ['src-tauri', '.']) for (const f of ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml']) if (!file && fs.existsSync(path.join(root, d, f))) { dir = d; file = f; }
  if (!file) return null;
  const text = read(path.join(root, dir, file)) || '';
  const conf = file === 'tauri.conf.json' ? json(path.join(root, dir, file)) || {} : {};
  const cargo = read(path.join(root, dir, 'Cargo.toml')) || '';
  const pkg = json(path.join(root, 'package.json')) || {};
  const npmCli = pkg.devDependencies?.['@tauri-apps/cli'] || pkg.dependencies?.['@tauri-apps/cli'] || null;
  // Tauri 2 configs have a top-level identifier and an "app" section; Tauri 1 keeps both under "tauri" and "package".
  let version = conf.identifier || conf.app || /schema\.tauri\.app\/config\/2/.test(text) ? 2 : conf.tauri || conf.package || /"(distDir|devPath)"/.test(text) ? 1 : null;
  version ||= Number((/^tauri\s*=\s*(?:\{[^}\n]*version\s*=\s*)?"[~^=]?(\d)/m.exec(cargo) || [])[1] || (/(\d)\./.exec(npmCli || '') || [])[1]) || null;
  const script = Object.entries(pkg.scripts || {}).find(([, v]) => /^tauri\s*$/.test(String(v)))?.[0];
  const cli = script ? `npm run ${script}` : npmCli || fs.existsSync(path.join(root, 'node_modules', '@tauri-apps', 'cli', 'package.json')) ? 'npx tauri' : 'cargo tauri';
  const b = conf.build || {};
  const bin = (/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(cargo) || [])[1] || null; // the program cargo builds
  return { dir, file, version, cli, devUrl: b.devUrl || b.devPath || null, frontendDist: b.frontendDist || b.distDir || null, bin };
}

/** A DevTools port for this project's window: the same each time for one folder, so two projects rarely collide. */
export const devtoolsPort = (root) => { let h = 0; for (const c of String(root || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 9400 + (h % 100); };

/** The command line that starts the app in dev mode with WebView2's DevTools port open, in the given shell. */
export function devLine(cli, port, shell = 'powershell') {
  const arg = `--remote-debugging-port=${port}`, cmd = `${cli} dev`;
  if (shell === 'cmd') return `set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=${arg}" && ${cmd}`;
  if (shell === 'bash') return `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=${arg} ${cmd}`;
  return `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="${arg}"; ${cmd}`;
}

// Tauri compiles Rust, so it works only where Rust can link (on Windows, the Visual Studio Build Tools with C++).
// The rust pack's build check answers that; it is kept 30 seconds, since both toolchains are probed together.
let linkCheck = null;
async function tauriBuilds() {
  if (!linkCheck || Date.now() - linkCheck.at > 30e3) linkCheck = { at: Date.now(), p: rust.toolchains[0].works() };
  const r = await linkCheck.p;
  return r.ok ? r : { ok: false, why: `${r.why}, so Tauri apps can't be built or run either` };
}

export default {
  id: 'tauri',
  label: 'Tauri',
  summary: 'Desktop apps with a Rust back end and a web front end',
  toolchains: [
    { id: 'tauri', label: 'Tauri CLI', for: 'Tauri desktop apps (Rust and a web front end)', works: tauriBuilds, fixWith: WIN ? 'msvc' : undefined, url: 'https://tauri.app/start/prerequisites/', install: 'cargo install tauri-cli --locked',
      detect: async () => cliVersion(await run('cargo', ['tauri', '--version'])) || cliVersion(await run('tauri', ['--version'])),
      brokenHint: () => (WIN
        ? `Tauri builds with Rust's MSVC toolchain, so it needs the Visual Studio Build Tools with C++ (Rust's GNU toolchain is no way around that for Tauri). Offer: they install them from ⚙ Settings → Setup check, or you run \`${VS_LINE}\` for them (it asks them first, shows Windows' admin prompt and takes 5–15 minutes). Until then even cargo check fails on a Tauri crate (its build script has to be linked), so no Rust check runs; the front end can still be written and checked.`
        : MAC ? 'Offer to run xcode-select --install (the user confirms Apple\'s dialog).'
          : 'Offer to install build-essential and the WebKitGTK development packages (on Debian and Ubuntu: libwebkit2gtk-4.1-dev, libssl-dev, libayatana-appindicator3-dev, librsvg2-dev).') },
    // Windows 11 ships WebView2; older Windows may not have it, and a Tauri window can't open without it.
    ...(WIN ? [{ id: 'webview2', label: 'WebView2 runtime', for: 'Tauri windows on Windows', detect: webview2, winget: 'Microsoft.EdgeWebView2Runtime', url: 'https://developer.microsoft.com/microsoft-edge/webview2/' }] : []),
  ],
  // The config sits in src-tauri/, one folder down, where the marker scan still looks.
  markers: [/^tauri\.conf\.json5?$/, /^Tauri\.toml$/],
  notes: (have, root) => {
    const p = tauriProject(root) || { dir: 'src-tauri', version: 2, cli: 'cargo tauri' };
    const port = devtoolsPort(root), src = p.dir === '.' ? 'the project folder' : `${p.dir}/`;
    return [
      `a Tauri${p.version ? ` ${p.version}` : ''} app: the Rust side is in ${src} (cargo check runs there before your final reply; a Tauri crate's first build compiles a few hundred crates, so run cargo build there once, in the background, before that check), the web front end in the project folder (the node pack checks its TypeScript once typescript is installed). Run its commands from the project folder with ${p.cli}.`,
      WIN
        ? `To run and use it: shell (background: true) with \`${devLine(p.cli, port)}\` (in cmd: \`${devLine(p.cli, port, 'cmd')}\`). The variable opens the window's DevTools port; when job_output shows the app running (the first build takes minutes), browser open cdp:${port} reads the window, and click, type, press and look act on it, with its console errors. If nothing answers: it is still building, a copy of the app is already running (stop it), or tauri.conf.json sets additionalBrowserArgs (put the flag there too). The desktop tool with the job id reaches the same window as a fallback.`
        : `On ${MAC ? 'macOS' : 'Linux'} the window is WebKit, with no DevTools port: the browser tool can open the front end alone at its dev server${p.devUrl ? ` (${p.devUrl})` : ''}, but Tauri's APIs (invoke) don't exist there.`,
      `${p.cli} dev also starts the front end's dev server (beforeDevCommand) and rebuilds when Rust files change; ${p.cli} build builds the front end (beforeBuildCommand) and a release app, with installers in ${p.dir === '.' ? '' : `${p.dir}/`}target/release/bundle/${WIN ? ' (msi/ and nsis/; the first build downloads WiX and NSIS)' : ''}; add --no-bundle for just the program in ${p.dir === '.' ? '' : `${p.dir}/`}target/release/.`,
      `For a panic, add ${WIN ? '$env:RUST_BACKTRACE=1; to the start of the line' : 'RUST_BACKTRACE=1 before the command'}: Rust's println! and panics go to the job's output, the front end's console.log to the window's console (the browser tool after cdp:). Rust breakpoints, when the debug tool lists Rust: build with cargo build in ${src}, then debug start on a .rs file with program ${p.dir === '.' ? '' : `${p.dir}/`}target/debug/${p.bin || '<name>'}${WIN ? '.exe' : ''}${p.devUrl ? ' (with the front end dev server running, since a debug build loads it)' : ''}.`,
      `Common errors: ${WIN ? 'the window never opens or "WebView2 … not found": the WebView2 runtime is missing (winget install Microsoft.EdgeWebView2Runtime, asking first); ' : ''}"linking with \`link.exe\` failed" or a missing cc: Rust has no linker (see the toolchain note); ${p.version === 1
        ? 'Tauri 1 turns APIs on in tauri.conf.json\'s tauri.allowlist, and an API used without it fails in the window\'s console'
        : '"… not allowed" or "Permissions associated with this command" in the console: add the permission (core:default, dialog:allow-open…) to the window\'s file in src-tauri/capabilities/; a plugin also needs its crate, .plugin(tauri_plugin_<name>::init()) and its npm package; "command … not found": add it to tauri::generate_handler![…]; after changing tauri.conf.json or a capability run cargo check in src-tauri, whose build script checks them'}; "Port 1420 is already in use": an earlier dev run is still going (job_stop it). Keep the tauri crate, @tauri-apps/api and @tauri-apps/cli on the same major version (Tauri 2 imports invoke from @tauri-apps/api/core, Tauri 1 from @tauri-apps/api/tauri).`,
      have.has('tauri') || p.cli !== 'cargo tauri' ? '' : `There is no Tauri CLI here: ask before installing it, for this project (npm install -D @tauri-apps/cli@^${p.version || 2}, then npx tauri) or for the whole computer (cargo install tauri-cli --locked, which compiles for several minutes).`,
    ].filter(Boolean).join(' ');
  },
  test: { needs: [] },
};
