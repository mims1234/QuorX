// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Where a pop-out window goes: the box it had (or was asked for), kept on a screen that is still there. A box half off
// every screen (a monitor unplugged since) moves to the screen nearest it, and is never bigger than that screen.
// displays: [{ x, y, width, height }] (work areas). Plain functions, so the tests can run them without Electron.
'use strict';
const DEF = { width: 760, height: 560 };
function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
function fitBox(box, displays, near = null) {
  const ds = (Array.isArray(displays) ? displays : []).filter((d) => d && d.width > 0 && d.height > 0);
  if (!ds.length) return { ...DEF, ...(box || {}) };
  const want = { width: Number(box?.width) || DEF.width, height: Number(box?.height) || DEF.height };
  const has = Number.isFinite(box?.x) && Number.isFinite(box?.y);
  const b = has ? { x: box.x, y: box.y, ...want } : null;
  // The screen it is mostly on, else the one nearest its middle (or near, or the first).
  const mid = (r) => [r.x + r.width / 2, r.y + r.height / 2];
  const pick = b ? (ds.map((d) => [d, overlap(b, d)]).sort((p, q) => q[1] - p[1])[0][1] > 0 ? ds.map((d) => [d, overlap(b, d)]).sort((p, q) => q[1] - p[1])[0][0]
    : ds.map((d) => { const [x, y] = mid(b), [dx, dy] = mid(d); return [d, Math.hypot(x - dx, y - dy)]; }).sort((p, q) => p[1] - q[1])[0][0]) : (near && ds.find((d) => overlap({ ...near, width: 1, height: 1 }, d))) || ds[0];
  const width = Math.min(want.width, pick.width), height = Math.min(want.height, pick.height);
  const x0 = b ? b.x : pick.x + Math.round((pick.width - width) / 2), y0 = b ? b.y : pick.y + Math.round((pick.height - height) / 2);
  return { x: Math.round(Math.min(Math.max(x0, pick.x), pick.x + pick.width - width)), y: Math.round(Math.min(Math.max(y0, pick.y), pick.y + pick.height - height)), width: Math.round(width), height: Math.round(height) };
}
module.exports = { fitBox };
