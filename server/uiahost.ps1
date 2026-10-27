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
#   zoom    {pids, handle, x, y, w, h}   -> {png}   (part of the window, enlarged)
#   ocr     {pids, handle}               -> {text}  (the words in its picture, "text" @x,y per line: Windows text recognition)
#   mouse   {pids, handle, ref|x,y, kind} -> {did}  (right, middle, double, hover, down, up)
#   drag    {pids, handle, x, y, x2, y2} -> {did}
#   scroll  {pids, handle, ref|x,y, dir, amount} -> {did}
#   hold    {pids, handle, key, ms}      -> {did}
#   win     {pids, handle, what, x, y, w, h} -> {did} (focus, minimize, maximize, restore, move, resize)
#   board   {set, text}                  -> {did} or {text}   (the clipboard)
# Every x,y is window pixels from its top-left corner: the same in its picture, its controls @x,y and click_at.
#   apps    {name}                       -> {apps: [{name, appId}]}   (Start-menu apps whose name matches)
#   appwins {appId, name}                -> {windows: [{handle, pid, appPid, title}]}   (that app's open windows)
#   openapps {}                          -> {names: [..]}   (apps with a window open now: names only, no titles)
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
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
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
  // Every app with a window open now: its Store id (or "") and its program's own name. No window titles.
  public static string OpenApps() {
    StringBuilder sb = new StringBuilder();
    AutomationElementCollection all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
    foreach (AutomationElement w in all) {
      try {
        AutomationElement.AutomationElementInformation c = w.Current;
        if (c.IsOffscreen || string.IsNullOrEmpty(c.Name)) continue;
        int appPid = c.ProcessId; string path = ExeOf(appPid);
        if (path.EndsWith("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) {
          AutomationElement core = w.FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "Windows.UI.Core.CoreWindow"));
          if (core == null) continue;
          appPid = core.Current.ProcessId; path = ExeOf(appPid);
        }
        string own = "";
        if (path.Length > 0) { System.Diagnostics.FileVersionInfo v = System.Diagnostics.FileVersionInfo.GetVersionInfo(path); own = (v.FileDescription ?? "").Trim(); if (own.Length == 0) own = Path.GetFileNameWithoutExtension(path); }
        sb.Append(AumidOf(appPid)).Append('\t').Append(own.Replace('\t', ' ')).Append('\n');
      } catch { }
    }
    return sb.ToString();
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
      // Windows lets only the process that had the last input change the window in front. Holding Alt (our own key
      // event) makes that us; Alt is let go after the switch, so it opens no menu. The QuorX window the user just
      // typed in is in front otherwise, and every click was refused.
      if (i > 0 || fg == IntPtr.Zero || !Ours(fg, pids)) keybd_event(0x12, 0, 0, UIntPtr.Zero);
      SetForegroundWindow(h);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
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

  // Real pixels on every monitor (per-monitor DPI aware), so a window's picture, its controls' @x,y and click_at all
  // count the same pixels from the window's top-left corner, however the display is scaled.
  public static void Dpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  public static string Tree(long handle, int depth, int max) {
    AutomationElement el = AutomationElement.FromHandle(new IntPtr(handle));
    List<AutomationElement> list = new List<AutomationElement>();
    StringBuilder sb = new StringBuilder();
    int lines = 0;
    RECT wr; GetWindowRect(new IntPtr(handle), out wr);
    System.Windows.Rect origin = new System.Windows.Rect(wr.L, wr.T, Math.Max(0, wr.R - wr.L), Math.Max(0, wr.B - wr.T));
    int off = 0, offHidden = 0;
    Visited = 0; Capped = false; Clock = System.Diagnostics.Stopwatch.StartNew();
    Walk(el, 0, 0, depth, max, list, sb, ref lines, origin, ref off, ref offHidden);
    Refs[handle] = list;
    if (offHidden > 0) sb.Append("\u2026 ").Append(offHidden).Append(" more controls are off screen and not listed: scroll to them, then read again\n");
    if (Capped) sb.Append("\u2026 (a very large window: the read stopped after ").Append(Visited).Append(" controls; for the rest, use screenshot, read_text or click_at)\n");
    else if (lines >= max) sb.Append("\u2026 (more controls not shown)\n");
    return sb.ToString();
  }
  // Every control looked at costs a call into the app. Off-screen controls aren't listed, but they were still walked:
  // Discord's whole message history took each read past its 30 s limit after every action. A read stops after
  // VisitMax controls or ReadMs, whichever comes first.
  const int VisitMax = 1500, ReadMs = 5000;
  static int Visited; static bool Capped; static System.Diagnostics.Stopwatch Clock = new System.Diagnostics.Stopwatch();
  // A long list (a Save dialog's folder tree, its file rows) filled the read before the File name box and the Save
  // button: past the first few, controls off screen are only counted, and a run of one kind of control under one
  // parent stops after SameRun with a count.
  const int OffShown = 8, SameRun = 20;

  static string Clip(string s, int n) { if (s == null) return ""; s = s.Replace("\r", " ").Replace("\n", " "); return s.Length > n ? s.Substring(0, n) + "\u2026" : s; }

  static void Walk(AutomationElement e, int indent, int level, int depth, int max, List<AutomationElement> list, StringBuilder sb, ref int lines, System.Windows.Rect origin, ref int off, ref int offHidden) {
    if (lines >= max || level > depth || Capped) return;
    if (++Visited > VisitMax || Clock.ElapsedMilliseconds > ReadMs) { Capped = true; return; }
    AutomationElement.AutomationElementInformation c;
    try { c = e.Current; } catch { return; }
    if (c.IsOffscreen && level > 0 && ++off > OffShown) { offHidden++; return; } // its children are off screen too
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
    Dictionary<string, int> kinds = new Dictionary<string, int>();
    Dictionary<string, int> skipped = new Dictionary<string, int>();
    while (ch != null && lines < max && !Capped) {
      string k = "";
      try { k = ch.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { }
      int n; kinds.TryGetValue(k, out n); kinds[k] = ++n;
      if (n > SameRun && k != "Pane" && k != "Group" && k != "Custom") {
        int s; skipped.TryGetValue(k, out s); skipped[k] = s + 1;
        if (++Visited > VisitMax || Clock.ElapsedMilliseconds > ReadMs) { Capped = true; break; }
      }
      else Walk(ch, show ? indent + 1 : indent, level + 1, depth, max, list, sb, ref lines, origin, ref off, ref offHidden);
      try { ch = walker.GetNextSibling(ch); } catch { break; }
    }
    foreach (KeyValuePair<string, int> s in skipped) { sb.Append(new string(' ', (show ? indent + 1 : indent) * 2)).Append("\u2026 ").Append(s.Value).Append(" more ").Append(s.Key).Append(" (scroll or use find to reach one)\n"); lines++; }
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

  // Typing replaces what the field holds, with the keyboard as a person would (a Save dialog ignored a value set from
  // outside and saved under its old name), then reads the field back. A field the keys can't reach gets its value set.
  public static string Set(long handle, int r, string text, int[] pids) {
    AutomationElement e = Ref(handle, r);
    object p;
    ValuePattern vp = e.TryGetCurrentPattern(ValuePattern.Pattern, out p) ? (ValuePattern)p : null;
    if (vp != null && vp.Current.IsReadOnly) throw new Exception("that field is read-only");
    string was = vp != null ? Read(vp) : null;
    IntPtr h = new IntPtr(handle);
    bool keyed = false;
    try {
      Front(h, pids);
      e.SetFocus();
      if (Ours(GetForegroundWindow(), pids)) {
        // Ctrl+Home, Ctrl+Shift+End selects what the field holds in every kind of text box: the classic one in a Save
        // dialog ignores Ctrl+A (the name went in after the old one: "bat.pngC:\..."), and in a drawing app Ctrl+A
        // selects the whole picture.
        System.Windows.Forms.SendKeys.SendWait("^{HOME}^+{END}" + Escape(text));
        Thread.Sleep(150);
        keyed = true;
      }
    } catch (Exception) { if (vp == null) throw; }
    if (vp == null) {
      if (!keyed) throw new Exception("the window lost the focus before typing, so nothing was typed: try again");
      return "typed into it (the field can't be read back: check it in a screenshot)";
    }
    string now = Read(vp);
    if (now != text) { Busy(Within(delegate () { vp.SetValue(text); }, 3000), ""); Thread.Sleep(100); now = Read(vp); }
    string before = string.IsNullOrEmpty(was) ? "" : " (it held \"" + Clip(was, 120) + "\" before)";
    if (now == text) return (keyed ? "typed it" : "set its text") + before + "; it now holds \"" + Clip(now, 120) + "\"";
    return "typed it" + before + ", but it now holds \"" + Clip(now, 120) + "\", not what you meant: click the field and type again, or use keys";
  }
  static string Read(ValuePattern vp) { try { return vp.Current.Value ?? ""; } catch (Exception) { return ""; } }

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

  // A picture of the window. Some apps (Unity and other GPU-drawn ones, games, video) come back from PrintWindow as one
  // flat colour, black or white: then the window is brought to the front and the screen under it is copied instead.
  // LastVia says which way the last picture was taken.
  public static string LastVia = "";
  static Bitmap Grab(IntPtr h, int[] pids) {
    if (IsIconic(h)) ShowWindow(h, 9);
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, ht = r.B - r.T;
    if (w <= 0 || ht <= 0 || IsIconic(h)) throw new Exception("the window is minimised or has no size");
    Bitmap bmp = new Bitmap(w, ht);
    using (Graphics g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
    LastVia = "window";
    if (!Flat(bmp)) return bmp;
    try { Front(h, pids); }
    catch { LastVia = "window, one flat colour: Windows kept another window in front, so the screen under it couldn't be copied (ask the user to click the app once)"; return bmp; }
    Thread.Sleep(250); // the app draws again once it is in front
    GetWindowRect(h, out r);
    using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.L, r.T, 0, 0, new Size(w, ht));
    LastVia = Flat(bmp) ? "screen, still one flat colour: the app may really be blank, or still loading" : "screen (the window's own picture was one flat colour)";
    return bmp;
  }
  // One flat colour below the title bar: every sample within a few levels of the first.
  static bool Flat(Bitmap b) {
    int top = Math.Min(b.Height - 1, 40);
    Color f = b.GetPixel(b.Width / 2, top + (b.Height - top) / 2);
    for (int i = 1; i < 10; i++) for (int j = 1; j < 10; j++) {
      Color c = b.GetPixel(b.Width * i / 10, top + (b.Height - top) * j / 10);
      if (Math.Abs(c.R - f.R) > 6 || Math.Abs(c.G - f.G) > 6 || Math.Abs(c.B - f.B) > 6) return false;
    }
    return true;
  }
  static string Png(Bitmap b) { using (MemoryStream ms = new MemoryStream()) { b.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); } }
  public static string Shot(long handle, int[] pids) { using (Bitmap b = Grab(new IntPtr(handle), pids)) return Png(b); }
  // The window's picture as a file, for Windows' own text recognition (ocr below).
  public static string ShotFile(long handle, int[] pids) {
    string f = Path.Combine(Path.GetTempPath(), "qx-ocr-" + handle + ".png");
    using (Bitmap b = Grab(new IntPtr(handle), pids)) b.Save(f, ImageFormat.Png);
    return f;
  }

  // A part of the window, enlarged (up to 4x, to about 1000 pixels on its long side) to read small text. Its x,y,w,h
  // are window pixels, the same ones click_at takes.
  public static string Zoom(long handle, int x, int y, int w, int h, int[] pids) {
    using (Bitmap full = Grab(new IntPtr(handle), pids)) {
      x = Math.Max(0, Math.Min(x, full.Width - 1)); y = Math.Max(0, Math.Min(y, full.Height - 1));
      w = Math.Max(1, Math.Min(w, full.Width - x)); h = Math.Max(1, Math.Min(h, full.Height - y));
      double k = Math.Max(1.0, Math.Min(4.0, 1000.0 / Math.Max(w, h)));
      using (Bitmap part = new Bitmap((int)(w * k), (int)(h * k))) {
        using (Graphics g = Graphics.FromImage(part)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g.DrawImage(full, new Rectangle(0, 0, part.Width, part.Height), new Rectangle(x, y, w, h), GraphicsUnit.Pixel); }
        return Png(part);
      }
    }
  }

  // ---- more ways to use a window: each point is a control [ref] or window pixels x,y, checked like a click ----
  static POINT At(IntPtr h, int x, int y, int[] pids) {
    if (IsIconic(h)) ShowWindow(h, 9);
    RECT r; GetWindowRect(h, out r);
    if (x < 0 || y < 0 || x >= r.R - r.L || y >= r.B - r.T) throw new Exception("that point is outside the window");
    Front(h, pids);
    POINT p = new POINT { X = r.L + x, Y = r.T + y };
    Lands(p, pids);
    return p;
  }
  static POINT Target(long handle, int r, int x, int y, int[] pids) {
    IntPtr h = new IntPtr(handle);
    if (r <= 0) return At(h, x, y, pids);
    System.Windows.Rect b = Ref(handle, r).Current.BoundingRectangle;
    if (b.IsEmpty) throw new Exception("that control has no place on screen");
    Front(h, pids);
    POINT p = new POINT { X = (int)(b.Left + b.Width / 2), Y = (int)(b.Top + b.Height / 2) };
    Lands(p, pids);
    return p;
  }
  static void Btn(uint down, uint up, int times) { for (int i = 0; i < times; i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(20); mouse_event(up, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(60); } }

  // The press and release flags of a mouse button: left, right or middle (3D views turn with the right or middle one).
  static uint[] Button(string b) {
    if (b == "right") return new uint[] { 0x8, 0x10 };
    if (b == "middle") return new uint[] { 0x20, 0x40 };
    if (string.IsNullOrEmpty(b) || b == "left") return new uint[] { 0x2, 0x4 };
    throw new Exception("button is left, right or middle");
  }

  // kind: right, middle, double, hover, down, up (down and up with button).
  public static string Mouse(long handle, int r, int x, int y, string kind, string button, int[] pids) {
    POINT p = Target(handle, r, x, y, pids);
    SetCursorPos(p.X, p.Y); Thread.Sleep(30);
    uint[] f = Button(button);
    string name = string.IsNullOrEmpty(button) ? "left" : button;
    switch (kind) {
      case "right": Btn(0x8, 0x10, 1); return "right-clicked";
      case "middle": Btn(0x20, 0x40, 1); return "middle-clicked";
      case "double": Btn(0x2, 0x4, 2); return "double-clicked";
      case "hover": Thread.Sleep(500); return "the pointer rests there";
      case "down": mouse_event(f[0], 0, 0, 0, UIntPtr.Zero); return "pressed the " + name + " button (send mouse_up with the same button to let go)";
      case "up": mouse_event(f[1], 0, 0, 0, UIntPtr.Zero); return "let go of the " + name + " button";
    }
    throw new Exception("unknown mouse action " + kind);
  }

  public static string Drag(long handle, int x, int y, int x2, int y2, string button, int[] pids) {
    uint[] f = Button(button);
    int steps = f[0] == 0x2 ? 12 : 24; // a 3D view turns with the movement it sees, so a slower path turns it smoothly
    IntPtr h = new IntPtr(handle);
    POINT a = At(h, x, y, pids);
    RECT r; GetWindowRect(h, out r);
    if (x2 < 0 || y2 < 0 || x2 >= r.R - r.L || y2 >= r.B - r.T) throw new Exception("the end point is outside the window");
    POINT b = new POINT { X = r.L + x2, Y = r.T + y2 };
    Lands(b, pids);
    SetCursorPos(a.X, a.Y); Thread.Sleep(40);
    mouse_event(f[0], 0, 0, 0, UIntPtr.Zero); Thread.Sleep(80);
    for (int i = 1; i <= steps; i++) { SetCursorPos(a.X + (b.X - a.X) * i / steps, a.Y + (b.Y - a.Y) * i / steps); Thread.Sleep(20); }
    Thread.Sleep(80); mouse_event(f[1], 0, 0, 0, UIntPtr.Zero);
    return (f[0] == 0x2 ? "dragged" : (f[0] == 0x8 ? "right-dragged" : "middle-dragged")) + " from " + x + "," + y + " to " + x2 + "," + y2;
  }

  // A control that can scroll itself is scrolled by its own means; otherwise the mouse wheel turns over the point (or
  // the window's middle).
  public static string Scroll(long handle, int r, int x, int y, string dir, int amount, int[] pids) {
    amount = Math.Max(1, Math.Min(20, amount));
    bool horiz = dir == "left" || dir == "right", back = dir == "up" || dir == "left";
    if (r > 0) {
      object p;
      AutomationElement e = Ref(handle, r);
      if (e.TryGetCurrentPattern(ScrollPattern.Pattern, out p)) {
        ScrollPattern sp = (ScrollPattern)p;
        if (horiz ? sp.Current.HorizontallyScrollable : sp.Current.VerticallyScrollable) {
          ScrollAmount step = back ? ScrollAmount.SmallDecrement : ScrollAmount.SmallIncrement;
          for (int i = 0; i < amount; i++) { if (horiz) sp.ScrollHorizontal(step); else sp.ScrollVertical(step); }
          return "scrolled it " + dir;
        }
      }
    }
    IntPtr h = new IntPtr(handle);
    if (r <= 0 && x < 0) { RECT wr; GetWindowRect(h, out wr); x = (wr.R - wr.L) / 2; y = (wr.B - wr.T) / 2; }
    POINT at = Target(handle, r, x, y, pids);
    SetCursorPos(at.X, at.Y); Thread.Sleep(30);
    int delta = 120 * amount * (back ? 1 : -1);
    if (horiz) delta = -delta;
    mouse_event(horiz ? 0x1000u : 0x0800u, 0, 0, (uint)delta, UIntPtr.Zero);
    return "turned the wheel " + dir + " " + amount + (amount > 1 ? " notches" : " notch");
  }

  static readonly Dictionary<string, byte> Vk = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase) {
    { "shift", 0x10 }, { "ctrl", 0x11 }, { "control", 0x11 }, { "alt", 0x12 }, { "win", 0x5B }, { "space", 0x20 }, { "enter", 0x0D }, { "tab", 0x09 }, { "escape", 0x1B }, { "esc", 0x1B },
    { "left", 0x25 }, { "up", 0x26 }, { "right", 0x27 }, { "down", 0x28 }, { "backspace", 0x08 }, { "delete", 0x2E }, { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 }
  };
  public static string HoldKey(long handle, string key, int ms, int[] pids) {
    byte vk;
    if (!Vk.TryGetValue(key, out vk)) {
      if (key.Length == 1 && char.IsLetterOrDigit(key[0])) vk = (byte)char.ToUpperInvariant(key[0]);
      else if (key.Length >= 2 && (key[0] == 'f' || key[0] == 'F')) { int n; if (!int.TryParse(key.Substring(1), out n) || n < 1 || n > 12) throw new Exception("unknown key " + key); vk = (byte)(0x6F + n); }
      else throw new Exception("unknown key " + key + " (use a letter, a digit, F1-F12, shift, ctrl, alt, space, enter, an arrow\u2026)");
    }
    Front(new IntPtr(handle), pids);
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    Thread.Sleep(Math.Max(50, Math.Min(10000, ms)));
    keybd_event(vk, 0, 2, UIntPtr.Zero);
    return "held " + key + " for " + Math.Max(50, Math.Min(10000, ms)) + " ms";
  }

  // what: focus, minimize, maximize, restore, move {x, y}, resize {w, h}.
  public static string Win(long handle, string what, int x, int y, int w, int ht, int[] pids) {
    IntPtr h = new IntPtr(handle);
    switch (what) {
      case "focus": Front(h, pids); return "brought it to the front";
      case "minimize": ShowWindow(h, 6); return "minimised it";
      case "maximize": ShowWindow(h, 3); return "maximised it";
      case "restore": ShowWindow(h, 9); return "restored it";
      case "move": SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, 0x1 | 0x4); return "moved it to " + x + "," + y;
      case "resize": if (w < 50 || ht < 50) throw new Exception("too small: at least 50 by 50"); SetWindowPos(h, IntPtr.Zero, 0, 0, w, ht, 0x2 | 0x4); return "resized it to " + w + "x" + ht;
    }
    throw new Exception("unknown window action " + what);
  }

  // The clipboard needs a single-threaded apartment thread.
  public static string Board(string text, bool set) {
    string got = null; Exception err = null;
    Thread t = new Thread(delegate () { try { if (set) { if (string.IsNullOrEmpty(text)) System.Windows.Forms.Clipboard.Clear(); else System.Windows.Forms.Clipboard.SetText(text); } else got = System.Windows.Forms.Clipboard.ContainsText() ? System.Windows.Forms.Clipboard.GetText() : ""; } catch (Exception x) { err = x; } });
    t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join(5000);
    if (err != null) throw err;
    return set ? "put the text on the clipboard" : got;
  }

  public static string Close(long handle) {
    AutomationElement e = AutomationElement.FromHandle(new IntPtr(handle));
    object p;
    if (e.TryGetCurrentPattern(WindowPattern.Pattern, out p)) { WindowPattern wp = (WindowPattern)p; return Busy(Within(delegate () { wp.Close(); }, 3000), "closed it"); }
    throw new Exception("that window can't be closed this way");
  }
}
'@
[QxUia]::Dpi()

# Windows' own text recognition (Windows.Media.Ocr), for windows whose controls can't be read (Unity, games, canvas
# apps). Loaded on first use. Lines: "text @x,y" with x,y the middle of the line in window pixels (what click_at takes).
$script:ocr = $null
function Read-WindowText([string]$file) {
  if (-not $script:ocr) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime] | Out-Null
    $script:ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $script:ocr) { throw 'Windows text recognition has no language installed (Settings > Time & language > Language)' }
  }
  $await = { param($op, $type) $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  $f = & $await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file)) ([Windows.Storage.StorageFile])
  $s = & $await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $d = & $await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $b = & $await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $r = & $await ($script:ocr.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])
  } finally { $s.Dispose() }
  $out = foreach ($line in @($r.Lines)) {
    $x0 = 1e9; $y0 = 1e9; $x1 = 0; $y1 = 0
    foreach ($w in @($line.Words)) { $q = $w.BoundingRect; $x0 = [Math]::Min($x0, $q.X); $y0 = [Math]::Min($y0, $q.Y); $x1 = [Math]::Max($x1, $q.X + $q.Width); $y1 = [Math]::Max($y1, $q.Y + $q.Height) }
    '"{0}" @{1},{2}' -f ($line.Text -replace '"', "'"), [int](($x0 + $x1) / 2), [int](($y0 + $y1) / 2)
  }
  ($out -join "`n")
}
# Answers go out as UTF-8. In the console's own code page some characters become control bytes ("•" is 0x07), which
# made the JSON unreadable, and the call waited out its timeout.
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
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
    if ($m.op -notin @('windows', 'apps', 'appwins', 'openapps', 'board')) { [QxUia]::Check([long]$m.handle, $pids) }
    switch ($m.op) {
      'apps' {
        # Start-menu apps by name: exact names first, then names that contain it.
        $q = [string]$m.name; $all = @(Get-StartApps)
        $like = '*' + [System.Management.Automation.WildcardPattern]::Escape($q) + '*'
        $hits = @($all | Where-Object { $_.Name -ieq $q }) + @($all | Where-Object { $_.Name -ine $q -and $_.Name -ilike $like })
        # A program may call itself more than its Start-menu name ("Brave Browser" for Brave): the longest name it starts with.
        if (-not $hits.Count) { $hits = @($all | Where-Object { $q.StartsWith($_.Name + ' ', [StringComparison]::OrdinalIgnoreCase) } | Sort-Object { $_.Name.Length } -Descending) }
        # Spaces, case and a version number don't matter: "VRoid Studio" finds "VRoidStudio 2.3.0".
        if (-not $hits.Count) {
          $norm = { param($t) (($t -replace '[\s._-]*v?\d+(\.\d+)+\s*$', '') -replace '[^A-Za-z0-9]', '').ToLowerInvariant() }
          $k = & $norm $q
          if ($k.Length -ge 3) { $hits = @($all | Where-Object { $n = & $norm $_.Name; $n -eq $k -or $n.StartsWith($k) -or ($k.StartsWith($n) -and $n.Length -ge 4) } | Sort-Object { $_.Name.Length }) }
        }
        $out.apps = @($hits | Select-Object -First 8 | ForEach-Object { @{ name = $_.Name; appId = $_.AppID } })
      }
      'openapps' {
        # Store apps by their Start-menu name; other programs by their own name for themselves.
        $start = @{}; foreach ($a in @(Get-StartApps)) { if (-not $start.ContainsKey($a.AppID)) { $start[$a.AppID] = $a.Name } }
        $names = @(([QxUia]::OpenApps()) -split "`n" | Where-Object { $_ } | ForEach-Object { $p = $_ -split "`t", 2; if ($p[0] -and $start.ContainsKey($p[0])) { $start[$p[0]] } else { $p[1] } } | Where-Object { $_ })
        $out.names = @($names | Sort-Object -Unique)
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
      'shot' { $out.png = [QxUia]::Shot([long]$m.handle, $pids); $out.via = [QxUia]::LastVia }
      'ocr' { $f = [QxUia]::ShotFile([long]$m.handle, $pids); try { $out.text = Read-WindowText $f; $out.via = [QxUia]::LastVia } finally { Remove-Item $f -ErrorAction SilentlyContinue } }
      'zoom' { $out.png = [QxUia]::Zoom([long]$m.handle, [int]$m.x, [int]$m.y, [int]$m.w, [int]$m.h, $pids); $out.via = [QxUia]::LastVia }
      'mouse' { $out.did = [QxUia]::Mouse([long]$m.handle, [int]$m.ref, [int]$m.x, [int]$m.y, [string]$m.kind, [string]$m.button, $pids) }
      'drag' { $out.did = [QxUia]::Drag([long]$m.handle, [int]$m.x, [int]$m.y, [int]$m.x2, [int]$m.y2, [string]$m.button, $pids) }
      'scroll' { $out.did = [QxUia]::Scroll([long]$m.handle, [int]$m.ref, [int]$(if ($null -ne $m.x) { $m.x } else { -1 }), [int]$(if ($null -ne $m.y) { $m.y } else { -1 }), [string]$m.dir, [int]$(if ($m.amount) { $m.amount } else { 3 }), $pids) }
      'hold' { $out.did = [QxUia]::HoldKey([long]$m.handle, [string]$m.key, [int]$(if ($m.ms) { $m.ms } else { 1000 }), $pids) }
      'win' { $out.did = [QxUia]::Win([long]$m.handle, [string]$m.what, [int]$m.x, [int]$m.y, [int]$m.w, [int]$m.h, $pids) }
      'board' { if ($m.set) { $out.did = [QxUia]::Board([string]$m.text, $true) } else { $out.text = [QxUia]::Board($null, $false) } }
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
