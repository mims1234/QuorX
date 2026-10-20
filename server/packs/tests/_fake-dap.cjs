// A stand-in debug adapter that speaks DAP over stdin/stdout like `dart debug_adapter`, for the bridge's self-test on
// computers without Dart: it answers the requests QuorX's debugger sends, "stops" at the first breakpoint it is
// given (with a local `total = 42`), and ends on the next continue. It writes its pid to QX_FAKE_DAP_PID if set.
const fs = require('node:fs');

if (process.env.QX_FAKE_DAP_PID) fs.writeFileSync(process.env.QX_FAKE_DAP_PID, String(process.pid));
let buf = Buffer.alloc(0), seq = 0, bp = null, program = '';
const send = (m) => { const body = JSON.stringify({ seq: ++seq, ...m }); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
const reply = (req, body = {}) => send({ type: 'response', request_seq: req.seq, command: req.command, success: true, body });
const event = (name, body = {}) => send({ type: 'event', event: name, body });
let launchReq = null;

function handle(req) {
  const a = req.arguments || {};
  switch (req.command) {
    case 'initialize': reply(req, { supportsConfigurationDoneRequest: true }); event('initialized'); break;
    case 'launch': launchReq = req; program = a.program; break; // answered after configurationDone, as Dart's adapter does
    case 'setBreakpoints': bp = { path: a.source.path, line: a.breakpoints.at(-1)?.line }; reply(req, { breakpoints: a.breakpoints.map((b) => ({ verified: true, line: b.line })) }); break;
    case 'configurationDone':
      reply(req); if (launchReq) reply(launchReq);
      setTimeout(() => { if (bp) { event('stopped', { reason: 'breakpoint', threadId: 1 }); } else event('terminated'); }, 100);
      break;
    case 'threads': reply(req, { threads: [{ id: 1, name: 'main' }] }); break;
    case 'stackTrace': reply(req, { stackFrames: [{ id: 7, name: 'total', line: bp.line, column: 1, source: { path: bp.path || program } }], totalFrames: 1 }); break;
    case 'scopes': reply(req, { scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }] }); break;
    case 'variables': reply(req, { variables: [{ name: 'total', value: '42', variablesReference: 0 }, { name: 'items', value: 'List (3 items)', variablesReference: 0 }] }); break;
    case 'evaluate': reply(req, { result: a.expression === 'total * 2' ? '84' : `"${a.expression}"`, variablesReference: 0 }); break;
    case 'continue': reply(req, { allThreadsContinued: true }); setTimeout(() => { event('terminated'); }, 50); break;
    case 'disconnect': reply(req); process.exit(0); break;
    default: reply(req);
  }
}
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const head = buf.indexOf('\r\n\r\n');
    if (head < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, head).toString())[1]);
    if (buf.length < head + 4 + len) return;
    const m = JSON.parse(buf.slice(head + 4, head + 4 + len).toString());
    buf = buf.slice(head + 4 + len);
    handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));
