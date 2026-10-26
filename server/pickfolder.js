// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// "Browse…" for project folders: opens the computer's own folder dialog (on the machine running the
// harness) and returns the chosen path, or null when cancelled. One dialog at a time.
// On Windows it is the modern Explorer-style picker, owned by a small always-on-top window (with a taskbar
// entry) so it opens in front of the browser instead of hiding behind it. If that can't load, the classic
// folder dialog is used, owned the same way.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$title = 'Choose a project folder for QuorX'
$start = $env:AGENT_PICK_START
$owner = New-Object System.Windows.Forms.Form -Property @{
  Text = $title; TopMost = $true; ShowInTaskbar = $true; FormBorderStyle = 'None'; Opacity = 0
  StartPosition = 'CenterScreen'; Size = New-Object System.Drawing.Size(1, 1)
}
$owner.Show(); $owner.Activate(); $owner.BringToFront()
[System.Windows.Forms.Application]::DoEvents()
$picked = $null
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ModernFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c); void Unadvise(uint c);
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem si); void SetFolder(IShellItem si);
    void GetFolder(out IShellItem si); void GetCurrentSelection(out IShellItem si);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem si);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv); void GetParent(out IShellItem si);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attrs); void Compare(IShellItem si, uint hint, out int order);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
  // Returns the folder, "" when cancelled.
  public static string Pick(IntPtr owner, string title, string start) {
    var d = (IFileDialog)new FileOpenDialog();
    uint o; d.GetOptions(out o); d.SetOptions(o | 0x20 | 0x40 | 0x800); // pick folders, file system only, path must exist
    d.SetTitle(title); d.SetOkButtonLabel("Use this folder");
    if (!string.IsNullOrEmpty(start)) { try { IShellItem f; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out f); d.SetFolder(f); } catch { } }
    int hr = d.Show(owner);
    if (hr != 0) return "";
    IShellItem r; d.GetResult(out r); string p; r.GetDisplayName(0x80058000, out p); return p;
  }
}
'@
  $picked = [ModernFolderPicker]::Pick($owner.Handle, $title, $start)
} catch {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $title
  $d.ShowNewFolderButton = $true
  if ($start -and (Test-Path -LiteralPath $start)) { $d.SelectedPath = $start }
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $d.SelectedPath }
}
$owner.Close(); $owner.Dispose()
if ($picked) { [Console]::Out.Write($picked) }
`;

let busy = false;
export function pickFolder(start) {
  if (busy) return Promise.reject(new Error('a folder dialog is already open on this computer: look for “Choose a project folder” in the taskbar'));
  busy = true;
  const env = { ...process.env, AGENT_PICK_START: start && fs.existsSync(start) ? start : '' };
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')]]
    : process.platform === 'darwin'
      ? ['osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a project folder for QuorX")']]
      : ['zenity', ['--file-selection', '--directory', '--title=Choose a project folder for QuorX']];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: 10 * 60e3, windowsHide: false, encoding: 'utf8' }, (err, out) => {
      busy = false;
      const dir = String(out || '').trim().replace(/[\\/]+$/, '') || null;
      // Cancelling exits non-zero on macOS and Linux; that is not an error.
      if (err && !dir && err.code !== 1 && !/cancel/i.test(String(err.message))) return reject(new Error(`could not open the folder dialog: ${err.message}`));
      resolve(dir && /^[a-z]:$/i.test(dir) ? `${dir}\\` : dir);
    });
  });
}
