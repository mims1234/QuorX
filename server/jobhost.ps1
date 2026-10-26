# Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
# QuorX job host: keeps Windows Job Objects for the commands and servers the agent starts, so Stop ends
# every process a command started (even ones whose parent already exited), and so they all end if QuorX dies.
# Talks JSON lines on stdin/stdout:
#   {"id":1,"op":"adopt","job":"j1","pid":1234,"memoryMB":0} -> {"id":1,"ok":true}
#   {"id":2,"op":"count","job":"j1"}                        -> {"id":2,"ok":true,"active":3,"pids":[..]}
#   {"id":2,"op":"count","job":"j1","windows":true}         -> also "windowed":[..] (processes showing a window, and
#                                                              their helpers) and "gui":[..] (programs built to show one)
#   {"id":3,"op":"kill","job":"j1"}                         -> {"id":3,"ok":true}
#   {"id":4,"op":"close","job":"j1"}                        -> {"id":4,"ok":true}
#   {"id":5,"op":"release","job":"j1","keep":[..]}          -> ends the rest, lets the kept ones live on without QuorX
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class QxJob {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PE32 { public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PE32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PE32 e);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr p, int flags, System.Text.StringBuilder s, ref int size);
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct ACCT { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, ref ACCT info, uint len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  public static IntPtr Create(long memoryMB) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    EXT info = new EXT();
    info.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    if (memoryMB > 0) { info.Basic.LimitFlags |= 0x200; info.JobMemoryLimit = new UIntPtr((ulong)memoryMB * 1024UL * 1024UL); }
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    return job;
  }
  public static void Assign(IntPtr job, int pid) {
    IntPtr p = OpenProcess(0x0101, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (p == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try { if (!AssignProcessToJobObject(job, p)) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error()); }
    finally { CloseHandle(p); }
  }
  public static uint Active(IntPtr job) {
    ACCT a = new ACCT();
    if (!QueryInformationJobObject(job, 1, ref a, (uint)Marshal.SizeOf(typeof(ACCT)), IntPtr.Zero)) return 0;
    return a.ActiveProcesses;
  }
  public static long[] Pids(IntPtr job) {
    int n = 256, size = 8 + IntPtr.Size * n;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, 3, buf, (uint)size, IntPtr.Zero)) return new long[0];
      int count = Marshal.ReadInt32(buf, 4);
      long[] r = new long[count];
      for (int i = 0; i < count; i++) r[i] = IntPtr.Size == 8 ? Marshal.ReadInt64(buf, 8 + i * 8) : Marshal.ReadInt32(buf, 8 + i * 4);
      return r;
    } finally { Marshal.FreeHGlobal(buf); }
  }
  public static void Kill(IntPtr job) { TerminateJobObject(job, 1); }
  public static void Close(IntPtr job) { CloseHandle(job); }

  // Programs built to show windows (the PE header's subsystem is "Windows GUI"), as opposed to console tools.
  public static long[] Gui(long[] pids) {
    List<long> r = new List<long>();
    foreach (long pid in pids) {
      IntPtr p = OpenProcess(0x1000, false, (int)pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (p == IntPtr.Zero) continue;
      try {
        System.Text.StringBuilder sb = new System.Text.StringBuilder(1024); int n = sb.Capacity;
        if (!QueryFullProcessImageNameW(p, 0, sb, ref n)) continue;
        using (System.IO.FileStream f = new System.IO.FileStream(sb.ToString(), System.IO.FileMode.Open, System.IO.FileAccess.Read, System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete)) {
          byte[] b = new byte[4]; f.Seek(0x3C, System.IO.SeekOrigin.Begin); f.Read(b, 0, 4);
          int pe = BitConverter.ToInt32(b, 0); byte[] s = new byte[2];
          f.Seek(pe + 0x5C, System.IO.SeekOrigin.Begin); f.Read(s, 0, 2);
          if (BitConverter.ToUInt16(s, 0) == 2) r.Add(pid);
        }
      } catch { } finally { CloseHandle(p); }
    }
    return r.ToArray();
  }

  // Processes among `pids` that show a visible top-level window with a title, and their child processes (an
  // editor's renderer and GPU helpers), which go with it.
  public static long[] Windowed(long[] pids) {
    Dictionary<uint, bool> inJob = new Dictionary<uint, bool>(), owners = new Dictionary<uint, bool>();
    foreach (long p in pids) inJob[(uint)p] = true;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && GetWindowTextLength(h) > 0) { uint pid; GetWindowThreadProcessId(h, out pid); if (inJob.ContainsKey(pid)) owners[pid] = true; }
      return true;
    }, IntPtr.Zero);
    if (owners.Count == 0) return new long[0];
    Dictionary<uint, uint> parent = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
    if (snap != IntPtr.Zero && snap != new IntPtr(-1)) {
      try {
        PE32 e = new PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
        if (Process32FirstW(snap, ref e)) do { parent[e.th32ProcessID] = e.th32ParentProcessID; } while (Process32NextW(snap, ref e));
      } finally { CloseHandle(snap); }
    }
    List<long> keep = new List<long>();
    foreach (uint pid in inJob.Keys) {
      uint cur = pid;
      for (int i = 0; i < 16; i++) {
        if (owners.ContainsKey(cur)) { keep.Add(pid); break; }
        uint up; if (!parent.TryGetValue(cur, out up) || up == cur || !inJob.ContainsKey(up)) break;
        cur = up;
      }
    }
    return keep.ToArray();
  }

  // Ends every process of the job except `keep`, then lets the kept ones go: the job no longer ends them when QuorX
  // closes it (a process can't leave a job, so its limits are lifted instead).
  public static void Release(IntPtr job, long[] keep) {
    Dictionary<long, bool> k = new Dictionary<long, bool>();
    foreach (long p in keep) k[p] = true;
    foreach (long pid in Pids(job)) {
      if (k.ContainsKey(pid)) continue;
      IntPtr p = OpenProcess(0x0001, false, (int)pid);
      if (p != IntPtr.Zero) { TerminateProcess(p, 1); CloseHandle(p); }
    }
    EXT info = new EXT();
    SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)));
    CloseHandle(job);
  }
}
'@
$jobs = @{}
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break } # QuorX went away: closing our handles ends every job (KILL_ON_JOB_CLOSE)
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $m = $line | ConvertFrom-Json
    $id = $m.id
    $out = @{ id = $id; ok = $true }
    switch ($m.op) {
      'adopt' {
        if (-not $jobs.ContainsKey($m.job)) { $jobs[$m.job] = [QxJob]::Create([long]$m.memoryMB) }
        [QxJob]::Assign($jobs[$m.job], [int]$m.pid)
      }
      'count' {
        if ($jobs.ContainsKey($m.job)) {
          $out.active = [QxJob]::Active($jobs[$m.job])
          $out.pids = @([QxJob]::Pids($jobs[$m.job]))
          $out.names = @($out.pids | ForEach-Object { try { (Get-Process -Id $_ -ErrorAction Stop).ProcessName + '.exe' } catch { "pid $_" } })
          if ($m.windows -and $out.pids.Count) { $out.windowed = @([QxJob]::Windowed([long[]]$out.pids)); $out.gui = @([QxJob]::Gui([long[]]$out.pids)) }
        } else { $out.active = 0; $out.pids = @(); $out.names = @() }
      }
      'parse' {
        # Splits a PowerShell command line with PowerShell's own parser, for the rule engine (cmdpolicy.js).
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput([string]$m.line, [ref]$tokens, [ref]$errs)
        $out.errors = @($errs | ForEach-Object { $_.Message })
        $cmds = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
        # Functions the line defines itself: calling one runs only its own body (whose commands are listed too), so it
        # is not the alias or program of the same name (a function called Cat is not Get-Content).
        $fns = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name.ToLowerInvariant() })
        $out.commands = @(foreach ($c in $cmds) {
          $els = $c.CommandElements
          $first = $els[0]
          $nameStatic = $first -is [System.Management.Automation.Language.StringConstantExpressionAst]
          $name = if ($nameStatic) { $first.Value } else { $first.Extent.Text }
          $resolved = $name
          $isFunction = $nameStatic -and ($fns -contains $name.ToLowerInvariant())
          if ($nameStatic -and -not $isFunction) { $al = Get-Alias -Name $name -ErrorAction SilentlyContinue; if ($al) { $resolved = $al.Definition } }
          $argsOut = @(for ($i = 1; $i -lt $els.Count; $i++) {
            $e = $els[$i]
            if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
              $a = @{ t = 'param'; text = '-' + $e.ParameterName; static = $true }
              if ($e.Argument) { $a.value = $e.Argument.Extent.Text; $a.static = $e.Argument -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $e.Argument -is [System.Management.Automation.Language.ConstantExpressionAst] }
              $a
            } elseif ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
              @{ t = 'arg'; text = $e.Value; static = $true }
            } elseif ($e -is [System.Management.Automation.Language.ConstantExpressionAst]) {
              @{ t = 'arg'; text = [string]$e.Value; static = $true }
            } else {
              @{ t = 'arg'; text = $e.Extent.Text; static = $false; kind = $e.GetType().Name }
            }
          })
          @{
            name = $name; resolved = $resolved; nameStatic = $nameStatic; isFunction = [bool]$isFunction; invocation = [string]$c.InvocationOperator
            args = $argsOut; text = $c.Extent.Text
            redirects = @($c.Redirections | Where-Object { $_ -is [System.Management.Automation.Language.FileRedirectionAst] } | ForEach-Object { $_.Location.Extent.Text })
          }
        })
        # .NET calls ([IO.File]::Delete(...), $x.Kill()) and script blocks built from text can't be checked.
        $out.members = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object { $_.Extent.Text })
      }
      'kill' { if ($jobs.ContainsKey($m.job)) { [QxJob]::Kill($jobs[$m.job]) } }
      'release' { if ($jobs.ContainsKey($m.job)) { [QxJob]::Release($jobs[$m.job], [long[]]@($m.keep)); $jobs.Remove($m.job) } }
      'close' { if ($jobs.ContainsKey($m.job)) { [QxJob]::Close($jobs[$m.job]); $jobs.Remove($m.job) } }
      default { throw "unknown op $($m.op)" }
    }
  } catch {
    $out = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
