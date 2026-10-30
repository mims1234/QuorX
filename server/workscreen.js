// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Computer use works on one screen. With several, it is one that isn't the main screen (the largest of those), so your
// main screen stays yours; with one, that one. The glow and its Stop banner show there (server/glow.js), every app the
// agent acts on is pulled onto it (server/uia.js), and the desktop app shrinks QuorX to a phone-sized window beside it
// that never covers it and never shows in the agent's pictures (desktop/main.js, app.computerUse).
import { listScreens, setWorkArea } from './uia.js';
import { desktopReady, desktopCall } from './desktop.js';

/** The screen computer use works on, from [{ bounds, work, primary }]: a screen other than the main one, the largest. */
export function pickScreen(screens) {
  const list = (screens || []).filter((s) => s?.bounds?.w > 0 && s?.bounds?.h > 0);
  const others = list.filter((s) => !s.primary).sort((a, b) => b.bounds.w * b.bounds.h - a.bounds.w * a.bounds.h);
  return others[0] || list.find((s) => s.primary) || list[0] || null;
}

let working = null;
/** Computer use starts (`chatId` is the chat driving it): picks the screen, makes room on it. → { screen, area } or null. */
export function startWork(chatId) {
  const p = (async () => {
    const s = pickScreen(await listScreens());
    if (!s) return null;
    let area = s.work;
    // The desktop app makes itself compact and says what it leaves free on that screen (all of it when it moved away).
    if (desktopReady()) {
      const r = await desktopCall('app.computerUse', { on: true, work: s.work, chatId: chatId || null }, 8000).catch(() => null);
      if (r?.area?.w > 100 && r.area.h > 100) area = r.area;
    }
    return { screen: s.bounds, area };
  })().catch(() => null);
  working = p;
  setWorkArea(p.then((w) => w?.area || null));
  return p;
}
/** Computer use ended: apps may go anywhere again, and QuorX goes back to how you had it. */
export function endWork() {
  const was = working;
  if (!was) return;
  working = null;
  setWorkArea(null);
  // After a start still under way, so QuorX isn't made compact again once it is back.
  was.finally(() => { if (!working && desktopReady()) desktopCall('app.computerUse', { on: false }, 8000).catch(() => {}); });
}
