// The link to the desktop app (desktop/main.js), when one is running. The app opens an event stream
// here (/api/desktop/link) and answers commands with POST /api/desktop/reply; it also forwards the
// DevTools events of the real tabs it hosts. With the link, the agent's browser tab is a real view in
// the app's pane instead of a hidden headless one. Without it, nothing changes.
// Only this computer may link (loopback), and only the app that linked may reply (its token).
const link = { res: null, token: null, seq: 0, pending: new Map(), listeners: new Map() };

export const desktopReady = () => !!link.res && !link.res.writableEnded;

export function openLink(req, res, token) {
  if (!/^[\w-]{16,80}$/.test(String(token))) { res.writeHead(400); return res.end('bad token'); }
  if (link.res && !link.res.writableEnded) link.res.end(); // a new app replaces the old one
  for (const p of link.pending.values()) p.reject(new Error('the desktop app reconnected'));
  link.pending.clear();
  Object.assign(link, { res, token: String(token) });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': linked\n\n');
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  res.on('close', () => {
    clearInterval(ping);
    if (link.res !== res) return;
    link.res = null;
    for (const p of link.pending.values()) p.reject(new Error('the desktop app went away'));
    link.pending.clear();
  });
}

/** A reply to a command, or DevTools events from one of the app's tabs. */
export function linkReply(body) {
  if (!link.token || body.token !== link.token) return false;
  if (body.events) for (const e of body.events) for (const fn of link.listeners.get(e.tab) || []) { try { fn(e.method, e.params); } catch { /* listener's problem */ } }
  if (body.id != null) {
    const p = link.pending.get(body.id);
    if (p) { link.pending.delete(body.id); body.error ? p.reject(new Error(body.error)) : p.resolve(body.result); }
  }
  return true;
}

/** Sends a command to the app and waits for its answer. */
export function desktopCall(cmd, args = {}, ms = 30000) {
  if (!desktopReady()) return Promise.reject(new Error('no desktop app linked'));
  const id = ++link.seq;
  return new Promise((resolve, reject) => {
    link.pending.set(id, { resolve, reject });
    link.res.write(`data: ${JSON.stringify({ id, cmd, args })}\n\n`);
    setTimeout(() => { if (link.pending.has(id)) { link.pending.delete(id); reject(new Error(`${cmd} timed out in the desktop app`)); } }, ms);
  });
}
export function onTabEvents(tab, fn) {
  if (!link.listeners.has(tab)) link.listeners.set(tab, new Set());
  link.listeners.get(tab).add(fn);
  return () => { link.listeners.get(tab)?.delete(fn); if (!link.listeners.get(tab)?.size) link.listeners.delete(tab); };
}
