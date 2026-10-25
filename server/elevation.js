// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Commands that need administrator rights. QuorX runs the agent's commands as the user, never elevated, and hidden,
// so an installer that needs admin fails (or would wait on a UAC prompt nobody sees). QuorX never elevates anything:
// it spots the failure and hands the command to the user, to run in a terminal they opened as administrator.

// Windows' ERROR_ELEVATION_REQUIRED: the program asked for admin rights before it started.
const ELEVATION_REQUIRED = 740;
// What programs print when they need admin. Read only from a command that failed.
const SAYS_ADMIN = [
  /requires? elevation/i,
  /run (?:it |this |the \w+ )?as (?:an )?administrator/i,
  /administrator privileges are required/i,
  /requires? (?:administrator|admin) (?:rights|privileges|access)/i,
  /requires administrator/i,
  /must be run (?:as|from) an? (?:administrator|elevated)/i,
  /(?:administrator|elevated) (?:rights|privileges|permissions) (?:are |is )?required/i,
];
// …and what says the opposite ("cannot be run from an administrator context"), which is not this.
const SAYS_NOT_ADMIN = /cannot be run (?:from|as) an? administrator|(?:do not|don't|never) run (?:it |this )?as (?:an )?administrator|not (?:be )?run (?:as|from) an? administrator/i;
// "Access is denied" means too little often to be sure; it counts only for a command that installs something.
const INSTALLS = /\b(?:winget|choco|chocolatey|scoop|msiexec|install|installer|setup|add-appxpackage|add-windowscapability|enable-windowsoptionalfeature|dism)\b|\.msi\b/i;

/** Whether a finished command failed because it needs administrator rights. `out` is its output (the end is enough). */
export function needsAdmin({ line = '', code = null, out = '' } = {}) {
  if (code === ELEVATION_REQUIRED) return true;
  if (code === 0 || code == null) return false;
  const text = String(out || '').slice(-8000);
  if (SAYS_NOT_ADMIN.test(text)) return false;
  if (SAYS_ADMIN.some((re) => re.test(text))) return true;
  return /access is denied/i.test(text) && INSTALLS.test(String(line));
}

/** What the agent is told, and what the user sees: the command, to run in an administrator terminal. */
export const adminForAgent = (line) => `This needs administrator rights, which QuorX doesn't use. Ask the user to run it in a Terminal tab opened as administrator: \`${line}\``;
export const adminForUser = (line) => `This command needs administrator rights, which QuorX doesn't use. Run it yourself in a terminal opened as administrator: \`${line}\``;
