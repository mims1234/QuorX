// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The safety layer's settings (docs/shell-safety-plan.md). Every value is editable in ⚙ Safety; these are the
// defaults and the limits each one is held to.
const WIN = process.platform === 'win32';
export const SAFETY_DEFAULTS = {
  shell: WIN ? 'powershell' : 'bash', // the agent's shell: on Windows 'powershell' (5.1, parsed exactly) · 'pwsh' · 'cmd' · 'bash' (Git Bash, opt-in); elsewhere 'bash' · 'zsh'
  timeout: 180,          // seconds a command may run before it is stopped
  memoryMB: 0,           // memory cap for one command and everything it starts (0 = none)
  snapshots: true,       // snapshot the project before each command that can change files, so Undo covers it
  snapshotMaxMB: 1024,   // past this many MB of project files, snapshots pause (the command row says so)
  tripwire: true,        // stop a command that deletes many files outside the project
  tripwireFiles: 25,     //   … this many files
  tripwireSeconds: 3,    //   … within this many seconds
  // ⚡ YOLO runs these on its own; ticked, it checks that kind with the deciders first (a no still comes to you).
  yoloCheckWeb: false,     // web reads: curl/iwr GET, wrangler whoami, gh pr view, cloud CLI list/describe
  yoloCheckInline: false,  // one-liners QuorX can read: node -e, python -c
  yoloCheckBuild: false,   // builds, tests and project scripts
  yoloCheckInstall: false, // package installs in the project
  yoloCheckUnknown: false, // commands QuorX doesn't know
  yoloCheckReads: false,   // reading files outside the project (never your keys)
  // These pause for you even in YOLO; ticked, the deciders may approve them instead.
  yoloExternal: false,     // pushes, publishes, deploys
  yoloOutside: false,      // writes, deletes and moves outside the project (never the blocked places)
  yoloGlobal: false,       // installs for the whole computer (npm -g, winget, cargo install)
  yoloOpaque: true,        // commands QuorX can't read first (cmd /c, iex, one-liners that start programs)
  androidPhones: false,  // the android tool may use a physical phone (unticked: emulators only)
  // How the deciders vote on an action.
  quorum: 2,             // valid votes needed; fewer and it asks you
  neededMin: 0.7,        // P(the user's messages ask for it) must reach this
  harmMax: 0.2,          // P(it could harm files outside the project, leak data or cost money) must stay under this
  escalateRow: 3,        // this many blocks in a row pauses the reply for you
  escalateTotal: 20,     //   … or this many in one reply
};

const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
// PowerShell's parser runs in the Windows job host, so the PowerShell shells are Windows-only (and cmd is Windows').
// Before per-item settings, YOLO had levels (never released, but settings files may carry one): careful checked
// everything first and let the deciders approve nothing; balanced checked builds, installs and unknown commands.
const LEVEL_CHECKS = { careful: ['Web', 'Inline', 'Build', 'Install', 'Unknown', 'Reads'], balanced: ['Build', 'Install', 'Unknown'] };
const SHELLS = WIN ? ['powershell', 'pwsh', 'cmd', 'bash'] : ['bash', 'zsh'];

/** The safety settings for a reply: the page's values over the defaults, each held to its limits. */
export function safetySettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = SAFETY_DEFAULTS;
  const level = LEVEL_CHECKS[r.yoloLevel] || [];
  const bool = (k) => (typeof r[k] === 'boolean' ? r[k] : level.includes(k.replace(/^yoloCheck/, '')) && k.startsWith('yoloCheck') ? true
    : k === 'yoloOpaque' && r.yoloLevel === 'careful' ? false : d[k]);
  return {
    shell: SHELLS.includes(r.shell) ? r.shell : d.shell,
    timeout: num(r.timeout, d.timeout, 5, 900),
    memoryMB: num(r.memoryMB, d.memoryMB, 0, 1e6),
    snapshots: bool('snapshots'),
    snapshotMaxMB: num(r.snapshotMaxMB, d.snapshotMaxMB, 1, 1e6),
    tripwire: bool('tripwire'),
    tripwireFiles: num(r.tripwireFiles, d.tripwireFiles, 2, 1e5),
    tripwireSeconds: num(r.tripwireSeconds, d.tripwireSeconds, 1, 120),
    ...Object.fromEntries(['yoloCheckWeb', 'yoloCheckInline', 'yoloCheckBuild', 'yoloCheckInstall', 'yoloCheckUnknown', 'yoloCheckReads',
      'yoloExternal', 'yoloOutside', 'yoloGlobal', 'yoloOpaque'].map((k) => [k, bool(k)])),
    androidPhones: bool('androidPhones'),
    quorum: Math.round(num(r.quorum, d.quorum, 1, 10)),
    neededMin: num(r.neededMin, d.neededMin, 0, 1),
    harmMax: num(r.harmMax, d.harmMax, 0, 1),
    escalateRow: Math.round(num(r.escalateRow, d.escalateRow, 1, 100)),
    escalateTotal: Math.round(num(r.escalateTotal, d.escalateTotal, 1, 1000)),
  };
}

/** What the command engine needs to know about YOLO: what it checks first, and what the deciders may approve. */
export const yoloOf = (SF) => ({
  check: { web: SF.yoloCheckWeb, inline: SF.yoloCheckInline, build: SF.yoloCheckBuild, install: SF.yoloCheckInstall, unknown: SF.yoloCheckUnknown, reads: SF.yoloCheckReads },
  external: SF.yoloExternal, outside: SF.yoloOutside, global: SF.yoloGlobal, opaque: SF.yoloOpaque });
