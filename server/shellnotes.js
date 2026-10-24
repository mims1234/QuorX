// What works in the agent's shell, so it writes commands for the shell it really has instead of guessing and retrying.
// The user picks the shell in ⚙ Settings → Approvals & safety (server/safety.js): on Windows 'powershell' (5.1, the
// default), 'pwsh' (7), 'cmd' or 'bash' (Git Bash); elsewhere 'bash' or 'zsh'. 'direct' is one program with its
// arguments, no shell at all (the old run_command).

const UNIX_IN_PS = 'no Unix tools: head/tail → Select-Object -First/-Last, grep → Select-String, cat → Get-Content, ls -la → Get-ChildItem -Force, rm -rf → Remove-Item -Recurse -Force, touch → New-Item, which → Get-Command, wc -l → Measure-Object -Line, export X=1 → $env:X = "1"';
const INLINE = 'Inline code (node -e, python -c) breaks on this shell\'s quoting: write it to a file with write_file and run the file (node fix.mjs, python fix.py)';

/** One paragraph for the system prompt: the shell's name and what to write for it. */
export function shellNote(shell) {
  if (shell === 'powershell') return `Shell: commands run in Windows PowerShell 5.1. It has no && or || (chain with ; or cmd1; if ($?) { cmd2 }), no ternary ?: and no ??, and ${UNIX_IN_PS}. curl and wget are names for Invoke-WebRequest there: call curl.exe for real curl. ${INLINE}.`;
  if (shell === 'pwsh') return `Shell: commands run in PowerShell 7 (pwsh): && and || work, and so do ?: and ??, but there are ${UNIX_IN_PS}. ${INLINE}.`;
  if (shell === 'cmd') return `Shell: commands run in cmd.exe: && and || work; no Unix tools (type for cat, findstr for grep, dir for ls, del /s /q and rmdir /s /q to delete, set X=1 for export). ${INLINE}.`;
  if (shell === 'bash' && process.platform === 'win32') return 'Shell: commands run in bash (Git Bash on Windows): Unix tools and && work, Windows paths are written /c/Users/… and some Windows programs need their .exe name. PowerShell cmdlets (Get-ChildItem…) are not available.';
  if (shell === 'bash' || shell === 'zsh') return `Shell: commands run in ${shell}: Unix tools, &&, || and pipes work.`;
  return '';
}

/** A one-line hint when a command failed because of the shell (a Unix tool in PowerShell, && in 5.1, quoting), else ''. */
export function shellHint(shell, out, line = '') {
  const o = String(out || '').slice(-6000), l = String(line || '');
  const ps = shell === 'powershell' || shell === 'pwsh';
  if (shell === 'powershell' && /The token '(&&|\|\|)' is not a valid statement separator/i.test(o)) return '[Shell hint: Windows PowerShell 5.1 has no && or ||. Chain with ; or cmd1; if ($?) { cmd2 }.]';
  const tool = /The term '([\w.-]+)' is not recognized as the name of a cmdlet/i.exec(o) || /'([\w.-]+)' is not recognized as an internal or external command/i.exec(o);
  if (tool && /^(head|tail|grep|egrep|sed|awk|touch|which|wc|cat|ls|rm|cp|mv|export|xargs|chmod|ln|find|less|nano|vi|unzip|tar)$/i.test(tool[1])) {
    return `[Shell hint: ${tool[1]} is a Unix tool, and this shell is ${shell === 'cmd' ? 'cmd.exe' : shell === 'pwsh' ? 'PowerShell 7' : 'Windows PowerShell 5.1'}. ${ps ? UNIX_IN_PS.replace(/^no Unix tools: /, 'Use: ') : 'Use the cmd equivalent (type, findstr, dir, del).'}]`;
  }
  // PowerShell either refuses the line (ParserError) or hands the program mangled quotes (node's [eval] SyntaxError).
  if (ps && /(ParserError|Unexpected token|Missing (closing|expression|argument)|The string is missing the terminator|\[eval\]:\d|SyntaxError: |File "<string>", line)/i.test(o) && /\b(node|python3?|py|deno|bun|ruby|perl)\s+-(e|c|p)\b/i.test(l)) {
    return '[Shell hint: PowerShell could not parse the quotes in the inline code. Write the code to a file with write_file and run that file instead of retrying with other quotes.]';
  }
  if ((shell === 'bash' || shell === 'zsh') && /(Get|Set|New|Remove|Select|Invoke)-\w+: command not found/i.test(o)) return `[Shell hint: that is a PowerShell command, and this shell is ${shell}. Use the Unix tool instead.]`;
  return '';
}
