// The safety layer's settings (docs/shell-safety-plan.md). Every value is editable in ⚙ Safety; these are the
// defaults and the limits each one is held to.
export const SAFETY_DEFAULTS = {
  shell: 'powershell',   // the agent's shell: 'powershell' (Windows PowerShell 5.1, parsed exactly) · 'pwsh' · 'cmd' · 'bash' (opt-in)
  timeout: 180,          // seconds a command may run before it is stopped
  memoryMB: 0,           // memory cap for one command and everything it starts (0 = none)
  snapshots: true,       // snapshot the project before each command that can change files, so Undo covers it
  snapshotMaxMB: 1024,   // past this many MB of project files, snapshots pause (the command row says so)
  tripwire: true,        // stop a command that deletes many files outside the project
  tripwireFiles: 25,     //   … this many files
  tripwireSeconds: 3,    //   … within this many seconds
  // What YOLO's deciders may approve on their own (unticked = it asks you, even in YOLO).
  yoloExternal: false,   // pushes, publishes, deploys
  yoloOpaque: false,     // commands that can't be checked (python -c, cmd /c, iex …)
  yoloOutside: false,    // deletes and moves outside the project (never the blocked places)
  androidPhones: false,  // the android tool may use a physical phone (unticked: emulators only)
  // How the deciders vote on an action.
  quorum: 2,             // valid votes needed; fewer and it asks you
  neededMin: 0.7,        // P(the user's messages ask for it) must reach this
  harmMax: 0.2,          // P(it could harm files outside the project, leak data or cost money) must stay under this
  escalateRow: 3,        // this many blocks in a row pauses the reply for you
  escalateTotal: 20,     //   … or this many in one reply
};

const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const SHELLS = ['powershell', 'pwsh', 'cmd', 'bash'];

/** The safety settings for a reply: the page's values over the defaults, each held to its limits. */
export function safetySettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = SAFETY_DEFAULTS;
  const bool = (k) => (typeof r[k] === 'boolean' ? r[k] : d[k]);
  return {
    shell: SHELLS.includes(r.shell) ? r.shell : d.shell,
    timeout: num(r.timeout, d.timeout, 5, 900),
    memoryMB: num(r.memoryMB, d.memoryMB, 0, 1e6),
    snapshots: bool('snapshots'),
    snapshotMaxMB: num(r.snapshotMaxMB, d.snapshotMaxMB, 1, 1e6),
    tripwire: bool('tripwire'),
    tripwireFiles: num(r.tripwireFiles, d.tripwireFiles, 2, 1e5),
    tripwireSeconds: num(r.tripwireSeconds, d.tripwireSeconds, 1, 120),
    yoloExternal: bool('yoloExternal'),
    yoloOpaque: bool('yoloOpaque'),
    yoloOutside: bool('yoloOutside'),
    androidPhones: bool('androidPhones'),
    quorum: Math.round(num(r.quorum, d.quorum, 1, 10)),
    neededMin: num(r.neededMin, d.neededMin, 0, 1),
    harmMax: num(r.harmMax, d.harmMax, 0, 1),
    escalateRow: Math.round(num(r.escalateRow, d.escalateRow, 1, 100)),
    escalateTotal: Math.round(num(r.escalateTotal, d.escalateTotal, 1, 1000)),
  };
}
