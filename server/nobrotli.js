// Node's Brotli decoder had a remote-code-execution bug (CVE-2026-111497, the Node.js security releases of 21 October
// 2026), and fetch decompresses Brotli by itself. Until QuorX runs on a fixed Node (22.23.4, 24.22.1, 26.12.1 or later;
// the desktop app gets one with the next Electron, see .github/workflows/electron-watch.yml), its own web requests
// never take Brotli: they ask for gzip or deflate only, and an answer that arrives Brotli-encoded anyway is refused
// before its body is read. Imported first by server.js, so every fetch on the server goes through it.
const FIXED = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };

/** Whether this Node version has the Brotli fix: a fixed release line at or past its fix, or a newer line. */
export function brotliFixed(version = process.versions.node) {
  const [maj, min, pat] = String(version).split('.').map(Number);
  if (maj > 26) return true;
  const f = FIXED[maj];
  if (!f) return false;
  return min > f[0] || (min === f[0] && pat >= f[1]);
}

export const brotliGuard = !brotliFixed();

if (brotliGuard && typeof globalThis.fetch === 'function' && !globalThis.fetch.qxNoBrotli) {
  const real = globalThis.fetch;
  const guarded = async (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('accept-encoding', 'gzip, deflate');
    const res = await real(input, { ...init, headers });
    if (/(^|[\s,])br($|[\s,])/i.test(res.headers.get('content-encoding') || '')) {
      try { await res.body?.cancel(); } catch { /* already closed */ }
      let host = ''; try { host = new URL(res.url).host; } catch { /* no url */ }
      throw new Error(`refused a Brotli-compressed answer${host ? ` from ${host}` : ''}: Brotli is off until QuorX runs on a Node with the October 2026 security fix`);
    }
    return res;
  };
  guarded.qxNoBrotli = true;
  globalThis.fetch = guarded;
}
