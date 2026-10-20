// Windows installers: MSI packages built with WiX (v4 and later: the `wix` command) and MSIX packages made with
// MakeAppx and signed with SignTool (both in the Windows SDK). The check builds changed .wxs files into a throwaway
// MSI; packaging notes cover the apps QuorX builds (Electron, .NET, Rust) and signing with a test certificate only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WIN, run, hasFile, tempDir, rm } from './_lib.js';

const q = (p) => (/[\s&()]/.test(p) ? `"${p}"` : p);
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const byNum = (a, b) => b.localeCompare(a, undefined, { numeric: true });

// ---------- WiX ----------
let WIX = null; // how to run wix here: 'wix' when it is on PATH, or its full path
async function findWix() {
  const home = os.homedir();
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const msi = (() => { try { return fs.readdirSync(pf).filter((d) => /^WiX Toolset v\d/i.test(d)).sort(byNum).map((d) => path.join(pf, d, 'bin', 'wix.exe')); } catch { return []; } })();
  for (const c of [process.env.QX_WIX, 'wix', path.join(home, '.dotnet', 'tools', WIN ? 'wix.exe' : 'wix'), ...msi].filter(Boolean)) {
    if (c !== 'wix' && !exists(c)) continue;
    const v = /^(\d+\.\d+\.\d+)/m.exec((await run(c, ['--version'], { timeout: 20000 })) || '')?.[1];
    if (v && Number(v.split('.')[0]) >= 4) { WIX = c; return v; }
  }
  WIX = null;
  return null;
}

/** Whether wix says the user still has to accept its EULA (WiX 7 and later stop every build until they do). */
export const wixNeedsEula = (out) => /\bWIX7015\b|accept the Open Source Maintenance Fee/i.test(String(out || ''));

// Found is not enough: a tiny package must build (WiX 7 refuses until its EULA is accepted).
async function wixWorks() {
  const dir = tempDir('wixcheck');
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'QuorX\n');
    fs.writeFileSync(path.join(dir, 'p.wxs'), '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Package Name="QuorX check" Manufacturer="QuorX" Version="1.0.0" UpgradeCode="6f7a3b1e-2c4d-4e5f-8a9b-0c1d2e3f4a5b" Scope="perUser"><MediaTemplate EmbedCab="yes" /><StandardDirectory Id="LocalAppDataFolder"><Directory Id="D" Name="QuorXCheck"><Component><File Source="a.txt" /></Component></Directory></StandardDirectory></Package></Wix>\n');
    const out = await run(WIX, ['build', 'p.wxs', '-o', 'p.msi'], { cwd: dir, timeout: 120000 });
    if (exists(path.join(dir, 'p.msi'))) return { ok: true, why: '' };
    if (wixNeedsEula(out)) return { ok: false, why: 'WiX needs its EULA (the Open Source Maintenance Fee terms) accepted, and only the user can accept it' };
    return { ok: false, why: `wix could not build a test package (${String(out || 'no output').split(/\r?\n/).find((l) => /error/i.test(l)) || 'unknown error'})` };
  } finally { rm(dir); }
}

// WiX extensions a .wxs uses, from its namespaces: each has to be passed to wix build with -ext.
const EXT = { ui: 'WixToolset.UI.wixext', util: 'WixToolset.Util.wixext', netfx: 'WixToolset.Netfx.wixext', firewall: 'WixToolset.Firewall.wixext',
  http: 'WixToolset.Http.wixext', iis: 'WixToolset.Iis.wixext', sql: 'WixToolset.Sql.wixext', dependency: 'WixToolset.Dependency.wixext', complus: 'WixToolset.ComPlus.wixext' };
/** The -ext names a set of .wxs texts needs, from their xmlns:…="http://wixtoolset.org/schemas/v4/wxs/<ext>". */
export const wixExtensions = (texts) => [...new Set(texts.flatMap((t) => [...String(t).matchAll(/xmlns:\w+="http:\/\/wixtoolset\.org\/schemas\/v4\/wxs\/(\w+)"/g)].map((m) => EXT[m[1]]).filter(Boolean)))];

/**
 * The command that checks a folder's installer: `dotnet build` for a .wixproj (it brings its own WiX and defines
 * its variables), otherwise wix build of every .wxs there (one package can span several) into a throwaway MSI.
 */
export function wixCommand(dir, wix = WIX || 'wix') {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const proj = names.find((f) => /\.wixproj$/i.test(f));
  if (proj) return `dotnet build ${q(proj)} -nologo -v q -clp:NoSummary`;
  const wxs = names.filter((f) => /\.wxs$/i.test(f)).sort();
  if (!wxs.length) return null;
  const exts = wixExtensions(wxs.map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } }));
  const loc = names.filter((f) => /\.wxl$/i.test(f)).sort();
  const out = path.join(os.tmpdir(), 'qx-wixcheck', `${path.basename(dir).replace(/[^\w.-]/g, '_')}-${process.pid}.msi`);
  return [q(wix), 'build', ...wxs.map(q), ...exts.flatMap((e) => ['-ext', e]), ...loc.flatMap((l) => ['-loc', q(l)]), '-o', q(out)].join(' ');
}

/**
 * WiX's errors as 'Product.wxs:12: error WIX0005: …', each once. Errors with no place in a file (a missing extension,
 * the EULA) are put on the changed files, so they still reach the agent. Undefined $(var.X) is left out: those values
 * usually come from the build that calls wix (a .wixproj or -d), not from the .wxs.
 */
export function parseWix(out, { files = [] } = {}) {
  const res = new Set();
  for (const raw of String(out || '').split(/\r?\n/)) {
    const l = raw.replace(/\s+\[[^\]]+\.wixproj\]\s*$/i, '').trim();
    const m = /^(.+?\.(?:wxs|wxi|wxl))\((\d+)\)\s*:\s*error (WIX\d+):\s*(.+)$/i.exec(l);
    if (m) { if (m[3] !== 'WIX0150') res.add(`${path.basename(m[1])}:${m[2]}: error ${m[3]}: ${m[4]}`); continue; }
    const g = /^(?:wix(?:\.exe)?|.*?\.wixproj)\s*:\s*error (WIX\d+):\s*(.+)$/i.exec(l);
    if (g) for (const f of files.length ? files : ['wix']) res.add(`${path.basename(f)}: error ${g[1]}: ${g[2]}`);
  }
  return [...res];
}

// ---------- MSIX: MakeAppx and SignTool from the Windows SDK ----------
let SDK = null; // { bin, makeappx, signtool }
/**
 * The newest Windows SDK tools folder with makeappx.exe and signtool.exe: QX_WINSDK_BIN, the installed SDK
 * (Windows Kits\10\bin\<version>\x64), or the Microsoft.Windows.SDK.BuildTools NuGet package many projects restore.
 */
export function sdkBins(env = process.env) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const out = env.QX_WINSDK_BIN ? [env.QX_WINSDK_BIN] : [];
  const kits = path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  try { out.push(...fs.readdirSync(kits).filter((v) => /^10\.\d/.test(v)).sort(byNum).map((v) => path.join(kits, v, arch))); } catch { /* no SDK */ }
  const nuget = path.join(env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages'), 'microsoft.windows.sdk.buildtools');
  try {
    for (const pv of fs.readdirSync(nuget).sort(byNum)) { try { out.push(...fs.readdirSync(path.join(nuget, pv, 'bin')).filter((v) => /^10\./.test(v)).sort(byNum).map((v) => path.join(nuget, pv, 'bin', v, arch))); } catch { /* other layout */ } }
  } catch { /* no NuGet copy */ }
  return out.filter((d) => exists(path.join(d, 'makeappx.exe')) && exists(path.join(d, 'signtool.exe')));
}
async function findSdk() {
  const bin = WIN ? sdkBins()[0] : null;
  SDK = bin ? { bin, makeappx: path.join(bin, 'makeappx.exe'), signtool: path.join(bin, 'signtool.exe') } : null;
  return bin ? /(10\.\d+\.\d+\.\d+)/.exec(bin)?.[1] || 'found' : null;
}
/** The SDK tools QuorX found (after detection): { bin, makeappx, signtool } or null. */
export const sdkTools = () => SDK;

const wixDir = (d) => hasFile(d, /\.(wxs|wixproj)$/i);

export default {
  id: 'installers',
  label: 'Windows installers',
  summary: 'MSI packages with WiX and MSIX packages with MakeAppx and SignTool',
  hosts: ['win32'],
  toolchains: [
    { id: 'wix', label: 'WiX Toolset (v4 or later)', for: 'MSI installers from .wxs files', detect: findWix, works: wixWorks, winget: 'WiXToolset.WiXCLI', url: 'https://wixtoolset.org/docs/intro/',
      brokenHint: 'If it is the EULA: WiX 7 and later ask each user to accept its Open Source Maintenance Fee EULA (see https://wixtoolset.org/osmf/). Explain that to the user; if they agree, they run wix eula accept wix7 themselves, or tell you in this chat to run it. Never pass --acceptEula or accept it for them.' },
    { id: 'winsdk', label: 'Windows SDK (MakeAppx, SignTool)', for: 'MSIX packages and signing', detect: findSdk, winget: 'Microsoft.WindowsSDK.10.0.26100', url: 'https://developer.microsoft.com/windows/downloads/windows-sdk/' },
  ],
  markers: [/\.wxs$/i, /\.wixproj$/i, /^Package\.appxmanifest$/i, /^AppxManifest\.xml$/i],
  checks: [{ id: 'wix', tool: 'wix', ext: /\.(wxs|wxi|wxl)$/i, marker: wixDir, cmd: (dir) => wixCommand(dir), parse: parseWix }],
  notes: () => {
    const w = WIX ? q(WIX) : 'wix';
    const sdk = SDK ? `MakeAppx and SignTool are in ${q(SDK.bin)}` : 'the Windows SDK (MakeAppx, SignTool) is not installed';
    return `MSI: ${w} build Product.wxs -o out\\App.msi (WiX v4+ schema, xmlns="http://wixtoolset.org/schemas/v4/wxs"; extensions need -ext, e.g. -ext WixToolset.UI.wixext after wix extension add -g WixToolset.UI.wixext). Before the final reply QuorX builds changed .wxs files into a throwaway MSI. `
      + `MSIX: ${sdk}. Put the app and an AppxManifest.xml in a layout folder, then makeappx pack /d layout /p out\\App.msix /o, then signtool sign /fd SHA256 /f test.pfx /p <password> out\\App.msix; the manifest's Publisher must equal the certificate's subject exactly. `
      + 'Packaging what you built: Electron with electron-builder (--win nsis, msi or appx) or Electron Forge\'s makers; .NET with dotnet publish -c Release -r win-x64 --self-contained, then the publish folder goes in the .wxs (<Files Include="publish\\**" /> in recent WiX) or the MSIX layout; Rust with cargo build --release, then the .exe into the .wxs or layout (Tauri\'s cargo tauri build makes its own MSI). '
      + 'Signing: only ever with a test certificate you make for this (New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=<Publisher>" -CertStoreLocation Cert:\\CurrentUser\\My, then Export-PfxCertificate; it adds a certificate to the user\'s store, so say so). Never sign with a real certificate (one already in their store, a .pfx of theirs, a token or a cloud signing service) unless the user tells you to, for that build. '
      + 'Installing changes the whole computer: ask first. An MSIX signed with a test certificate installs only once that certificate is trusted (Cert:\\LocalMachine\\TrustedPeople, an admin change the user approves). For a failed MSI install, run msiexec /i out\\App.msi /l*v install.log and read the lines before "Return value 3"; for MSIX, Get-AppPackageLog -ActivityID <id from the error>. Uninstall what you installed to test.';
  },
  test: { needs: [] }, // the parsers are tested anywhere; building needs WiX or the Windows SDK
};
