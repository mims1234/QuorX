// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Device sizes for the Browser tab's 📱 menu: a few common screens, a size of your own, and turning it sideways.
// A tab with a size lays its page out at exactly that size and shows it whole, scaled down when the pane is smaller.
// The desktop app does it in the real tab; elsewhere the headless browser's picture (or the frame) is sized the same.

export const DEVICES = [
  { id: 'phone', icon: '📱', name: 'Phone', w: 390, h: 844, mobile: true },
  { id: 'phone-l', icon: '📱', name: 'Large phone', w: 430, h: 932, mobile: true },
  { id: 'tablet', icon: '▭', name: 'Tablet', w: 820, h: 1180, mobile: true },
  { id: 'laptop', icon: '💻', name: 'Laptop', w: 1366, h: 768, mobile: false },
  { id: 'desktop', icon: '🖥', name: 'Desktop', w: 1920, h: 1080, mobile: false },
];
export const MIN_SIDE = 200, MAX_SIDE = 3840;

/** A preset by id, as the size a tab keeps: { id, name, w, h, mobile }. */
export function preset(id) {
  const d = DEVICES.find((x) => x.id === id);
  return d ? { id: d.id, name: d.name, w: d.w, h: d.h, mobile: d.mobile } : null;
}
/** "1024x768", "1024 × 768", "1024,768" → { w, h }, or null. Sizes are kept between MIN_SIDE and MAX_SIDE. */
export function parseSize(text) {
  const m = String(text || '').trim().match(/^(\d{2,5})\s*(?:[x×*,]|by)\s*(\d{2,5})$/i);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE) return null;
  return { w, h };
}
/** A size of your own: a touch screen when it is narrower than a small laptop. */
export function custom(w, h) { return { id: 'custom', name: 'Custom', w, h, mobile: Math.min(w, h) < 900 && w < 1024 }; }
/** Turned sideways (portrait ↔ landscape); the name says which way it is now. */
export function rotate(d) { return d ? { ...d, w: d.h, h: d.w, turned: !d.turned } : d; }
/** How a size fits a box: the scale (never above 1) and the shown width and height. */
export function fitBox(d, box) {
  if (!d || !box?.width || !box?.height) return { scale: 1, width: d?.w || 0, height: d?.h || 0 };
  const scale = Math.min(1, box.width / d.w, box.height / d.h);
  return { scale, width: Math.round(d.w * scale), height: Math.round(d.h * scale) };
}
/** The button's words: "Fit", or "Phone 390×844" (and the scale when it is shown smaller). */
export function deviceLabel(d, scale = 1) {
  if (!d) return 'Fit';
  return `${d.id === 'custom' ? '' : `${d.name} `}${d.w}×${d.h}${scale < 0.995 ? ` · ${Math.round(scale * 100)}%` : ''}`;
}
/** What the desktop app and the headless browser are sent: { width, height, mobile }, or null for the pane's own size. */
export const deviceMetrics = (d) => (d ? { width: d.w, height: d.h, mobile: !!d.mobile } : null);
