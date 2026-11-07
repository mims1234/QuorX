// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The performance readout: what the page is holding and how hard it is working, to find what makes QuorX slow with
// many chats open. Off by default (⚙ Settings → Appearance → Under the hood); the perf UI test reads the same numbers
// through window.qxPerf.sample() whether the box shows or not.
//
// Counted from the moment this module loads: repeating timers (setInterval) still running, 3D (WebGL) contexts made in
// the app's own page, and long tasks (the page busy for 50 ms or more, felt as a stutter). In the desktop app the
// shell adds every process with its memory, each browser tab, and Chromium's lost-3D-view warnings. Previews in a
// sandboxed frame can't be looked inside, so their 3D views are counted only by the shell's warnings.

const LONG_WINDOW = 60e3; // long tasks are reported over the last minute

const timers = new Set();
const realSet = window.setInterval.bind(window), realClear = window.clearInterval.bind(window);
window.setInterval = (fn, ms, ...a) => { const id = realSet(fn, ms, ...a); timers.add(id); return id; };
window.clearInterval = (id) => { timers.delete(id); return realClear(id); };

let webgl = 0;
const realGet = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function getContext(kind, ...a) {
  const ctx = realGet.call(this, kind, ...a);
  if (ctx && /^(webgl2?|experimental-webgl)$/.test(kind) && !this._qxGl) { this._qxGl = true; webgl++; }
  return ctx;
};

const longTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ at: performance.timeOrigin + e.startTime, ms: e.duration });
    const cut = Date.now() - LONG_WINDOW;
    while (longTasks.length && longTasks[0].at < cut) longTasks.shift();
  }).observe({ type: 'longtask', buffered: true });
} catch { /* not in this browser */ }

let chatStats = () => ({});
/** app.js tells the readout how to count its chats: () => ({ open, busy, visible }). */
export function setChatStats(fn) { chatStats = fn; }

const MB = 1024 * 1024;
/** One reading of everything the readout knows. Async: the desktop shell answers over IPC. */
export async function sample() {
  const cut = Date.now() - LONG_WINDOW, recent = longTasks.filter((t) => t.at >= cut);
  const imgs = [...document.images];
  let decoded = 0;
  for (const i of imgs) if (i.complete && i.naturalWidth) decoded += i.naturalWidth * i.naturalHeight * 4;
  const frames = [...document.querySelectorAll('iframe')];
  const mem = performance.memory;
  const page = {
    heapMb: mem ? Math.round(mem.usedJSHeapSize / MB) : null,
    elements: document.getElementsByTagName('*').length,
    images: imgs.length,
    imagesMb: Math.round(decoded / MB),
    videos: document.querySelectorAll('video').length,
    frames: frames.length,
    framesShown: frames.filter((f) => f.getClientRects().length).length,
    webgl,
    timers: timers.size,
    longTasks: recent.length,
    longestMs: Math.round(Math.max(0, ...recent.map((t) => t.ms))),
  };
  let shell = null;
  try { shell = await window.ohDesktop?.perf?.(); } catch { /* an older shell without perf */ }
  let chats = {};
  try { chats = chatStats() || {}; } catch { /* app not ready */ }
  return { at: Date.now(), page, chats, shell };
}

// ---------- the box in the corner ----------
let box = null, tick = null;
const fmt = (mb) => (mb == null ? '–' : mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);
function draw(s) {
  if (!box) return;
  const p = s.page, sh = s.shell, c = s.chats;
  const yours = sh ? sh.tabs.filter((t) => !t.agent) : [], agents = sh ? sh.tabs.filter((t) => t.agent) : [];
  const rows = [
    sh && ['All of QuorX', fmt(sh.totalMb), sh.totalMb > 2000 ? 'bad' : sh.totalMb > 1000 ? 'warn' : ''],
    sh && ['This window', fmt(sh.appMb)],
    sh && ['Graphics (GPU)', fmt(sh.gpuMb)],
    sh && ['Browser tabs', `${yours.length} yours · ${agents.length} agent · ${fmt(sh.tabsMb)}`, sh.tabs.length > 6 ? 'warn' : ''],
    ['JS memory', fmt(p.heapMb)],
    ['Chats loaded', c.open == null ? '–' : `${c.open} (${c.visible || 0} on screen, ${c.busy || 0} busy)`, c.open > 6 ? 'warn' : ''],
    ['Page parts', p.elements.toLocaleString(), p.elements > 60000 ? 'warn' : ''],
    ['Pictures', `${p.images} · ${fmt(p.imagesMb)} decoded`],
    ['Frames', `${p.frames} (${p.framesShown} on screen)`],
    ['3D views', `${p.webgl} here${sh ? ` · ${sh.webglLost} lost` : ''}`, sh?.webglLost ? 'bad' : ''],
    ['Timers', String(p.timers)],
    ['Stutters (1 min)', p.longTasks ? `${p.longTasks} · longest ${p.longestMs} ms` : 'none', p.longestMs > 200 ? 'bad' : p.longTasks ? 'warn' : ''],
  ].filter(Boolean);
  box.querySelector('.qp-rows').innerHTML = rows.map(([k, v, tone]) => `<div class="qp-row ${tone || ''}"><span>${k}</span><b>${v}</b></div>`).join('');
}
async function refresh() { try { draw(await sample()); } catch { /* next tick */ } }
/** Shows or hides the box; while hidden nothing runs. */
export function showReadout(on) {
  if (!on) { if (tick) realClear(tick); tick = null; box?.remove(); box = null; return; }
  if (box) return;
  box = document.createElement('aside');
  box.className = 'qx-perf';
  box.setAttribute('aria-label', 'Performance readout');
  box.innerHTML = '<div class="qp-head"><span>Performance</span><button type="button" class="qp-copy" title="Copy these numbers">Copy</button></div><div class="qp-rows"></div>';
  box.querySelector('.qp-copy').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(await sample(), null, 2)); } catch { /* no clipboard */ } };
  document.body.appendChild(box);
  refresh();
  tick = realSet(refresh, 2000); // the readout's own timer isn't counted among the app's
}

window.qxPerf = { sample, showReadout };
