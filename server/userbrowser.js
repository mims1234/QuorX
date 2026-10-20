// The pane's Browser tab: pages run in tabs of the harness's headless browser and the pane shows their
// live picture; clicks, scrolling and typing are passed through. Your tabs are one session each. The
// agent's own tab is shared as "agent-<chat>": watch-only while its reply runs, yours to use after,
// and closed when idle like the rest.
import { openTab } from './browser.js';
import { desktopCall } from './desktop.js';

const sessions = new Map(); // sid → { tab, at, w, h, agent?, locked? }
const IDLE = 10 * 60e3;
setInterval(() => { for (const [sid, s] of sessions) if (Date.now() - s.at > IDLE) { s.tab.close(); sessions.delete(sid); } }, 60e3).unref();

const clampSize = (n, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number(n) || d)));
/** The agent's tab for a chat: shown live while its reply works (locked), kept for you afterwards. */
export function adoptAgentTab(chatId, tab) {
  const sid = `agent-${chatId}`, old = sessions.get(sid);
  // In the desktop app a chat's agent tab keeps one name (agent-<chat>), so a replacement has the same name as the
  // tab it replaces: closing "the old one" by that name would close the new one (and every retry after it).
  if (old && old.tab !== tab && old.tab.id !== tab.id) old.tab.close();
  sessions.set(sid, { tab, at: Date.now(), w: tab.size?.width || 1280, h: tab.size?.height || 800, agent: true, locked: true, sized: true });
  // In the desktop app the tab is a real view: a see-through cover stops your clicks while the agent works.
  if (tab.desktop) desktopCall('tab.lock', { tab: tab.id, locked: true }).catch(() => {});
}
export function releaseAgentTab(chatId, tab) {
  const s = sessions.get(`agent-${chatId}`);
  if (s && s.tab === tab) {
    s.locked = false; s.at = Date.now();
    if (tab.desktop) { desktopCall('tab.lock', { tab: tab.id, locked: false }).catch(() => {}); tab.clearViewport(); }
  } else if (!s || s.tab.id !== tab.id) tab.close();
}
async function session(sid, w, h) {
  let s = sessions.get(sid);
  if (!s && sid.startsWith('agent-')) return null; // only the agent opens its tab
  if (!s) { s = { tab: await openTab(), at: Date.now(), w: 1280, h: 800 }; sessions.set(sid, s); }
  s.at = Date.now();
  if (s.locked || s.tab.desktop) { s.w = s.tab.size?.width || s.w; s.h = s.tab.size?.height || s.h; return s; } // never resize under the agent, or a real tab the app sizes
  const nw = w ? clampSize(w, 360, 1600, 1280) : s.w, nh = h ? clampSize(h, 300, 1400, 800) : s.h;
  if (nw !== s.w || nh !== s.h || !s.sized) { s.w = nw; s.h = nh; s.sized = true; await s.tab.viewport(s.w, s.h).catch(() => {}); }
  return s;
}
async function state(s, peek = false) {
  const info = await s.tab.eval('({ url: location.href, title: document.title, w: innerWidth, h: innerHeight })').catch(() => ({ url: s.tab.url, title: '' }));
  if (s.tab.desktop && info.w) { s.w = info.w; s.h = info.h; } // a real tab: whatever size the app gives it
  return { url: info.url, title: info.title, shot: peek ? null : await s.tab.screenshot(), w: s.w, h: s.h, agent: !!s.agent, locked: !!s.locked, desktop: !!s.tab.desktop, at: Date.now() };
}

/** One step: open a URL, click, scroll, type, press a key, go back/forward/reload, or just look again. */
export async function userBrowse(sid, op, a = {}) {
  if (!/^[\w-]{6,60}$/.test(String(sid))) throw new Error('bad session');
  const s = await session(sid, a.w, a.h);
  if (!s) return { none: true };
  if (s.locked && op !== 'look' && op !== 'peek' && op !== 'inspect') throw new Error('the agent is using this page right now: watch only until its reply ends');
  // 💬 Comment: what is under a point of the picture, and a cropped picture of it. Reads only; never clicks.
  if (op === 'inspect') {
    const x = Math.max(0, Math.min(s.w, Number(a.x) || 0)), y = Math.max(0, Math.min(s.h, Number(a.y) || 0));
    const hit = await s.tab.inspect(x, y);
    if (!hit) return { hit: null };
    const info = await s.tab.eval('location.href').catch(() => s.tab.url);
    return { hit: { ...hit, url: info }, crop: await s.tab.crop(hit.rect, hit.scroll).catch(() => null), w: s.w, h: s.h };
  }
  const t = s.tab;
  if (op === 'open') {
    const url = String(a.url || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('only http and https addresses can be opened');
    await t.open(url, { width: s.w, height: s.h, mobile: false }).catch(() => {}); // a slow page still shows what has loaded
  } else if (op === 'click') {
    await t.click({ x: Math.max(0, Math.min(s.w, Number(a.x) || 0)), y: Math.max(0, Math.min(s.h, Number(a.y) || 0)) });
    await new Promise((r) => setTimeout(r, 500));
  } else if (op === 'scroll') await t.scroll(Math.max(-4000, Math.min(4000, Number(a.dy) || 600)));
  else if (op === 'type') await t.keys(String(a.text || '').slice(0, 2000));
  else if (op === 'key') await t.press(String(a.key || 'Enter'));
  else if (op === 'back' || op === 'forward') { await t.eval(`history.${op}()`).catch(() => {}); await new Promise((r) => setTimeout(r, 900)); }
  else if (op === 'reload') { await t.eval('location.reload()').catch(() => {}); await new Promise((r) => setTimeout(r, 1200)); }
  else if (op === 'close') { await t.close(); sessions.delete(sid); return { closed: true }; }
  else if (op === 'peek') return state(s, true);
  else if (op !== 'look') throw new Error(`unknown step ${op}`);
  return state(s);
}
