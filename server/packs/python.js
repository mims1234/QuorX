// Python: scripts, command-line tools, services and desktop apps (tkinter, PyQt).
// Debugging goes through debugpy, over the Debug Adapter Protocol.
import { WIN } from './_lib.js';

const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);

export default {
  id: 'python',
  label: 'Python',
  summary: 'Scripts, command-line tools, services and desktop apps',
  toolchains: [{ id: 'python', label: 'Python 3', for: 'Python scripts and desktop apps (tkinter, PyQt)', probe: [WIN ? 'py' : 'python3', WIN ? ['-3', '--version'] : ['--version']], re: /Python (3\.\d+\.\d+)/, winget: 'Python.Python.3.12', brew: 'python', apt: 'python3' }],
  markers: [/^pyproject\.toml$/, /^requirements\.txt$/, /^setup\.py$/, /^Pipfile$/],
  debug: {
    exts: ['.py'], tool: 'python', label: 'Python (debugpy)',
    gate: ({ file, args = [], python = WIN ? 'py -3' : 'python3' }) => [python, ...[file, ...args].map(quote)].join(' '),
    // debugpy waits for the debugger before running a line; QuorX attaches over DAP.
    start: ({ file, args = [], port, python = WIN ? 'py -3' : 'python3' }) => ({
      line: `${python} -m debugpy --listen 127.0.0.1:${port} --wait-for-client ${[file, ...args].map(quote).join(' ')}`,
      adapterID: 'python', request: 'attach', args: { justMyCode: true },
      missing: 'debugpy did not open its port (is it installed? pip install debugpy)',
    }),
  },
  notes: () => `run with ${WIN ? 'py -3' : 'python3'} <file>; tests with ${WIN ? 'py -3' : 'python3'} -m pytest when the project uses pytest. A tkinter or PyQt window can be driven with the desktop tool once it runs as a background job. For a crash, read the traceback from the bottom up; the debug tool runs a .py file under debugpy (pip install debugpy) once plain debugging has failed twice.`,
  test: { needs: ['python'] },
};
