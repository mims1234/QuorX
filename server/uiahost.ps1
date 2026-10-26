# Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
# QuorX desktop helper: reads and drives the windows of programs the agent started, through Windows UI Automation
# (the structure screen readers use), with a picture of a window as the fallback. Its own process, apart from the job
# host, because an app that opens a modal dialog can block a UI Automation call; every call that acts runs on a
# separate thread with a time limit.
# Every request names the process ids it may touch (QuorX passes the agent job's processes); a window owned by any
# other process is refused, so the user's own windows are never read or clicked.
# JSON lines on stdin/stdout:
#   windows {pids}                       -> {windows: [{handle, pid, title}]}
#   tree    {pids, handle, depth, max}   -> {text}   (interactive controls numbered [n])
#   click   {pids, handle, ref}          -> {did}
#   set     {pids, handle, ref, text}    -> {did}
#   keys    {pids, handle, keys}         -> {did}   (SendKeys syntax: {ENTER}, ^s, %{F4} …)
#   shot    {pids, handle}               -> {png}   (base64)
#   close   {pids, handle}               -> {did}
#   apps    {name}                       -> {apps: [{name, appId}]}   (Start-menu apps whose name matches)
#   appwins {appId, name}                -> {windows: [{handle, pid, appPid, title}]}   (that app's open windows)
# Apps the agent opened by name (desktop open) are reached the same way: QuorX passes their windows' processes.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms, WindowsBase -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Drawing;
using System.Drawing.Imaging;

public static class QxUia {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr p, int flags, StringBuilder s, ref int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr p, ref uint len, StringBuilder s);
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);

  // ---- apps by name (desktop open): which windows belong to a Start-menu app ----
  static string ExeOf(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (p == IntPtr.Zero) return "";
    try { StringBuilder sb = new StringBuilder(1024); int n = sb.Capacity; return QueryFullProcessImageNameW(p, 0, sb, ref n) ? sb.ToString() : ""; } finally { CloseHandle(p); }
  }
  // A Store app's id (Microsoft.WindowsCalculator_8wekyb3d8bbwe!App); "" for a classic program.
  static string AumidOf(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return "";
    try { uint n = 512; StringBuilder sb = new StringBuilder(512); return GetApplicationUserModelId(p, ref n, sb) == 0 ? sb.ToString() : ""; } finally { CloseHandle(p); }
  }
  // A classic program's Start-menu id is often its path under a known folder: {6D809377-…}\Microsoft VS Code\Code.exe.
  static string PathOfAppId(string appId) {
    if (string.IsNullOrEmpty(appId)) return "";
    if (Path.IsPathRooted(appId)) return appId;
    if (appId.Length > 39 && appId[0] == '{' && appId[37] == '}' && appId[38] == '\\') {
      try {
        Guid g = new Guid(appId.Substring(0, 38)); IntPtr s;
        if (SHGetKnownFolderPath(ref g, 0, IntPtr.Zero, out s) == 0) { string b = Marshal.PtrToStringUni(s); Marshal.FreeCoTaskMem(s); return Path.Combine(b, appId.Substring(39)); }
      } catch { }
    }
    return "";
  }
  // A program's own name for itself is the app's name, or starts with it ("Brave Browser" for Brave).
  static bool Named(string own, string name) {
    own = (own ?? "").Trim();
    return name.Length > 0 && (string.Equals(own, name, StringComparison.OrdinalIgnoreCase) || own.StartsWith(name + " ", StringComparison.OrdinalIgnoreCase));
  }
  // The windows of one app: its Store id, its program file, or a program whose own description is the app's name
  // (Code.exe says "Visual Studio Code"). A window's title never decides: a browser tab can be called "Calculator".
  // A Store app's window is drawn by ApplicationFrameHost, with the app's own process in a child window.
  // Lines: handle, the window's process, the app's process, title.
  public static string AppWindows(string appId, string name) {
    string exe = PathOfAppId(appId);
    StringBuilder sb = new StringBuilder();
    AutomationElementCollection all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
    foreach (AutomationElement w in all) {
      try {
        AutomationElement.AutomationElementInformation c = w.Current;
        int appPid = c.ProcessId; string path = ExeOf(appPid);
        if (path.EndsWith("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) {
          AutomationElement core = w.FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "Windows.UI.Core.CoreWindow"));
          if (core == null) continue;
          appPid = core.Current.ProcessId; path = ExeOf(appPid);
        }
        bool hit = false;
        string aumid = AumidOf(appPid);
        if (aumid.Length > 0) hit = string.Equals(aumid, appId, StringComparison.OrdinalIgnoreCase);
        else if (path.Length > 0) {
          if (exe.Length > 0) hit = string.Equals(Path.GetFullPath(exe), path, StringComparison.OrdinalIgnoreCase);
          if (!hit) { System.Diagnostics.FileVersionInfo v = System.Diagnostics.FileVersionInfo.GetVersionInfo(path); hit = Named(v.FileDescription, name) || Named(v.ProductName, name); }
        }
        if (hit) sb.Append(c.NativeWindowHandle).Append('\t').Append(c.ProcessId).Append('\t').Append(appPid).Append('\t').Append((c.Name ?? "").Replace('\t', ' ').Replace('\n', ' ')).Append('\n');
      } catch { }
    }
    return sb.ToString();
  }

  // Whether a window (or the top-level window it sits in) belongs to a process the agent started.
  static bool Ours(IntPtr w, int[] pids) {
    if (w == IntPtr.Zero) return false;
    IntPtr root = GetAncestor(w, 2); // GA_ROOT
    if (root != IntPtr.Zero) w = root;
    uint pid; GetWindowThreadProcessId(w, out pid);
    foreach (int p in pids) if (p == (int)pid) return true;
    return false;
  }

  // Keys and real clicks go to whatever window is in front, and Windows may refuse to bring the agent's window there
  // (it keeps the focus with the window the user last used). So the window is brought forward and checked, and when
  // it isn't in front nothing is sent: typing then would land in the user's own window.
  static void Front(IntPtr h, int[] pids) {
    if (IsIconic(h)) ShowWindow(h, 9);
    for (int i = 0; i < 3; i++) {
      IntPtr fg = GetForegroundWindow();
      uint none, me = GetCurrentThreadId(), fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out none);
      // Joining the input of the window in front lets the focus move away from it.
      bool joined = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
      SetForegroundWindow(h);
      if (joined) AttachThreadInput(me, fgThread, false);
      Thread.Sleep(150 + i * 100);
      if (Ours(GetForegroundWindow(), pids)) return;
    }
    throw new Exception("Windows kept another window in front, so nothing was typed or clicked (it would have landed there): try again, or ask the user to click the app's window once");
  }

  // A real click lands on whatever window is at that point on screen.
  static void Lands(POINT at, int[] pids) {
    if (!Ours(WindowFromPoint(at), pids)) throw new Exception("another window covers that spot, so nothing was clicked (the click would have landed there): close or move it, then try again");
  }

  static readonly Dictionary<long, List<AutomationElement>> Refs = new Dictionary<long, List<AutomationElement>>();
  static readonly HashSet<string> Interactive = new HashSet<string>(new string[] { "Button", "Edit", "CheckBox", "RadioButton", "ComboBox", "ListItem", "MenuItem", "TabItem", "Hyperlink", "TreeItem", "Slider", "Spinner", "SplitButton", "DataItem", "Document" });

  // A window may be used only if a process the agent started owns it.
  public static void Check(long handle, int[] pids) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) throw new Exception("that window is gone: list the windows again");
    uint pid; GetWindowThreadProcessId(h, out pid);
    foreach (int p in pids) if (p == (int)pid) return;
    throw new Exception("that window belongs to a program the agent did not start, so it is off limits");
  }

  public static string Windows(int[] pids) {
    HashSet<int> set = new HashSet<int>(pids);
    StringBuilder sb = new StringBuilder();
    AutomationElementCollection all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
    foreach (AutomationElement w in all) {
      try {
        AutomationElement.AutomationElementInformation c = w.Current;
        if (!set.Contains(c.ProcessId)) continue;
        sb.Append(c.NativeWindowHandle).Append('\t').Append(c.ProcessId).Append('\t').Append((c.Name ?? "").Replace('\t', ' ').Replace('\n', ' ')).Append('\n');
      } catch { }
    }
    return sb.ToString();
  }

  public static string Tree(long handle, int depth, int max) {
    AutomationElement el = AutomationElement.FromHandle(new IntPtr(handle));
    List<AutomationElement> list = new List<AutomationElement>();
    StringBuilder sb = new StringBuilder();
    int lines = 0;
    System.Windows.Rect origin = el.Current.BoundingRectangle;
    Walk(el, 0, 0, depth, max, list, sb, ref lines, origin);
    Refs[handle] = list;
    if (lines >= max) sb.Append("… (more controls not shown)\n");
    return sb.ToString();
  }

  static string Clip(string s, int n) { if (s == null) return ""; s = s.Replace("\r", " ").Replace("\n", " "); return s.Length > n ? s.Substring(0, n) + "…" : s; }

  static void Walk(AutomationElement e, int indent, int level, int depth, int max, List<AutomationElement> list, StringBuilder sb, ref int lines, System.Windows.Rect origin) {
    if (lines >= max || level > depth) return;
    AutomationElement.AutomationElementInformation c;
    try { c = e.Current; } catch { return; }
    string type = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
    string name = Clip(c.Name, 80);
    bool inter = Interactive.Contains(type) && c.IsEnabled;
    string val = null, toggle = null;
    object p;
    try { if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) val = Clip(((ValuePattern)p).Current.Value, 80); } catch { }
    try { if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) toggle = ((TogglePattern)p).Current.ToggleState.ToString(); } catch { }
    bool show = inter || name.Length > 0 || level == 0 || (val != null && val.Length > 0);
    if (show) {
      sb.Append(new string(' ', indent * 2));
      if (inter) { list.Add(e); sb.Append('[').Append(list.Count).Append("] "); }
      sb.Append(type);
      if (name.Length > 0) sb.Append(" \"").Append(name).Append('"');
      if (val != null && val.Length > 0 && val != name) sb.Append(" value=\"").Append(val).Append('"');
      if (toggle != null) sb.Append(toggle == "On" ? " checked" : toggle == "Off" ? " unchecked" : " mixed");
      if (!c.IsEnabled) sb.Append(" (disabled)");
      if (c.IsOffscreen && level > 0) sb.Append(" (off screen)");
      else if (inter && !c.BoundingRectangle.IsEmpty && !origin.IsEmpty) { System.Windows.Rect b = c.BoundingRectangle; sb.Append(" @").Append((int)(b.Left - origin.Left + b.Width / 2)).Append(",").Append((int)(b.Top - origin.Top + b.Height / 2)); }
      sb.Append('\n');
      lines++;
    }
    TreeWalker walker = TreeWalker.ControlViewWalker;
    AutomationElement ch = null;
    try { ch = walker.GetFirstChild(e); } catch { }
    while (ch != null && lines < max) {
      Walk(ch, show ? indent + 1 : indent, level + 1, depth, max, list, sb, ref lines, origin);
      try { ch = walker.GetNextSibling(ch); } catch { break; }
    }
  }

  static AutomationElement Ref(long handle, int r) {
    List<AutomationElement> l;
    if (!Refs.TryGetValue(handle, out l) || r < 1 || r > l.Count) throw new Exception("no control [" + r + "] in this window: read it again (the numbers change when the window changes)");
    return l[r - 1];
  }

  // Runs a UI Automation call on its own thread; an app that opens a modal dialog can block it.
  static bool Within(ThreadStart a, int ms) {
    Exception err = null;
    Thread t = new Thread(delegate () { try { a(); } catch (Exception x) { err = x; } });
    t.IsBackground = true;
    t.Start();
    bool done = t.Join(ms);
    if (err != null) throw err;
    return done;
  }

  static string Busy(bool done, string did) { return done ? did : did + " (the app is still busy: it may have opened a dialog; list the windows)"; }

  public static string Click(long handle, int r, int[] pids) {
    AutomationElement e = Ref(handle, r);
    object p;
    // Tk (Python's tkinter) makes a button's events from the real mouse: Invoke answers "pressed" but the command never
    // runs, and messages posted to the button are ignored. So a Tk button gets a real click, once it is the window there.
    bool tk = false;
    try { tk = AutomationElement.FromHandle(new IntPtr(handle)).Current.ClassName == "TkTopLevel"; } catch { }
    if (!tk) {
      if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { InvokePattern ip = (InvokePattern)p; return Busy(Within(delegate () { ip.Invoke(); }, 3000), "pressed"); }
      if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { TogglePattern tp = (TogglePattern)p; return Busy(Within(delegate () { tp.Toggle(); }, 3000), "toggled"); }
      if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { SelectionItemPattern sp = (SelectionItemPattern)p; return Busy(Within(delegate () { sp.Select(); }, 3000), "selected"); }
      if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
        ExpandCollapsePattern ep = (ExpandCollapsePattern)p;
        return Busy(Within(delegate () { if (ep.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) ep.Expand(); else ep.Collapse(); }, 3000), "expanded or collapsed");
      }
    }
    System.Windows.Rect rect = e.Current.BoundingRectangle;
    if (rect.IsEmpty) throw new Exception("that control has no place on screen to click");
    IntPtr h = new IntPtr(handle);
    Front(h, pids);
    POINT at = new POINT { X = (int)(rect.Left + rect.Width / 2), Y = (int)(rect.Top + rect.Height / 2) };
    if (tk && e.Current.NativeWindowHandle != 0 && WindowFromPoint(at) != new IntPtr(e.Current.NativeWindowHandle)) throw new Exception("another window covers that button, so a click would land there: close or move it, then click again");
    Lands(at, pids);
    if (!tk) { SetCursorPos(at.X, at.Y); mouse_event(0x2, 0, 0, 0, UIntPtr.Zero); mouse_event(0x4, 0, 0, 0, UIntPtr.Zero); }
    else {
      // Each event carries the point, so the user moving the mouse meanwhile can't send the press elsewhere; Tk must
      // see the pointer enter the button before the press counts.
      int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(1, GetSystemMetrics(78) - 1), vh = Math.Max(1, GetSystemMetrics(79) - 1);
      uint ax = (uint)((at.X - vx) * 65535L / vw), ay = (uint)((at.Y - vy) * 65535L / vh);
      const uint ABS = 0x8000 | 0x4000 | 0x1; // absolute, on the whole desktop, with a move
      mouse_event(ABS, ax, ay, 0, UIntPtr.Zero); Thread.Sleep(100);
      mouse_event(ABS | 0x2, ax, ay, 0, UIntPtr.Zero); Thread.Sleep(50);
      mouse_event(ABS | 0x4, ax, ay, 0, UIntPtr.Zero);
    }
    return tk ? "clicked with the mouse" : "clicked with the mouse (it has no button behaviour of its own)";
  }

  // A click at x,y inside the window (as in its picture): for apps whose controls UI Automation can't see.
  public static string ClickAt(long handle, int x, int y, int[] pids) {
    IntPtr h = new IntPtr(handle);
    if (IsIconic(h)) ShowWindow(h, 9);
    RECT r; GetWindowRect(h, out r);
    if (x < 0 || y < 0 || x >= r.R - r.L || y >= r.B - r.T) throw new Exception("that point is outside the window");
    Front(h, pids);
    Lands(new POINT { X = r.L + x, Y = r.T + y }, pids);
    SetCursorPos(r.L + x, r.T + y);
    mouse_event(0x2, 0, 0, 0, UIntPtr.Zero); mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
    return "clicked at " + x + "," + y;
  }

  public static string Set(long handle, int r, string text, int[] pids) {
    AutomationElement e = Ref(handle, r);
    object p;
    if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
      ValuePattern vp = (ValuePattern)p;
      if (vp.Current.IsReadOnly) throw new Exception("that field is read-only");
      return Busy(Within(delegate () { vp.SetValue(text); }, 3000), "set its text");
    }
    IntPtr h = new IntPtr(handle);
    Front(h, pids);
    e.SetFocus();
    if (!Ours(GetForegroundWindow(), pids)) throw new Exception("the window lost the focus before typing, so nothing was typed: try again");
    System.Windows.Forms.SendKeys.SendWait(Escape(text));
    return "typed into it";
  }

  static string Escape(string s) {
    StringBuilder b = new StringBuilder();
    foreach (char ch in s) { if ("+^%~(){}[]".IndexOf(ch) >= 0) b.Append('{').Append(ch).Append('}'); else b.Append(ch); }
    return b.ToString();
  }

  public static string Keys(long handle, string keys, int[] pids) {
    IntPtr h = new IntPtr(handle);
    Front(h, pids);
    System.Windows.Forms.SendKeys.SendWait(keys);
    return "sent the keys";
  }

  public static string Shot(long handle) {
    IntPtr h = new IntPtr(handle);
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, ht = r.B - r.T;
    if (w <= 0 || ht <= 0 || IsIconic(h)) throw new Exception("the window is minimised or has no size");
    using (Bitmap bmp = new Bitmap(w, ht)) {
      using (Graphics g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      using (MemoryStream ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); }
    }
  }

  public static string Close(long handle) {
    AutomationElement e = AutomationElement.FromHandle(new IntPtr(handle));
    object p;
    if (e.TryGetCurrentPattern(WindowPattern.Pattern, out p)) { WindowPattern wp = (WindowPattern)p; return Busy(Within(delegate () { wp.Close(); }, 3000), "closed it"); }
    throw new Exception("that window can't be closed this way");
  }
}
'@
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $m = $line | ConvertFrom-Json
    $id = $m.id
    $out = @{ id = $id; ok = $true }
    $pids = [int[]]@($m.pids | ForEach-Object { [int]$_ })
    if ($m.op -notin @('windows', 'apps', 'appwins')) { [QxUia]::Check([long]$m.handle, $pids) }
    switch ($m.op) {
      'apps' {
        # Start-menu apps by name: exact names first, then names that contain it.
        $q = [string]$m.name; $all = @(Get-StartApps)
        $like = '*' + [System.Management.Automation.WildcardPattern]::Escape($q) + '*'
        $hits = @($all | Where-Object { $_.Name -ieq $q }) + @($all | Where-Object { $_.Name -ine $q -and $_.Name -ilike $like })
        $out.apps = @($hits | Select-Object -First 8 | ForEach-Object { @{ name = $_.Name; appId = $_.AppID } })
      }
      'appwins' {
        $out.windows = @(([QxUia]::AppWindows([string]$m.appId, [string]$m.name)) -split "`n" | Where-Object { $_ } | ForEach-Object { $p = $_ -split "`t", 4; @{ handle = [long]$p[0]; pid = [int]$p[1]; appPid = [int]$p[2]; title = $p[3] } })
      }
      'windows' {
        $out.windows = @(([QxUia]::Windows($pids)) -split "`n" | Where-Object { $_ } | ForEach-Object { $p = $_ -split "`t", 3; @{ handle = [long]$p[0]; pid = [int]$p[1]; title = $p[2] } })
      }
      'tree' { $out.text = [QxUia]::Tree([long]$m.handle, [int]($(if ($m.depth) { $m.depth } else { 25 })), [int]($(if ($m.max) { $m.max } else { 250 }))) }
      'click' { $out.did = [QxUia]::Click([long]$m.handle, [int]$m.ref, $pids) }
      'clickxy' { $out.did = [QxUia]::ClickAt([long]$m.handle, [int]$m.x, [int]$m.y, $pids) }
      'set' { $out.did = [QxUia]::Set([long]$m.handle, [int]$m.ref, [string]$m.text, $pids) }
      'keys' { $out.did = [QxUia]::Keys([long]$m.handle, [string]$m.keys, $pids) }
      'shot' { $out.png = [QxUia]::Shot([long]$m.handle) }
      'close' { $out.did = [QxUia]::Close([long]$m.handle) }
      default { throw "unknown op $($m.op)" }
    }
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    $out = @{ id = $id; ok = $false; error = $msg }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
