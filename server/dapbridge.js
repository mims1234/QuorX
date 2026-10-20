// For packs whose debug adapter speaks DAP over stdin/stdout instead of a port: debug.start() returns
// { stdio: true, line: 'dart debug_adapter', … } and the debugger runs that line behind dapbridge.cjs, which listens
// on the session's port. The bridge is the background job itself, so Stop still ends the adapter and the program.
import { fileURLToPath } from 'node:url';

const BRIDGE = fileURLToPath(new URL('./dapbridge.cjs', import.meta.url));
const q = (p) => `"${p}"`;

/** The job's command line: Node (the desktop app's own, as Node) running the bridge on `port` for `adapterLine`. */
export function stdioLine(port, adapterLine) {
  // jobgate.cjs drops ELECTRON_RUN_AS_NODE before it starts a command, so the bridge's Node gets it back here.
  const asNode = process.versions.electron ? (process.platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : 'ELECTRON_RUN_AS_NODE=1 ') : '';
  return `${asNode}${q(process.execPath)} ${q(BRIDGE)} ${port} ${adapterLine}`;
}
