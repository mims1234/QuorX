# Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
# While the agent uses the desktop: a glowing QuorX-coloured edge round every screen and a Stop button at the top,
# both left out of screen captures (the agent's pictures never show them) and click-through (the agent's clicks go to
# the app underneath). Only YOUR mouse and keyboard can stop it: a real click on Stop, or Ctrl+Alt+Backspace, seen by
# low-level hooks that tell your input from the input the agent sends.
# Talks JSON lines: {"ready":true} once, then requests {"op":"show","text":…} / {"op":"hide"}; events {"event":"stop","how":…}.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class QxGlow {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref Pt pos, ref Sz size, IntPtr src, ref Pt srcPos, int key, ref Blend blend, int flags);
  // The same call with no picture: only the window's opacity changes (the pulse), nothing is copied.
  [DllImport("user32.dll", EntryPoint = "UpdateLayeredWindow")] static extern bool FadeLayeredWindow(IntPtr h, IntPtr dst, IntPtr pos, IntPtr size, IntPtr src, IntPtr srcPos, int key, ref Blend blend, int flags);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
  [StructLayout(LayoutKind.Sequential)] struct Pt { public int X, Y; public Pt(int x, int y) { X = x; Y = y; } }
  [StructLayout(LayoutKind.Sequential)] struct Sz { public int W, H; public Sz(int w, int h) { W = w; H = h; } }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] struct Blend { public byte Op, Flags, Alpha, Format; }
  [StructLayout(LayoutKind.Sequential)] struct MouseLL { public Pt pt; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KeyLL { public uint vk, scan, flags, time; public IntPtr extra; }
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);

  // A borderless window drawn with per-pixel alpha (UpdateLayeredWindow): never active, never in the taskbar,
  // click-through, and excluded from capture (Windows 10 2004 and later; earlier it is still click-through).
  class Layer : Form {
    public Bitmap Pic; public byte Alpha = 255;
    public Layer(Rectangle r) { FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual; Bounds = r; TopMost = true; }
    protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x8000000 | 0x8; return p; } } // layered, transparent, toolwindow, noactivate, topmost
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); try { SetWindowDisplayAffinity(Handle, 0x11); } catch { } }
    public void Paint2() {
      if (Pic == null || !IsHandleCreated) return;
      IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen), hb = Pic.GetHbitmap(Color.FromArgb(0)), old = SelectObject(mem, hb);
      var size = new Sz(Pic.Width, Pic.Height); var src = new Pt(0, 0); var pos = new Pt(Left, Top);
      var b = new Blend { Op = 0, Flags = 0, Alpha = Alpha, Format = 1 };
      UpdateLayeredWindow(Handle, screen, ref pos, ref size, mem, ref src, 0, ref b, 2);
      SelectObject(mem, old); DeleteObject(hb); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
    }
    public void Fade(byte a) { Alpha = a; if (!IsHandleCreated) return; var b = new Blend { Op = 0, Flags = 0, Alpha = a, Format = 1 }; FadeLayeredWindow(Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref b, 2); }
  }

  static readonly Color Teal = Color.FromArgb(60, 194, 201);
  static List<Layer> edges = new List<Layer>();
  static Layer pill;
  static Form host;
  static System.Windows.Forms.Timer pulse;
  static IntPtr mouseHook = IntPtr.Zero, keyHook = IntPtr.Zero;
  static HookProc mouseFn = MouseHook, keyFn = KeyHook;
  static readonly object outLock = new object();
  static long lastStop;

  static void Say(string json) { lock (outLock) { Console.Out.WriteLine(json); Console.Out.Flush(); } }
  static void Stop(string how) {
    long now = Environment.TickCount;
    if (now - lastStop < 800) return; // one press, one stop
    lastStop = now;
    Say("{\"event\":\"stop\",\"how\":\"" + how + "\"}");
  }

  // The glowing edge of one screen: the colour fades in from each side.
  static Bitmap Edge(int w, int h, int band) {
    var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
    using (var g = Graphics.FromImage(bmp)) {
      g.Clear(Color.Transparent);
      for (int i = 0; i < band; i++) {
        double t = 1.0 - (double)i / band;
        int a = (int)(230 * t * t);
        using (var pen = new Pen(Color.FromArgb(a, Teal), 1)) g.DrawRectangle(pen, i, i, w - 1 - 2 * i, h - 1 - 2 * i);
      }
    }
    return bmp;
  }
  // The Stop button: a dark rounded pill with the QuorX edge, a red square and the words.
  static Bitmap Pill(string text, out int w, out int h) {
    var font = new Font("Segoe UI Semibold", 10f);
    Size ts; using (var probe = new Bitmap(1, 1)) using (var g0 = Graphics.FromImage(probe)) ts = Size.Ceiling(g0.MeasureString(text, font));
    w = ts.Width + 46; h = Math.Max(30, ts.Height + 12);
    var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      g.Clear(Color.Transparent);
      int r = h - 2;
      using (var path = new GraphicsPath()) {
        path.AddArc(1, 1, r, r, 90, 180); path.AddArc(w - r - 2, 1, r, r, 270, 180); path.CloseFigure();
        using (var fill = new SolidBrush(Color.FromArgb(240, 14, 22, 24))) g.FillPath(fill, path);
        using (var pen = new Pen(Color.FromArgb(255, Teal), 1.5f)) g.DrawPath(pen, path);
      }
      using (var red = new SolidBrush(Color.FromArgb(255, 232, 72, 72))) g.FillRectangle(red, 14, h / 2 - 5, 10, 10);
      using (var fg = new SolidBrush(Color.FromArgb(255, 235, 245, 246))) g.DrawString(text, font, fg, 32, (h - ts.Height) / 2f);
    }
    font.Dispose();
    return bmp;
  }

  static void Show(string text) {
    Hide();
    foreach (var s in Screen.AllScreens) {
      var b = s.Bounds; int band = Math.Max(10, Math.Min(b.Width, b.Height) / 70);
      var l = new Layer(b) { Pic = Edge(b.Width, b.Height, band) };
      l.Show(); l.Paint2(); edges.Add(l);
    }
    int w, h; var pic = Pill(text, out w, out h);
    var wa = Screen.PrimaryScreen.WorkingArea;
    pill = new Layer(new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + 6, w, h)) { Pic = pic };
    pill.Show(); pill.Paint2();
    if (mouseHook == IntPtr.Zero) mouseHook = SetWindowsHookEx(14, mouseFn, GetModuleHandle(null), 0);
    if (keyHook == IntPtr.Zero) keyHook = SetWindowsHookEx(13, keyFn, GetModuleHandle(null), 0);
    pulse.Start();
  }
  static void Hide() {
    pulse.Stop();
    foreach (var l in edges) { l.Close(); l.Pic.Dispose(); }
    edges.Clear();
    if (pill != null) { pill.Close(); pill.Pic.Dispose(); pill = null; }
    if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
    if (keyHook != IntPtr.Zero) { UnhookWindowsHookEx(keyHook); keyHook = IntPtr.Zero; }
  }

  // Your left click on Stop (not one the agent sent: those carry LLMHF_INJECTED) stops the agent and goes no further.
  static IntPtr MouseHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && (int)w == 0x201 && pill != null) {
      var m = (MouseLL)Marshal.PtrToStructure(l, typeof(MouseLL));
      if ((m.flags & 1) == 0 && pill.Bounds.Contains(m.pt.X, m.pt.Y)) { Stop("button"); return (IntPtr)1; }
    }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }
  // Ctrl+Alt+Backspace on your keyboard (keys the agent sends carry LLKHF_INJECTED and are ignored).
  static IntPtr KeyHook(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && ((int)w == 0x100 || (int)w == 0x104)) {
      var k = (KeyLL)Marshal.PtrToStructure(l, typeof(KeyLL));
      bool ctrl = (GetAsyncKeyState(0x11) & 0x8000) != 0, alt = (GetAsyncKeyState(0x12) & 0x8000) != 0;
      if ((k.flags & 0x10) == 0 && k.vk == 0x08 && ctrl && alt) { Stop("keys"); return (IntPtr)1; }
    }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    Application.EnableVisualStyles();
    host = new Form { ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None, Size = new Size(1, 1), Opacity = 0, StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000) };
    var made = host.Handle; // a window handle, for BeginInvoke from the reading thread
    pulse = new System.Windows.Forms.Timer { Interval = 60 };
    int tick = 0;
    pulse.Tick += (s, e) => { tick++; byte a = (byte)(150 + 105 * (0.5 + 0.5 * Math.Sin(tick / 9.0))); foreach (var l in edges) l.Fade(a); };
    var reader = new Thread(() => {
      while (true) {
        string line = Console.In.ReadLine();
        if (line == null) { host.BeginInvoke(new Action(() => { Hide(); Application.Exit(); })); return; }
        line = line.Trim(); if (line.Length == 0) continue;
        string op = Field(line, "op"), text = Field(line, "text"), id = Field(line, "id");
        host.BeginInvoke(new Action(() => {
          try { if (op == "show") Show(text.Length > 0 ? text : "QuorX is using your computer"); else if (op == "hide") Hide(); Say("{\"id\":" + id + ",\"ok\":true}"); }
          catch (Exception ex) { Say("{\"id\":" + id + ",\"ok\":false,\"error\":\"" + ex.Message.Replace("\\", "/").Replace("\"", "'") + "\"}"); }
        }));
      }
    });
    reader.IsBackground = true; reader.Start();
    Say("{\"ready\":true}");
    Application.Run();
  }
  // The few fields the requests carry: a number (id) or a string with \" and \\ escapes.
  static string Field(string json, string name) {
    int i = json.IndexOf("\"" + name + "\""); if (i < 0) return "";
    i = json.IndexOf(':', i) + 1; while (i < json.Length && json[i] == ' ') i++;
    if (i >= json.Length) return "";
    if (json[i] != '"') { int j = i; while (j < json.Length && (char.IsDigit(json[j]) || json[j] == '-')) j++; return json.Substring(i, j - i); }
    var sb = new System.Text.StringBuilder();
    for (i++; i < json.Length && json[i] != '"'; i++) {
      if (json[i] == '\\' && i + 1 < json.Length) { i++; char c = json[i]; if (c == 'u' && i + 4 < json.Length) { sb.Append((char)Convert.ToInt32(json.Substring(i + 1, 4), 16)); i += 4; } else sb.Append(c == 'n' ? ' ' : c); }
      else sb.Append(json[i]);
    }
    return sb.ToString();
  }
}
'@
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
[QxGlow]::Run()
