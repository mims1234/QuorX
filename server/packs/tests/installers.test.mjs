// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Windows installers pack self-test. WiX's error parser, the extensions a .wxs needs, the check's command and
// finding the SDK tools are tested anywhere. With WiX (v4 or later, its EULA accepted where it asks), the check
// catches an error in a changed .wxs and a good one builds an MSI; with the Windows SDK, an MSIX is packed and signed
// with a test certificate made for the test (it never touches a certificate store).
import { project, tool, skipUnless } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { languageChecks } from '../../langchecks.js';
import { parseWix, wixExtensions, wixCommand, wixNeedsEula, sdkBins, sdkTools } from '../installers.js';

const WXS = (body = '<Component><File Source="app.txt" /></Component>') => `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="QX Pack" Manufacturer="QuorX Test" Version="1.0.0" UpgradeCode="6f7a3b1e-2c4d-4e5f-8a9b-0c1d2e3f4a5b" Scope="perUser">
    <MediaTemplate EmbedCab="yes" />
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="INSTALLFOLDER" Name="QXPack">
        ${body}
      </Directory>
    </StandardDirectory>
  </Package>
</Wix>
`;

test('installers: the WiX parser reads errors with file and line, and puts file-less ones on the changed file', () => {
  const out = [
    'C:\\work\\setup\\Bad.wxs(3) : error WIX0005: The Package element contains an unexpected child element \'Bogus\'.',
    'C:\\work\\setup\\Miss.wxs(6) : error WIX0103: Cannot find the File file \'missing.exe\'. The following paths were checked: missing.exe',
    'C:\\work\\setup\\Vars.wxs(2) : error WIX0150: Undefined preprocessor variable \'$(var.Version)\'.',
    'C:\\work\\setup\\Package.wxs(9): error WIX0005: The Directory element contains an unexpected child element \'X\'. [C:\\work\\setup\\Setup.wixproj]',
    'C:\\work\\setup\\Bad.wxs(3) : error WIX0005: The Package element contains an unexpected child element \'Bogus\'.',
    'C:\\work\\setup\\Bad.wxs(8) : warning WIX1102: something minor',
  ].join('\r\n');
  assert.deepEqual(parseWix(out), [
    "Bad.wxs:3: error WIX0005: The Package element contains an unexpected child element 'Bogus'.",
    "Miss.wxs:6: error WIX0103: Cannot find the File file 'missing.exe'. The following paths were checked: missing.exe",
    "Package.wxs:9: error WIX0005: The Directory element contains an unexpected child element 'X'.",
  ]);
  const eula = 'wix.exe : error WIX7015: You must accept the Open Source Maintenance Fee (OSMF) EULA to use WiX Toolset v7. For instructions, see https://wixtoolset.org/osmf/';
  assert.ok(wixNeedsEula(eula));
  assert.deepEqual(parseWix(eula, { files: ['Product.wxs'] }), ['Product.wxs: error WIX7015: You must accept the Open Source Maintenance Fee (OSMF) EULA to use WiX Toolset v7. For instructions, see https://wixtoolset.org/osmf/']);
});

test('installers: the check builds every .wxs in the folder with the extensions they use', () => {
  assert.deepEqual(wixExtensions(['<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui" xmlns:util="http://wixtoolset.org/schemas/v4/wxs/util">', '<Wix xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">']),
    ['WixToolset.UI.wixext', 'WixToolset.Util.wixext']);
  const dir = project('wix-cmd', { 'Product.wxs': WXS().replace('<Wix ', '<Wix xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui" '), 'Dirs.wxs': '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" />', 'en-us.wxl': '<WixLocalization />' });
  const cmd = wixCommand(dir, 'wix');
  assert.match(cmd, /^wix build Dirs\.wxs Product\.wxs -ext WixToolset\.UI\.wixext -loc en-us\.wxl -o \S+\.msi$/);
  fs.writeFileSync(path.join(dir, 'Setup.wixproj'), '<Project Sdk="WixToolset.Sdk/6.0.2" />');
  assert.match(wixCommand(dir, 'wix'), /^dotnet build Setup\.wixproj /);
  assert.equal(wixCommand(project('wix-none', { 'readme.md': '' }), 'wix'), null);
});

test('installers: the SDK tools are found in the Windows Kits folder or a NuGet package', () => {
  const fake = project('winsdk', {
    'Windows Kits/10/bin/10.0.22621.0/x64/makeappx.exe': '', 'Windows Kits/10/bin/10.0.22621.0/x64/signtool.exe': '',
    'Windows Kits/10/bin/10.0.26100.0/x64/makeappx.exe': '', 'Windows Kits/10/bin/10.0.26100.0/x64/signtool.exe': '',
    'Windows Kits/10/bin/10.0.28000.0/x64/makeappx.exe': '', // no signtool: not a usable folder
    'nuget/microsoft.windows.sdk.buildtools/10.0.28000.2705/bin/10.0.28000.0/x64/makeappx.exe': '',
    'nuget/microsoft.windows.sdk.buildtools/10.0.28000.2705/bin/10.0.28000.0/x64/signtool.exe': '',
  });
  if (process.arch === 'arm64') return; // the fixture is x64
  const bins = sdkBins({ 'ProgramFiles(x86)': fake, NUGET_PACKAGES: path.join(fake, 'nuget') }).map((b) => path.relative(fake, b).split(path.sep).join('/'));
  assert.deepEqual(bins, ['Windows Kits/10/bin/10.0.26100.0/x64', 'Windows Kits/10/bin/10.0.22621.0/x64', 'nuget/microsoft.windows.sdk.buildtools/10.0.28000.2705/bin/10.0.28000.0/x64']);
});

test('installers: QuorX finds WiX and it builds a package here', async (t) => {
  const skip = await skipUnless('wix'); if (skip) return t.skip(skip);
  const w = await tool('wix');
  assert.ok(Number(w.version.split('.')[0]) >= 4, `WiX ${w.version}`);
  if (!w.works) assert.match(w.problem, /EULA|could not build/, 'a reason is given');
});

test('installers: the WiX check catches an error in a changed .wxs, and a good one builds an MSI', async (t) => {
  const skip = await skipUnless('wix', { works: true }); if (skip) return t.skip(skip);
  const dir = project('wix-check', { 'app.txt': 'hello\n', 'Product.wxs': WXS('<Component><File Source="app.txt" /></Component><Bogus />') });
  let r = await languageChecks(dir, ['Product.wxs'], { have: ['wix'] });
  assert.equal(r.ran[0]?.lang, 'wix');
  assert.ok(r.problems.some((p) => /Product\.wxs:\d+: error WIX0005: .*Bogus/.test(p)), `problems: ${r.problems.join(' | ')}`);
  fs.writeFileSync(path.join(dir, 'Product.wxs'), WXS());
  r = await languageChecks(dir, ['Product.wxs'], { have: ['wix'] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ran[0]?.code, 0);
});

// A 1×1 PNG for the package's logos.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap rescap">
  <Identity Name="QuorX.PackTest" Publisher="CN=QuorX Pack Test" Version="1.0.0.0" ProcessorArchitecture="x64" />
  <Properties><DisplayName>QuorX Pack Test</DisplayName><PublisherDisplayName>QuorX Test</PublisherDisplayName><Logo>logo.png</Logo></Properties>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" /></Dependencies>
  <Resources><Resource Language="en-us" /></Resources>
  <Applications><Application Id="App" Executable="app.exe" EntryPoint="Windows.FullTrustApplication">
    <uap:VisualElements DisplayName="QuorX Pack Test" Description="QuorX pack test" BackgroundColor="transparent" Square150x150Logo="logo.png" Square44x44Logo="logo.png" />
  </Application></Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
`;
// A code-signing certificate made in memory and saved as a .pfx: no certificate store is touched.
const PFX_PS = (pfx, subject) => `$ErrorActionPreference='Stop'
$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$req=New-Object System.Security.Cryptography.X509Certificates.CertificateRequest('${subject}',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$oids=New-Object System.Security.Cryptography.OidCollection; [void]$oids.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($oids,$false)))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($false,$false,0,$false)))
$c=$req.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1),[DateTimeOffset]::Now.AddDays(7))
[IO.File]::WriteAllBytes('${pfx}',$c.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,'qx-test'))`;

test('installers: an MSIX is packed with MakeAppx and signed with a test certificate', async (t) => {
  const skip = await skipUnless('winsdk'); if (skip) return t.skip(skip);
  const sdk = sdkTools();
  const dir = project('msix', { 'layout/AppxManifest.xml': MANIFEST });
  fs.writeFileSync(path.join(dir, 'layout', 'logo.png'), PNG);
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), path.join(dir, 'layout', 'app.exe'));
  const msix = path.join(dir, 'out', 'QxPack.msix');
  fs.mkdirSync(path.dirname(msix));
  execFileSync(sdk.makeappx, ['pack', '/d', path.join(dir, 'layout'), '/p', msix, '/o'], { stdio: 'pipe', timeout: 120000 });
  assert.ok(fs.existsSync(msix), 'the package was made');
  const pfx = path.join(dir, 'test.pfx');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PFX_PS(pfx, 'CN=QuorX Pack Test')], { stdio: 'pipe', timeout: 60000 });
  const out = execFileSync(sdk.signtool, ['sign', '/fd', 'SHA256', '/f', pfx, '/p', 'qx-test', msix], { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
  assert.match(out, /Successfully signed/);
  // A certificate whose subject is not the manifest's Publisher is refused.
  const other = path.join(dir, 'other.pfx');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PFX_PS(other, 'CN=Someone Else')], { stdio: 'pipe', timeout: 60000 });
  assert.throws(() => execFileSync(sdk.signtool, ['sign', '/fd', 'SHA256', '/f', other, '/p', 'qx-test', msix], { stdio: 'pipe', timeout: 120000 }));
});
